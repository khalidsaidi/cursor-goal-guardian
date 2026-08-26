import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveNodeInvocation, wireIntegration } from "../src/setup.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete process.env.GOAL_GUARDIAN_TEST_HOME;
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

function makeContext(extensionPath: string): { extensionPath: string } {
  return { extensionPath };
}

// A user's machine is not required to have Node.js on PATH — the wiring must
// never assume it. These pin the resolution ladder.
describe("node runtime resolution", () => {
  it("remote server: the extension host runtime IS node -> used directly, no PATH probe", () => {
    const inv = resolveNodeInvocation("/home/u/.cursor-server/bin/abc/node", () => {
      throw new Error("must not probe PATH when execPath is already node");
    });
    expect(inv).toEqual({ exe: "/home/u/.cursor-server/bin/abc/node" });
  });

  it("windows server runtime node.exe counts too", () => {
    const inv = resolveNodeInvocation("C:\\server\\node.exe", () => {
      throw new Error("no probe");
    });
    expect(inv.exe).toBe("C:\\server\\node.exe");
  });

  it("desktop electron + node on PATH -> bare node", () => {
    const inv = resolveNodeInvocation("/Applications/Cursor.app/Contents/MacOS/Cursor", () => true, "darwin");
    expect(inv).toEqual({ exe: "node" });
  });

  it("desktop electron, no node anywhere (POSIX) -> electron-as-node with env prefix for hooks", () => {
    const inv = resolveNodeInvocation("/opt/cursor/cursor", () => false, "linux");
    expect(inv.exe).toBe("/opt/cursor/cursor");
    expect(inv.mcpEnv).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(inv.hookPrefix).toBe("ELECTRON_RUN_AS_NODE=1 ");
    expect(inv.hookUnavailable).toBeUndefined();
  });

  it("windows desktop without node -> MCP still works via env; hook honestly unavailable", () => {
    const inv = resolveNodeInvocation("C:\\cursor\\Cursor.exe", () => false, "win32");
    expect(inv.mcpEnv).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(inv.hookUnavailable).toBe(true);
  });
});

describe("wiring carries the resolved runtime", () => {
  it("hooks and mcp entries use the absolute runtime, not a bare PATH lookup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-wire-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    process.env.GOAL_GUARDIAN_TEST_HOME = root;

    const inv = { exe: "/srv/.cursor-server/bin/x/node" };
    await wireIntegration(root, makeContext("/ext/dir") as never, inv);

    const hooks = JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
    const cmd = hooks.hooks.beforeShellExecution[0].command as string;
    expect(cmd).toBe(`"/srv/.cursor-server/bin/x/node" "${path.join("/ext/dir", "bin", "goal-guardian-hook.cjs")}"`);

    const mcp = JSON.parse(await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
    expect(mcp.mcpServers["goal-guardian"].command).toBe("/srv/.cursor-server/bin/x/node");
    expect(mcp.mcpServers["goal-guardian"].env.GOAL_GUARDIAN_WORKSPACE_ROOT).toBe(root);
  });

  it("electron-as-node fallback lands env on the MCP entry and a prefix on the hook command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-wire2-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    process.env.GOAL_GUARDIAN_TEST_HOME = root;

    const inv = { exe: "/opt/cursor/cursor", mcpEnv: { ELECTRON_RUN_AS_NODE: "1" }, hookPrefix: "ELECTRON_RUN_AS_NODE=1 " };
    await wireIntegration(root, makeContext("/ext/dir") as never, inv);

    const hooks = JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.beforeShellExecution[0].command).toMatch(/^ELECTRON_RUN_AS_NODE=1 "\/opt\/cursor\/cursor"/);

    const mcp = JSON.parse(await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
    expect(mcp.mcpServers["goal-guardian"].env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", GOAL_GUARDIAN_WORKSPACE_ROOT: root });
  });
});
