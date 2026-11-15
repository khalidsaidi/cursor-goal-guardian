#!/usr/bin/env node
// The recorder and the MCP server are compiled into self-contained native
// executables for six configured platform/architecture targets. A successful
// core-binary build is not qualification of the full CGG package. Five targets compile with bun; windows-arm64 (which
// bun cannot target) builds via official Node SEA: esbuild CJS bundle ->
// SEA blob -> injected into the official win-arm64 node.exe with postject.
//
//   node scripts/compile-binaries.mjs             # all configured core-binary targets
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

/**
 * One CJS file per entry, made by esbuild. bun then compiles that file: esbuild runs the plugin DeepSeek Harness's
 * packages need (scripts/dsh-bundle.mjs), which `bun build --compile` on the sources can't.
 */
async function bundleEntries() {
  const esbuild = (await import("esbuild")).default;
  const { dshBundlePlugin } = await import("./dsh-bundle.mjs");
  const stage = path.join(cacheDir, "bundle-stage");
  await fs.mkdir(stage, { recursive: true });
  const out = [];
  for (const job of ENTRIES) {
    const bundle = path.join(stage, `${job.name}.cjs`);
    await esbuild.build({ entryPoints: [job.entry], bundle: true, platform: "node", format: "cjs", target: "node20", outfile: bundle, logLevel: "silent", plugins: [dshBundlePlugin] });
    out.push({ ...job, bundle });
  }
  return out;
}

async function buildBun(target, bunTarget, dir) {
  const bun = bunExe();
  const exe = target.startsWith("win32") ? ".exe" : "";
  for (const job of await bundleEntries()) {
    run(bun, ["build", "--compile", `--target=${bunTarget}`, job.bundle, "--outfile", path.join(dir, `${job.name}${exe}`)]);
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

  const { dshBundlePlugin } = await import("./dsh-bundle.mjs");
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
      plugins: [dshBundlePlugin],
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

/**
 * OpenAI Codex's goal store behind Guardian's small Rust binary (packages/codex-goals): token budgets and usage.
 * Rust doesn't cross-compile from here, so it is built for this machine's own target with cargo; for the other
 * targets a binary built by CI on that platform (the `codex-goals` job's artifact, unpacked to
 * .cache/codex-goals/<target>/) is used when it is there. Without that runtime,
 * full goal completion remains unverified; core-binary smoke tests alone do not qualify the product.
 */
async function addCodexGoals(target, dir) {
  const name = `goal-guardian-codex-goals${target.startsWith("win32") ? ".exe" : ""}`;
  const out = path.join(dir, name);
  const prebuilt = path.join(cacheDir, "codex-goals", target, name);
  const copy = async (from) => {
    await fs.copyFile(from, out);
    if (!target.startsWith("win32")) await fs.chmod(out, 0o755);
  };
  if (process.env.GOAL_GUARDIAN_SKIP_CODEX_GOALS) return console.log(`codex-goals: skipped for ${target} (GOAL_GUARDIAN_SKIP_CODEX_GOALS)`);
  if (target === hostTarget()) {
    if (spawnSync("cargo", ["--version"], { timeout: 10_000 }).status !== 0) {
      console.log("codex-goals: cargo isn't installed, so Codex's goal runtime is unavailable; checked goal completion will be unverified");
    } else {
      const crate = path.join(root, "packages", "codex-goals");
      const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(cacheDir, "codex-goals-target");
      const built = spawnSync("cargo", ["build", "--release", "--locked"], { cwd: crate, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: targetDir } });
      if (built.status === 0) return copy(path.join(targetDir, "release", name));
      console.log("codex-goals: the cargo build failed, so the Codex goal runtime is unavailable; checked goal completion will be unverified");
    }
  }
  try {
    await copy(prebuilt);
    console.log(`codex-goals: used the prebuilt binary for ${target}`);
  } catch {
    if (target !== hostTarget()) console.log(`codex-goals: no binary for ${target} (build it on that platform, or unpack CI's artifact to ${path.relative(root, prebuilt)})`);
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
  await addCodexGoals(target, dir);
  console.log(`compiled ${target}`);
}
