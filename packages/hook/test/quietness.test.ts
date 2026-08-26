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

  it("nudge format: one sentence, prefixed, pointing at the panel", async () => {
    const w = await ws();
    const { response } = runHook(w.root, shellEvent("docker build -t darkmode-theme ."));
    const msg = String(response.userMessage);
    expect(msg).toMatch(/^Goal Guardian: /);
    expect(msg).toMatch(/\(see panel\)$/);
    expect(msg.length).toBeLessThan(160);
    expect(response.agentMessage).toBe(msg);
  });
});
