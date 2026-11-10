import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
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
  it("exposes exactly the goal tools — the permit and task machinery is gone", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "guardian_get_contract",
      "guardian_get_status",
      "guardian_report_goal",
      "guardian_update_goal",
    ]);
    expect(names).not.toContain("guardian_issue_permit");
    expect(names).not.toContain("guardian_check_step");
    expect(names).not.toContain("guardian_commit_result");
    expect(names).not.toContain("guardian_record_progress");
  });
});

describe("guardian_get_contract", () => {
  it("returns the contract with criterion ids and boundaries", async () => {
    const result = await callJson("guardian_get_contract");
    expect(result.goal).toBe("Ship the CSV export feature");
    expect(result.successCriteria).toEqual([{ id: "sc_1", text: "Users can export the report table as CSV" }]);
    expect(result.constraints).toEqual(["No new dependencies"]);
    expect(result).not.toHaveProperty("activeTask");
  });
});

describe("guardian_get_status", () => {
  it("summarizes the session from the contract and the tape", async () => {
    const result = await callJson("guardian_get_status");
    expect(result.goal).toBe("Ship the CSV export feature");
    expect(result.goalPhase).toBe("active");
    expect(result).not.toHaveProperty("tasks");
    expect(result).not.toHaveProperty("counts24h");
  });
});

describe("guardian_update_goal", () => {
  const contractFile = () => path.join(ws.root, ".cursor", "goal-guardian", "contract.json");
  let saved = "";
  beforeEach(async () => { saved = await fs.readFile(contractFile(), "utf8"); });
  afterEach(async () => { await fs.writeFile(contractFile(), saved); });

  it("the user's words become the goal, a list in them the done-when items, and items can be added", async () => {
    const result = await callJson("guardian_update_goal", {
      user_words: "Ship the CSV export feature, plus filters",
      add_criteria: ["Filter state is preserved in the export"],
    });
    expect(result.goal).toBe("Ship the CSV export feature, plus filters");
    expect((result.criteria as Array<{ id: string; text: string }>).map((c) => c.id)).toEqual(["sc_1"]);
    expect((await callJson("guardian_get_contract")).goal).toBe("Ship the CSV export feature, plus filters");
    const listed = await callJson("guardian_update_goal", { user_words: "Ship it.\n- one thing\n- another thing" });
    expect(listed.goal).toBe("Ship it.");
    expect((listed.criteria as Array<{ text: string }>).map((c) => c.text)).toEqual(["one thing", "another thing"]);
  });
});

describe("only the user changes the goal", () => {
  const contractFile = () => path.join(ws.root, ".cursor", "goal-guardian", "contract.json");
  let saved = "";
  beforeEach(async () => { saved = await fs.readFile(contractFile(), "utf8"); });
  afterEach(async () => { await fs.writeFile(contractFile(), saved); });

  const prompts = () => path.join(ws.root, ".cursor", "goal-guardian", "telemetry", "prompts.json");
  const call = (args: Record<string, unknown>) => client.callTool({ name: "guardian_update_goal", arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

  it("refuses words the user never said, and accepts theirs", async () => {
    await fs.mkdir(path.dirname(prompts()), { recursive: true });
    await fs.writeFile(prompts(), JSON.stringify(["please make it JSON export instead"]));
    const before = String((await callJson("guardian_get_contract")).goal);
    const invented = await call({ user_words: "make it smaller" });
    expect(invented.isError).toBe(true);
    expect(invented.content[0]!.text).toContain("only the user changes");
    expect(String((await callJson("guardian_get_contract")).goal)).toBe(before);
    expect((await call({ add_criteria: ["a new item"] })).isError).toBeFalsy();
    expect((await call({ user_words: "make it JSON export instead" })).isError).toBeFalsy();
    expect(String((await callJson("guardian_get_contract")).goal)).toBe("make it JSON export instead");
    await fs.rm(prompts());
  });
});

describe("guardian_report_goal", () => {
  it("answers at once with what doesn't hold, and records the claim", async () => {
    const answer = await callJson("guardian_report_goal", { status: "complete", proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }] });
    expect(answer.accepted).toBe(false);
    expect(JSON.stringify(answer.unproved)).toContain("no record of `make test`");
    expect(auditOfKind(await readAudit(ws.root), "goal.report").length).toBeGreaterThanOrEqual(1);
  });
});

describe("robustness", () => {
  it("rejects malformed arguments but stays alive for the next call", async () => {
    const outcome = await client
      .callTool({ name: "guardian_report_goal", arguments: { status: "teleport" } })
      .then((res) => res as { isError?: boolean })
      .catch(() => ({ isError: true }));
    expect(outcome.isError).toBe(true);
    const alive = await callJson("guardian_get_contract");
    expect(String(alive.goal)).toContain("CSV export");
  });
});
