/**
 * Guardian improves its own reviewer from what happened in this workspace. The method follows Google Research's
 * RRSI (regularized recursive self-improvement), written here in our own terms: learn only from labelled outcomes,
 * propose a small tagged edit with the history of rejected ideas in view, replay the user's own cases that the
 * proposer never saw, and keep the edit only if it clears a noise margin without losing a catch. The user applies it.
 */
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAudit, readAuditTail } from "../audit/log.js";
import { newId, nowIso } from "../clock.js";
import type { AuditRecord, GoalReviewRecord, ImproveRunRecord, ReviewFeedbackRecord } from "../schema/audit.js";
import { casePatchText, loadCases, materializeCase, type ReviewCase } from "./cases.js";
import { harnessDir, harnessUsable, removeHarness, writeHarness } from "./harness.js";
import { agentText, askAgent, firstObjectWith, REVIEW_BUDGET_MS, reviewIn, reviewPrompt, reviewTemplate } from "./review.js";

/** Labelled cases needed, of both kinds, before an improvement is worth trying. */
export const MIN_LABELLED = 8;
/** One case in this many is held out from the proposer and used only to score. */
export const HELD_OUT_EVERY = 3;
/** The most lines one proposal may change: small, testable steps. */
export const MAX_CHANGED_LINES = 12;
const PROPOSER_BUDGET_MS = 120_000;
const AUDIT_WINDOW = 50_000;

export type ReviewLabel = "right" | "wrong";
export interface LabelledCase {
  reviewCase: ReviewCase;
  /** right: it should have objected; wrong: it shouldn't have. */
  label: ReviewLabel;
  source: "user" | "fixed" | "overruled";
}

export async function recordReviewFeedback(root: string, reviewId: string, index: number, label: ReviewLabel): Promise<void> {
  await appendAudit(root, { ts: nowIso(), kind: "review.feedback", reviewId, index, label });
}

const isEditOf = (r: AuditRecord): boolean => r.kind === "action.observed" && r.actionType === "edit";

/**
 * Labels for reviews that objected, from what people did. The user's own word wins. Without it, an objection the
 * agent fixed (files changed, then the next review on that goal passed) was right, and the user marking the goal done
 * while it still stood was wrong. The agent arguing back is not a label.
 */
export function reviewLabels(records: AuditRecord[]): Map<string, { label: ReviewLabel; source: LabelledCase["source"] }> {
  const out = new Map<string, { label: ReviewLabel; source: LabelledCase["source"] }>();
  const reviews = records.filter((r): r is GoalReviewRecord => r.kind === "goal.review" && r.ran && Boolean(r.id));
  const objected = (r: GoalReviewRecord): boolean => r.fails.length + r.extra.length > 0;
  for (const [i, r] of records.entries()) {
    if (r.kind !== "goal.review" || !r.ran || !r.id || !objected(r)) continue;
    const later = records.slice(i + 1);
    const nextReview = later.find((x): x is GoalReviewRecord => x.kind === "goal.review" && x.ran && x.goalHash === r.goalHash);
    if (nextReview && !objected(nextReview)) {
      const between = later.slice(0, later.indexOf(nextReview));
      if (between.some(isEditOf)) out.set(r.id, { label: "right", source: "fixed" });
      continue;
    }
    const closedByUser = later.find((x) => x.kind === "goal.control" && x.operation === "done" && x.goalHash === r.goalHash);
    if (closedByUser && (!nextReview || Date.parse(nextReview.ts) > Date.parse(closedByUser.ts))) out.set(r.id, { label: "wrong", source: "overruled" });
  }
  const said = new Map<string, ReviewFeedbackRecord[]>();
  for (const r of records) if (r.kind === "review.feedback") said.set(r.reviewId, [...(said.get(r.reviewId) ?? []).filter((x) => x.index !== r.index), r]);
  for (const [id, feedback] of said) {
    const review = reviews.find((r) => r.id === id);
    const total = review ? review.fails.length + review.extra.length : 0;
    // One objection the user calls right makes the review right to object; it was wrong only if every one was.
    if (feedback.some((f) => f.label === "right")) out.set(id, { label: "right", source: "user" });
    else if (total > 0 && feedback.length >= total) out.set(id, { label: "wrong", source: "user" });
  }
  return out;
}

/** The same case always lands on the same side, whatever else is added. */
export function isHeldOut(caseId: string): boolean {
  return createHash("sha256").update(caseId).digest()[0]! % HELD_OUT_EVERY === 0;
}

/** Lines one text has that the other doesn't, counted both ways. */
export function changedLines(before: string, after: string): number {
  const count = (lines: string[]): Map<string, number> => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const a = count(before.split("\n"));
  const b = count(after.split("\n"));
  let n = 0;
  for (const [line, k] of a) n += Math.max(0, k - (b.get(line) ?? 0));
  for (const [line, k] of b) n += Math.max(0, k - (a.get(line) ?? 0));
  return n;
}

/** A diff readable on the panel: removed lines then added ones. */
export function lineDiff(before: string, after: string): string {
  const a = new Set(before.split("\n"));
  const b = new Set(after.split("\n"));
  return [...before.split("\n").filter((l) => !b.has(l)).map((l) => `- ${l}`), ...after.split("\n").filter((l) => !a.has(l)).map((l) => `+ ${l}`)].join("\n");
}

export interface ReplayScore {
  correct: number;
  catches: number;
}
export interface ReplayResult {
  caseId: string;
  label: ReviewLabel;
  flagged: boolean;
}

export function scoreReplays(results: ReplayResult[]): ReplayScore {
  return {
    correct: results.filter((r) => (r.label === "right") === r.flagged).length,
    catches: results.filter((r) => r.label === "right" && r.flagged).length,
  };
}

/** Run-to-run noise: a margin of one case, or a tenth of the held-out set when that's bigger. */
export function noiseMargin(heldOut: number): number {
  return Math.max(1, Math.ceil(heldOut / 10));
}

/** Keep a proposal only if it beats the current version by the noise margin and drops no catch the current one made. */
export function keepDecision(oldRuns: ReplayResult[], newRuns: ReplayResult[]): { keep: boolean; reason: string; lostCatches: number; old: ReplayScore; new: ReplayScore } {
  const old = scoreReplays(oldRuns);
  const neu = scoreReplays(newRuns);
  const newFlag = new Map(newRuns.map((r) => [r.caseId, r.flagged]));
  const lostCatches = oldRuns.filter((r) => r.label === "right" && r.flagged && newFlag.get(r.caseId) === false).length;
  const margin = noiseMargin(oldRuns.length);
  if (lostCatches > 0) return { keep: false, reason: `it missed ${lostCatches} problem${lostCatches === 1 ? "" : "s"} the current reviewer caught`, lostCatches, old, new: neu };
  if (neu.correct - old.correct < margin) {
    return { keep: false, reason: `${neu.correct} right against ${old.correct} now, short of the ${margin}-case margin for noise`, lostCatches, old, new: neu };
  }
  return { keep: true, reason: `${neu.correct} right against ${old.correct} now on ${oldRuns.length} cases it never saw`, lostCatches, old, new: neu };
}

/** Labelled cases, newest last. */
export async function labelledCases(root: string, records?: AuditRecord[]): Promise<LabelledCase[]> {
  const labels = reviewLabels(records ?? (await readAuditTail(root, AUDIT_WINDOW)));
  const out: LabelledCase[] = [];
  for (const c of await loadCases(root)) {
    const l = labels.get(c.id);
    if (l) out.push({ reviewCase: c, ...l });
  }
  return out;
}

export function enoughToImprove(cases: Array<Pick<LabelledCase, "label">>): boolean {
  return cases.length >= MIN_LABELLED && cases.some((c) => c.label === "right") && cases.some((c) => c.label === "wrong");
}

interface Proposal {
  prompt: string;
  hypotheses: string[];
}

/** One proposer call: the current prompt, the training cases with labels, and what was already tried and rejected. */
async function propose(root: string, current: string, train: LabelledCase[], rejected: ImproveRunRecord[]): Promise<Proposal | { error: string }> {
  const cases = await Promise.all(
    train.map(async (c) => ({
      goal: c.reviewCase.goal,
      items: c.reviewCase.items,
      reviewer_objected: c.reviewCase.flagged,
      objections: [...c.reviewCase.fails.map((f) => `${f.id}: ${f.evidence}`), ...c.reviewCase.extra.map((e) => `extra ${e.file}: ${e.what}`)],
      verdict_on_the_reviewer: c.label === "right" ? "right to object" : "wrong to object",
      work: await casePatchText(root, c.reviewCase.id),
    })),
  );
  const history = rejected.slice(-6).map((r) => ({ hypotheses: r.hypotheses, why_rejected: r.reason, diff: r.diff.slice(0, 1500) }));
  const ask = `You improve the instructions of an automated reviewer. The reviewer checks an AI coding agent's claim that a user's goal is done: it tries to prove each "done when" item isn't really done, and lists changes no item needs. In this workspace it has been right to object sometimes and wrong at other times. Your job: change its instructions so it objects when it should and stays quiet when it shouldn't.

Current instructions (keep the placeholders {goal} and {items} exactly as they are):
<instructions>
${current}
</instructions>

Cases from this workspace, with what the people involved concluded about the reviewer:
${JSON.stringify(cases, null, 1)}

Ideas already tried and rejected, with why (don't repeat them):
${history.length ? JSON.stringify(history, null, 1) : "none yet"}

Rules: change at most ${MAX_CHANGED_LINES} lines in total. Make each change test one idea, and name that idea as a hypothesis: what in the cases suggests it, and why it should help. General guidance only: no project names, file names, languages or tools from these cases. Don't change the answer format.
Answer with JSON only: {"changes":[{"hypothesis":"one sentence"}],"prompt":"the full new instructions"}`;
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "gg-propose-"));
  try {
    const dir = path.join(scratch, "ws");
    await fsp.mkdir(dir);
    const run = await askAgent(ask, dir, scratch, PROPOSER_BUDGET_MS);
    if (!run.ok) return { error: run.reason };
    const text = agentText(run.stdout);
    const answer = text ? firstObjectWith(text, "changes") : null;
    const prompt = typeof answer?.prompt === "string" ? answer.prompt : "";
    const hypotheses = ((answer?.changes as unknown[]) ?? []).map((c) => String((c as { hypothesis?: unknown })?.hypothesis ?? "").trim()).filter(Boolean);
    if (!prompt) return { error: "the proposer's answer couldn't be read" };
    if (!harnessUsable("reviewer", prompt)) return { error: "the proposal dropped {goal} or {items}" };
    if (!hypotheses.length) return { error: "the proposal named no hypothesis" };
    if (changedLines(current, prompt) > MAX_CHANGED_LINES) return { error: `the proposal changed more than ${MAX_CHANGED_LINES} lines` };
    if (changedLines(current, prompt) === 0) return { error: "the proposal changed nothing" };
    return { prompt, hypotheses };
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Re-run the review on each case with a template. A case that can't be rebuilt or reviewed is left out of both sides. */
async function replay(root: string, cases: LabelledCase[], template: string, budgetMs: number): Promise<Map<string, boolean>> {
  const flagged = new Map<string, boolean>();
  for (const c of cases) {
    const copy = await materializeCase(root, c.reviewCase);
    if (!copy) continue;
    try {
      const outcome = await reviewIn(copy.dir, copy.scratch, reviewPrompt({ goal: c.reviewCase.goal, successCriteria: c.reviewCase.items }, undefined, template), budgetMs);
      if (outcome.ran) flagged.set(c.reviewCase.id, outcome.fails.length + outcome.extra.length > 0);
    } finally {
      await fsp.rm(copy.scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return flagged;
}

export function candidatePath(root: string, runId: string): string {
  return path.join(harnessDir(root), "candidates", `${runId}.md`);
}

export interface ImproveResult {
  status: "not-enough" | "running" | "done";
  run?: ImproveRunRecord;
}

/**
 * One improvement try, start to finish. Started only by the user. Records improve.start, then improve.run with the
 * verdict; a kept proposal waits as a candidate until the user applies it.
 */
export async function improveReviewer(root: string, budgetMs = REVIEW_BUDGET_MS): Promise<ImproveResult> {
  const records = await readAuditTail(root, AUDIT_WINDOW);
  if (improveRunning(records)) return { status: "running" };
  const cases = await labelledCases(root, records);
  if (!enoughToImprove(cases)) return { status: "not-enough" };
  const id = newId("improve");
  const started = Date.now();
  await appendAudit(root, { ts: nowIso(), kind: "improve.start", id });
  const train = cases.filter((c) => !isHeldOut(c.reviewCase.id));
  const held = cases.filter((c) => isHeldOut(c.reviewCase.id));
  const current = reviewTemplate(root);
  const rejected = records.filter((r): r is ImproveRunRecord => r.kind === "improve.run" && !r.kept);
  let calls = 1;
  const finish = async (rest: Omit<ImproveRunRecord, "ts" | "kind" | "id" | "train" | "heldOut" | "seconds" | "calls">): Promise<ImproveResult> => {
    const run: ImproveRunRecord = { ts: nowIso(), kind: "improve.run", id, train: train.length, heldOut: held.length, seconds: Math.round((Date.now() - started) / 1000), calls, ...rest };
    await appendAudit(root, run);
    return { status: "done", run };
  };
  if (!held.length || !train.length) return finish({ kept: false, reason: "not enough cases on both sides of the split yet", hypotheses: [], diff: "" });
  const proposal = await propose(root, current, train, rejected);
  if ("error" in proposal) return finish({ kept: false, reason: proposal.error, hypotheses: [], diff: "" });
  const diff = lineDiff(current, proposal.prompt);
  const oldFlags = await replay(root, held, current, budgetMs);
  const newFlags = await replay(root, held, proposal.prompt, budgetMs);
  calls += oldFlags.size + newFlags.size;
  const both = held.filter((c) => oldFlags.has(c.reviewCase.id) && newFlags.has(c.reviewCase.id));
  if (!both.length) return finish({ kept: false, reason: "none of the held-out cases could be replayed", hypotheses: proposal.hypotheses, diff });
  const runsOf = (flags: Map<string, boolean>): ReplayResult[] => both.map((c) => ({ caseId: c.reviewCase.id, label: c.label, flagged: flags.get(c.reviewCase.id)! }));
  const verdict = keepDecision(runsOf(oldFlags), runsOf(newFlags));
  if (verdict.keep) {
    await fsp.mkdir(path.dirname(candidatePath(root, id)), { recursive: true });
    await fsp.writeFile(candidatePath(root, id), proposal.prompt, "utf8");
  }
  return finish({ kept: verdict.keep, reason: verdict.reason, old: verdict.old, new: verdict.new, lostCatches: verdict.lostCatches, hypotheses: proposal.hypotheses, diff });
}

export function improveRunning(records: AuditRecord[]): boolean {
  let open: string | null = null;
  for (const r of records) {
    if (r.kind === "improve.start") open = r.id;
    if (r.kind === "improve.run" && r.id === open) open = null;
  }
  return open !== null;
}

/** Switch the workspace to a kept proposal. */
export async function applyImprovement(root: string, runId: string): Promise<void> {
  const text = await fsp.readFile(candidatePath(root, runId), "utf8");
  await writeHarness(root, "reviewer", text);
  await appendAudit(root, { ts: nowIso(), kind: "improve.apply", runId });
}

/** Back to the built-in reviewer. */
export async function undoImprovement(root: string): Promise<void> {
  await removeHarness(root, "reviewer");
  await appendAudit(root, { ts: nowIso(), kind: "improve.undo" });
}
