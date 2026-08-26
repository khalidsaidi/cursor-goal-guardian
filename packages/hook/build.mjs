// The hook runs on every shell/read/edit event: one self-contained CJS bundle
// keeps cold-start latency minimal (no module resolution, no workspace deps).
import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "silent",
});
await chmod("dist/cli.cjs", 0o755);
