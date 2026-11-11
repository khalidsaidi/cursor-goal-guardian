import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { makeWorkspace, readAudit, auditOfKind, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { ensureBuilt, runHook, shellEvent, readEvent } from "./helpers.js";

beforeAll(ensureBuilt, 30000);

const workspaces: TestWorkspace[] = [];
async function ws(opts: Parameters<typeof makeWorkspace>[0] = {}): Promise<TestWorkspace> {
  const w = await makeWorkspace({
    goal: "Expense tracker app",
    successCriteria: ["expense form works"],
    ...opts,
  });
  workspaces.push(w);
  return w;
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.cleanup()));
});

describe("hook behavior (built bundle)", () => {


  it("a risky command is recorded with nothing said: safety isn't Guardian's job", async () => {
    const w = await ws();
    const { status, response } = runHook(w.root, shellEvent("rm -rf /"));
    expect(status).toBe(0);
    expect(response).toEqual({ continue: true, permission: "allow" });
    const records = await readAudit(w.root);
    expect(auditOfKind(records, "action.observed")[0]).toMatchObject({ actionValue: "rm -rf /" });
    expect(auditOfKind(records, "policy.advisory")).toHaveLength(0);
  });

  it("reads from a workspace wired earlier pass with nothing recorded", async () => {
    const w = await ws();
    const { response } = runHook(w.root, readEvent(".env"));
    expect(response).toEqual({});
    expect(await readAudit(w.root)).toHaveLength(0);
  });


  it("goal-guardian MCP calls pass silently (both server-name payload keys)", async () => {
    const w = await ws();
    const legacy = runHook(w.root, { hook_event_name: "beforeMCPExecution", server: "goal-guardian", tool_name: "get_goal" });
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
    const events = auditOfKind(records, "hook.event");
    expect(events[events.length - 1]).toMatchObject({ conversationId: "conv-1", generationId: "gen-1" });
  });

  it("afterFileEdit records the event and the edit without breaking anything", async () => {
    const w = await ws();
    const { response } = runHook(w.root, { hook_event_name: "afterFileEdit", file_path: "src/theme/dark-palette.css" });
    expect(response.permission).toBe("allow");
    const records = await readAudit(w.root);
    expect(auditOfKind(records, "hook.event")[0]?.event).toBe("afterFileEdit");
    expect(auditOfKind(records, "action.observed")[0]).toMatchObject({ actionType: "edit" });
  });

  it("Tab completions are the person typing: they aren't recorded as agent work", async () => {
    const w = await ws();
    runHook(w.root, { hook_event_name: "beforeTabFileRead", file_path: "src/expense-form.tsx" });
    runHook(w.root, { hook_event_name: "afterTabFileEdit", file_path: "src/expense-form.tsx" });
    const records = await readAudit(w.root);
    expect(auditOfKind(records, "action.observed")).toEqual([]);
    expect(auditOfKind(records, "hook.event")).toEqual([]);
  });

  it("unknown events get a bare allow", async () => {
    const w = await ws();
    const { status, response } = runHook(w.root, { hook_event_name: "somethingNew" });
    expect(status).toBe(0);
    expect(response).toEqual({ continue: true, permission: "allow" });
  });
});
