// The hook runs on every shell/read/edit event: one self-contained CJS bundle
// keeps cold-start latency minimal (no module resolution, no workspace deps).
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { dshBundlePlugin } from "../../scripts/dsh-bundle.mjs";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  // DeepSeek Harness's goal packages are bundled in; they are loaded only when the goal is read or changed.
  plugins: [dshBundlePlugin],
  logLevel: "silent",
});
await chmod("dist/cli.cjs", 0o755);
