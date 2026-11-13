import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scaffoldWorkspace, type E2EWorkspace } from "../src/scaffold.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST_TARGET = `${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const EXE = process.platform === "win32" ? ".exe" : "";
const BIN_MCP = path.join(REPO, "dist-bin", HOST_TARGET, `goal-guardian-mcp${EXE}`);
const BIN_HOOK = path.join(REPO, "dist-bin", HOST_TARGET, `goal-guardian-hook${EXE}`);

/**
 * The whole goal loop through the shipped binaries, in the order Cursor calls them. What this can't
 * cover is Cursor itself delivering the follow-up: that needs the real app.
 */
describe("15 [deterministic] shipped binaries: the goal loop", () => {
  let ws: E2EWorkspace;
  let client: Client;

  const hook = (payload: Record<string, unknown>): Record<string, unknown> => {
    const res = spawnSync(BIN_HOOK, [], { input: JSON.stringify({ workspace_roots: [ws.root], cwd: ws.root, conversation_id: "conv-1", generation_id: "gen-1", ...payload }), encoding: "utf8", timeout: 30_000 });
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout) as Record<string, unknown>;
  };
  const edit = (file: string) => hook({ hook_event_name: "afterFileEdit", file_path: path.join(ws.root, file) });
  const ran = (command: string, output: string) => {
    hook({ hook_event_name: "beforeShellExecution", command });
    hook({ hook_event_name: "afterShellExecution", command, output, duration: 5 });
  };
  const stop = (loop_count: number) => hook({ hook_event_name: "stop", status: "completed", loop_count });
  const report = async (args: Record<string, unknown>): Promise<{ accepted: boolean; outcome?: string; verificationPending?: boolean; unproved: string[]; unclaimed: string[] }> => {
    hook({ hook_event_name: "beforeMCPExecution", mcp_server_name: "goal-guardian", tool_name: "update_goal" });
    const res = (await client.callTool({ name: "update_goal", arguments: args })) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0]!.text);
  };
  const pause = () => new Promise((r) => setTimeout(r, 20));
  const tape = () => fs.readFileSync(ws.paths.audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeAll(async () => {
    expect(fs.existsSync(BIN_MCP)).toBe(true);
    ws = await scaffoldWorkspace({ goal: "Add a subtract function", successCriteria: ["subtract is tested"] });
    client = new Client({ name: "e2e-15", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: BIN_MCP, args: [], env: { ...process.env, GOAL_GUARDIAN_WORKSPACE_ROOT: ws.root } as Record<string, string>, stderr: "ignore" }));
  }, 300_000);

  afterAll(async () => {
    await client?.close();
    await ws?.cleanup();
  });

  it("keeps the goal moving, uses captured results, and stops without proof paperwork", async () => {
    expect(hook({ hook_event_name: "beforeSubmitPrompt", prompt: "add subtract", composer_mode: "agent" })).toMatchObject({ continue: true });
    expect(stop(0)).toEqual({});
    fs.appendFileSync(path.join(ws.root, "src/math.ts"), "\nexport function subtract(a: number, b: number) { return a - b; }\n");
    fs.appendFileSync(path.join(ws.root, "README.md"), "\nsubtract returns the difference.\n");
    edit("src/math.ts"); edit("README.md");
    const first = String(stop(0).followup_message);
    expect(first).toMatch(/^Goal Guardian: round 1 of 20/);
    expect(first).toContain("Add a subtract function");
    expect(first).toContain("Observed change: src/math.ts");
    await pause(); ran("bun test", "1 pass\n0 fail");

    // No independent model is installed in this offline scenario. The goal stays open for a
    // recovery pass, and eventually ends unchecked through both real goal keepers' handlers.
    const pending = await report({ status: "complete" });
    expect(pending).toMatchObject({ accepted: false, verificationPending: true, unproved: [], unclaimed: [] });
    expect(tape().filter((r) => r.kind === "goal.end")).toHaveLength(0);
    expect(String(stop(1).followup_message)).toContain("Do not hand those commands to the user");
    const held = await report({ status: "complete" });
    expect(held).toMatchObject({ accepted: true, outcome: "unchecked" });
    expect(stop(2)).toEqual({});
    expect(tape().filter((r) => r.kind === "goal.end")).toMatchObject([{ outcome: "unchecked", extras: [], proved: expect.arrayContaining([{ criterion: "goal", command: "bun test", recordedAt: expect.any(String) }]) }]);
    expect(tape().filter((r) => r.kind === "goal.refused")).toEqual([]);
    edit("src/other.ts"); expect(stop(0)).toEqual({});
  });

  it("reports where the goal stands", async () => {
    const res = (await client.callTool({ name: "get_goal", arguments: {} })) as { content: Array<{ text: string }> };
    expect(JSON.parse(res.content[0]!.text).goal.status).toBe("complete");
  });

  it("refuses to let the agent rewrite the goal without the user's words", async () => {
    const res = (await client.callTool({ name: "guardian_change_goal", arguments: { user_words: "Something smaller" } })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    const ok = (await client.callTool({ name: "get_goal", arguments: {} })) as { content: Array<{ text: string }> };
    expect(ok.content[0]!.text).toContain("Add a subtract function");
  });
});
