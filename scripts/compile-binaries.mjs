#!/usr/bin/env node
// The professional shipping pattern (as used by OpenAI's extension): the
// recorder and the MCP server are compiled into self-contained native
// executables for ALL six platform/arch combos — no Node.js, no PATH, no
// downloads, no dialogs. Five targets compile with bun; windows-arm64 (which
// bun cannot target) builds via official Node SEA: esbuild CJS bundle ->
// SEA blob -> injected into the official win-arm64 node.exe with postject.
//
//   node scripts/compile-binaries.mjs             # all publishable targets
//   node scripts/compile-binaries.mjs --host-only # just this machine (CI/dev)
//
// Output: dist-bin/<vscode-target>/goal-guardian-{hook,mcp}[.exe]
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = path.join(root, "dist-bin");
const cacheDir = path.join(root, ".cache");
const NODE_SEA_VERSION = "20.18.1";

const ENTRIES = [
  { entry: path.join(root, "packages", "hook", "src", "cli.ts"), name: "goal-guardian-hook" },
  { entry: path.join(root, "packages", "mcp", "src", "index.ts"), name: "goal-guardian-mcp" },
];

// vscode targetPlatform -> builder
const TARGETS = {
  "linux-x64": { kind: "bun", bunTarget: "bun-linux-x64" },
  "linux-arm64": { kind: "bun", bunTarget: "bun-linux-arm64" },
  "darwin-x64": { kind: "bun", bunTarget: "bun-darwin-x64" },
  "darwin-arm64": { kind: "bun", bunTarget: "bun-darwin-arm64" },
  "win32-x64": { kind: "bun", bunTarget: "bun-windows-x64" },
  "win32-arm64": { kind: "sea" },
};

function hostTarget() {
  const plat = os.platform();
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  return `${plat === "win32" ? "win32" : plat === "darwin" ? "darwin" : "linux"}-${arch}`;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (res.status !== 0) {
    console.error(`command failed: ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
}

function bunExe() {
  const candidates = [
    process.env.BUN_PATH,
    path.join(os.homedir(), ".bun", "bin", "bun"),
    path.join(os.homedir(), ".bun", "bin", "bun.exe"),
    "bun",
  ].filter(Boolean);
  for (const c of candidates) {
    const probe = spawnSync(c, ["--version"], { timeout: 10_000 });
    if (probe.status === 0) return c;
  }
  console.error("bun is required to compile the shipped binaries: https://bun.sh");
  process.exit(1);
}

async function buildBun(target, bunTarget, dir) {
  const bun = bunExe();
  const exe = target.startsWith("win32") ? ".exe" : "";
  for (const job of ENTRIES) {
    run(bun, ["build", "--compile", `--target=${bunTarget}`, job.entry, "--outfile", path.join(dir, `${job.name}${exe}`)]);
  }
}

/** Fetch (and cache) the official win-arm64 node.exe for SEA injection. */
async function winArm64NodeExe() {
  const cached = path.join(cacheDir, `node-v${NODE_SEA_VERSION}-win-arm64`, "node.exe");
  try {
    await fs.access(cached);
    return cached;
  } catch {
    /* download below */
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const name = `node-v${NODE_SEA_VERSION}-win-arm64`;
  const zip = path.join(cacheDir, `${name}.zip`);
  // CI runners see transient nodejs.org hiccups; retries make the build
  // deterministic instead of luck-based.
  const CURL_RETRY = ["--retry", "4", "--retry-delay", "2", "--retry-all-errors"];
  run("curl", ["-fsSL", ...CURL_RETRY, "-o", zip, `https://nodejs.org/dist/v${NODE_SEA_VERSION}/${name}.zip`]);
  // checksum against the official manifest
  const sums = path.join(cacheDir, `SHASUMS256-${NODE_SEA_VERSION}.txt`);
  run("curl", ["-fsSL", ...CURL_RETRY, "-o", sums, `https://nodejs.org/dist/v${NODE_SEA_VERSION}/SHASUMS256.txt`]);
  const sumsText = await fs.readFile(sums, "utf8");
  const expected = sumsText.split("\n").find((l) => l.includes(`${name}.zip`))?.split(/\s+/)[0];
  const crypto = await import("node:crypto");
  const actual = crypto.createHash("sha256").update(await fs.readFile(zip)).digest("hex");
  if (!expected || expected !== actual) {
    console.error("win-arm64 node download failed its checksum");
    process.exit(1);
  }
  // GNU tar can't read zip; prefer unzip, fall back to bsdtar (mac/win).
  const hasUnzip = spawnSync("unzip", ["-v"], { timeout: 5000 }).status === 0;
  if (hasUnzip) run("unzip", ["-oq", zip, "-d", cacheDir]);
  else run("tar", ["-xf", zip, "-C", cacheDir]);
  return cached;
}

async function buildSea(dir) {
  const esbuild = (await import("esbuild")).default;
  const stage = path.join(cacheDir, "sea-stage");
  await fs.mkdir(stage, { recursive: true });
  const baseNode = await winArm64NodeExe();

  for (const job of ENTRIES) {
    const bundle = path.join(stage, `${job.name}.cjs`);
    await esbuild.build({
      entryPoints: [job.entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      outfile: bundle,
      logLevel: "silent",
    });
    const seaConfig = path.join(stage, `${job.name}.sea.json`);
    const blob = path.join(stage, `${job.name}.blob`);
    await fs.writeFile(
      seaConfig,
      JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }),
      "utf8",
    );
    run(process.execPath, ["--experimental-sea-config", seaConfig]);

    const outExe = path.join(dir, `${job.name}.exe`);
    await fs.copyFile(baseNode, outExe);
    run(process.execPath, [
      path.join(root, "node_modules", "postject", "dist", "cli.js"),
      outExe,
      "NODE_SEA_BLOB",
      blob,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ]);
  }
}

const hostOnly = process.argv.includes("--host-only");
const targetFlag = process.argv.indexOf("--target");
const wanted =
  targetFlag !== -1
    ? [process.argv[targetFlag + 1]]
    : hostOnly
      ? [hostTarget()]
      : Object.keys(TARGETS);

for (const target of wanted) {
  const spec = TARGETS[target];
  if (!spec) {
    console.error(`unknown target ${target}`);
    process.exit(1);
  }
  const dir = path.join(outRoot, target);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  if (spec.kind === "bun") await buildBun(target, spec.bunTarget, dir);
  else await buildSea(dir);
  console.log(`compiled ${target}`);
}
