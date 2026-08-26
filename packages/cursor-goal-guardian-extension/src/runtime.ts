import * as vscode from "vscode";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import https from "node:https";
import path from "node:path";

/**
 * The guardian's recorder and agent tools are Node programs that Cursor
 * spawns as external processes, so they need a real Node.js runtime at an
 * absolute path. Production contract:
 *
 *   1. Cursor's remote server (WSL/SSH): the extension host itself runs on a
 *      real node binary — use it. Present by definition, nothing to ask.
 *   2. A Node.js already on this machine (PATH): resolve it to an absolute
 *      path once, so later PATH changes can't break the wiring.
 *   3. A runtime this extension previously installed into its own storage.
 *   4. Nothing found: ask the user once — download the official Node.js
 *      build (checksum-verified, into extension storage), or cancel setup.
 *
 * One absolute path comes out; every surface (hooks, workspace MCP, hub MCP)
 * is wired the same way on every platform.
 */

const NODE_VERSION = "20.18.1";

export interface RuntimeArchive {
  url: string;
  shasumsUrl: string;
  archiveName: string;
  /** Path of the node binary inside the archive. */
  binaryInArchive: string;
}

export function platformArchive(platform: NodeJS.Platform = process.platform, arch: string = process.arch): RuntimeArchive {
  const archMap: Record<string, string> = { x64: "x64", arm64: "arm64" };
  const a = archMap[arch] ?? "x64";
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  if (platform === "win32") {
    const name = `node-v${NODE_VERSION}-win-${a}.zip`;
    return { url: `${base}/${name}`, shasumsUrl: `${base}/SHASUMS256.txt`, archiveName: name, binaryInArchive: `node-v${NODE_VERSION}-win-${a}/node.exe` };
  }
  const os = platform === "darwin" ? "darwin" : "linux";
  const name = `node-v${NODE_VERSION}-${os}-${a}.tar.gz`;
  return { url: `${base}/${name}`, shasumsUrl: `${base}/SHASUMS256.txt`, archiveName: name, binaryInArchive: `node-v${NODE_VERSION}-${os}-${a}/bin/node` };
}

function runsAsNode(exe: string): boolean {
  const result = spawnSync(exe, ["--version"], { timeout: 5000 });
  return result.status === 0 && /^v\d+\./.test(result.stdout?.toString().trim() ?? "");
}

/** Ladder step 1: the extension host's own runtime, when it is a plain node. */
export function hostRuntime(execPath: string = process.execPath): string | null {
  const base = execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return base === "node" || base === "node.exe" ? execPath : null;
}

/** Ladder step 2: a node on PATH, pinned to its absolute location. */
export function pathRuntime(platform: NodeJS.Platform = process.platform): string | null {
  const probe = platform === "win32" ? spawnSync("where.exe", ["node.exe"], { timeout: 5000 }) : spawnSync("which", ["node"], { timeout: 5000 });
  if (probe.status !== 0) return null;
  const first = probe.stdout?.toString().split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!first) return null;
  return runsAsNode(first) ? first : null;
}

function installedBinaryPath(context: vscode.ExtensionContext): string {
  const bin = process.platform === "win32" ? "node.exe" : "node";
  return path.join(context.globalStorageUri.fsPath, "node-runtime", `v${NODE_VERSION}`, bin);
}

/** Ladder step 3: a runtime this extension installed earlier. */
async function installedRuntime(context: vscode.ExtensionContext): Promise<string | null> {
  const bin = installedBinaryPath(context);
  try {
    await fs.access(bin);
    return runsAsNode(bin) ? bin : null;
  } catch {
    return null;
  }
}

function fetch(url: string, redirects = 3): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(fetch(res.headers.location, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function downloadRuntime(context: vscode.ExtensionContext): Promise<string> {
  const info = platformArchive();
  const stageDir = path.join(context.globalStorageUri.fsPath, "node-runtime", "stage");
  const destDir = path.dirname(installedBinaryPath(context));
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });
  await fs.mkdir(destDir, { recursive: true });

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Goal Guardian: downloading the Node.js runtime", cancellable: false },
    async (progress) => {
      progress.report({ message: `fetching v${NODE_VERSION}…` });
      const [archive, shasums] = await Promise.all([fetch(info.url), fetch(info.shasumsUrl)]);

      progress.report({ message: "verifying checksum…" });
      const expected = shasums
        .toString("utf8")
        .split("\n")
        .find((l) => l.includes(info.archiveName))
        ?.split(/\s+/)[0];
      const actual = crypto.createHash("sha256").update(archive).digest("hex");
      if (!expected || expected !== actual) {
        throw new Error("runtime download failed its checksum — nothing was installed");
      }

      progress.report({ message: "unpacking…" });
      const archivePath = path.join(stageDir, info.archiveName);
      await fs.writeFile(archivePath, archive);
      // bsdtar ships with Windows 10+, macOS, and every mainstream Linux; it
      // reads both .zip and .tar.gz with the same flag.
      const tarExe = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
      const extract = spawnSync(tarExe, ["-xf", archivePath, "-C", stageDir], { timeout: 120_000 });
      if (extract.status !== 0) {
        throw new Error(`could not unpack the runtime archive: ${extract.stderr?.toString().slice(0, 200)}`);
      }

      const extractedBinary = path.join(stageDir, ...info.binaryInArchive.split("/"));
      const finalBinary = installedBinaryPath(context);
      await fs.copyFile(extractedBinary, finalBinary);
      if (process.platform !== "win32") await fs.chmod(finalBinary, 0o755);
      await fs.rm(stageDir, { recursive: true, force: true });

      if (!runsAsNode(finalBinary)) throw new Error("the downloaded runtime failed its self-check");
      return finalBinary;
    },
  );
}

export interface EnsureRuntimeOptions {
  /** When false, never show UI: return null instead of offering the download. */
  interactive: boolean;
}

/**
 * Resolve the runtime, offering the download when nothing suitable exists.
 * Returns an absolute path, or null when the user declined (the caller
 * aborts cleanly) or when running non-interactively with nothing found.
 */
export async function ensureRuntime(context: vscode.ExtensionContext, opts: EnsureRuntimeOptions): Promise<string | null> {
  const host = hostRuntime();
  if (host) return host;
  const onPath = pathRuntime();
  if (onPath) return onPath;
  const installed = await installedRuntime(context);
  if (installed) return installed;

  if (!opts.interactive) return null;

  const choice = await vscode.window.showInformationMessage(
    `Goal Guardian needs a JavaScript runtime for its session recorder and agent tools, and none was found on this machine. ` +
      `Download the official Node.js v${NODE_VERSION} build (about 30 MB, verified, kept inside the extension's own storage)?`,
    { modal: true },
    "Download runtime",
  );
  if (choice !== "Download runtime") return null;

  try {
    return await downloadRuntime(context);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Goal Guardian: the runtime download did not complete (${err instanceof Error ? err.message : String(err)}). ` +
        `Nothing was changed — run Setup again to retry.`,
    );
    return null;
  }
}
