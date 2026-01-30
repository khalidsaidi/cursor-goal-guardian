#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(process.cwd());
const mcpSrc = path.join(root, "packages", "cursor-goal-guardian-mcp", "src", "index.ts");
const hookSrc = path.join(root, "packages", "cursor-goal-guardian-hook", "src", "cli.ts");
const extBin = path.join(root, "packages", "cursor-goal-guardian-extension", "bin");

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function bundle(entry, destName) {
  const dest = path.join(extBin, destName);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: dest,
    logLevel: "silent",
  });
  await fs.chmod(dest, 0o755);
}

async function main() {
  await ensureDir(extBin);
  await bundle(mcpSrc, "goal-guardian-mcp.js");
  await bundle(hookSrc, "goal-guardian-hook.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
