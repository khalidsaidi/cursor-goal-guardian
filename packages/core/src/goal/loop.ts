/**
 * The goal loop at the end of each turn: keep the agent going toward the full objective, certify
 * completion against evidence, record a real blocker, wrap up at the budget. The wording is prompts.ts;
 * the rounds, phases and versioned state are service.ts.
 */
import type { DoneCheckResult } from "../donecheck/evaluate.js";
import type { GoalSnapshot } from "../schema/audit.js";
import { GOAL_BLOCKED_WRAPUP, GOAL_BUDGET_LIMIT, GOAL_CONTINUATION, GOAL_OBJECTIVE_UPDATED, render } from "./prompts.js";
import { createGoal, editGoal, readGoal } from "./service.js";

/** The objective Guardian pursues: the declared goal and its "done when" list. */
export function objectiveFromContract(contract: { goal: string; successCriteria: Array<{ id: string; text: string }> }): string {
  const done = contract.successCriteria.map((c) => `- ${c.id}: ${c.text}`);
  return [contract.goal.trim(), ...(done.length ? ["Done when:", ...done] : [])].join("\n");
}

/**
 * Keep the goal in step with the contract: create it the first time, edit it when the user changed
 * the goal or its "done when" list (the next round then tells the agent the goal changed).
 */
export async function syncGoal(
  root: string,
  contract: { goal: string; successCriteria: Array<{ id: string; text: string }> },
  maxRounds: number,
): Promise<{ goal: GoalSnapshot | null; objectiveUpdated: boolean }> {
  if (!contract.goal.trim()) return { goal: await readGoal(root), objectiveUpdated: false };
  const objective = objectiveFromContract(contract);
  const current = await readGoal(root);
  if (!current || (current.phase === "complete" && current.objective !== objective)) {
    return { goal: await createGoal(root, objective, "user", maxRounds), objectiveUpdated: false };
  }
  if (current.objective !== objective) {
    return { goal: await editGoal(root, current.revision, { objective }, "user"), objectiveUpdated: true };
  }
  return { goal: current, objectiveUpdated: false };
}

/**
 * Guardian certifies completion only on evidence: an honest Done check where every "done when" item
 * is backed or stated (no gap, no waiver), nothing is left open, and the turn did not break the tests.
 */
export function certifiesComplete(result: DoneCheckResult, opts: { open: string[]; testsBroke: boolean; criteria: number }): boolean {
  if (result.verdict !== "pass" || opts.criteria === 0 || opts.open.length > 0 || opts.testsBroke) return false;
  const sc = result.lines.filter((l) => l.key.startsWith("sc_"));
  return sc.length >= opts.criteria && sc.every((l) => l.status === "backed" || l.status === "stated");
}

/** Why Guardian is sending the agent back this round, in one header plus the items. */
export function roundReason(kind: "open" | "claim" | "blocked", detail: string[], round: number, max: number): string {
  const head =
    kind === "open"
      ? `Goal Guardian — goal round ${round}/${max}: the goal is not done yet. These "done when" items are still open, and you hold them:`
      : kind === "claim"
        ? `Goal Guardian — goal round ${round}/${max}: you marked the goal complete, but Guardian could not verify it:`
        : `Goal Guardian — goal round ${round}/${max}: before you stop as blocked — is it really out of your reach? Only the user, a credential or an outside service count. Try the ways around it now; if the same obstacle is still there, end with \`## Blocked\` again and say what you tried.`;
  return [head, ...detail.map((d) => `- ${d}`)].join("\n");
}

/** The keep-going message: Guardian's reason, then the continuation (or goal-changed) prompt. */
export function goalContinuation(goal: GoalSnapshot, reason: string, objectiveUpdated: boolean): string {
  const vars = { objective: goal.objective, rounds_used: goal.roundsStarted, round_budget: goal.maxRounds, rounds_remaining: Math.max(0, goal.maxRounds - goal.roundsStarted) };
  return [reason, "", render(objectiveUpdated ? GOAL_OBJECTIVE_UPDATED : GOAL_CONTINUATION, vars), "", "End your reply with an updated `## Done check` (or `## Blocked`)."].join("\n");
}

/** At the round budget: hand off, no new work. */
export function goalBudgetLimit(goal: GoalSnapshot, secondsUsed: number): string {
  return render(GOAL_BUDGET_LIMIT, { objective: goal.objective, time_used_seconds: secondsUsed, rounds_used: goal.roundsStarted, round_budget: goal.maxRounds });
}

/** When Guardian stops the run as blocked (a stall, a confirmed blocker): one grounded last message. */
export function goalBlockedWrapup(goal: GoalSnapshot, reason: string): string {
  return render(GOAL_BLOCKED_WRAPUP, { objective: goal.objective, blocked_reason: reason });
}

/** Why a completion claim did not verify: what the check found missing, in the agent's terms. */
export function unverifiedReasons(result: DoneCheckResult, criteria: number): string[] {
  if (result.verdict !== "pass") return [`the done check did not hold up (${result.verdict})`];
  const sc = result.lines.filter((l) => l.key.startsWith("sc_"));
  const weak = sc.filter((l) => l.status !== "backed" && l.status !== "stated").map((l) => `${l.key}: ${l.status} — ${l.note}`);
  if (sc.length < criteria) weak.push(`${criteria - sc.length} "done when" item(s) have no line`);
  return weak.length ? weak : ["the evidence did not cover every \"done when\" item"];
}
