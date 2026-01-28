#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd());
const mcpSrc = path.join(root, "packages", "cursor-goal-guardian-mcp", "dist", "index.js");
const hookSrc = path.join(root, "packages", "cursor-goal-guardian-hook", "dist", "cli.js");
const extBin = path.join(root, "packages", "cursor-goal-guardian-extension", "bin");

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function copy(src, destName) {
  const dest = path.join(extBin, destName);
  await fs.copyFile(src, dest);
  await fs.chmod(dest, 0o755);
}

async function main() {
  await ensureDir(extBin);
  await copy(mcpSrc, "goal-guardian-mcp.js");
  await copy(hookSrc, "goal-guardian-hook.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
