import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeWorkspace, readAudit, auditOfKind, type TestWorkspace } from "cursor-goal-guardian-testkit";

let ws: TestWorkspace;
let client: Client;

async function callJson(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  ws = await makeWorkspace({
    goal: "Ship the CSV export feature",
    successCriteria: ["Users can export the report table as CSV"],
    constraints: ["No new dependencies"],
    tasks: [{ id: "t1", title: "Users can export the report table as CSV", status: "doing", criterionId: "sc_1" }],
  });
  client = new Client({ name: "mcp-contract-tests", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: path.join(process.cwd(), "node_modules", ".bin", "tsx"),
    args: [path.join(process.cwd(), "src", "index.ts")],
    env: { ...process.env, GOAL_GUARDIAN_WORKSPACE_ROOT: ws.root } as Record<string, string>,
    stderr: "ignore",
  });
  await client.connect(transport);
}, 30000);

afterAll(async () => {
  await client?.close();
  await ws?.cleanup();
});

describe("tool surface", () => {
  it("exposes exactly the four v2 tools — the permit machinery is gone", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "guardian_check_action",
      "guardian_declare_intent",
      "guardian_get_contract",
      "guardian_get_status",
    ]);
    expect(names).not.toContain("guardian_issue_permit");
    expect(names).not.toContain("guardian_check_step");
    expect(names).not.toContain("guardian_commit_result");
  });
});

describe("guardian_get_contract", () => {
  it("returns the contract with criterion ids, active task, and pinned context", async () => {
    const result = await callJson("guardian_get_contract");
    expect(result.goal).toBe("Ship the CSV export feature");
    expect(result.successCriteria).toEqual([{ id: "sc_1", text: "Users can export the report table as CSV" }]);
    expect(result.activeTask).toMatchObject({ id: "t1", criterionId: "sc_1" });
    expect(result.pinnedContext).toEqual([]);
  });
});

describe("guardian_declare_intent", () => {
  it("appends intent.declared records and returns scope keywords; repeated calls append, never mutate", async () => {
    const first = await callJson("guardian_declare_intent", { summary: "Implement the CSV serializer", taskId: "t1" });
    expect(String(first.intentId)).toMatch(/^int_/);
    expect(first.taskScopeKeywords).toContain("csv");

    await callJson("guardian_declare_intent", { summary: "Add serializer tests", plannedActions: ["edit src/export/csv.test.ts"] });

    const intents = auditOfKind(await readAudit(ws.root), "intent.declared");
    expect(intents).toHaveLength(2);
    expect(intents[0]?.summary).toBe("Implement the CSV serializer");
    expect(intents[0]?.taskId).toBe("t1");
    expect(intents[1]?.plannedActions).toEqual(["edit src/export/csv.test.ts"]);
  });
});

describe("guardian_check_action", () => {
  it("reports alert for destructive commands without gating anything", async () => {
    const result = await callJson("guardian_check_action", { action_type: "shell", action_value: "rm -rf /" });
    expect(result.severity).toBe("alert");
    expect(result.rule).toBe("rm -rf /");
  });

  it("reports caution with the matched rule", async () => {
    const result = await callJson("guardian_check_action", { action_type: "shell", action_value: "git reset --hard" });
    expect(result).toMatchObject({ severity: "caution", rule: "git reset --hard*" });
  });

  it("reports ok with lexical drift details for off-scope actions", async () => {
    const result = await callJson("guardian_check_action", { action_type: "shell", action_value: "docker build -t darkmode-theme ." });
    expect(result.severity).toBe("ok");
    expect(result.lexicalDrift).toMatchObject({ confidence: expect.any(String) });
    const inScope = await callJson("guardian_check_action", { action_type: "read", action_value: "src/export/csv.ts" });
    expect(inScope.lexicalDrift).toBeNull();
  });
});

describe("guardian_get_status", () => {
  it("summarizes the session from state + audit", async () => {
    const result = await callJson("guardian_get_status");
    expect(result.goal).toBe("Ship the CSV export feature");
    expect(result.activeTask).toEqual({ id: "t1", title: "Users can export the report table as CSV" });
    expect(result.tasks).toEqual({ todo: 0, doing: 1, done: 0 });
    expect((result.counts24h as Record<string, number>).intents).toBe(2);
  });
});

describe("robustness", () => {
  it("rejects malformed arguments but stays alive for the next call", async () => {
    const outcome = await client
      .callTool({ name: "guardian_check_action", arguments: { action_type: "teleport", action_value: "x" } })
      .then((res) => res as { isError?: boolean })
      .catch(() => ({ isError: true }));
    expect(outcome.isError).toBe(true);
    const alive = await callJson("guardian_get_contract");
    expect(alive.goal).toBe("Ship the CSV export feature");
  });
});
