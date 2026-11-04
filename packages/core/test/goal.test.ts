import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  blockGoal, certifiesComplete, claimGoalComplete, clearGoal, completeGoal, createGoal, editGoal, getGuardianPaths, GoalError,
  goalArmed, objectiveFromContract, pauseGoal, readGoal, render, resumeGoal, startGoalRound, syncGoal, GOAL_CONTINUATION,
} from "../src/index.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function ws(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-goal-"));
  made.push(root);
  await fs.mkdir(getGuardianPaths(root).telemetryDir, { recursive: true });
  return root;
}

describe("the goal object", () => {
  it("is event-sourced: every change a new revision; stale revisions are rejected; clear ends it", async () => {
    const root = await ws();
    const g1 = await createGoal(root, "Ship CSV export", "user", 4);
    expect(g1).toMatchObject({ revision: 1, phase: "active", roundsStarted: 0, maxRounds: 4 });
    const g2 = await editGoal(root, 1, { objective: "Ship CSV and JSON export" }, "user");
    expect(g2.revision).toBe(2);
    await expect(pauseGoal(root, 1, "user")).rejects.toMatchObject({ code: "stale-revision" });
    const paused = await pauseGoal(root, 2, "user");
    expect(goalArmed(paused)).toBe(false);
    const resumed = await resumeGoal(root, paused.revision, "user");
    expect(resumed.phase).toBe("active");
    await expect(createGoal(root, "other", "user")).rejects.toBeInstanceOf(GoalError);
    await clearGoal(root, "user");
    expect(await readGoal(root)).toBeNull();
  });

  it("blocked keeps a code and message; resume clears it; a claim is not completion; Guardian completes", async () => {
    const root = await ws();
    const g = await createGoal(root, "x", "user");
    const b = await blockGoal(root, g.revision, { code: "needs-credential", message: "API key missing" }, "agent");
    expect(b).toMatchObject({ phase: "blocked", blockedReason: { code: "needs-credential" } });
    const r = await resumeGoal(root, b.revision, "user");
    expect(r.blockedReason).toBeUndefined();
    const c = await claimGoalComplete(root, r.revision, "agent");
    expect(c).toMatchObject({ phase: "active", claimedComplete: true });
    expect(await completeGoal(root)).toMatchObject({ phase: "complete", certified: true, claimedComplete: false });
  });

  it("rounds count against the budget; at the cap the goal is budget_limited; resume grants more", async () => {
    const root = await ws();
    await createGoal(root, "x", "user", 2);
    expect((await startGoalRound(root)).admitted).toBe(true);
    expect((await startGoalRound(root)).admitted).toBe(true);
    const third = await startGoalRound(root);
    expect(third).toMatchObject({ admitted: false, goal: { phase: "budget_limited", roundsStarted: 2 } });
    const more = await resumeGoal(root, third.goal.revision, "user");
    expect(more.maxRounds).toBeGreaterThan(2);
    expect((await startGoalRound(root)).admitted).toBe(true);
  });

  it("follows the contract: created from it, edited when the goal or its done-when list changes", async () => {
    const root = await ws();
    const contract = { goal: "Ship export", successCriteria: [{ id: "sc_1", text: "CSV works" }] };
    expect(objectiveFromContract(contract)).toBe("Ship export\nDone when:\n- sc_1: CSV works");
    const a = await syncGoal(root, contract, 50);
    expect(a).toMatchObject({ objectiveUpdated: false, goal: { revision: 1 } });
    expect((await syncGoal(root, contract, 50)).goal!.revision).toBe(1);
    const b = await syncGoal(root, { ...contract, successCriteria: [...contract.successCriteria, { id: "sc_2", text: "JSON works" }] }, 50);
    expect(b).toMatchObject({ objectiveUpdated: true, goal: { revision: 2 } });
    expect((await syncGoal(root, { goal: "", successCriteria: [] }, 50)).goal!.revision).toBe(2);
  });

  it("certifies only on evidence: every done-when item backed or stated, nothing open, tests intact", () => {
    const ok = { verdict: "pass" as const, required: true, problems: [], lines: [{ key: "1", status: "backed" as const, note: "" }, { key: "sc_1", status: "backed" as const, note: "" }] };
    const base = { open: [], testsBroke: false, reviewOpen: false, criteria: 1 };
    expect(certifiesComplete(ok, base)).toBe(true);
    expect(certifiesComplete(ok, { ...base, testsBroke: true })).toBe(false);
    expect(certifiesComplete(ok, { ...base, criteria: 2 })).toBe(false);
    expect(certifiesComplete({ ...ok, lines: [{ key: "sc_1", status: "gap" as const, note: "" }] }, base)).toBe(false);
    expect(certifiesComplete({ ...ok, lines: [{ key: "sc_1", status: "waived" as const, note: "" }] }, base)).toBe(false);
    expect(certifiesComplete({ ...ok, verdict: "fail" }, base)).toBe(false);
  });

  it("renders the continuation with the goal escaped and the round budget filled in", () => {
    const text = render(GOAL_CONTINUATION, { objective: "fix <script> & ship", rounds_used: 2, round_budget: 50, rounds_remaining: 48 });
    expect(text).toContain("fix &lt;script&gt; &amp; ship");
    expect(text).toContain("Rounds: 2 of 50 used, 48 left.");
    expect(() => render(GOAL_CONTINUATION, { objective: "x" })).toThrow(/missing rounds_used/);
  });
});
