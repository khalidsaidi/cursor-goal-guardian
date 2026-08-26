import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeWorkspace, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { appendAudit, nowIso, type DriftJudge } from "@goal-guardian/core";
import { recorded, responses, makeContext } from "./mocks/vscode.js";
import { RescoreService } from "../src/rescoreService.js";

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => recorded.reset());
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

function stubJudge(): DriftJudge & { calls: number } {
  const judge = {
    id: "stub",
    calls: 0,
    isAvailable: async () => ({ ok: true }) as const,
    judge: async (candidates: Parameters<DriftJudge["judge"]>[0]) => {
      judge.calls += 1;
      return candidates.map((c) => ({ driftId: c.driftId, verdict: "dismissed" as const, confidence: 0.5, rationale: "" }));
    },
  };
  return judge;
}

async function workspaceWithDrift(): Promise<TestWorkspace> {
  const w = await makeWorkspace();
  cleanups.push(() => w.cleanup());
  await appendAudit(w.root, {
    ts: nowIso(),
    kind: "drift.lexical",
    driftId: "d1",
    episodeId: "ep1",
    actionType: "shell",
    actionValue: "docker build .",
    activeTaskId: "t1",
    activeTaskTitle: "Task 1",
    taskTerms: ["task"],
    actionTerms: ["docker"],
    confidence: "low",
  });
  return w;
}

describe("rescore consent gating: no judge call without a yes", () => {
  it("manual rescore with the prompt declined never touches the judge", async () => {
    const w = await workspaceWithDrift();
    const judge = stubJudge();
    const service = new RescoreService(makeContext() as never, w.root, judge);
    responses.information = undefined; // user hits Esc
    await service.rescoreNow();
    expect(judge.calls).toBe(0);
    expect(service.isConsented()).toBe(false);
  });

  it("'Just this once' runs one pass without granting standing consent", async () => {
    const w = await workspaceWithDrift();
    const judge = stubJudge();
    const service = new RescoreService(makeContext() as never, w.root, judge);
    responses.information = "Just this once";
    await service.rescoreNow();
    expect(judge.calls).toBe(1);
    expect(service.isConsented()).toBe(false);
  });

  it("'Enable AI review' grants standing consent and runs", async () => {
    const w = await workspaceWithDrift();
    const judge = stubJudge();
    const service = new RescoreService(makeContext() as never, w.root, judge);
    responses.information = "Enable AI review";
    await service.rescoreNow();
    expect(judge.calls).toBe(1);
    expect(service.isConsented()).toBe(true);
    // Second manual run: no prompt needed, still works.
    await service.rescoreNow();
    expect(recorded.windowMessages).toHaveLength(1);
  });
});
