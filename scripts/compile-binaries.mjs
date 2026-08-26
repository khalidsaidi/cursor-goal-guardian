#!/usr/bin/env node
// The professional shipping pattern (as used by OpenAI's extension): the
// recorder and the MCP server are compiled into self-contained native
// executables, so an installed VSIX depends on nothing — no Node.js, no
// PATH, no downloads, no dialogs. One platform's binaries per targeted VSIX.
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

// vscode targetPlatform -> bun compile target. Bun has no windows-arm64
// compiler; modern ARM Windows runs the x64 build through its built-in
// emulation, so that target ships the x64 binaries.
const TARGETS = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "win32-x64": "bun-windows-x64",
  "win32-arm64": "bun-windows-x64",
};

function hostTarget() {
  const plat = os.platform();
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  return `${plat === "win32" ? "win32" : plat === "darwin" ? "darwin" : "linux"}-${arch}`;
}

function bunExe() {
  const candidates = [
    process.env.BUN_PATH,
    path.join(os.homedir(), ".bun", "bin", "bun"),
    path.join(os.homedir(), ".bun", "bin", "bun.exe"),
    "bun",
  ].filter(Boolean);
  for (const c of candidates) {
    const probe = spawnSync(c, ["--version"], { timeout: 10_000, shell: false });
    if (probe.status === 0) return c;
  }
  console.error("bun is required to compile the shipped binaries: https://bun.sh");
  process.exit(1);
}

const hostOnly = process.argv.includes("--host-only");
const wanted = hostOnly ? [hostTarget()] : Object.keys(TARGETS);
const bun = bunExe();

for (const target of wanted) {
  const bunTarget = TARGETS[target];
  if (!bunTarget) {
    console.error(`unknown target ${target}`);
    process.exit(1);
  }
  const dir = path.join(outRoot, target);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const exe = target.startsWith("win32") ? ".exe" : "";
  const jobs = [
    { entry: path.join(root, "packages", "hook", "src", "cli.ts"), out: `goal-guardian-hook${exe}` },
    { entry: path.join(root, "packages", "mcp", "src", "index.ts"), out: `goal-guardian-mcp${exe}` },
  ];
  for (const job of jobs) {
    const res = spawnSync(
      bun,
      ["build", "--compile", `--target=${bunTarget}`, job.entry, "--outfile", path.join(dir, job.out)],
      { stdio: "inherit", cwd: root },
    );
    if (res.status !== 0) process.exit(res.status ?? 1);
  }
  console.log(`compiled ${target}`);
}
