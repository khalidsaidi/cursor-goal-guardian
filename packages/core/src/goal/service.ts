/**
 * The goal service: one current goal per workspace, event-sourced on Guardian's tape.
 *
 * Every accepted change appends a `goal.change` event with the full new snapshot and a higher revision;
 * `clear` appends a tombstone; the current goal is the fold of those events. Callers change one exact
 * revision, so a stale view gets an error instead of overwriting newer state. Phases: active, paused,
 * blocked (with a stable code and a message), complete, budget_limited.
 *
 * Guardian's addition: `complete` is two-step. The agent may only CLAIM completion; the goal becomes
 * complete when Guardian's own check certifies it (every "done when" item backed, nothing open, tests
 * intact). The working agent never grades itself.
 */
import { appendAudit, readAuditTail } from "../audit/log.js";
import { newId, nowIso } from "../clock.js";
import type { AuditRecord, GoalChangeRecord, GoalPhase, GoalSnapshot } from "../schema/audit.js";

export const DEFAULT_MAX_GOAL_ROUNDS = 50;

export class GoalError extends Error {
  constructor(
    message: string,
    readonly code: "stale-revision" | "no-goal" | "invalid-transition" | "round-limit",
  ) {
    super(message);
  }
}

type Actor = GoalChangeRecord["actor"];

/** The current goal: the fold of `goal.change` events (latest snapshot; a clear tombstone ends it). */
export function currentGoal(records: AuditRecord[]): GoalSnapshot | null {
  let goal: GoalSnapshot | null = null;
  for (const r of records) {
    if (r.kind !== "goal.change") continue;
    if (r.operation === "clear") {
      if (goal && r.cleared?.id === goal.id) goal = null;
      continue;
    }
    if (r.goal && (!goal || r.goal.id !== goal.id || r.goal.revision > goal.revision)) goal = r.goal;
  }
  return goal;
}

export async function readGoal(root: string): Promise<GoalSnapshot | null> {
  return currentGoal(await readAuditTail(root, 20_000));
}

async function commit(root: string, operation: GoalChangeRecord["operation"], actor: Actor, goal: GoalSnapshot): Promise<GoalSnapshot> {
  await appendAudit(root, { ts: goal.updatedAt, kind: "goal.change", operation, actor, goal });
  return goal;
}

function expect(current: GoalSnapshot | null, revision: number | undefined): GoalSnapshot {
  if (!current) throw new GoalError("no goal is set", "no-goal");
  if (revision !== undefined && revision !== current.revision) {
    throw new GoalError(`stale goal revision ${revision}: current is ${current.revision} — read the goal again`, "stale-revision");
  }
  return current;
}

function next(g: GoalSnapshot, patch: Partial<GoalSnapshot>): GoalSnapshot {
  const out: GoalSnapshot = { ...g, ...patch, revision: g.revision + 1, updatedAt: nowIso() };
  if (out.phase !== "blocked") delete out.blockedReason;
  if (out.phase !== "complete") delete out.certified;
  return out;
}

/** Create (and arm) a goal. A completed or cleared goal may be replaced; an unfinished one must be cleared first. */
export async function createGoal(root: string, objective: string, actor: Actor, maxRounds = DEFAULT_MAX_GOAL_ROUNDS): Promise<GoalSnapshot> {
  const current = await readGoal(root);
  if (current && current.phase !== "complete") throw new GoalError(`a goal is already ${current.phase}; edit, resume, or clear it first`, "invalid-transition");
  const ts = nowIso();
  return commit(root, "create", actor, { id: newId("goal"), revision: 1, objective, phase: "active", maxRounds, roundsStarted: 0, createdAt: ts, updatedAt: ts });
}

/** Edit the objective and/or round cap without changing phase. */
export async function editGoal(root: string, revision: number | undefined, patch: { objective?: string; maxRounds?: number }, actor: Actor): Promise<GoalSnapshot> {
  const g = expect(await readGoal(root), revision);
  return commit(root, "edit", actor, next(g, { ...(patch.objective !== undefined ? { objective: patch.objective } : {}), ...(patch.maxRounds !== undefined ? { maxRounds: patch.maxRounds } : {}) }));
}

export async function pauseGoal(root: string, revision: number | undefined, actor: Actor): Promise<GoalSnapshot> {
  const g = expect(await readGoal(root), revision);
  if (g.phase !== "active") throw new GoalError(`only an active goal can be paused (it is ${g.phase})`, "invalid-transition");
  return commit(root, "pause", actor, next(g, { phase: "paused" }));
}

/** Resume a stopped goal while the round cap has capacity; clears any blocker. */
export async function resumeGoal(root: string, revision: number | undefined, actor: Actor): Promise<GoalSnapshot> {
  const g = expect(await readGoal(root), revision);
  if (g.phase === "active") return g;
  if (g.phase === "complete") throw new GoalError("the goal is complete; create a new one", "invalid-transition");
  const maxRounds = g.roundsStarted >= g.maxRounds ? g.roundsStarted + Math.max(5, Math.ceil(g.maxRounds / 2)) : g.maxRounds;
  return commit(root, "resume", actor, next(g, { phase: "active", maxRounds, claimedComplete: false }));
}

export async function blockGoal(root: string, revision: number | undefined, reason: { code: string; message: string }, actor: Actor): Promise<GoalSnapshot> {
  const g = expect(await readGoal(root), revision);
  return commit(root, "block", actor, next(g, { phase: "blocked", blockedReason: reason }));
}

/** The agent says it is done. Recorded as a claim; only Guardian's check makes it complete. */
export async function claimGoalComplete(root: string, revision: number | undefined, actor: Actor): Promise<GoalSnapshot> {
  const g = expect(await readGoal(root), revision);
  return commit(root, "claim", actor, next(g, { claimedComplete: true }));
}

/** Guardian certified completion against evidence. */
export async function completeGoal(root: string, actor: Actor = "guardian"): Promise<GoalSnapshot> {
  const g = expect(await readGoal(root), undefined);
  return commit(root, "complete", actor, next(g, { phase: "complete", certified: true, claimedComplete: false }));
}

/** One automatic keep-going round admitted; at the cap the goal becomes budget_limited instead. */
export async function startGoalRound(root: string): Promise<{ goal: GoalSnapshot; admitted: boolean }> {
  const g = expect(await readGoal(root), undefined);
  if (g.roundsStarted >= g.maxRounds) {
    const limited = g.phase === "budget_limited" ? g : await commit(root, "budget", "guardian", next(g, { phase: "budget_limited" }));
    return { goal: limited, admitted: false };
  }
  return { goal: await commit(root, "round", "guardian", next(g, { roundsStarted: g.roundsStarted + 1, claimedComplete: false })), admitted: true };
}

export async function clearGoal(root: string, actor: Actor): Promise<void> {
  const g = await readGoal(root);
  if (!g) return;
  await appendAudit(root, { ts: nowIso(), kind: "goal.change", operation: "clear", actor, cleared: { id: g.id, revision: g.revision } });
}

/** Whether automatic continuation may run: the goal exists and is active. */
export function goalArmed(g: GoalSnapshot | null): g is GoalSnapshot & { phase: "active" } {
  return g !== null && g.phase === "active";
}

export type { GoalPhase, GoalSnapshot };
