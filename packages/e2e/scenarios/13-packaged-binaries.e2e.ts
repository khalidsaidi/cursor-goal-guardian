import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scaffoldWorkspace } from "../src/scaffold.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST_TARGET = `${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const EXE = process.platform === "win32" ? ".exe" : "";
const BIN_DIR = path.join(REPO, "dist-bin", HOST_TARGET);
const PACKAGED_MCP = path.join(BIN_DIR, `goal-guardian-mcp${EXE}`);
const PACKAGED_HOOK = path.join(BIN_DIR, `goal-guardian-hook${EXE}`);

/**
 * The VSIX ships self-contained native executables — NOT the packages' dist/
 * builds the other scenarios exercise. These are the artifacts real users'
 * hooks.json and mcp.json invoke directly, so they get their own smoke on
 * every platform the CI matrix runs.
 */
describe("13 [deterministic] the packaged extension binaries actually run", () => {
  beforeAll(() => {
    // Binaries are compiled once per run by globalSetup.
    expect(fs.existsSync(PACKAGED_MCP)).toBe(true);
    expect(fs.existsSync(PACKAGED_HOOK)).toBe(true);
  }, 240_000);

  it("packaged MCP bundle starts and serves the six guardian tools", async () => {
    const ws = await scaffoldWorkspace({});
    const client = new Client({ name: "e2e-13", version: "0.0.0" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: PACKAGED_MCP,
          args: [],
          env: { ...process.env, GOAL_GUARDIAN_WORKSPACE_ROOT: ws.root } as Record<string, string>,
          stderr: "ignore",
        }),
      );
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        "guardian_check_action",
        "guardian_declare_intent",
        "guardian_get_contract",
        "guardian_get_status",
        "guardian_record_progress",
        "guardian_update_goal",
      ]);
      const res = (await client.callTool({ name: "guardian_get_contract", arguments: {} })) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(res.content[0]!.text).goal).toBe("Finish the math utilities");
      await ws.cleanup();
    } catch (err) {
      await ws.cleanup(true);
      throw err;
    } finally {
      await client.close();
    }
  }, 60_000);

  it("packaged hook bundle answers allow and writes the tape", async () => {
    const ws = await scaffoldWorkspace({});
    try {
      const res = spawnSync(PACKAGED_HOOK, [], {
        input: JSON.stringify({
          hook_event_name: "beforeShellExecution",
          command: "git status",
          workspace_roots: [ws.root],
        }),
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout).permission).toBe("allow");
      expect(fs.existsSync(ws.paths.audit)).toBe(true);
      await ws.cleanup();
    } catch (err) {
      await ws.cleanup(true);
      throw err;
    }
  }, 60_000);
});
