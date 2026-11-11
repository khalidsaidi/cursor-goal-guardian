// Bundling DeepSeek Harness's packages into Guardian's single-file hook, MCP server and extension.
//
// One of their modules (@deepseek-ai/dsh-llm) reads its own version at run time from the package.json beside it:
//   const { version } = createRequire(import.meta.url)("../package.json");
// A single-file bundle has no such file. This esbuild plugin puts the same value in at build time, read from that
// same package.json. Nothing else in their code is touched, and the build fails if that line ever changes.
import fs from "node:fs";
import path from "node:path";

const NEEDLE = 'createRequire(import.meta.url)("../package.json")';

export const dshBundlePlugin = {
  name: "dsh-llm-version",
  setup(build) {
    build.onLoad({ filter: /[\\/]@deepseek-ai[\\/]dsh-llm[\\/]lib[\\/]index\.js$/ }, (args) => {
      const source = fs.readFileSync(args.path, "utf8");
      if (source.split(NEEDLE).length !== 2) throw new Error(`dsh-bundle: ${args.path} no longer reads its version the way this plugin expects`);
      const { version } = JSON.parse(fs.readFileSync(path.join(path.dirname(args.path), "..", "package.json"), "utf8"));
      return { contents: source.replace(NEEDLE, JSON.stringify({ version })), loader: "js" };
    });
  },
};
