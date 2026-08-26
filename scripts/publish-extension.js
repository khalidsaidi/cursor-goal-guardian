#!/usr/bin/env node
// Publishes the platform-targeted VSIXs to Open VSX only (Cursor's registry).
// Each target carries its own self-contained native binaries.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.OVSX_TOKEN;
if (!token) {
  console.error("Missing OVSX_TOKEN env var.");
  process.exit(1);
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const extDir = path.join(root, "packages", "cursor-goal-guardian-extension");

const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];

run("node", [path.join(root, "scripts", "compile-binaries.mjs")], root);
for (const target of TARGETS) {
  run("node", [path.join(root, "scripts", "package-extension.js"), "--target", target], root);
  run(
    "pnpm",
    ["dlx", "ovsx", "publish", `cursor-goal-guardian-${target}.vsix`, "--target", target, "-p", token],
    extDir,
  );
}
