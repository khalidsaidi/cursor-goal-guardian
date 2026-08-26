import { build } from "esbuild";

// Extension host bundle (CJS, vscode external).
await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  logLevel: "silent",
});

// Webview bundle (browser IIFE, no runtime deps).
await build({
  entryPoints: ["src/webview/main.ts"],
  outfile: "media/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2020",
  logLevel: "silent",
});
