#!/usr/bin/env node
// All workspace packages must share one base version (prerelease tags allowed,
// e.g. 1.0.0-rc.0 alongside 1.0.0). Fails the build on drift.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");

const entries = await fs.readdir(packagesDir, { withFileTypes: true });
const seen = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const pkgPath = path.join(packagesDir, entry.name, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  const base = String(pkg.version).split("-")[0];
  seen.push({ name: pkg.name, version: pkg.version, base });
}

const bases = new Set(seen.map((s) => s.base));
if (bases.size > 1) {
  console.error("Version drift across workspace packages:");
  for (const s of seen) console.error(`  ${s.name}: ${s.version}`);
  process.exit(1);
}
console.log(`versions in sync at base ${[...bases][0]} (${seen.length} packages)`);
