#!/usr/bin/env node
// Bundle the MCP server and hook into the extension's bin/ so the VSIX is
// self-contained and setup can wire absolute paths to them.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extBin = path.join(root, "packages", "cursor-goal-guardian-extension", "bin");

async function bundle(entry, destName, format, addShebang) {
  const dest = path.join(extBin, destName);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format,
    target: "node18",
    outfile: dest,
    // The MCP entry carries its own hashbang (esbuild hoists it to line 1);
    // adding a banner there produced a second shebang on line 2 — a syntax
    // error in ESM. Only entries without one get the banner.
    ...(addShebang ? { banner: { js: "#!/usr/bin/env node" } } : {}),
    logLevel: "silent",
  });
  await fs.chmod(dest, 0o755);
}

await fs.mkdir(extBin, { recursive: true });
await fs.rm(path.join(extBin, "goal-guardian-mcp.js"), { force: true });
await fs.rm(path.join(extBin, "goal-guardian-hook.js"), { force: true });
// MCP server uses top-level await -> ESM; hook stays CJS for cold-start speed.
await bundle(path.join(root, "packages", "mcp", "src", "index.ts"), "goal-guardian-mcp.mjs", "esm", false);
await bundle(path.join(root, "packages", "hook", "src", "cli.ts"), "goal-guardian-hook.cjs", "cjs", true);
console.log("bundled bin/goal-guardian-mcp.mjs and bin/goal-guardian-hook.cjs");
