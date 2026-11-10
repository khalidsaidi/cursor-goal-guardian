import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { makeWorkspace, readAudit, auditOfKind, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { ensureBuilt, runHook, shellEvent, readEvent } from "./helpers.js";

beforeAll(ensureBuilt, 30000);

const workspaces: TestWorkspace[] = [];
async function ws(config?: unknown): Promise<TestWorkspace> {
  const w = await makeWorkspace({
    goal: "Expense tracker app",
    successCriteria: ["expense form works"],
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
  it("work is recorded with no message, whatever its words", async () => {
    const w = await ws();
    const runs = [
      runHook(w.root, shellEvent("docker build -t darkmode-theme .")),
      runHook(w.root, shellEvent("touch darkmode-theme.config")),
    ];
    for (const r of runs) expect(r.response).toEqual({ continue: true, permission: "allow" });
    expect(nudges(runs)).toBe(0);
    expect(auditOfKind(await readAudit(w.root), "hook.event")).toHaveLength(2);
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

});
