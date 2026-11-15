#!/usr/bin/env node
// Publishes the validated Linux x64 release to Open VSX (Cursor's registry).
// Each target carries its own self-contained native binaries.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const token = process.env.OVSX_TOKEN ?? process.env.OVSX_PAT;
if (!token) {
  console.error("Set OVSX_TOKEN (or OVSX_PAT) to an Open VSX publishing token. Never put it in source control.");
  process.exit(1);
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const extDir = path.join(root, "packages", "cursor-goal-guardian-extension");

const requested = process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : "linux-x64";
if (requested !== "linux-x64") {
  console.error("This release is validated for linux-x64 only. Older platform artifacts are historical.");
  process.exit(1);
}
const TARGETS = [requested];

run("node", [path.join(root, "scripts", "compile-binaries.mjs")], root);
for (const target of TARGETS) {
  run("node", [path.join(root, "scripts", "package-extension.js"), "--target", target], root);
  run(
    "pnpm",
    ["dlx", "ovsx", "publish", `cursor-goal-guardian-${target}.vsix`, "--target", target, "-p", token],
    extDir,
  );
}
