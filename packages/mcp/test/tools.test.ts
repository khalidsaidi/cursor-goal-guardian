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
    // Codex's get_goal and update_goal by their own names, and Guardian's own tool for a redirected goal.
    expect(names).toEqual(["create_goal", "get_goal", "goal_command", "guardian_change_goal", "update_goal"]);
    expect(names).not.toContain("guardian_issue_permit");
    expect(names).not.toContain("guardian_check_step");
    expect(names).not.toContain("guardian_commit_result");
    expect(names).not.toContain("guardian_record_progress");
  });
});

describe("get_goal", () => {
  it("carries Codex's description and returns the user's goal with its done-when ids, status and usage", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "get_goal")!;
    expect(tool.description).toContain("Get the current goal for this thread, including status, budgets, token and elapsed-time usage, and remaining token budget.");
    const { goal } = (await callJson("get_goal")) as { goal: Record<string, unknown> };
    expect(goal.objective).toBe("Ship the CSV export feature");
    expect(goal.done_when).toEqual([{ id: "sc_1", text: "Users can export the report table as CSV" }]);
    expect(goal.constraints).toEqual(["No new dependencies"]);
    expect(goal.status).toBe("active");
    expect(goal.token_budget).toBeNull();
  });
});

describe("guardian_change_goal", () => {
  const contractFile = () => path.join(ws.root, ".cursor", "goal-guardian", "contract.json");
  let saved = "";
  beforeEach(async () => { saved = await fs.readFile(contractFile(), "utf8"); });
  afterEach(async () => { await fs.writeFile(contractFile(), saved); });

  it("the user's words become the goal, a list in them the done-when items, and items can be added", async () => {
    const result = await callJson("guardian_change_goal", {
      user_words: "Ship the CSV export feature, plus filters",
      add_criteria: ["Filter state is preserved in the export"],
    });
    expect(result.goal).toBe("Ship the CSV export feature, plus filters");
    expect((result.criteria as Array<{ id: string; text: string }>).map((c) => c.id)).toEqual(["sc_1"]);
    expect(((await callJson("get_goal")).goal as { objective: string }).objective).toBe("Ship the CSV export feature, plus filters");
    const listed = await callJson("guardian_change_goal", { user_words: "Ship it.\n- one thing\n- another thing" });
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
  const call = (args: Record<string, unknown>) => client.callTool({ name: "guardian_change_goal", arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

  it("refuses words the user never said, and accepts theirs", async () => {
    await fs.mkdir(path.dirname(prompts()), { recursive: true });
    await fs.writeFile(prompts(), JSON.stringify(["please make it JSON export instead"]));
    const before = String(((await callJson("get_goal")).goal as { objective: string }).objective);
    const invented = await call({ user_words: "make it smaller" });
    expect(invented.isError).toBe(true);
    expect(invented.content[0]!.text).toContain("only the user changes");
    expect(String(((await callJson("get_goal")).goal as { objective: string }).objective)).toBe(before);
    expect((await call({ add_criteria: ["a new item"] })).isError).toBeFalsy();
    expect((await call({ user_words: "make it JSON export instead" })).isError).toBeFalsy();
    expect(String(((await callJson("get_goal")).goal as { objective: string }).objective)).toBe("make it JSON export instead");
    await fs.rm(prompts());
  });
});

describe("the token budget", () => {
  it("is offered on guardian_change_goal and get_goal reports usage; without Codex's store installed a budget change says so", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "guardian_change_goal")!;
    expect((tool.inputSchema.properties as Record<string, { description: string }>).token_budget!.description).toContain("Only when the user explicitly asks for a token budget");
    const res = (await client.callTool({ name: "guardian_change_goal", arguments: { token_budget: 50000, user_words: "use at most 50000 tokens" } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("Codex's goal store isn't installed");
    const { goal } = (await callJson("get_goal")) as { goal: Record<string, unknown> };
    expect(goal).toMatchObject({ token_budget: null });
    expect(typeof goal.tokens_used).toBe("number");
  });
});

describe("update_goal", () => {
  it("carries Codex's description and statuses, plus Guardian's set_aside", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "update_goal")!;
    expect(tool.description!.startsWith("Guardian: report on the goal with this tool before you stop")).toBe(true);
    expect(tool.description).toContain("\n\nUpdate the existing goal.\nSet status to `paused` only at the user's explicit request to pause this goal, never on your own initiative.");
    expect(tool.description).toContain("Guardian adds status `set_aside`");
    const status = (tool.inputSchema.properties as Record<string, { enum: string[]; description: string }>).status!;
    expect(status.enum).toEqual(["complete", "blocked", "paused", "set_aside"]);
    expect(status.description).toContain("Set to `complete` only when the objective is achieved and no required work remains.");
  });

  it("answers at once with what doesn't hold, and records the claim", async () => {
    const answer = await callJson("update_goal", { status: "complete", proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }] });
    expect(answer.accepted).toBe(false);
    expect(JSON.stringify(answer.unproved)).toContain("no record of `make test`");
    expect(auditOfKind(await readAudit(ws.root), "goal.report").length).toBeGreaterThanOrEqual(1);
  });
});

describe("robustness", () => {
  it("rejects malformed arguments but stays alive for the next call", async () => {
    const outcome = await client
      .callTool({ name: "update_goal", arguments: { status: "teleport" } })
      .then((res) => res as { isError?: boolean })
      .catch(() => ({ isError: true }));
    expect(outcome.isError).toBe(true);
    const alive = (await callJson("get_goal")).goal as { objective: string };
    expect(alive.objective).toContain("CSV export");
  });
});

describe("DeepSeek Harness's own tools and command behind the MCP tools", () => {
  it("update_goal carries their description and parameters next to Codex's, and get_goal returns their answer too", async () => {
    const tools = (await client.listTools()).tools;
    const update = tools.find((t) => t.name === "update_goal")!;
    expect(update.description).toContain("DeepSeek Harness: Update the current goal.");
    const props = update.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(props.action!.enum).toEqual(["edit", "pause", "resume", "complete", "blocked"]);
    expect(props.goal_id!.description).toBe("DeepSeek Harness: Exact id returned by get_goal.");
    expect(props.blocked_reason!.description).toContain("Required only with action blocked");
    const got = await callJson("get_goal");
    expect(got.their).toMatchObject({ goal: { objective: "Ship the CSV export feature", phase: "active", maxGoalRounds: 256 } });
    // create_goal carries Codex's description, then DeepSeek's, side by side.
    const create = tools.find((t) => t.name === "create_goal")!.description!;
    expect(create.startsWith("Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.")).toBe(true);
    expect(create).toContain("DeepSeek Harness: Create a persisted goal that keeps this session working across automatic continuation rounds.");
  });

  it("a call in their shape reaches their tool, which answers by its own rules", async () => {
    // An unfinished goal exists: their create_goal refuses a second one.
    const second = (await client.callTool({ name: "create_goal", arguments: { objective: "Another goal entirely" } })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toContain("already exists");
    // Their resume of an active goal in this process's view: answered by their tool, not by Guardian.
    const resumed = (await client.callTool({ name: "update_goal", arguments: { action: "resume" } })) as { content: Array<{ text: string }> };
    expect(resumed.content[0]!.text).toMatch(/"phase":"active"|already active and armed|goal/);
  });

  it("goal_command is their /goal command, in its own words", async () => {
    const shown = (await client.callTool({ name: "goal_command", arguments: { input: "" } })) as { content: Array<{ text: string }> };
    expect(shown.content[0]!.text).toContain("Status: active\nObjective: Ship the CSV export feature\nRounds: 0/256");
    expect(shown.content[0]!.text).toContain("Commands: /goal edit <objective>");
  });
});
