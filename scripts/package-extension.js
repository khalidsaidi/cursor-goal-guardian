#!/usr/bin/env node
// Package a platform-targeted VSIX carrying the self-contained native
// binaries for exactly that platform:
//
//   node scripts/package-extension.js                    # host platform
//   node scripts/package-extension.js --target win32-x64 # explicit target
//
// Produces cursor-goal-guardian-<target>.vsix (and copies the host build to
// cursor-goal-guardian.vsix for local install convenience).
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const extDir = path.join(root, "packages", "cursor-goal-guardian-extension");
const binDir = path.join(extDir, "bin");

function hostTarget() {
  const plat = os.platform();
  const arch = os.arch() === "arm64" ? "arm64" : "x64";
  return `${plat === "win32" ? "win32" : plat === "darwin" ? "darwin" : "linux"}-${arch}`;
}

const targetFlag = process.argv.indexOf("--target");
const target = targetFlag >= 0 ? process.argv[targetFlag + 1] : hostTarget();

run("pnpm", ["--filter", "@goal-guardian/core", "build"], root);
run("pnpm", ["--filter", "cursor-goal-guardian-extension", "build"], root);

// Ensure the compiled binaries for this target exist, then stage them as the
// VSIX's bin/ — nothing else ships there.
const compiled = path.join(root, "dist-bin", target);
try {
  await fs.access(compiled);
} catch {
  run("node", [path.join(root, "scripts", "compile-binaries.mjs"), ...(target === hostTarget() ? ["--host-only"] : [])], root);
}
await fs.rm(binDir, { recursive: true, force: true });
await fs.mkdir(binDir, { recursive: true });
for (const entry of await fs.readdir(compiled)) {
  await fs.copyFile(path.join(compiled, entry), path.join(binDir, entry));
  if (!target.startsWith("win32")) await fs.chmod(path.join(binDir, entry), 0o755);
}

const out = `cursor-goal-guardian-${target}.vsix`;
run("pnpm", ["dlx", "@vscode/vsce", "package", "--no-dependencies", "--target", target, "--out", out], extDir);
if (target === hostTarget()) {
  await fs.copyFile(path.join(extDir, out), path.join(extDir, "cursor-goal-guardian.vsix"));
}
console.log(`packaged ${out}`);
