#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const entry = path.join(root, "packages", "cursor-goal-guardian-extension", "src", "extension.ts");
const outFile = path.join(root, "packages", "cursor-goal-guardian-extension", "dist", "extension.js");

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: outFile,
  external: ["vscode"],
  logLevel: "silent",
});
