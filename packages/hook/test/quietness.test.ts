import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { makeWorkspace, readAudit, auditOfKind, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { ensureBuilt, runHook, shellEvent, readEvent } from "./helpers.js";

beforeAll(ensureBuilt, 30000);

const workspaces: TestWorkspace[] = [];
async function ws(config?: unknown): Promise<TestWorkspace> {
  const w = await makeWorkspace({
    goal: "Expense tracker app",
    successCriteria: ["expense form works"],
    tasks: [{ id: "t1", title: "Build the expense form component", status: "doing" }],
    ...(config !== undefined ? { config } : {}),
  });
  workspaces.push(w);
  return w;
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.cleanup()));
});

const nudges = (runs: ReturnType<typeof runHook>[]): number =>
  runs.filter((r) => r.response.userMessage !== undefined).length;

describe("quietness contract", () => {
  it("balanced: a burst of same-episode drift actions earns exactly ONE nudge; every action is still recorded", async () => {
    const w = await ws();
    const runs = [
      runHook(w.root, shellEvent("docker build -t darkmode-theme .")),
      runHook(w.root, shellEvent("docker push darkmode-theme:latest")),
      runHook(w.root, shellEvent("touch darkmode-theme.config")),
      runHook(w.root, readEvent("src/darkmode/theme.css")),
    ];
    for (const r of runs) expect(r.response.permission).toBe("allow");
    expect(nudges(runs)).toBe(1);
    expect(runs[0]?.response.userMessage).toBeDefined();

    const drifts = auditOfKind(await readAudit(w.root), "drift.lexical");
    expect(drifts).toHaveLength(4);
    expect(new Set(drifts.map((d) => d.episodeId)).size).toBe(1);
  });

  it("quiet: zero injected messages across drift, high-risk, and no-task events; the tape still fills", async () => {
    const w = await makeWorkspace({
      goal: "Expense tracker app",
      successCriteria: ["expense form works"],
      tasks: [{ id: "t1", title: "Build the expense form component", status: "todo" }],
      config: { notify: "quiet" },
    });
    workspaces.push(w);
    const runs = [
      runHook(w.root, shellEvent("docker build -t darkmode-theme .")),
      runHook(w.root, shellEvent("rm -rf /")),
      runHook(w.root, readEvent(".env")),
      runHook(w.root, shellEvent("cargo build")),
    ];
    for (const r of runs) {
      expect(r.response).toEqual({ continue: true, permission: "allow" });
    }
    const records = await readAudit(w.root);
    expect(auditOfKind(records, "policy.advisory").length).toBeGreaterThanOrEqual(2);
    expect(auditOfKind(records, "hook.event")).toHaveLength(4);
  });

  it("vocal: every drift action nudges", async () => {
    const w = await ws({ notify: "vocal" });
    const runs = [
      runHook(w.root, shellEvent("docker build -t darkmode-theme .")),
      runHook(w.root, shellEvent("docker push darkmode-theme:latest")),
      runHook(w.root, shellEvent("touch darkmode-theme.config")),
    ];
    expect(nudges(runs)).toBe(3);
  });

  it("an unrelated second topic starts a new episode and earns its own nudge", async () => {
    const w = await ws();
    const first = runHook(w.root, shellEvent("docker build -t darkmode-theme ."));
    const same = runHook(w.root, shellEvent("docker push darkmode-theme:latest"));
    const unrelated = runHook(w.root, shellEvent("psql billing-invoices --migrate"));
    expect(first.response.userMessage).toBeDefined();
    expect(same.response.userMessage).toBeUndefined();
    expect(unrelated.response.userMessage).toBeDefined();
  });

  it("escalation off (default): confirmed drift still only ever allows", async () => {
    const w = await ws();
    runHook(w.root, shellEvent("docker build -t darkmode-theme ."));
    const drifts = auditOfKind(await readAudit(w.root), "drift.lexical");
    const { writeJsonAtomic } = await import("@goal-guardian/core");
    await writeJsonAtomic(w.paths.verdicts, {
      schemaVersion: 2,
      entries: { [drifts[0]!.driftId]: { verdict: "confirmed", judge: "cursor-agent", confidence: 0.9, rationale: "r", ts: new Date().toISOString() } },
    });
    const next = runHook(w.root, shellEvent("docker push darkmode-theme:latest"));
    expect(next.response.permission).toBe("allow");
  });

  it("escalation 'ask': drift confirmed by the judge that continues after its nudge hands the call to the human", async () => {
    const w = await ws({ advisories: { escalateConfirmedDrift: "ask" } });
    const first = runHook(w.root, shellEvent("docker build -t darkmode-theme ."));
    expect(first.response.permission).toBe("allow"); // first contact: nudge only
    expect(first.response.userMessage).toBeDefined();

    const drifts = auditOfKind(await readAudit(w.root), "drift.lexical");
    const { writeJsonAtomic } = await import("@goal-guardian/core");
    await writeJsonAtomic(w.paths.verdicts, {
      schemaVersion: 2,
      entries: { [drifts[0]!.driftId]: { verdict: "confirmed", judge: "cursor-agent", confidence: 0.9, rationale: "r", ts: new Date().toISOString() } },
    });

    const continued = runHook(w.root, shellEvent("docker push darkmode-theme:latest"));
    expect(continued.response.permission).toBe("ask");
    expect(continued.response.userMessage).toMatch(/confirmed off-goal work/);

    // Without a confirmed verdict, the same continuation stays a silent allow.
    const w2 = await ws({ advisories: { escalateConfirmedDrift: "ask" } });
    runHook(w2.root, shellEvent("docker build -t darkmode-theme ."));
    const unconfirmed = runHook(w2.root, shellEvent("docker push darkmode-theme:latest"));
    expect(unconfirmed.response.permission).toBe("allow");
    expect(unconfirmed.response.userMessage).toBeUndefined();
  });

  it("the raw tape records shell/mcp/edit actions but not reads", async () => {
    const w = await ws();
    runHook(w.root, shellEvent("pnpm test"));
    runHook(w.root, { hook_event_name: "beforeMCPExecution", mcp_server_name: "some-server", tool_name: "do_thing" });
    runHook(w.root, { hook_event_name: "afterFileEdit", file_path: "src/expense-form.tsx" });
    runHook(w.root, readEvent("src/expense-form.tsx"));
    const observed = auditOfKind(await readAudit(w.root), "action.observed");
    expect(observed.map((o) => o.actionType)).toEqual(["shell", "mcp", "edit"]);
    expect(observed[1]?.actionValue).toBe("some-server/do_thing");
  });

  it("nudge format: calm one-liner for the human, chat-steering instruction for the agent", async () => {
    const w = await ws();
    const { response } = runHook(w.root, shellEvent("docker build -t darkmode-theme ."));
    const userMsg = String(response.userMessage);
    expect(userMsg).toMatch(/^Goal Guardian: /);
    expect(userMsg.length).toBeLessThan(160);
    const agentMsg = String(response.agentMessage);
    expect(agentMsg).toMatch(/^Goal Guardian: /);
    // The steering happens in the conversation: the agent is told to offer
    // the user the choice and put the outcome on the record.
    expect(agentMsg).toMatch(/give the user the choice in chat/);
    expect(agentMsg).toMatch(/guardian_declare_intent/);
    expect(agentMsg).toMatch(/Don't proceed silently/);
  });
});
