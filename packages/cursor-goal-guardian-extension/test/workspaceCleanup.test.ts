import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  cleanupLegacyIntegration,
  isGoalGuardianHookCommand,
} from "../src/workspaceCleanup.js";

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-cleanup-"));
  await fs.mkdir(path.join(dir, ".cursor"), { recursive: true });
  return dir;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function listBackups(workspaceRoot: string, fileName: string): Promise<string[]> {
  const cursorDir = path.join(workspaceRoot, ".cursor");
  const names = await fs.readdir(cursorDir);
  return names.filter((n) => n.startsWith(`${fileName}.bak-`));
}

describe("workspace cleanup", () => {
  it("detects legacy hook command variants", () => {
    expect(isGoalGuardianHookCommand("node /x/goal-guardian-hook.js --mcp /x/goal-guardian-mcp.js")).toBe(true);
    expect(isGoalGuardianHookCommand("cursor-goal-guardian-hook")).toBe(true);
    expect(isGoalGuardianHookCommand("node /x/custom-hook.js")).toBe(false);
  });

  it("removes only goal-guardian hook entries and goal-guardian MCP server", async () => {
    const root = await makeTempWorkspace();
    const hooksPath = path.join(root, ".cursor", "hooks.json");
    const mcpPath = path.join(root, ".cursor", "mcp.json");

    await writeJson(hooksPath, {
      version: 1,
      hooks: {
        beforeShellExecution: [
          { command: "node /x/goal-guardian-hook.js --mcp /x/goal-guardian-mcp.js" },
          { command: "node /x/custom-hook.js" },
        ],
        beforeReadFile: [{ command: "cursor-goal-guardian-hook" }],
        stop: [{ command: "echo done" }],
      },
    });

    await writeJson(mcpPath, {
      mcpServers: {
        "goal-guardian": { command: "node", args: ["/x/goal-guardian-mcp.js"] },
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      },
    });

    const cleaned = await cleanupLegacyIntegration(root);
    expect(cleaned).toEqual({ hooksCleaned: true, mcpCleaned: true });

    const hooks = JSON.parse(await fs.readFile(hooksPath, "utf8"));
    expect(hooks.hooks.beforeShellExecution).toEqual([{ command: "node /x/custom-hook.js" }]);
    expect(hooks.hooks.beforeReadFile).toBeUndefined();
    expect(hooks.hooks.stop).toEqual([{ command: "echo done" }]);

    const mcp = JSON.parse(await fs.readFile(mcpPath, "utf8"));
    expect(mcp.mcpServers["goal-guardian"]).toBeUndefined();
    expect(mcp.mcpServers.filesystem).toBeDefined();

    const hooksBackups = await listBackups(root, "hooks.json");
    const mcpBackups = await listBackups(root, "mcp.json");
    expect(hooksBackups.length).toBeGreaterThan(0);
    expect(mcpBackups.length).toBeGreaterThan(0);
  });

  it("is idempotent after cleanup", async () => {
    const root = await makeTempWorkspace();
    const hooksPath = path.join(root, ".cursor", "hooks.json");
    const mcpPath = path.join(root, ".cursor", "mcp.json");

    await writeJson(hooksPath, {
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: "cursor-goal-guardian-hook" }],
      },
    });
    await writeJson(mcpPath, {
      mcpServers: {
        "goal-guardian": { command: "node", args: ["/x/goal-guardian-mcp.js"] },
      },
    });

    const first = await cleanupLegacyIntegration(root);
    expect(first).toEqual({ hooksCleaned: true, mcpCleaned: true });

    const firstHookBackups = await listBackups(root, "hooks.json");
    const firstMcpBackups = await listBackups(root, "mcp.json");
    expect(firstHookBackups.length).toBe(1);
    expect(firstMcpBackups.length).toBe(1);

    const second = await cleanupLegacyIntegration(root);
    expect(second).toEqual({ hooksCleaned: false, mcpCleaned: false });

    const secondHookBackups = await listBackups(root, "hooks.json");
    const secondMcpBackups = await listBackups(root, "mcp.json");
    expect(secondHookBackups.length).toBe(1);
    expect(secondMcpBackups.length).toBe(1);
  });

  it("returns no-op when there are no legacy entries", async () => {
    const root = await makeTempWorkspace();
    const hooksPath = path.join(root, ".cursor", "hooks.json");
    const mcpPath = path.join(root, ".cursor", "mcp.json");

    await writeJson(hooksPath, {
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: "node /x/custom-hook.js" }],
      },
    });
    await writeJson(mcpPath, {
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      },
    });

    const cleaned = await cleanupLegacyIntegration(root);
    expect(cleaned).toEqual({ hooksCleaned: false, mcpCleaned: false });

    const hooksBackups = await listBackups(root, "hooks.json");
    const mcpBackups = await listBackups(root, "mcp.json");
    expect(hooksBackups.length).toBe(0);
    expect(mcpBackups.length).toBe(0);
  });

  it("handles missing files safely", async () => {
    const root = await makeTempWorkspace();
    const cleaned = await cleanupLegacyIntegration(root);
    expect(cleaned).toEqual({ hooksCleaned: false, mcpCleaned: false });
  });
});

