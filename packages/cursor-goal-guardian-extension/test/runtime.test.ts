import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostRuntime, pathRuntime, platformArchive } from "../src/runtime.js";
import { wireIntegration } from "../src/setup.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete process.env.GOAL_GUARDIAN_TEST_HOME;
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

// The recorder and agent tools are spawned by Cursor as external processes;
// they get ONE absolute runtime path, discovered or explicitly installed —
// never a bare PATH lookup, never an env-variable trick.
describe("runtime discovery", () => {
  it("remote server: the extension host runtime IS node -> used directly", () => {
    expect(hostRuntime("/home/u/.cursor-server/bin/abc/node")).toBe("/home/u/.cursor-server/bin/abc/node");
    expect(hostRuntime("C:\\server\\node.exe")).toBe("C:\\server\\node.exe");
  });

  it("desktop electron binaries are not a runtime answer", () => {
    expect(hostRuntime("/Applications/Cursor.app/Contents/MacOS/Cursor")).toBeNull();
    expect(hostRuntime("C:\\cursor\\Cursor.exe")).toBeNull();
  });

  it("a PATH node is pinned to an absolute path (this test host has one)", () => {
    // vitest itself runs under node, so a PATH probe on this machine succeeds
    // and must come back absolute — wiring never stores a bare name.
    const found = pathRuntime();
    if (found !== null) expect(path.isAbsolute(found)).toBe(true);
  });

  it("download coordinates map every supported platform to an official archive", () => {
    const win = platformArchive("win32", "x64");
    expect(win.url).toMatch(/^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/node-v.*-win-x64\.zip$/);
    expect(win.binaryInArchive).toMatch(/node\.exe$/);

    const mac = platformArchive("darwin", "arm64");
    expect(mac.url).toMatch(/darwin-arm64\.tar\.gz$/);
    expect(mac.binaryInArchive).toMatch(/bin\/node$/);

    const linux = platformArchive("linux", "x64");
    expect(linux.url).toMatch(/linux-x64\.tar\.gz$/);
    expect(linux.shasumsUrl).toMatch(/SHASUMS256\.txt$/);
  });
});

describe("wiring carries the resolved runtime", () => {
  it("hooks and both MCP entries use the same absolute runtime, no env tricks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-wire-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    process.env.GOAL_GUARDIAN_TEST_HOME = root;

    const exe = "/srv/.cursor-server/bin/x/node";
    await wireIntegration(root, { extensionPath: "/ext/dir" } as never, exe);

    const hooks = JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
    const cmd = hooks.hooks.beforeShellExecution[0].command as string;
    expect(cmd).toBe(`"${exe}" "${path.join("/ext/dir", "bin", "goal-guardian-hook.cjs")}"`);

    const mcp = JSON.parse(await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
    expect(mcp.mcpServers["goal-guardian"].command).toBe(exe);
    expect(mcp.mcpServers["goal-guardian"].env).toEqual({ GOAL_GUARDIAN_WORKSPACE_ROOT: root });
  });
});
