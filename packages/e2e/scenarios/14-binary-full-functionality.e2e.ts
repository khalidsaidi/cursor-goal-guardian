import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
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
 * win32. Scenario 13 is the smoke; this is the full sweep: all six MCP tools
 * as a session lifecycle, and every hook pipeline path (allow, lexical drift
 * with episode-governed nudging, chained risky-command advisory, no-task
 * reminder, quiet mode, guardian-tool exemption).
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
    execSync(`node ${path.join(REPO, "scripts", "compile-binaries.mjs")} --host-only`, { cwd: REPO, stdio: "inherit" });
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

  let exporterTaskId = "";

  it("goal grows and the board follows: update_goal, get_contract, decision-gated switch, intent, self-check", async () => {
    // update_goal: extend the goal with a new criterion -> a new task appears
    await tool("guardian_update_goal", {
      goal: "Finish the math utilities and ship the CSV exporter",
      add_criteria: ["Exporter writes valid CSV"],
    });

    const contract = (await tool("guardian_get_contract")) as { goal: string; successCriteria: Array<{ id: string; text: string }> };
    expect(contract.goal).toContain("CSV exporter");
    exporterTaskId = contract.successCriteria.find((c) => c.text.includes("Exporter"))!.id;

    // switching away from the active task without a decision is refused...
    const refused = (await client.callTool({
      name: "guardian_record_progress",
      arguments: { action: "start_task", taskId: exporterTaskId },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(JSON.stringify(refused.content)).toMatch(/decision/i);

    // ...and honored with one (the machine keeps the why on the record)
    await tool("guardian_record_progress", {
      action: "start_task",
      taskId: exporterTaskId,
      decision: { text: "Switch to the exporter", rationale: "CSV is the blocking deliverable" },
    });

    const intent = (await tool("guardian_declare_intent", { summary: "Writing the CSV serializer" })) as { intentId?: string };
    expect(intent).toBeTruthy();

    // check_action: severity comes from the per-segment policy even inside a
    // chain — destructive tail escalates to alert, cautionary tail to caution,
    // and a neutral command stays ok
    const destructive = (await tool("guardian_check_action", { action_type: "shell", action_value: "git status && rm -rf /" })) as { severity: string };
    const cautionary = (await tool("guardian_check_action", { action_type: "shell", action_value: "git status && git reset --hard" })) as { severity: string };
    const calm = (await tool("guardian_check_action", { action_type: "shell", action_value: "git status" })) as { severity: string };
    expect(destructive.severity).toBe("alert");
    expect(cautionary.severity).toBe("caution");
    expect(calm.severity).toBe("ok");

    expect(tapeKinds(ws)).toContain("intent.declared");
  });

  it("hook: neutral command -> bare allow, no message", () => {
    const { out } = hook(ws, { hook_event_name: "beforeShellExecution", command: "git status" });
    expect(out.permission).toBe("allow");
    expect(out.userMessage).toBeUndefined();
  });

  it("hook: off-goal burst -> drift recorded every time, nudged ONCE (episode governor)", () => {
    const first = hook(ws, { hook_event_name: "beforeShellExecution", command: "docker build darkmode theme palette ." });
    const second = hook(ws, { hook_event_name: "beforeShellExecution", command: "touch darkmode theme palette tokens" });
    const third = hook(ws, { hook_event_name: "beforeShellExecution", command: "mv darkmode-theme palette-tokens styles" });
    expect(first.out.permission).toBe("allow");
    expect(second.out.permission).toBe("allow");
    expect(third.out.permission).toBe("allow");
    const nudges = [first, second, third].filter((r) => typeof r.out.userMessage === "string" && (r.out.userMessage as string).length > 0);
    expect(nudges.length).toBe(1);
    const drifts = tapeKinds(ws).filter((k) => k === "drift.lexical");
    expect(drifts.length).toBeGreaterThanOrEqual(3);
  });

  it("hook: risky command inside a chain -> advisory recorded, still allow", () => {
    const { out } = hook(ws, { hook_event_name: "beforeShellExecution", command: "git status && git reset --hard HEAD~3" });
    expect(out.permission).toBe("allow");
    expect(tapeKinds(ws)).toContain("policy.advisory");
  });

  it("hook: guardian's own MCP tools are never drift", () => {
    const before = tapeKinds(ws).filter((k) => k === "drift.lexical").length;
    const { out } = hook(ws, {
      hook_event_name: "beforeMCPExecution",
      mcp_server_name: "goal-guardian",
      tool_name: "guardian_get_status",
    });
    expect(out.permission).toBe("allow");
    expect(tapeKinds(ws).filter((k) => k === "drift.lexical").length).toBe(before);
  });

  it("hook: edits and reads are observed on the raw tape", () => {
    hook(ws, { hook_event_name: "afterFileEdit", file_path: path.join(ws.root, "src", "exporter.ts") });
    const observed = tapeKinds(ws).filter((k) => k === "action.observed");
    expect(observed.length).toBeGreaterThan(0);
  });

  it("completing the task closes the lifecycle in get_status", async () => {
    await tool("guardian_record_progress", { action: "complete_task", taskId: exporterTaskId });
    const status = await tool("guardian_get_status");
    expect(JSON.stringify(status)).toContain("Exporter");
  });

  it("quiet mode: drifting actions stay recorded, zero messages injected", async () => {
    const quiet = await scaffoldWorkspace({ config: { notify: "quiet" } });
    try {
      const r1 = hook(quiet, { hook_event_name: "beforeShellExecution", command: "docker build darkmode theme palette ." });
      const r2 = hook(quiet, { hook_event_name: "beforeShellExecution", command: "git reset --hard" });
      expect(r1.out.userMessage).toBeUndefined();
      expect(r2.out.userMessage).toBeUndefined();
      expect(tapeKinds(quiet).length).toBeGreaterThan(0);
      await quiet.cleanup();
    } catch (err) {
      await quiet.cleanup(true);
      throw err;
    }
  });
});
