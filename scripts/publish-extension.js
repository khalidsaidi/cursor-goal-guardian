#!/usr/bin/env node
// Publish complete native packages, either verified locally or downloaded from CI.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "packages/core/package.json"));
const { sync: spawn } = require("cross-spawn");
const extDir = path.join(root, "packages/cursor-goal-guardian-extension");
const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];
const host = `${os.platform()}-${os.arch()}`;
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
};
const requested = flag("--target", host);
const selected = requested === "all" ? targets : [requested];
if (selected.some(target => !targets.includes(target))) throw new Error(`Unknown target: ${requested}`);
const { name, publisher, version } = JSON.parse(await fs.readFile(path.join(extDir, "package.json"), "utf8"));
const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
async function checkRegistryDownloads() {
  const registry = (process.env.OVSX_REGISTRY_URL ?? "https://open-vsx.org").replace(/\/$/, "");
  const results = await Promise.allSettled(selected.map(async target => {
    const url = `${registry}/api/${publisher}/${name}/${target}/${version}`;
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`registry returned HTTP ${response.status}`);
    }
    const entry = await response.json();
    if (entry.namespace !== publisher || entry.name !== name || entry.version !== version || entry.targetPlatform !== target) {
      throw new Error("registry returned a different package");
    }
    if (!entry.files?.download) throw new Error("registry supplied no download link");
    const download = await fetch(entry.files.download, {
      headers: { Range: "bytes=0-3" }, signal: AbortSignal.timeout(15_000),
    });
    if (!download.ok || !download.body) {
      await download.body?.cancel();
      throw new Error(`download returned HTTP ${download.status} or an empty body`);
    }
    let read = 0;
    for await (const chunk of download.body) {
      const prefix = chunk.subarray(0, zipHeader.length - read);
      if (!zipHeader.subarray(read, read + prefix.length).equals(prefix)) break;
      read += prefix.length;
      if (read === zipHeader.length) return;
    }
    throw new Error("download did not start with a VSIX archive header");
  }));
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") console.log(`${selected[index]} ${version} is downloadable`);
    else {
      console.error(`${selected[index]} ${version} download unconfirmed: ${result.reason.message}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv.includes("--check-registry")) {
  if (process.argv.includes("--check")) throw new Error("Use --check for local artifacts or --check-registry for public downloads");
  await checkRegistryDownloads();
  process.exit(process.exitCode ?? 0);
}
const artifacts = flag("--artifacts", null);
if (!artifacts && selected.some(target => target !== host)) {
  throw new Error("Cross-platform publishing needs --artifacts DIR containing the VSIX files and native CI verification receipts. Use --target all to publish the full matrix.");
}
function run(command, args, cwd = root) {
  const result = spawn(command, args, { stdio: "inherit", cwd, windowsHide: true });
  if (result.status !== 0) throw new Error(`Command failed: ${command} (exit ${result.status ?? "unavailable"})`);
}
if (!artifacts) {
  run(process.execPath, [path.join(root, "scripts/package-extension.js"), "--target", host]);
  run(process.execPath, [path.join(root, "scripts/verify-package.mjs"), path.join(extDir, `cursor-goal-guardian-${host}.vsix`)]);
}
const packages = [];
// Validate every selected file before publishing any of them.
for (const target of selected) {
  const archive = path.resolve(artifacts ?? extDir, `cursor-goal-guardian-${target}.vsix`);
  const receipt = JSON.parse(await fs.readFile(archive + ".verified.json", "utf8"));
  const digest = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  const components = ["native_codex", "goal_loop", "project_review_transport", "adk_evaluation", "rrsi_transport"];
  if (receipt.target !== target || receipt.version !== version || receipt.sha256 !== digest ||
      components.some(name => receipt.components?.[name] !== true) || (artifacts && !receipt.source_commit)) {
    throw new Error(`Missing or mismatched complete-package verification for ${target}`);
  }
  packages.push({ archive, target, source: receipt.source_commit });
}
if (artifacts && new Set(packages.map(pkg => pkg.source)).size !== 1) {
  throw new Error("The selected platform packages come from different source commits");
}
if (process.argv.includes("--check")) {
  console.log(`Complete-package verification matches ${version}: ${selected.join(", ")}`);
  process.exit(0);
}
const token = process.env.OVSX_TOKEN ?? process.env.OVSX_PAT;
if (!token) throw new Error("Set OVSX_TOKEN (or OVSX_PAT) to an Open VSX publishing token. Never put it in source control.");
for (const { archive, target } of packages) {
  run("pnpm", ["dlx", "ovsx", "publish", archive, "--target", target, "-p", token]);
}
await checkRegistryDownloads();
if (process.exitCode) console.error(`Recheck without uploading: pnpm publish:ovsx --target ${requested} --check-registry`);
