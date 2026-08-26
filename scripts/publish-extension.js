#!/usr/bin/env node
// Publishes to Open VSX only (Cursor's registry) — no Microsoft Marketplace.
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

run("pnpm", ["--filter", "@goal-guardian/core", "build"], root);
run("pnpm", ["--filter", "cursor-goal-guardian-extension", "build"], root);
run("node", [path.join(root, "scripts", "copy-binaries.js")], root);
run("pnpm", ["dlx", "ovsx", "publish", "--no-dependencies", "-p", token], extDir);
