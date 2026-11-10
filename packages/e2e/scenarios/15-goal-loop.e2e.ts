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
  const report = async (args: Record<string, unknown>): Promise<{ accepted: boolean; unproved: string[]; unclaimed: string[] }> => {
    hook({ hook_event_name: "beforeMCPExecution", mcp_server_name: "goal-guardian", tool_name: "guardian_report_goal" });
    const res = (await client.callTool({ name: "guardian_report_goal", arguments: args })) as { content: Array<{ text: string }> };
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

  it("sends the agent back until its claim holds on Guardian's record, then lets it stop", async () => {
    expect(hook({ hook_event_name: "beforeSubmitPrompt", prompt: "add subtract", composer_mode: "agent" })).toMatchObject({ continue: true });
    expect(stop(0)).toEqual({});

    edit("src/math.ts");
    edit("README.md");
    const first = String(stop(0).followup_message);
    expect(first).toMatch(/^Goal Guardian: round 1 of 20/);
    expect(first).toContain("Add a subtract function");
    expect(first).toContain("not accounted for: src/math.ts");

    // Claiming success without running anything: refused at once and at the stop.
    const claim = { status: "complete", proofs: [{ criterion: "sc_1", command: "bun test", quote: "1 pass" }], changes: [{ file: "src/math.ts", serves: "sc_1" }] };
    const refused = await report(claim);
    expect(refused.accepted).toBe(false);
    expect(refused.unproved[0]).toContain("no record of `bun test`");
    expect(refused.unclaimed).toEqual(["README.md"]);
    expect(String(stop(1).followup_message)).toContain("no record of `bun test`");

    // Runs it, then edits again: the proof is stale.
    await pause();
    ran("bun test", "1 pass\n0 fail");
    await pause();
    edit("src/math.ts");
    await pause();
    const stale = await report({ ...claim, changes: [...claim.changes, { file: "README.md", serves: "extra" }] });
    expect(stale.unproved[0]).toContain("before your latest edit");

    // Runs it again, still keeping the extra: told once, then left for the user.
    ran("bun test", "1 pass\n0 fail");
    const held = await report({ ...claim, changes: [...claim.changes, { file: "README.md", serves: "extra" }] });
    expect(held.accepted).toBe(true);
    expect(String(stop(2).followup_message)).toContain("so undo it unless the user asked for it: README.md");
    expect(stop(3)).toEqual({});

    const end = tape().filter((r) => r.kind === "goal.end");
    expect(end).toMatchObject([{ outcome: "proved", extras: ["README.md"], proved: [{ criterion: "sc_1", command: "bun test", quote: "1 pass" }] }]);

    // Proved stays proved: later turns aren't sent back.
    edit("src/other.ts");
    expect(stop(0)).toEqual({});
  });

  it("reports where the goal stands", async () => {
    const res = (await client.callTool({ name: "guardian_get_status", arguments: {} })) as { content: Array<{ text: string }> };
    expect(JSON.parse(res.content[0]!.text).goalPhase).toBe("complete");
  });

  it("refuses to let the agent rewrite the goal without the user's words", async () => {
    const res = (await client.callTool({ name: "guardian_update_goal", arguments: { user_words: "Something smaller" } })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    const ok = (await client.callTool({ name: "guardian_get_contract", arguments: {} })) as { content: Array<{ text: string }> };
    expect(ok.content[0]!.text).toContain("Add a subtract function");
  });
});
