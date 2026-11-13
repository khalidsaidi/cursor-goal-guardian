/**
 * Guardian improves its own reviewer from what happened in this workspace, with Google Research's RRSI (Regularized
 * Recursive Self-Improvement), bundled unmodified in third_party/rrsi. Guardian supplies what RRSI needs: labelled
 * cases (from the user's review feedback), a domain (packages/rsi/cgg) that replays a review with a candidate
 * prompt, and the user's own model for RRSI's search roles. The user applies a result, or doesn't.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendAudit, readAuditTail } from "../audit/log.js";
import { newId, nowIso } from "../clock.js";
import type { AuditRecord, GoalReviewRecord, ImproveRunRecord, ReviewFeedbackRecord } from "../schema/audit.js";
import { loadCases, materializeCase, type ReviewCase } from "./cases.js";
import { harnessDir, harnessUsable, removeHarness, writeHarness } from "./harness.js";
import { REVIEW_BUDGET_MS, reviewIn, reviewPrompt, reviewTemplate, objectionEntries, type ReviewOutcome } from "./review.js";

/** Labelled cases needed, of both kinds, before an improvement is worth trying. */
export const MIN_LABELLED = 8;
/** One case in this many is held out from the proposer and used only to score. */
export const HELD_OUT_EVERY = 3;
const AUDIT_WINDOW = 50_000;

export type ReviewLabel = "right" | "wrong";
export interface LabelledCase {
  reviewCase: ReviewCase;
  /** right: it should have objected; wrong: it shouldn't have. */
  label: ReviewLabel;
  source: "user" | "fixed" | "overruled" | "missed";
}

/** New labelled cases needed since the last try before Guardian tries again by itself. */
export const NEW_LABELS_PER_RUN = 4;

export async function recordReviewFeedback(root: string, reviewId: string, index: number, label: ReviewLabel | "missed"): Promise<void> {
  await appendAudit(root, { ts: nowIso(), kind: "review.feedback", reviewId, index, label });
}

/**
 * Learn from explicit review feedback. An agent complying with an objection does not establish
 * that the objection was useful. Marking a goal done likewise does not judge its review findings.
 * A passing review is labelled missed when the user says the work wasn't done.
 */
export function reviewLabels(records: AuditRecord[]): Map<string, { label: ReviewLabel; source: LabelledCase["source"] }> {
  const out = new Map<string, { label: ReviewLabel; source: LabelledCase["source"] }>();
  const reviews = records.filter((r): r is GoalReviewRecord => r.kind === "goal.review" && r.ran && Boolean(r.id));
  const said = new Map<string, ReviewFeedbackRecord[]>();
  for (const r of records) if (r.kind === "review.feedback") said.set(r.reviewId, [...(said.get(r.reviewId) ?? []).filter((x) => x.index !== r.index), r]);
  for (let [id, feedback] of said) {
    const review = reviews.find((r) => r.id === id);
    // The user said the work this review passed wasn't done: it should have objected.
    if (review && objectionEntries(review).length === 0 && feedback.some((f) => f.label === "missed")) {
      out.set(id, { label: "right", source: "missed" });
      continue;
    }
    // The evaluator's lines come after the reviewer's own and aren't what RRSI improves: a verdict on one isn't a label.
    const visible = new Set(review ? objectionEntries(review).filter((e) => e.source === "reviewer").map((e) => e.index) : []);
    feedback = feedback.filter((f) => visible.has(f.index) && f.label !== "missed");
    // One objection the user calls right makes the review right to object; it was wrong only if every one was.
    if (feedback.some((f) => f.label === "right")) out.set(id, { label: "right", source: "user" });
    else if (visible.size > 0 && feedback.length >= visible.size) out.set(id, { label: "wrong", source: "user" });
  }
  return out;
}

/** The same case always lands on the same side, whatever else is added. */
export function isHeldOut(caseId: string): boolean {
  return createHash("sha256").update(caseId).digest()[0]! % HELD_OUT_EVERY === 0;
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

/** Labelled cases, newest last. */
export async function labelledCases(root: string, records?: AuditRecord[]): Promise<LabelledCase[]> {
  const labels = reviewLabels(records ?? (await readAuditTail(root, AUDIT_WINDOW)));
  const out: LabelledCase[] = [];
  for (const c of await loadCases(root)) {
    const l = labels.get(c.id);
    if (l && typeof c.currentRequest === "string") out.push({ reviewCase: c, ...l });
  }
  return out;
}

export function enoughToImprove(cases: Array<Pick<LabelledCase, "label">>): boolean {
  return cases.length >= MIN_LABELLED && cases.some((c) => c.label === "right") && cases.some((c) => c.label === "wrong");
}

/** Re-run one saved review with another prompt. Guardian's binary exposes this so RRSI can call it. Never throws. */
export async function replayCase(root: string, caseId: string, template: string, budgetMs = REVIEW_BUDGET_MS): Promise<ReviewOutcome & { flagged: boolean | null }> {
  const c = (await loadCases(root)).find((x) => x.id === caseId);
  if (!c) return { ran: false, reason: "no such case", fails: [], extra: [], unanswered: [], seconds: 0, flagged: null };
  if (!c.constraints && c.prompt.includes("\n\nUser constraints:\n")) return { ran: false, reason: "this older case did not retain the user's constraints", fails: [], extra: [], unanswered: [], seconds: 0, flagged: null };
  if (typeof c.currentRequest !== "string") return { ran: false, reason: "this older case did not retain the user request active during review", fails: [], extra: [], unanswered: [], seconds: 0, flagged: null };
  const copy = await materializeCase(root, c);
  if (!copy) return { ran: false, reason: "the case's work no longer applies to its commit", fails: [], extra: [], unanswered: [], seconds: 0, flagged: null };
  try {
    const outcome = await reviewIn(copy.dir, copy.scratch, reviewPrompt({ goal: c.goal, successCriteria: c.items, constraints: c.constraints ?? [], currentRequest: c.currentRequest }, undefined, template), budgetMs, c.items.length ? c.items.map((i) => i.id) : ["goal"]);
    return { ...outcome, flagged: outcome.ran && !outcome.unanswered.length ? outcome.fails.length + outcome.extra.length > 0 : null };
  } finally {
    await fsp.rm(copy.scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Where Guardian's bundled copy of RRSI, its domain, a Python and the replay command are. */
export interface RsiPaths {
  python: string;
  /** Google's RRSI, unmodified (third_party/rrsi). */
  rrsiDir: string;
  /** Guardian's RRSI domain (packages/rsi/cgg). */
  domainDir: string;
  /** Command that replays one review: [binary, "replay-review"]. */
  replay: string[];
}

interface RsiConfig {
  T: number;
  m: number;
  k: number;
  repair_rounds: number;
}

/** RRSI's proposer may take this many turns per candidate (rrsi/propose.py MAX_TURNS). */
const PROPOSER_TURNS = 40;

function rsiConfig(rsi: RsiPaths): RsiConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(rsi.domainDir, "rrsi.json"), "utf8")) as Partial<RsiConfig>;
  return { T: raw.T ?? 2, m: raw.m ?? 2, k: raw.k ?? 1, repair_rounds: raw.repair_rounds ?? 2 };
}

/** What one run costs on the user's plan, shown before it starts. */
export interface ImproveEstimate {
  evolve: number;
  heldOut: number;
  reviews: number;
  searchCallsMax: number;
}

export function estimateImprove(cases: LabelledCase[], cfg: RsiConfig): ImproveEstimate {
  const heldOut = cases.filter((c) => isHeldOut(c.reviewCase.id)).length;
  const evolve = cases.length - heldOut;
  // Held out before and after; the evolve set once for the baseline and once per candidate.
  const reviews = (2 * heldOut + evolve * (1 + cfg.T * cfg.m)) * cfg.k;
  // Per round: the analyst and digester, then each candidate's proposer turns and critic repairs.
  const searchCallsMax = cfg.T * (2 + cfg.m * (PROPOSER_TURNS + cfg.repair_rounds + 1));
  return { evolve, heldOut, reviews, searchCallsMax };
}

export async function improveEstimate(root: string, rsi: RsiPaths): Promise<ImproveEstimate | null> {
  const cases = await labelledCases(root);
  return enoughToImprove(cases) ? estimateImprove(cases, rsiConfig(rsi)) : null;
}

/** Identifiers and file names from the cases: a general prompt has no reason to mention them. */
function leakTerms(cases: LabelledCase[]): string[] {
  const out = new Set<string>();
  const add = (text: string): void => {
    for (const w of text.match(/[A-Za-z_][A-Za-z0-9_.\/-]{3,}/g) ?? []) {
      // camelCase, snake_case, paths and names with digits are specific; ordinary words aren't.
      const t = w.replace(/[./\\-]+$/, "");
      if (/[a-z][A-Z]|[_/\\]|\.\w|\d/.test(t)) out.add(t);
    }
  };
  for (const c of cases) {
    add(c.reviewCase.goal);
    for (const i of c.reviewCase.items) add(i.text);
    for (const e of c.reviewCase.extra) add(e.file);
  }
  return [...out].filter((w) => w.length >= 4);
}

function rsiRoot(root: string): string {
  return path.join(path.dirname(harnessDir(root)), "rsi");
}

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (b: Buffer): void => {
      out += b.toString("utf8");
      fs.appendFileSync(log, b);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const git = (args: string[], cwd: string): string =>
  execFileSync("git", ["-c", "user.name=Goal Guardian", "-c", "user.email=guardian@localhost", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });

async function copyTree(from: string, to: string): Promise<void> {
  await fsp.cp(from, to, { recursive: true, filter: (src) => !/(^|[\\/])(__pycache__|runs|\.git)([\\/]|$)/.test(path.relative(from, src)) });
}

/** Compare the same complete held-out set, retaining every individual catch the current reviewer made. */
export function compareHeldOutVerdicts(labels: ReadonlyMap<string, ReviewLabel>, before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): {
  kept: boolean; reason: string; old: ReplayScore; new: ReplayScore; lostCatches: number;
} {
  const score = (verdicts: ReadonlyMap<string, unknown>): ReplayScore => {
    let correct = 0;
    let catches = 0;
    for (const [id, label] of labels) {
      const flagged = verdicts.get(id);
      if (typeof flagged !== "boolean") continue;
      if (flagged === (label === "right")) correct += 1;
      if (label === "right" && flagged) catches += 1;
    }
    return { correct, catches };
  };
  const old = score(before);
  const neu = score(after);
  const beforeRun = [...labels.keys()].filter((id) => typeof before.get(id) === "boolean").length;
  const afterRun = [...labels.keys()].filter((id) => typeof after.get(id) === "boolean").length;
  const lostCatches = [...labels].filter(([id, label]) => label === "right" && before.get(id) === true && after.get(id) === false).length;
  const scores = { old, new: neu, lostCatches };
  if (!labels.size) return { kept: false, reason: "no held-out cases to compare", ...scores };
  if (beforeRun !== labels.size || afterRun !== labels.size) {
    return { kept: false, reason: `held-out replay coverage is incomplete: current ${beforeRun}/${labels.size}, candidate ${afterRun}/${labels.size}; no comparison accepted`, ...scores };
  }
  if (lostCatches) return { kept: false, reason: `RRSI's winner missed ${lostCatches} gap${lostCatches === 1 ? "" : "s"} the current reviewer caught`, ...scores };
  if (neu.correct <= old.correct) return { kept: false, reason: `${neu.correct} right against ${old.correct} now on ${labels.size} cases RRSI never saw: no better`, ...scores };
  return { kept: true, reason: `${neu.correct} right against ${old.correct} now on ${labels.size} cases RRSI never saw`, ...scores };
}

/** Read the expected held-out verdicts; missing, malformed and inconclusive results remain incomplete. */
async function heldOutScore(runs: string, job: string, labels: Map<string, ReviewLabel>): Promise<Map<string, unknown> | null> {
  const jobDir = path.join(runs, "cgg", "jobs", job);
  const tasks = await fsp.readdir(jobDir).catch(() => null);
  if (!tasks) return null;
  const verdicts = new Map<string, unknown>();
  for (const id of labels.keys()) {
    const rec = await fsp.readFile(path.join(jobDir, id, "trial0.json"), "utf8").then((x) => JSON.parse(x) as { flagged?: unknown }).catch(() => null);
    if (rec) verdicts.set(id, rec.flagged);
  }
  return verdicts;
}

export function candidatePath(root: string, runId: string): string {
  return path.join(harnessDir(root), "candidates", `${runId}.md`);
}

export interface ImproveResult {
  status: "not-enough" | "running" | "done";
  run?: ImproveRunRecord;
}

/**
 * One improvement try, run by Google's RRSI (third_party/rrsi, unmodified) on this workspace's labelled cases.
 * Started only by the user. Guardian assembles a throwaway RRSI checkout under .cursor/goal-guardian/rsi with its
 * own domain, scores the current reviewer on the held-out cases, lets RRSI search on the rest, and scores RRSI's
 * winner on the same held-out cases. A winner that does better there without losing a catch waits for the user.
 */
export async function improveReviewer(root: string, rsi: RsiPaths, opts: { auto?: boolean } = {}): Promise<ImproveResult> {
  const records = await readAuditTail(root, AUDIT_WINDOW);
  if (improveRunning(records)) return { status: "running" };
  const cases = await labelledCases(root, records);
  if (!enoughToImprove(cases)) return { status: "not-enough" };
  const id = newId("improve");
  const started = Date.now();
  const cfg = rsiConfig(rsi);
  const est = estimateImprove(cases, cfg);
  const labelSet = labelsFingerprint(cases);
  await appendAudit(root, { ts: nowIso(), kind: "improve.start", id, ...(opts.auto ? { auto: true } : {}), reviews: est.reviews, searchCallsMax: est.searchCallsMax });
  const progress = (stage: string): Promise<void> => appendAudit(root, { ts: nowIso(), kind: "improve.progress", id, stage });
  const finish = async (rest: Omit<ImproveRunRecord, "ts" | "kind" | "id" | "train" | "heldOut" | "seconds" | "calls">): Promise<ImproveResult> => {
    const run: ImproveRunRecord = { ts: nowIso(), kind: "improve.run", id, labels: labelSet, ...(opts.auto ? { auto: true } : {}), train: est.evolve, heldOut: est.heldOut, seconds: Math.round((Date.now() - started) / 1000), calls: est.reviews, ...rest };
    await appendAudit(root, run);
    return { status: "done", run };
  };
  if (!est.heldOut || !est.evolve) return finish({ kept: false, reason: "not enough cases on both sides of the split yet", hypotheses: [], diff: "" });

  // A fresh RRSI checkout: their files, our domain, this workspace's cases and current reviewer.
  const base = rsiRoot(root);
  const repo = path.join(base, "repo");
  const runs = path.join(base, "runs");
  await fsp.rm(base, { recursive: true, force: true });
  await fsp.mkdir(base, { recursive: true });
  await copyTree(rsi.rrsiDir, repo);
  const domain = path.join(repo, "domains", "cgg");
  await copyTree(rsi.domainDir, domain);
  await fsp.mkdir(path.join(domain, "data"), { recursive: true });
  const labels = new Map(cases.map((c) => [c.reviewCase.id, c.label] as const));
  await fsp.writeFile(path.join(domain, "data", "tasks.json"), JSON.stringify(cases.map((c) => ({ id: c.reviewCase.id, case: c.reviewCase.id, label: c.label, split: isHeldOut(c.reviewCase.id) ? "heldout" : "evolve" })), null, 1));
  await fsp.writeFile(path.join(domain, "data", "leak_terms.json"), JSON.stringify(leakTerms(cases)));
  await fsp.mkdir(path.join(domain, "harness"), { recursive: true });
  const current = reviewTemplate(root);
  await fsp.writeFile(path.join(domain, "harness", "reviewer.md"), current);
  await fsp.writeFile(path.join(base, ".gitignore"), "*\n");
  const log = path.join(base, "rrsi.log");
  let start: string;
  try {
    git(["init", "-q"], repo);
    git(["add", "-A"], repo);
    git(["commit", "-qm", "Guardian's reviewer, as it is now"], repo);
    start = git(["rev-parse", "HEAD"], repo).trim();
  } catch (err) {
    return finish({ kept: false, reason: `RRSI's checkout couldn't be set up: ${err instanceof Error ? err.message : String(err)}`, hypotheses: [], diff: "" });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CGG_WORKSPACE: root, CGG_REPLAY: JSON.stringify(rsi.replay), PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" };
  delete env.GOAL_GUARDIAN_REVIEWING;
  const rrsi = (args: string[]) => sh(rsi.python, [path.join(repo, "rrsi.py"), "--domain", "cgg", "--runs", runs, ...args], repo, env, log);

  await progress(`Scoring the current reviewer on ${est.heldOut} cases RRSI won't see`);
  const before = await rrsi(["heldout", "--label", "before", "--ref", start]);
  if (before.code !== 0) return finish({ kept: false, reason: `RRSI couldn't score the current reviewer (see ${path.relative(root, log)})`, hypotheses: [], diff: "" });
  await progress(`RRSI is searching: ${cfg.T} rounds of ${cfg.m} candidates on ${est.evolve} cases`);
  const search = await rrsi(["run"]);
  if (search.code !== 0) return finish({ kept: false, reason: `RRSI's search stopped (see ${path.relative(root, log)})`, hypotheses: [], diff: "" });
  const frontier = JSON.parse(await fsp.readFile(path.join(runs, "cgg", "frontier.json"), "utf8")) as { incumbent: { t: number; commit: string } };
  const history = (await fsp.readFile(path.join(runs, "cgg", "history.jsonl"), "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { outcome?: string; hypothesis?: string });
  const hypotheses = history.filter((h) => h.outcome === "ACCEPTED" && h.hypothesis).map((h) => String(h.hypothesis)).slice(-6);
  if (frontier.incumbent.t === 0 || frontier.incumbent.commit === start) {
    return finish({ kept: false, reason: "RRSI found no change that beat the current reviewer by more than the noise", hypotheses: history.filter((h) => h.outcome !== "BASELINE" && h.hypothesis).map((h) => String(h.hypothesis)).slice(-6), diff: "" });
  }
  const winner = git(["show", `${frontier.incumbent.commit}:domains/cgg/harness/reviewer.md`], repo);
  const diff = lineDiff(current, winner);
  if (!harnessUsable("reviewer", winner)) return finish({ kept: false, reason: "RRSI's winner dropped {goal} or {items}", hypotheses, diff });
  await progress("Scoring RRSI's winner on the same held-out cases");
  const after = await rrsi(["heldout", "--label", "after", "--ref", frontier.incumbent.commit]);
  if (after.code !== 0) return finish({ kept: false, reason: `RRSI couldn't score its winner (see ${path.relative(root, log)})`, hypotheses, diff });
  const heldOutLabels = new Map([...labels].filter(([id]) => isHeldOut(id)));
  const old = await heldOutScore(runs, "heldout_before", heldOutLabels);
  const neu = await heldOutScore(runs, "heldout_after", heldOutLabels);
  if (!old || !neu) return finish({ kept: false, reason: "the held-out replay records could not be read", hypotheses, diff });
  const comparison = compareHeldOutVerdicts(heldOutLabels, old, neu);
  if (!comparison.kept) return finish({ hypotheses, diff, ...comparison });
  await fsp.mkdir(path.dirname(candidatePath(root, id)), { recursive: true });
  await fsp.writeFile(candidatePath(root, id), winner, "utf8");
  return finish({ hypotheses, diff, ...comparison });
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
export async function applyImprovement(root: string, runId: string, auto = false): Promise<void> {
  const text = await fsp.readFile(candidatePath(root, runId), "utf8");
  await writeHarness(root, "reviewer", text);
  await appendAudit(root, { ts: nowIso(), kind: "improve.apply", runId, ...(auto ? { auto: true } : {}) });
}

/** One fingerprint for a set of labelled cases: which reviews, and what each was judged. */
export function labelsFingerprint(cases: LabelledCase[]): string {
  return createHash("sha256").update(cases.map((c) => `${c.reviewCase.id}:${c.label}`).sort().join("\n")).digest("hex").slice(0, 16);
}

/**
 * Guardian improving its reviewer by itself. It runs when there are enough labelled cases of both kinds and at least
 * NEW_LABELS_PER_RUN more than the last try had, never two at once. RRSI's result is applied only when the gate in
 * improveReviewer kept it: more right on cases RRSI never saw, and no gap the current reviewer caught lost. Every
 * run and every apply is on the record, and the panel shows it with an Undo. Null when there was nothing to do.
 */
export async function autoImprove(root: string, rsi: RsiPaths): Promise<ImproveResult | null> {
  const records = await readAuditTail(root, AUDIT_WINDOW);
  if (improveRunning(records)) return null;
  const cases = await labelledCases(root, records);
  if (!enoughToImprove(cases)) return null;
  const runs = records.filter((r): r is ImproveRunRecord => r.kind === "improve.run");
  const last = runs[runs.length - 1];
  if (last && (last.labels === labelsFingerprint(cases) || cases.length < last.train + last.heldOut + NEW_LABELS_PER_RUN)) return null;
  const result = await improveReviewer(root, rsi, { auto: true });
  if (result.run?.kept) await applyImprovement(root, result.run.id, true);
  return result;
}

/** Back to the built-in reviewer. */
export async function undoImprovement(root: string): Promise<void> {
  await removeHarness(root, "reviewer");
  await appendAudit(root, { ts: nowIso(), kind: "improve.undo" });
}
