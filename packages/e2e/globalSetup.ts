import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Compile the shipped binaries exactly once per e2e run. Per-scenario
 * compiles raced on Windows: deleting dist-bin while the previous scenario's
 * just-closed executable still held its file handle fails there.
 */
export default function setup(): void {
  execSync(`node ${path.join(REPO, "scripts", "compile-binaries.mjs")} --host-only`, {
    cwd: REPO,
    stdio: "inherit",
  });
}
