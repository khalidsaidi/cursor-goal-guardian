#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const extDir = path.join(root, "packages", "cursor-goal-guardian-extension");

run("pnpm", ["--filter", "cursor-goal-guardian-mcp", "build"], root);
run("pnpm", ["--filter", "cursor-goal-guardian-hook", "build"], root);
run("pnpm", ["--filter", "cursor-goal-guardian-extension", "build"], root);
run("node", [path.join(root, "scripts", "copy-binaries.js")], root);
run("pnpm", ["dlx", "@vscode/vsce", "package", "--no-dependencies", "--out", "cursor-goal-guardian.vsix"], extDir);
