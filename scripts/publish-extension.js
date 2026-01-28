#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const token = process.env.OVSX_TOKEN;
if (!token) {
  console.error("Missing OVSX_TOKEN env var.");
  process.exit(1);
}

function run(cmd, args, env, cwd) {
  const res = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env }, cwd });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const root = process.cwd();
const extDir = "packages/cursor-goal-guardian-extension";

run("pnpm", ["--filter", "cursor-goal-guardian-mcp", "build"], {}, root);
run("pnpm", ["--filter", "cursor-goal-guardian-hook", "build"], {}, root);
run("pnpm", ["--filter", "cursor-goal-guardian-extension", "build"], {}, root);
run("node", ["scripts/copy-binaries.js"], {}, root);
run("pnpm", ["dlx", "ovsx", "publish", "-p", token], {}, extDir);
