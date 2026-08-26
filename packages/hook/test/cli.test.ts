import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { makeWorkspace, readAudit, auditOfKind, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { ensureBuilt, runHook, shellEvent, readEvent } from "./helpers.js";

beforeAll(ensureBuilt, 30000);

const workspaces: TestWorkspace[] = [];
async function ws(opts: Parameters<typeof makeWorkspace>[0] = {}): Promise<TestWorkspace> {
  const w = await makeWorkspace({
    goal: "Expense tracker app",
    successCriteria: ["expense form works"],
    tasks: [{ id: "t1", title: "Build the expense form component", status: "doing" }],
    ...opts,
  });
  workspaces.push(w);
  return w;
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.cleanup()));
});

describe("hook behavior (built bundle)", () => {
  it("high-risk shell: allow + one calm alert nudge + policy.advisory record", async () => {
    const w = await ws();
    const { status, response } = runHook(w.root, shellEvent("rm -rf /"));
    expect(status).toBe(0);
    expect(response.permission).toBe("allow");
    expect(response.userMessage).toMatch(/^Goal Guardian: heads up/);
    expect(response.userMessage).toMatch(/high-risk/);
    const advisories = auditOfKind(await readAudit(w.root), "policy.advisory");
    expect(advisories[0]).toMatchObject({ severity: "alert", actionValue: "rm -rf /" });
  });

  it("caution commands are recorded silently — no message injected", async () => {
    const w = await ws();
    // In-scope vocabulary ("expense") so only the caution rule fires, not drift.
    const { response } = runHook(w.root, shellEvent("git reset --hard expense-form-wip"));
    expect(response.permission).toBe("allow");
    expect(response.userMessage).toBeUndefined();
    expect(response.agentMessage).toBeUndefined();
    const advisories = auditOfKind(await readAudit(w.root), "policy.advisory");
    expect(advisories[0]).toMatchObject({ severity: "caution", rule: "git reset --hard*" });
  });

  it("off-scope shell: allow + drift nudge + drift.lexical record with episode id", async () => {
    const w = await ws();
    const { response } = runHook(w.root, shellEvent("docker build -t darkmode-theme ."));
    expect(response.permission).toBe("allow");
    expect(response.userMessage).toMatch(/outside "Build the expense form component"/);
    const drifts = auditOfKind(await readAudit(w.root), "drift.lexical");
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.driftId).toMatch(/^drift_/);
    expect(drifts[0]?.episodeId).toMatch(/^ep_/);
    expect(drifts[0]?.activeTaskId).toBe("t1");
  });

  it("in-scope reads pass silently with no drift record", async () => {
    const w = await ws();
    const { response } = runHook(w.root, readEvent("src/expense-form.tsx"));
    expect(response).toEqual({ continue: true, permission: "allow" });
    expect(auditOfKind(await readAudit(w.root), "drift.lexical")).toHaveLength(0);
  });

  it("sensitive file reads: allow + alert nudge", async () => {
    const w = await ws();
    const { response } = runHook(w.root, readEvent(".env"));
    expect(response.permission).toBe("allow");
    expect(response.userMessage).toMatch(/high-risk|secrets/i);
  });

  it("no active task: one reminder, then silence (episode-governed)", async () => {
    const w = await ws({ tasks: [{ id: "t1", title: "Build the expense form component", status: "todo" }] });
    const first = runHook(w.root, shellEvent("cargo build"));
    expect(first.response.userMessage).toMatch(/no task is active/);
    const second = runHook(w.root, shellEvent("cargo build --release"));
    expect(second.response.userMessage).toBeUndefined();
  });

  it("goal-guardian MCP calls pass silently (both server-name payload keys)", async () => {
    const w = await ws();
    const legacy = runHook(w.root, { hook_event_name: "beforeMCPExecution", server: "goal-guardian", tool_name: "guardian_get_status" });
    expect(legacy.response).toEqual({ continue: true, permission: "allow" });
    const current = runHook(w.root, {
      hook_event_name: "beforeMCPExecution",
      mcp_server_name: "goal-guardian",
      tool_name: "guardian_declare_intent",
      conversation_id: "conv-1",
      generation_id: "gen-1",
    });
    expect(current.response).toEqual({ continue: true, permission: "allow" });
    const records = await readAudit(w.root);
    expect(auditOfKind(records, "drift.lexical")).toHaveLength(0);
    const events = auditOfKind(records, "hook.event");
    expect(events[events.length - 1]).toMatchObject({ conversationId: "conv-1", generationId: "gen-1" });
  });

  it("afterFileEdit records the event and drift without breaking anything", async () => {
    const w = await ws();
    const { response } = runHook(w.root, { hook_event_name: "afterFileEdit", file_path: "src/theme/dark-palette.css" });
    expect(response.permission).toBe("allow");
    const records = await readAudit(w.root);
    expect(auditOfKind(records, "hook.event")[0]?.event).toBe("afterFileEdit");
    expect(auditOfKind(records, "drift.lexical")).toHaveLength(1);
  });

  it("tab variants normalize to their base events", async () => {
    const w = await ws();
    runHook(w.root, { hook_event_name: "beforeTabFileRead", file_path: "src/expense-form.tsx" });
    const events = auditOfKind(await readAudit(w.root), "hook.event");
    expect(events[0]?.event).toBe("beforeReadFile");
  });

  it("unknown events get a bare allow", async () => {
    const w = await ws();
    const { status, response } = runHook(w.root, { hook_event_name: "stop" });
    expect(status).toBe(0);
    expect(response).toEqual({ continue: true, permission: "allow" });
  });
});
