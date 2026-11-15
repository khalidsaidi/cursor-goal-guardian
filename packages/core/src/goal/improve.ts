/**
 * Guardian improves its own reviewer from what happened in this workspace, with Google Research's RRSI (Regularized
 * Recursive Self-Improvement), bundled unmodified in third_party/rrsi. Guardian supplies what RRSI needs: labelled
 * cases (from the user's review feedback), a domain (packages/rsi/cgg) that replays a review with a candidate
 * prompt, and the user's own model for RRSI's search roles. An automatically selected result still has to pass held-out checks, and the user can undo it.
 */
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import crossSpawn from "cross-spawn";
const spawn = crossSpawn as typeof nodeSpawn;
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readConfigSafe, readContractSafe } from "../safeReaders.js";
import { processLease } from "../processLease.js";
import { stopProcessTree, trackProcessTree } from "../processTree.js";
import { getGuardianPaths } from "../paths.js";
import { goalPhaseOf } from "./loop.js";
import { appendAudit, readAuditTail } from "../audit/log.js";
import { newId, nowIso } from "../clock.js";
import type { AuditRecord, GoalReviewRecord, ImproveRunRecord, ReviewFeedbackRecord } from "../schema/audit.js";
import { loadCases, materializeCase, type ReviewCase } from "./cases.js";
import { harnessDir, harnessUsable, removeHarness, writeHarness } from "./harness.js";
import { reviewIn, reviewPrompt, reviewTemplate, objectionEntries, REVIEW_POLICY, REVIEW_REQUIREMENTS, resolveReviewer, type ReviewOutcome } from "./review.js";

/** Learning runs outside the interactive MCP deadline; leave room under the adapter's five-minute limit. */
export const LEARNING_REVIEW_BUDGET_MS = 240_000;

/** Labelled cases needed, of both kinds, before an improvement is worth trying. */
export const MIN_LABELLED = 8;
/** One case in this many is held out from the proposer and used only to score. */
export const HELD_OUT_EVERY = 3;
const AUDIT_WINDOW = 50_000;

export type ReviewLabel = "right" | "wrong";
export interface LabelledCase {
  reviewCase: ReviewCase;
  /** Batch balance label; individual feedback targets determine correctness. */
  label: ReviewLabel;
  source: "user" | "fixed" | "overruled" | "missed";
  targets?: FeedbackTarget[];
}
export interface FeedbackTarget { key: string; finding: string; label: ReviewLabel; userWords?: string; }

/** Keep what the user actually judged. A wrong objection does not label the whole project correct. */
export function reviewFeedbackTargets(records: AuditRecord[], reviewId: string): FeedbackTarget[] {
  const review = records.find((r): r is GoalReviewRecord => r.kind === "goal.review" && r.id === reviewId && r.ran);
  if (!review) return [];
  const entries = new Map(objectionEntries(review).filter(e => e.source === "reviewer").map(e => [e.index, e.line]));
  const feedback = new Map<number, ReviewFeedbackRecord>();
  for (const r of records) if (r.kind === "review.feedback" && r.reviewId === reviewId) feedback.set(r.index, r);
  return [...feedback].flatMap(([index, f]) => {
    const finding = entries.get(index);
    return finding && f.label !== "missed" ? [{ key: `finding_${index}`, finding, label: f.label, ...(f.userWords ? {userWords:f.userWords} : {}) }] : [];
  });
}

/** New labelled cases needed since the last try before Guardian tries again by itself. */
export const NEW_LABELS_PER_RUN = 4;

export async function recordReviewFeedback(root: string, reviewId: string, index: number, label: ReviewLabel | "missed", context: {userWords?:string; source?:"chat"|"panel"} = {}): Promise<void> {
  await appendAudit(root, { ts: nowIso(), kind: "review.feedback", reviewId, index, label, ...context });
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
  const history = records ?? await readAuditTail(root, AUDIT_WINDOW);
  const out: LabelledCase[] = [];
  for (const c of await loadCases(root)) {
    const targets = reviewFeedbackTargets(history, c.id);
    // A vague missed-work button still resumes the goal, but cannot specify a defect for learning qualification.
    if (targets.length && typeof c.currentRequest === "string") out.push({ reviewCase: c, label: targets.some(t => t.label === "right") ? "right" : "wrong", source: "user", targets });
  }
  return out;
}

/** One saved review can teach both retaining a useful catch and removing a false complaint. */
function hasFeedbackLabel(c: Pick<LabelledCase,"label" | "targets">, label: ReviewLabel): boolean {
  return c.targets?.length ? c.targets.some(t => t.label === label) : c.label === label;
}

export function enoughToImprove(cases: Array<Pick<LabelledCase, "label" | "targets"> & { id?: string; reviewCase?: Pick<ReviewCase, "id"> }>): boolean {
  if (cases.length < MIN_LABELLED) return false;
  const identified = cases.map((c) => ({ ...c, id: c.id ?? c.reviewCase?.id }));
  if (identified.some((c) => !c.id)) return false;
  return [true, false].every((heldOut) => {
    const group = identified.filter((c) => isHeldOut(c.id!) === heldOut);
    return group.some((c) => hasFeedbackLabel(c,"right")) && group.some((c) => hasFeedbackLabel(c,"wrong"));
  });
}

/** A bounded recent batch, retaining examples from both labels on both sides of the fixed split. */
export function learningBatch(cases: LabelledCase[], limit = 12): LabelledCase[] {
  if (cases.length <= limit) return cases;
  const selected = new Set<string>();
  for (const heldOut of [true, false]) for (const label of ["right", "wrong"] as const) {
    const match = [...cases].reverse().find((c) => isHeldOut(c.reviewCase.id) === heldOut && hasFeedbackLabel(c,label));
    if (match) selected.add(match.reviewCase.id);
  }
  for (const c of [...cases].reverse()) {
    if (selected.size >= limit) break;
    selected.add(c.reviewCase.id);
  }
  return cases.filter((c) => selected.has(c.reviewCase.id));
}

/** Re-run one saved review with another prompt. Guardian's binary exposes this so RRSI can call it. Never throws. */
export async function replayCase(root: string, caseId: string, template: string, budgetMs = LEARNING_REVIEW_BUDGET_MS): Promise<ReviewOutcome & { flagged: boolean | null }> {
  const c = (await loadCases(root)).find((x) => x.id === caseId);
  if (!c) return { ran: false, reason: "no such case", fails: [], extra: [], unanswered: [], seconds: 0, flagged: null };
  if (!c.constraints && c.prompt.includes("\n\nUser constraints:\n")) return { ran: false, reason: "this older case did not retain the user's constraints", fails: [], extra: [], unanswered: [], seconds: 0, flagged: null };
  if (typeof c.currentRequest !== "string") return { ran: false, reason: "this older case did not retain the user request active during review", fails: [], extra: [], unanswered: [], seconds: 0, flagged: null };
  if (!c.reviewFeedback && c.prompt.includes("\n\nUser feedback on earlier review findings:")) return { ran:false, reason:"this case did not retain the user feedback seen during review", fails:[],extra:[],unanswered:[],seconds:0,flagged:null };
  const copy = await materializeCase(root, c);
  if (!copy) return { ran: false, reason: "the case's work no longer applies to its commit", fails: [], extra: [], unanswered: [], seconds: 0, flagged: null };
  try {
    const outcome = await reviewIn(copy.dir, copy.scratch, reviewPrompt({ goal: c.goal, successCriteria: c.items, constraints: c.constraints ?? [], currentRequest: c.currentRequest, reviewFeedback: c.reviewFeedback }, undefined, template), budgetMs, c.items.length ? c.items.map((i) => i.id) : ["goal"]);
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

function rsiConfig(rsi: RsiPaths, auto = false): RsiConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(rsi.domainDir, "rrsi.json"), "utf8")) as Partial<RsiConfig>;
  return auto ? { T: 1, m: 1, k: 1, repair_rounds: 1 } : { T: raw.T ?? 2, m: raw.m ?? 2, k: raw.k ?? 1, repair_rounds: raw.repair_rounds ?? 2 };
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
  const searchCallsMax = cfg.T * (2 + cfg.m * (PROPOSER_TURNS + cfg.repair_rounds + 1)) + reviews; // at most one specific-issue match judgment per replay
  return { evolve, heldOut, reviews, searchCallsMax };
}

export async function improveEstimate(root: string, rsi: RsiPaths): Promise<ImproveEstimate | null> {
  const cases = await labelledCases(root);
  return enoughToImprove(cases) ? estimateImprove(cases, rsiConfig(rsi)) : null;
}

/** Saved-case identities cannot become memorized verdict exceptions. */
function leakTerms(cases: LabelledCase[]): string[] {
  // Project paths and APIs are legitimate workspace knowledge; only saved-case identities are forbidden.
  return cases.map(c => c.reviewCase.id);
}

/** A cache identity includes the real reviewer/model/runtime and installed dependency metadata, never labels. */
async function replayVersion(root: string, rsi: RsiPaths): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify([REVIEW_POLICY, REVIEW_REQUIREMENTS, process.version, process.env.CGG_MODEL_ID, process.env.CGG_SEARCH_MODEL]));
  for (const file of [resolveReviewer(), ...rsi.replay, ...["package.json", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "node_modules/.modules.yaml", "node_modules/.package-lock.json", ".venv/pyvenv.cfg"].map(f => path.join(root, f))]) {
    if (!file) continue;
    try { hash.update(await fsp.readFile(file)); } catch { hash.update(String(file)); }
  }
  let modelKnown = Boolean(process.env.CGG_MODEL_ID);
  try { const config = JSON.parse(await fsp.readFile(path.join(os.homedir(), ".cursor", "cli-config.json"), "utf8")); const model = config.selectedModel ?? config.model; if (model) { modelKnown = true; hash.update(JSON.stringify(model)); } } catch { /* no observable default model */ }
  // Unknown effective models cannot safely share evaluations between attempts.
  if (!modelKnown) hash.update(String(Date.now()));
  for (const name of await fsp.readdir(rsi.domainDir)) if (/\.(py|md|json)$/.test(name)) hash.update(await fsp.readFile(path.join(rsi.domainDir, name)));
  return hash.digest("hex");
}

function rsiRoot(root: string): string {
  return path.join(path.dirname(harnessDir(root)), "rsi");
}

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, foreground?: () => Promise<boolean>): Promise<{ code: number | null; out: string; yielded?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    trackProcessTree(child);
    let alive = true, checking = false, yielded = false;
    const monitor = foreground ? setInterval(() => {
      if (checking || !alive) return;
      checking = true;
      void foreground().then(active => {
        if (!active || !alive || yielded) return;
        yielded = true;
        // Replay processes own isolated reviewer groups: let their shutdown handlers stop those too.
        if (process.platform === "win32" || !child.pid) { stopProcessTree(child); return; }
        try { process.kill(-child.pid, "SIGTERM"); } catch { stopProcessTree(child); }
        const force = setTimeout(() => stopProcessTree(child), 1000);
        child.once("close", () => clearTimeout(force));
      }).finally(() => { checking = false; }).catch(() => undefined);
    }, 500) : null;
    child.once("close", () => { alive = false; if (monitor) clearInterval(monitor); });
    child.once("error", () => { alive = false; if (monitor) clearInterval(monitor); });
    const timer = setTimeout(() => stopProcessTree(child), 600_000);
    child.once("close", () => clearTimeout(timer));
    child.once("error", () => clearTimeout(timer));
    let out = "";
    const keep = (b: Buffer): void => {
      out += b.toString("utf8");
      fs.appendFileSync(log, b);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (err) => resolve({ code: -1, out: `${out}\n${err.message}` }));
    child.on("close", (code) => resolve({ code, out, ...(yielded ? { yielded: true } : {}) }));
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

/** A candidate must preserve each useful issue, not merely produce some objection on that case. */
export function compareFeedbackResults(cases: LabelledCase[], before: Map<string, unknown>, after: Map<string, unknown>) {
  const labels = new Map(cases.flatMap(c => (c.targets ?? []).map(t => [`${c.reviewCase.id}/${t.key}`, t.label] as const)));
  const comparison = compareHeldOutVerdicts(labels, before, after);
  return { ...comparison, reason: comparison.reason.replace(/cases/g, "feedback checks") };
}

async function heldOutScore(runs: string, job: string, cases: LabelledCase[]): Promise<Map<string, unknown>> {
  const verdicts = new Map<string, unknown>();
  for (const c of cases) {
    const rec = await fsp.readFile(path.join(runs, "cgg", "jobs", job, c.reviewCase.id, "trial0.json"), "utf8").then(JSON.parse).catch(() => null);
    for (const target of c.targets ?? []) verdicts.set(`${c.reviewCase.id}/${target.key}`, rec?.ran && typeof rec.flagged === "boolean" && !rec.unanswered?.length ? rec.feedback_matches?.[target.key] : undefined);
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
 * Automatic background runs are bounded; explicit calls may use the full search configuration. Guardian assembles a throwaway RRSI checkout under .cursor/goal-guardian/rsi with its
 * own domain, scores the current reviewer on the held-out cases, lets RRSI search on the rest, and scores RRSI's
 * winner on the same held-out cases. A winner that does better there without losing a catch waits for the user.
 */
export async function improveReviewer(root: string, rsi: RsiPaths, opts: { auto?: boolean } = {}): Promise<ImproveResult> {
  const release = processLease(path.join(getGuardianPaths(root).dir, "improvement.lock"));
  if (!release) return { status: "running" };
  try { return await improveReviewerLocked(root, rsi, opts); }
  finally { release(); }
}

async function improveReviewerLocked(root: string, rsi: RsiPaths, opts: { auto?: boolean }): Promise<ImproveResult> {
  const records = await readAuditTail(root, AUDIT_WINDOW);
  const available = await labelledCases(root, records);
  const cases = opts.auto ? learningBatch(available) : available;
  if (!enoughToImprove(cases)) return { status: "not-enough" };
  const id = newId("improve");
  const started = Date.now();
  const cfg = rsiConfig(rsi, opts.auto);
  const est = estimateImprove(cases, cfg);
  const preferences = (await readConfigSafe(root)).learning;
  const requestedLimit = Number(process.env.CGG_RSI_AUTO_CALL_LIMIT ?? preferences?.callLimit ?? 32);
  const limit = opts.auto ? (Number.isFinite(requestedLimit) ? Math.max(0, Math.min(256, Math.floor(requestedLimit))) : 32) : null;
  const learningDir = path.join(getGuardianPaths(root).dir, "learning");
  const pendingFile = path.join(learningDir, "pending.json");
  const dailyFile = path.join(learningDir, "allowance.json");
  await fsp.mkdir(learningDir, { recursive: true });
  const now = Date.now();
  const savedDaily = await fsp.readFile(dailyFile, "utf8").then(JSON.parse).catch(() => null);
  const daily = savedDaily && Number.isFinite(savedDaily.windowStarted) && now - savedDaily.windowStarted < 86_400_000 ? savedDaily : { used: 0, windowStarted: now };
  daily.limit = preferences?.dailyCallLimit ?? 32;
  if (opts.auto) await fsp.writeFile(dailyFile, JSON.stringify(daily));
  const budget = path.join(rsiRoot(root), "model-budget.json");
  const budgetState = (): { used: number; exhausted: boolean; daily_exhausted?: boolean } => {
    try { return JSON.parse(fs.readFileSync(budget, "utf8")) as { used: number; exhausted: boolean; daily_exhausted?: boolean }; }
    catch { return { used: 0, exhausted: false }; }
  };
  const labelSet = labelsFingerprint(available);
  await appendAudit(root, { ts: nowIso(), kind: "improve.start", id, ...(opts.auto ? { auto: true } : {}), reviews: est.reviews, searchCallsMax: est.searchCallsMax, ...(limit !== null ? { callLimit: limit } : {}) });
  const progress = (stage: string): Promise<void> => appendAudit(root, { ts: nowIso(), kind: "improve.progress", id, stage });
  const finish = async (rest: Omit<ImproveRunRecord, "ts" | "kind" | "id" | "train" | "heldOut" | "seconds" | "calls">): Promise<ImproveResult> => {
    const run: ImproveRunRecord = { ts: nowIso(), kind: "improve.run", id, labels: labelSet, ...(opts.auto ? { auto: true } : {}), train: est.evolve, heldOut: est.heldOut, seconds: Math.round((Date.now() - started) / 1000), calls: budgetState().used, ...rest };
    const memoryFile = path.join(getGuardianPaths(root).dir, "learning", "search-history.json");
    try {
      const rows = (await fsp.readFile(path.join(rsiRoot(root), "runs", "cgg", "history.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
      const previous = await fsp.readFile(memoryFile, "utf8").then(JSON.parse).catch(() => []);
      const memory = new Map(previous.map((entry: { key: string }) => [entry.key, entry]));
      for (const entry of rows) {
        if (!entry.hypothesis) continue;
        const key = createHash("sha256").update(JSON.stringify([labelSet, entry])).digest("hex");
        memory.set(key, { key, feedback: labelSet, run: id, qualified: rest.kept, qualification: rest.reason, search: entry });
      }
      await fsp.mkdir(path.dirname(memoryFile), { recursive: true });
      await fsp.writeFile(memoryFile, JSON.stringify([...memory.values()].slice(-80), null, 1));
    } catch { /* no completed search history on an early stop */ }
    if (!rest.yielded && !rest.deferredUntil) await fsp.rm(pendingFile, { force: true });
    await appendAudit(root, run);
    return { status: "done", run };
  };
  const foreground = async (): Promise<boolean> => {
    if (!opts.auto) return false;
    const phase = goalPhaseOf(await readAuditTail(root, AUDIT_WINDOW), await readContractSafe(root));
    return phase === "active" || phase === "paused" || (await readConfigSafe(root)).learning?.dailyCallLimit === 0;
  };
  const pause = () => finish({ kept: false, yielded: true, reason: "Learning yielded to the user's goal; compatible progress is saved for later", hypotheses: [], diff: "" });
  const exhausted = () => {
    const day = budgetState().daily_exhausted;
    return finish({ kept: false, ...(day ? { deferredUntil: daily.windowStarted + 86_400_000 } : {}), reason: day ? "Automatic learning reached this workspace's daily allowance; progress is saved" : "background learning reached its usage limit; the current reviewer is unchanged", hypotheses: [], diff: "" });
  };
  try {
  if (opts.auto && daily.used >= daily.limit) return finish({ kept: false, deferredUntil: daily.windowStarted + 86_400_000, reason: "Automatic learning is waiting for its workspace allowance", hypotheses: [], diff: "" });
  if (!est.heldOut || !est.evolve) return finish({ kept: false, reason: "not enough cases on both sides of the split yet", hypotheses: [], diff: "" });

  // A fresh RRSI checkout: their files, our domain, this workspace's cases and current reviewer.
  const base = rsiRoot(root);
  const repo = path.join(base, "repo");
  const runs = path.join(base, "runs");
  const current = reviewTemplate(root);
  const version = await replayVersion(root, rsi);
  const compatibility = createHash("sha256").update(JSON.stringify([labelSet, reviewTemplate(root), cfg, version, Boolean(opts.auto)])).digest("hex");
  const pending = await fsp.readFile(pendingFile, "utf8").then(JSON.parse).catch(() => null);
  const resume = pending?.compatibility === compatibility && typeof pending.start === "string" && fs.existsSync(repo);
  const log = path.join(base, "rrsi.log");
  let start: string;
  if (resume) {
    start = pending.start;
    if (opts.auto) {
      const state = await fsp.readFile(budget, "utf8").then(JSON.parse);
      state.limit = limit;
      state.exhausted = state.used >= (limit ?? Number.MAX_SAFE_INTEGER);
      if (daily.used < daily.limit) delete state.daily_exhausted;
      await fsp.writeFile(budget, JSON.stringify(state));
    }
    // Interrupted trials are retried; complete trials and accepted search history remain intact.
    const clean = async (dir: string): Promise<void> => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await clean(file);
        else if (/^(trial\d+|eval)\.json$/.test(entry.name)) {
          const rec = await fsp.readFile(file, "utf8").then(JSON.parse).catch(() => null);
          if (!rec || rec.missing > 0 || (entry.name.startsWith("trial") && (rec.flagged === null || Object.values(rec.feedback_matches ?? {}).some(v => v === null)))) await fsp.rm(file, { force: true });
        }
      }
    };
    await clean(runs);
  } else {
  await fsp.rm(base, { recursive: true, force: true });
  await fsp.mkdir(base, { recursive: true });
  await copyTree(rsi.rrsiDir, repo);
  const domain = path.join(repo, "domains", "cgg");
  await copyTree(rsi.domainDir, domain);
  if (opts.auto) {
    const file = path.join(domain, "rrsi.json");
    await fsp.writeFile(file, JSON.stringify({ ...JSON.parse(await fsp.readFile(file, "utf8")), ...cfg }));

  }
  await fsp.writeFile(budget, JSON.stringify({ limit: limit ?? Number.MAX_SAFE_INTEGER, used: 0, exhausted: false }));
  await fsp.mkdir(path.join(domain, "data"), { recursive: true });
  await fsp.writeFile(path.join(domain, "data", "tasks.json"), JSON.stringify(cases.map((c) => ({ id: c.reviewCase.id, case: c.reviewCase.id, label: c.label, feedback: c.targets, split: isHeldOut(c.reviewCase.id) ? "heldout" : "evolve" })), null, 1));
  await fsp.writeFile(path.join(domain, "data", "leak_terms.json"), JSON.stringify(leakTerms(cases)));
  const previousSearch = await fsp.readFile(path.join(getGuardianPaths(root).dir, "learning", "search-history.json"), "utf8").then(JSON.parse).catch(() => []);
  await fsp.writeFile(path.join(domain, "data", "previous_search.json"), JSON.stringify(previousSearch.slice(-20)));
  await fsp.mkdir(path.join(domain, "harness"), { recursive: true });
  await fsp.writeFile(path.join(domain, "harness", "reviewer.md"), current);
  await fsp.writeFile(path.join(base, ".gitignore"), "*\n");
  try {
    git(["init", "-q"], repo);
    git(["add", "-A"], repo);
    git(["commit", "-qm", "Guardian's reviewer, as it is now"], repo);
    start = git(["rev-parse", "HEAD"], repo).trim();
  } catch (err) {
    return finish({ kept: false, reason: `RRSI's checkout couldn't be set up: ${err instanceof Error ? err.message : String(err)}`, hypotheses: [], diff: "" });
  }
    await fsp.writeFile(pendingFile, JSON.stringify({ compatibility, start }));
  }
  const learning = path.join(getGuardianPaths(root).dir, "learning");
  const env: NodeJS.ProcessEnv = { ...process.env, CGG_REPLAY_VERSION: version, CGG_REPLAY_CACHE: path.join(learning, "replays"), CGG_FEEDBACK_CACHE: path.join(learning, "feedback-matches"), CGG_WORKSPACE: root, CGG_REPLAY: JSON.stringify(rsi.replay), PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1", CGG_MODEL_BUDGET: budget, ...(limit !== null ? { CGG_DAILY_MODEL_BUDGET: dailyFile } : {}) };
  delete env.GOAL_GUARDIAN_REVIEWING;
  const rrsi = async (args: string[]) => await foreground() ? { code: -1, out: "foreground work", yielded: true } : sh(rsi.python, [path.join(repo, "rrsi.py"), "--domain", "cgg", "--runs", runs, ...args], repo, env, log, opts.auto ? foreground : undefined);

  await progress(`Scoring the current reviewer on ${est.heldOut} cases RRSI won't see`);
  const before = await rrsi(["heldout", "--label", "before", "--ref", start]);
  if (before.yielded) return pause();
  if (limit !== null && budgetState().exhausted) return exhausted();
  if (before.code !== 0) return finish({ kept: false, reason: `RRSI couldn't score the current reviewer (see ${path.relative(root, log)})`, hypotheses: [], diff: "" });
  const reserved = cases.filter(c => isHeldOut(c.reviewCase.id));
  const heldOutLabels = new Map(reserved.flatMap(c => (c.targets ?? []).map(t => [`${c.reviewCase.id}/${t.key}`, t.label] as const)));
  const old = await heldOutScore(runs, "heldout_before", reserved);
  if (!old || [...heldOutLabels.keys()].some((id) => typeof old.get(id) !== "boolean")) {
    const reasons = await Promise.all(reserved.map((c) => c.reviewCase.id).map((id) => fsp.readFile(path.join(runs, "cgg", "jobs", "heldout_before", id, "trial0.json"), "utf8").then((raw) => (JSON.parse(raw) as { reason?: string }).reason).catch(() => undefined)));
    const detail = reasons.find(Boolean);
    return finish({ kept: false, reason: `the initial review checks did not finish${detail ? `: ${detail}` : ""}; no learning search was started`, hypotheses: [], diff: "" });
  }
  const baseline = compareHeldOutVerdicts(heldOutLabels, old, old).old;
  if (baseline.correct === heldOutLabels.size) return finish({ kept: false, old: baseline, reason: "the current reviewer was already correct on every reserved example; no learning search was needed", hypotheses: [], diff: "" });
  await progress(`RRSI is searching: ${cfg.T} rounds of ${cfg.m} candidates on ${est.evolve} cases`);
  const search = await rrsi(["run"]);
  if (search.yielded) return pause();
  if (limit !== null && budgetState().exhausted) return exhausted();
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
  if (after.yielded) return pause();
  if (limit !== null && budgetState().exhausted) return exhausted();
  if (after.code !== 0) return finish({ kept: false, reason: `RRSI couldn't score its winner (see ${path.relative(root, log)})`, hypotheses, diff });
  const neu = await heldOutScore(runs, "heldout_after", reserved);
  if (!old || !neu) return finish({ kept: false, reason: "the held-out replay records could not be read", hypotheses, diff });
  if (await foreground()) return pause();
  if (reviewTemplate(root) !== current || labelsFingerprint(await labelledCases(root)) !== labelSet) return finish({kept:false,reason:"The reviewer or your feedback changed during learning; no earlier result was installed",hypotheses,diff});
  const comparison = compareFeedbackResults(reserved, old, neu);
  if (!comparison.kept) return finish({ hypotheses, diff, ...comparison });
  await fsp.mkdir(path.dirname(candidatePath(root, id)), { recursive: true });
  await fsp.writeFile(candidatePath(root, id), winner, "utf8");
  return finish({ hypotheses, diff, ...comparison });
  } catch (err) {
    return finish({ kept: false, reason: `improvement stopped; the current reviewer is unchanged: ${err instanceof Error ? err.message : String(err)}`, hypotheses: [], diff: "" });
  }
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
  return createHash("sha256").update(cases.map(c => JSON.stringify([c.reviewCase.id, c.targets ?? c.label])).sort().join("\n")).digest("hex").slice(0, 16);
}

/**
 * Guardian improving its reviewer by itself. It runs when there are enough labelled cases of both kinds and at least
 * NEW_LABELS_PER_RUN more than the last try had, never two at once. RRSI's result is applied only when the gate in
 * improveReviewer kept it: more right on cases RRSI never saw, and no gap the current reviewer caught lost. Every
 * run and every apply is on the record, and the panel shows it with an Undo. Null when there was nothing to do.
 */
export async function autoImprove(root: string, rsi: RsiPaths): Promise<ImproveResult | null> {
  const records = await readAuditTail(root, AUDIT_WINDOW);
  // Finish the user's current work before spending model calls improving future reviews.
  const phase = goalPhaseOf(records, await readContractSafe(root));
  if (phase === "active" || phase === "paused") return null;
  const cases = await labelledCases(root, records);
  const preference = (await readConfigSafe(root)).learning?.dailyCallLimit ?? 32;
  if (!preference || !enoughToImprove(cases)) return null;
  const runs = records.filter((r): r is ImproveRunRecord => r.kind === "improve.run");
  const last = runs[runs.length - 1];
  if (last) {
    if (last.labels === labelsFingerprint(cases)) {
      if (!last.yielded) {
        if (!last.deferredUntil) return null;
        if (Date.now() < last.deferredUntil) {
          const allowance = await fsp.readFile(path.join(getGuardianPaths(root).dir, "learning/allowance.json"), "utf8").then(JSON.parse).catch(() => null);
          if (!allowance || allowance.used >= preference) return null;
        }
      }
    } else {
    const start = records.find((r) => r.kind === "improve.start" && r.id === last.id)?.ts ?? last.ts;
    const known = new Set(cases.map((c) => c.reviewCase.id));
    const fresh = new Set(records.filter((r) => r.kind === "review.feedback" && Date.parse(r.ts) > Date.parse(start) && known.has(r.reviewId)).map((r) => r.kind === "review.feedback" ? r.reviewId : ""));
    if (fresh.size < NEW_LABELS_PER_RUN) return null;
    }
  }
  const result = await improveReviewer(root, rsi, { auto: true });
  if (result.status === "running") return null;
  if (result.run?.kept) {
    const latestPhase = goalPhaseOf(await readAuditTail(root, AUDIT_WINDOW), await readContractSafe(root));
    if (latestPhase !== "active" && latestPhase !== "paused" && (await readConfigSafe(root)).learning?.dailyCallLimit !== 0) await applyImprovement(root, result.run.id, true);
  }
  return result;
}

/** Back to the built-in reviewer. */
export async function undoImprovement(root: string): Promise<void> {
  await removeHarness(root, "reviewer");
  await appendAudit(root, { ts: nowIso(), kind: "improve.undo" });
}
