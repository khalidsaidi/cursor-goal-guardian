/** Work already observed on this goal, derived from existing records rather than another goal store. */
import { readGoalRecords } from "../audit/log.js";
import { readContractSafe } from "../safeReaders.js";
import type { Contract } from "../schema/contract.js";
import type { AuditRecord, GoalReviewRecord } from "../schema/audit.js";
import { goalHash } from "./loop.js";
import { objectionEntries, REVIEW_POLICY, type ReviewUserFeedback } from "./review.js";
import { verificationState } from "./verificationState.js";
import { readShellOutputs } from "./record.js";

/** Identical words can start a new goal: old receipts must not become its progress. */
export function currentGoalRecords(records: AuditRecord[], hash: string): AuditRecord[] {
  let start = 0;
  let sawEngineGoal = false;
  let ended = false;
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i]!;
    const event = r.kind === "goal.engine" ? r.event as { type?: string; data?: { operation?: string } } | undefined : undefined;
    if (r.kind === "goal.set" && r.goalHash === hash) { start = i; sawEngineGoal = false; ended = false; }
    if (r.kind === "goal.end" && r.goalHash === hash && ["proved", "unchecked"].includes(r.outcome)) ended = true;
    if (event?.type === "goal/change") {
      // A legacy/panel goal can be reviewed before DeepSeek is first materialized at completion.
      // That initial create belongs to the same work; a replacement after an engine goal or close does not.
      if (event.data?.operation === "create" && (sawEngineGoal || ended)) { start = i; ended = false; }
      sawEngineGoal = true;
    }
  }
  return records.slice(start);
}

/** Use explicit feedback now as well as saving it for future RRSI search. */
export function goalReviewFeedback(records: AuditRecord[], hash: string): ReviewUserFeedback[] {
  const current = currentGoalRecords(records,hash);
  const reviews = current.filter((r): r is GoalReviewRecord => r.kind === "goal.review" && r.goalHash === hash && Boolean(r.id)).slice(-3);
  const latest = new Map<string, {reviewId:string; index:number; label:"right"|"wrong"; userWords?:string}>();
  for (const r of current) {
    if (r.kind !== "review.feedback" || r.label === "missed" || !reviews.some(review=>review.id === r.reviewId)) continue;
    const key = `${r.reviewId}/${r.index}`;
    latest.delete(key); // A changed judgment belongs among the most recent feedback, too.
    latest.set(key,{reviewId:r.reviewId,index:r.index,label:r.label,...(r.userWords ? {userWords:r.userWords} : {})});
  }
  return [...latest.values()].slice(-8).flatMap(f => {
    const review = reviews.find(r=>r.id === f.reviewId)!;
    const entry = objectionEntries(review).find(e=>e.index === f.index);
    return entry ? [{finding:entry.line,judgment:f.label,...(f.userWords ? {userWords:f.userWords} : {})}] : [];
  });
}

export async function goalWorkContext(root: string, contract?: Contract, records?: AuditRecord[]) {
  const goal = contract ?? await readContractSafe(root);
  const hash = goalHash(goal);
  const current = currentGoalRecords(records ?? await readGoalRecords(root), hash);
  const review = [...current].reverse().find((r): r is GoalReviewRecord => r.kind === "goal.review" && r.goalHash === hash);
  const state = review ? verificationState(root) : null;
  const feedback = current.filter(r => r.kind === "review.feedback" && r.reviewId === review?.id);
  const latestFeedback = new Map(feedback.flatMap(r => r.kind === "review.feedback" ? [[r.index, r.label] as const] : []));
  const rejected = new Set([...latestFeedback].filter(([,label]) => label === "wrong").map(([index]) => index));
  const corrected = feedback.some(r => r.kind === "review.feedback" && (r.label === "wrong" || r.label === "missed"));
  const unchanged = Boolean(review && state && review.tree === state && review.policy === REVIEW_POLICY);
  const findings = review ? objectionEntries(review).filter(e => !rejected.has(e.index)).map(e => e.line) : [];
  const end = [...current].reverse().find(r => r.kind === "goal.end" && r.goalHash === hash);
  const verified = end?.kind === "goal.end" && end.outcome === "proved" && review?.ran && !review.unanswered?.length && !findings.length && unchanged && !corrected && end.tree === state ? end.verifiedItems ?? [] : [];
  const unavailable = review ? [!review.ran ? review.reason ?? "Project review did not finish" : null, ...(review.unanswered ?? []).map(id => `No clear verdict for ${id}`), review.evaluator && !review.evaluator.ran ? review.evaluator.reason ?? "Extra evaluation did not finish" : null].filter((s): s is string => Boolean(s)) : [];
  const since = current[0]?.ts;
  const commands = (await readShellOutputs(root)).filter(o => !since || Date.parse(o.startedAt) >= Date.parse(since)).slice(-4).map(o => ({ command: o.command, failed: o.failed === true, recorded_at: o.ts }));
  return {
    verified_items: verified,
    last_review: review ? {
      id: review.id ?? null, recorded_at: review.ts, project_unchanged: unchanged, feedback_requires_recheck: corrected,
      items: review.verdicts ?? [], checks: review.checks ?? [], findings,
      feedback_targets: objectionEntries(review).map(e=>({index:e.index,source:e.source,finding:e.line})),
      unavailable,
    } : null,
    recorded_commands: commands,
    next_steps: corrected ? ["Use the user's correction; recheck the affected work without repeating a rejected objection.", ...findings, ...unavailable.map(s => `Finish the relevant check: ${s}`)]
      : findings.length ? [unchanged ? "Address the concrete findings below within the user's current request." : "Inspect changes since the last review and recheck whether its findings still apply.", ...findings, ...unavailable.map(s => `Finish the relevant check: ${s}`)]
      : unavailable.length ? unavailable.map(s => `Finish the relevant check: ${s}`)
      : verified.length ? ["Relevant completion checks already passed on this project state. Do not repeat them merely to restate the result."]
      : ["Continue the requested work from the current project. Reuse relevant recorded checks while their inputs remain unchanged."],
    guidance: "These are recorded observations, not new requirements or a substitute for the user's latest request. Old findings may be stale after edits. Do not redo completed work or rerun passing checks merely to fill in a report.",
  };
}

export async function goalWorkMessage(root: string, contract?: Contract, records?: AuditRecord[]): Promise<string[]> {
  const work = await goalWorkContext(root, contract, records);
  if (!work.last_review && !work.recorded_commands.length) return [];
  const lines = ["Work carried forward from this goal:", work.last_review ? `Last review: ${work.last_review.project_unchanged ? "same project snapshot" : "project changed; findings need rechecking"}${work.last_review.feedback_requires_recheck ? "; user corrected this review" : ""}.` : "No independent review on this goal yet.",
    ...work.next_steps.slice(0, 5),
    ...(work.last_review?.items ?? []).filter(i => i.verdict === "holds").slice(0,3).map(i => `Previously checked item ${i.id}: ${i.evidence.slice(0,180)}${work.last_review?.project_unchanged && !work.last_review.feedback_requires_recheck ? " Reuse this result if its relevant inputs are unchanged." : " Recorded before changes or feedback; check relevance before reusing."}`),
    ...(work.last_review?.checks ?? []).filter(c => c.verdict === "holds" || c.verdict === "not_applicable").slice(0,2).map(c => `Recorded verification ${c.id} (${c.verdict}): ${c.evidence.slice(0,180)}`),
    ...work.recorded_commands.slice(-3).map(c => `Recorded ${c.failed ? "failed" : "completed"} command: ${c.command}`),
    "Full prior checks and findings are in get_goal.work. Use relevant results; do not repeat passing checks merely to restate them."];
  return [lines.join("\n").slice(0, 2400)];
}
