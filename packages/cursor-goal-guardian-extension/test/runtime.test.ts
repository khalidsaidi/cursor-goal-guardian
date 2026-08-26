import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wireIntegration, bundledBinPaths } from "../src/setup.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete process.env.GOAL_GUARDIAN_TEST_HOME;
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

// The VSIX ships self-contained native executables per platform (the shipping
// pattern renowned extensions use). Wiring points straight at them: no
// Node.js, no PATH lookups, no env tricks, nothing that can be missing.
describe("self-contained binary wiring", () => {
  it("bin paths carry the platform's executable name", () => {
    const paths = bundledBinPaths({ extensionPath: "/ext" } as never);
    const exe = process.platform === "win32" ? ".exe" : "";
    expect(paths.hook).toBe(path.join("/ext", "bin", `goal-guardian-hook${exe}`));
    expect(paths.mcp).toBe(path.join("/ext", "bin", `goal-guardian-mcp${exe}`));
  });

  it("hooks and both MCP entries invoke the bundled executables directly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-wire-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    process.env.GOAL_GUARDIAN_TEST_HOME = root;

    await wireIntegration(root, { extensionPath: "/ext/dir" } as never, );

    const bins = bundledBinPaths({ extensionPath: "/ext/dir" } as never);
    const hooks = JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.beforeShellExecution[0].command).toBe(`"${bins.hook}"`);

    const mcp = JSON.parse(await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
    expect(mcp.mcpServers["goal-guardian"].command).toBe(bins.mcp);
    expect(mcp.mcpServers["goal-guardian"].args).toBeUndefined();
    expect(mcp.mcpServers["goal-guardian"].env).toEqual({ GOAL_GUARDIAN_WORKSPACE_ROOT: root });
  });
});
