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
 * The complete functionality of the SHIPPED binaries, exercised on whatever
 * platform runs this suite — the CI matrix makes that linux, darwin, and
 * win32. Scenario 13 is the smoke; this is the full sweep: all four MCP tools
 * as a session lifecycle, and every hook path (record and allow, with nothing said).
 */

function hook(ws: E2EWorkspace, payload: Record<string, unknown>): { out: Record<string, unknown>; status: number } {
  const res = spawnSync(BIN_HOOK, [], {
    input: JSON.stringify({ workspace_roots: [ws.root], cwd: ws.root, ...payload }),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(res.status).toBe(0);
  return { out: JSON.parse(res.stdout) as Record<string, unknown>, status: res.status ?? -1 };
}

function tapeKinds(ws: E2EWorkspace): string[] {
  if (!fs.existsSync(ws.paths.audit)) return [];
  return fs
    .readFileSync(ws.paths.audit, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { kind: string }).kind);
}

describe("14 [deterministic] shipped binaries: full functionality on this platform", () => {
  let ws: E2EWorkspace;
  let client: Client;

  beforeAll(async () => {
    // Binaries are compiled once per run by globalSetup.
    expect(fs.existsSync(BIN_MCP)).toBe(true);
    expect(fs.existsSync(BIN_HOOK)).toBe(true);
    ws = await scaffoldWorkspace({});
    client = new Client({ name: "e2e-14", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: BIN_MCP,
        args: [],
        env: { ...process.env, GOAL_GUARDIAN_WORKSPACE_ROOT: ws.root } as Record<string, string>,
        stderr: "ignore",
      }),
    );
  }, 300_000);

  afterAll(async () => {
    await client?.close();
    await ws?.cleanup();
  });

  async function tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).not.toBe(true);
    return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
  }

  it("the goal grows on the record: guardian_change_goal, get_goal", async () => {
    await tool("guardian_change_goal", {
      user_words: "Finish the math utilities and ship the CSV exporter",
      add_criteria: ["Exporter writes valid CSV"],
    });

    const { goal } = (await tool("get_goal")) as { goal: { objective: string; done_when: Array<{ id: string; text: string }> } };
    expect(goal.objective).toContain("CSV exporter");
    expect(goal.done_when.some((c) => c.text.includes("Exporter"))).toBe(true);
  });

  it("hook: a command -> bare allow, no message", () => {
    const { out } = hook(ws, { hook_event_name: "beforeShellExecution", command: "git status" });
    expect(out.permission).toBe("allow");
    expect(out.userMessage).toBeUndefined();
  });


  it("hook: guardian's own MCP tools pass silently", () => {
    const { out } = hook(ws, {
      hook_event_name: "beforeMCPExecution",
      mcp_server_name: "goal-guardian",
      tool_name: "get_goal",
    });
    expect(out.permission).toBe("allow");
    expect(out.userMessage).toBeUndefined();
  });

  it("hook: edits are observed on the raw tape", () => {
    hook(ws, { hook_event_name: "afterFileEdit", file_path: path.join(ws.root, "src", "exporter.ts") });
    const observed = tapeKinds(ws).filter((k) => k === "action.observed");
    expect(observed.length).toBeGreaterThan(0);
  });

  it("a report on the goal goes on the record, and get_goal shows where the goal stands", async () => {
    const answer = await tool("update_goal", { status: "complete", proofs: [], changes: [] });
    expect(answer.accepted).toBe(false);
    expect(tapeKinds(ws)).toContain("goal.report");
    const { goal } = (await tool("get_goal")) as { goal: { objective: string; status: string } };
    expect(goal.objective).toContain("CSV exporter");
    expect(goal.status).toBe("active");
  });

});
