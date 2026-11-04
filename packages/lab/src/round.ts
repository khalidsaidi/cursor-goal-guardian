/**
 * One review round: first passes (facts, claims, pieces, claim-breaking agents, drift check), the adversarial
 * reviewer in a throwaway copy, then a true-and-material check per objection. About 10-15 agent calls: a developer
 * tool for auditing agent work and measuring Guardian, not something to run on a user's plan.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import {
  environmentFacts,
  makeReviewCopy,
  runProjectTests,
  testCommandFromTape,
  turnDiff,
  type AuditRecord,
  type ConversationScope,
  type ShellRun,
} from "@goal-guardian/core";
import {
  buildReviewPrompt,
  parseReviewOutput,
  resolveAgentCommand,
  type ReviewHistoryRound,
  type ReviewObjection,
  type ReviewerRun,
  type ReviewerRunOptions,
  type TestRun,
} from "./review.js";
import { centralClaims, checkClaims, checkScope, claimFindings, extractClaims, falsificationFindings, falsificationObjections, falsificationPieces, falsifyClaims, filterObjections, pieceFindings, scopeObjections, scorePieces, setReviewGuidance, splitIntoPieces, type ReviewGuidance } from "./pieces.js";

const OBJECTION_CHECK_MS = 45_000;
const ANSWER_KEEP = 6_000;

export interface ReviewRoundResult {
  round: number;
  maxRounds: number;
  status: "objections" | "clean" | "open" | "error";
  objections: ReviewObjection[];
  error?: string;
  model?: string;
  tests?: { command: string; exit: number | "timeout" };
  durationMs: number;
}

function inScope(rec: { ts: string; conversationId?: string }, scope: ConversationScope): boolean {
  if (scope.conversationId && rec.conversationId) return rec.conversationId === scope.conversationId;
  if (!scope.sinceIso) return !scope.conversationId || !rec.conversationId;
  return Date.parse(rec.ts) >= Date.parse(scope.sinceIso);
}

export interface ReviewRoundInput {
  history: ReviewHistoryRound[];
  message: string;
  contract: { goal: string; successCriteria: Array<{ id: string; text: string }>; constraints: string[] };
  records: AuditRecord[];
  scope: ConversationScope;
  shellRuns: ShellRun[];
  plainLines: string[];
  maxRounds: number;
  timeoutMs: number;
  model?: string;
  agentPath?: string;
  verify: boolean;
  pieces: boolean;
  guidance: ReviewGuidance;
  tests: { enabled: boolean; command?: string; timeoutSeconds: number };
  reviewer: ReviewerRun;
}

/** cursor-agent's refusals when --model names a model the account cannot use: not on the plan, or its
 *  usage limit is spent ("You've hit your usage limit for Opus", seen live 2026-11-03). */
const UNAVAILABLE_MODEL = /Cannot use this model|hit your usage limit/i;

/** One reviewer call; mutates the chain (records the answer, appends objections). Never throws. */
export async function reviewRound(root: string, r: ReviewRoundInput): Promise<ReviewRoundResult> {
  const started = Date.now();
  setReviewGuidance(r.guidance);
  // The configured model not on this plan, or its limit spent: use Cursor's default for the rest of the round.
  let activeModel = r.model;
  const call: ReviewerRun = async (prompt, o) => {
    const { model: _m, ...rest } = o;
    const opts: ReviewerRunOptions = activeModel ? { ...rest, model: activeModel } : rest;
    const first = await r.reviewer(prompt, opts);
    if (!first.ok && opts.model && UNAVAILABLE_MODEL.test(first.error)) {
      activeModel = undefined;
      return r.reviewer(prompt, rest);
    }
    return first;
  };
  const history = r.history;
  // The message under review answers the previous round's objections.
  const last = history[history.length - 1];
  if (last) last.answer = r.message.slice(-ANSWER_KEEP);
  const round = history.length + 1;
  const final = history.length >= r.maxRounds;
  const base = { round, maxRounds: r.maxRounds };
  const command = resolveAgentCommand(r.agentPath);
  if (!command) {
    return { ...base, status: "error", objections: [], error: "cursor-agent not found (install it, or set doneCheck.review.agentPath)", durationMs: 0 };
  }
  const edits = [
    ...new Set(
      r.records
        .filter((x): x is Extract<AuditRecord, { kind: "action.observed" }> => x.kind === "action.observed" && x.actionType === "edit" && inScope(x, r.scope))
        .map((x) => x.actionValue)
        .filter((v) => v && !v.startsWith(".cursor/goal-guardian/")),
    ),
  ];
  // A throwaway copy to verify in: Guardian re-runs the tests there first, then the reviewer may run its own checks.
  const copy = r.verify ? await makeReviewCopy(root) : null;
  try {
  let testRun: TestRun | undefined;
  const testCommand = copy && r.tests.enabled ? testCommandFromTape(r.shellRuns, root, copy.dir, r.tests.command) : null;
  if (copy && testCommand) testRun = await runProjectTests(copy.dir, copy.scratch, testCommand, Math.min(r.tests.timeoutSeconds * 1000, r.timeoutMs / 3));
  const tests = testRun ? { tests: { command: testRun.command, exit: testRun.exit } } : {};
  const diff = turnDiff(root, edits);
  // Piece by piece first, read-only and in parallel, on a third of what is left of the budget.
  let pieceLines: string[] | undefined;
  let pieces: ReturnType<typeof splitIntoPieces> = [];
  let facts: string[] = [];
  let refuted: Array<{ line: string; objection: string }> = [];
  let drift: Array<{ line: string; objection: string }> = [];
  if (r.pieces) {
    pieces = splitIntoPieces(r.shellRuns, diff);
    {
      // First passes about 40% of what is left, the reviewer most of the rest, 45 s kept for the per-objection checks.
      const budget = Math.max(15_000, Math.min(150_000, (r.timeoutMs - (Date.now() - started)) * 0.4));
      const opts = { command, workspaceRoot: path.resolve(root), timeoutMs: budget, ...(r.model ? { model: r.model } : {}) };
      facts = await environmentFacts(copy?.dir ?? root);
      const claims = extractClaims(r.message);
      // Hidden changes show up piece by piece; false statements claim by claim; what only shows when run,
      // by trying to break the central claims in the copy. All at once.
      const [scores, verdicts, falsified, scope] = await Promise.all([
        scorePieces(call, opts, r.contract.goal, r.message, pieces),
        claims.length ? checkClaims(call, opts, r.contract.goal, facts, claims, pieces) : Promise.resolve([]),
        copy && claims.length ? falsifyClaims(call, opts, r.contract.goal, centralClaims(claims), copy) : Promise.resolve([]),
        checkScope(call, opts, r.contract.goal, r.contract.successCriteria.map((c) => c.text), r.contract.constraints, pieces),
      ]);
      drift = scopeObjections(scope);
      pieces = [...pieces, ...falsificationPieces(falsified)];
      refuted = falsificationObjections(falsified);
      pieceLines = [...falsificationFindings(falsified), "", ...claimFindings(facts, claims, verdicts), "", ...(scores.length ? pieceFindings(pieces, scores) : [])];
    }
  }
  const prompt = buildReviewPrompt({
    goal: r.contract.goal,
    successCriteria: r.contract.successCriteria.map((c) => ({ id: c.id, text: c.text })),
    constraints: r.contract.constraints,
    message: r.message,
    tape: r.shellRuns,
    edits,
    history,
    round,
    maxRounds: r.maxRounds,
    final,
    plainLines: r.plainLines,
    diff,
    workspaceRoot: path.resolve(root),
    ...(pieceLines ? { pieceLines } : {}),
    ...(copy ? { copyRoot: copy.dir } : {}),
    ...(testRun ? { testRun } : {}),
  });
  const timeoutMs = Math.max(15_000, r.timeoutMs - (Date.now() - started) - (r.pieces ? OBJECTION_CHECK_MS : 0));
  const options: ReviewerRunOptions = { command, workspaceRoot: path.resolve(root), timeoutMs, ...(copy ? { copy } : {}) };
  let ran = await call(prompt, options);
  const used = { model: activeModel ?? "auto", ...tests };
  let parsed = ran.ok ? parseReviewOutput(ran.stdout) : null;
  // A reply that ran but did not parse (seen once in 70 live calls) gets one more try;
  // a timeout or a failed start does not — the turn has already waited.
  if (ran.ok && !parsed && Date.now() - started < r.timeoutMs / 2) {
    ran = await call(prompt, options);
    parsed = ran.ok ? parseReviewOutput(ran.stdout) : null;
  }
  // Each surviving objection gets its own narrow true-and-material check.
  // A refuted claim is an objection even if the reviewer passed over it, or failed to answer at all.
  const reviewerFailed = !ran.ok || !parsed;
  if (refuted.length > 0) parsed = { objections: [...(parsed?.objections ?? []), ...refuted].slice(0, 6) };
  if (parsed && parsed.objections.length > 0 && r.pieces) {
    const left = Math.max(15_000, Math.min(90_000, r.timeoutMs - (Date.now() - started)));
    const { kept } = await filterObjections(call, { command, workspaceRoot: path.resolve(root), timeoutMs: left, ...(r.model ? { model: r.model } : {}) }, r.contract.goal, r.message, facts, parsed.objections, pieces);
    parsed = { objections: kept };
  }
  // Drift is judged against the request, not against what the message claims: the true-and-material check
  // does not apply to it. It goes straight to the agent: take it out, or say why it is needed.
  if (drift.length > 0) parsed = { objections: [...(parsed?.objections ?? []), ...drift].slice(0, 6) };
  const durationMs = Date.now() - started;
  if (reviewerFailed && (!parsed || parsed.objections.length === 0)) {
    return { ...base, ...used, status: "error", objections: [], error: !ran.ok ? ran.error.slice(0, 300) : "reviewer reply was not the expected JSON", durationMs };
  }
  if (!parsed) return { ...base, ...used, status: "error", objections: [], error: "reviewer reply was not the expected JSON", durationMs };
  if (parsed.objections.length === 0) return { ...base, ...used, status: "clean", objections: [], durationMs };
  if (final) return { ...base, ...used, status: "open", objections: parsed.objections, durationMs };
  history.push({ objections: parsed.objections });
  return { ...base, ...used, status: "objections", objections: parsed.objections, durationMs };
  } finally {
    if (copy) await fsp.rm(copy.scratch, { recursive: true, force: true }).catch(() => {});
  }
}
