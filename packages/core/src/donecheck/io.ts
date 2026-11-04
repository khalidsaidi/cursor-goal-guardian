import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { appendAudit, readAuditTail } from "../audit/log.js";
import { appendLine, readJsonFile, writeJsonAtomic } from "../fsutil.js";
import { nowIso } from "../clock.js";
import { getGuardianPaths } from "../paths.js";
import { readConfigSafe, readContractSafe } from "../safeReaders.js";
import type { AuditRecord } from "../schema/audit.js";
import { wrapupFollowup, doneCheckFollowup, evaluateDoneCheck, openWork, type DoneCheckResult, type ShellRun } from "./evaluate.js";
import type { TestRun } from "./sandbox.js";
import { makeReviewCopy, runProjectTests, runTestsWithoutChanges, testCommandFromTape } from "./sandbox.js";
import type { GuardianConfig } from "../schema/config.js";
import type { TestsRerunRecord } from "../schema/audit.js";
import { editsSince, lastSendBack, sendBackOutcomes, testsOutcome } from "./outcomes.js";
import { blockGoal, completeGoal, goalArmed, startGoalRound } from "../goal/service.js";
import { certifiesComplete, goalBlockedWrapup, goalBudgetLimit, goalContinuation, roundReason, syncGoal, unverifiedReasons } from "../goal/loop.js";

const OUTPUT_HEAD = 600;
const OUTPUT_TAIL = 3_400;
const SHELL_OUTPUT_KEEP = 300;
const SHELL_OUTPUT_ROTATE_BYTES = 2_000_000;
const RESPONSE_MAX_CHARS = 40_000;
const RESPONSES_KEEP = 20;
const AUDIT_SCAN = 5_000;

interface ShellOutputLine {
  ts: string;
  conversationId?: string;
  command: string;
  output: string;
  durationMs?: number;
}

/** Keep the head (what ran) and the tail (the summary every test runner prints last). */
function clip(output: string): string {
  if (output.length <= OUTPUT_HEAD + OUTPUT_TAIL) return output;
  return `${output.slice(0, OUTPUT_HEAD)}\n…\n${output.slice(-OUTPUT_TAIL)}`;
}

/** afterShellExecution: what the command printed, so quoted output can be checked. */
export async function recordShellOutput(
  root: string,
  entry: { conversationId?: string; command: string; output: string; durationMs?: number },
): Promise<void> {
  const p = getGuardianPaths(root).shellOutput;
  const line: ShellOutputLine = {
    ts: nowIso(),
    ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    command: entry.command.slice(0, 2_000),
    output: clip(entry.output),
    ...(typeof entry.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
  };
  await appendLine(p, JSON.stringify(line));
  try {
    const size = (await fsp.stat(p)).size;
    if (size > SHELL_OUTPUT_ROTATE_BYTES) {
      const kept = (await fsp.readFile(p, "utf8")).split("\n").filter(Boolean).slice(-SHELL_OUTPUT_KEEP);
      const tmp = `${p}.tmp-${process.pid}`;
      await fsp.writeFile(tmp, `${kept.join("\n")}\n`, "utf8");
      await fsp.rename(tmp, p);
    }
  } catch {
    // rotation is housekeeping; never fail the hook over it
  }
}

export async function readShellOutputs(root: string): Promise<ShellOutputLine[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(getGuardianPaths(root).shellOutput, "utf8");
  } catch {
    return [];
  }
  const out: ShellOutputLine[] = [];
  for (const line of raw.split("\n").slice(-SHELL_OUTPUT_KEEP * 2)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as ShellOutputLine;
      if (typeof v.command === "string" && typeof v.output === "string") out.push(v);
    } catch {
      // tolerate damaged telemetry
    }
  }
  return out;
}

/** Which records belong to this conversation. Records without an id (the
 * Windows observer) count only when they fall inside the conversation's window. */
export interface ConversationScope {
  conversationId?: string;
  sinceIso?: string;
}

function inScope(rec: { ts: string; conversationId?: string }, scope: ConversationScope): boolean {
  if (scope.conversationId && rec.conversationId) return rec.conversationId === scope.conversationId;
  if (!scope.sinceIso) return !scope.conversationId || !rec.conversationId;
  return Date.parse(rec.ts) >= Date.parse(scope.sinceIso);
}

/** When the conversation began, from its first taped hook event. */
export function conversationStart(records: AuditRecord[], conversationId: string | undefined): string | undefined {
  if (!conversationId) return undefined;
  const first = records.find((r) => r.kind === "hook.event" && r.conversationId === conversationId);
  return first?.ts;
}

export function shellRunsInScope(records: AuditRecord[], outputs: ShellOutputLine[], scope: ConversationScope): ShellRun[] {
  const runs: ShellRun[] = records
    .filter((r): r is Extract<AuditRecord, { kind: "action.observed" }> => r.kind === "action.observed" && r.actionType === "shell")
    .filter((r) => inScope(r, scope))
    .map((r) => ({ command: r.actionValue }));
  for (const o of outputs) {
    if (inScope(o, scope)) runs.push({ command: o.command, output: o.output });
  }
  return runs;
}

/** Shell/edit actions since this conversation's previous done check: what this turn changed. */
export function turnActionCount(records: AuditRecord[], scope: ConversationScope): number {
  let lastCheck = -1;
  records.forEach((r, i) => {
    if (r.kind === "done.check" && inScope(r, scope)) lastCheck = i;
  });
  return records
    .slice(lastCheck + 1)
    .filter((r) => r.kind === "action.observed" && (r.actionType === "shell" || r.actionType === "edit") && inScope(r, scope))
    .filter((r) => !(r.kind === "action.observed" && r.actionValue.startsWith(".cursor/goal-guardian/"))).length;
}

/** Line count for file:line evidence; null when the file is missing or outside the workspace. */
export function workspaceLineCounter(root: string): (rel: string) => number | null {
  const resolvedRoot = path.resolve(root);
  return (rel: string) => {
    const abs = path.resolve(resolvedRoot, rel);
    if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) return null;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > 20_000_000) return null;
      const text = fs.readFileSync(abs, "utf8");
      if (text.length === 0) return 0;
      const n = text.split("\n").length;
      return text.endsWith("\n") ? n - 1 : n;
    } catch {
      return null;
    }
  };
}

/** File contents for quote checks; null when missing, outside the workspace, or large. */
export function workspaceFileReader(root: string): (rel: string) => string | null {
  const resolvedRoot = path.resolve(root);
  return (rel: string) => {
    const abs = path.resolve(resolvedRoot, rel);
    if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) return null;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > 2_000_000) return null;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * The uncommitted changes to the given files: `git diff HEAD`
 * for tracked files, the head of the file for untracked new ones. Empty when
 * the workspace is not a git repository. Never throws.
 */
export function turnDiff(root: string, edits: string[], maxChars = 40_000): string {
  if (edits.length === 0) return "";
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 8_000_000, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  if (git(["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return "";
  const files = edits.slice(-50);
  let out = git(["diff", "HEAD", "--", ...files]) ?? "";
  const untracked = (git(["ls-files", "--others", "--exclude-standard", "--", ...files]) ?? "").split("\n").filter(Boolean);
  for (const f of untracked) {
    const read = workspaceFileReader(root)(f);
    if (read !== null) out += `\n--- new file: ${f}\n${read.split("\n").slice(0, 200).join("\n")}\n`;
  }
  return out.length > maxChars ? out.slice(0, maxChars) + "\n…[diff clipped]" : out;
}

interface StoredResponse {
  generationId?: string;
  text: string;
  ts: string;
}

/** afterAgentResponse: keep the final text so the stop hook can judge it. */
export async function storeLastResponse(root: string, conversationId: string, generationId: string | undefined, text: string): Promise<void> {
  const p = getGuardianPaths(root).lastResponses;
  let all: Record<string, StoredResponse> = {};
  try {
    all = (await readJsonFile(p)) as Record<string, StoredResponse>;
  } catch {
    all = {};
  }
  all[conversationId] = { ...(generationId ? { generationId } : {}), text: text.slice(-RESPONSE_MAX_CHARS), ts: nowIso() };
  const entries = Object.entries(all).sort((a, b) => Date.parse(b[1].ts) - Date.parse(a[1].ts)).slice(0, RESPONSES_KEEP);
  await writeJsonAtomic(p, Object.fromEntries(entries));
}

export async function readLastResponse(root: string, conversationId: string): Promise<StoredResponse | null> {
  try {
    const all = (await readJsonFile(getGuardianPaths(root).lastResponses)) as Record<string, StoredResponse>;
    return all[conversationId] ?? null;
  } catch {
    return null;
  }
}

/**
 * The final assistant text of the latest turn in a Cursor agent transcript
 * (JSONL: {role, message:{content:[{type:"text",text}]}} lines, then a
 * {"type":"turn_ended"} marker). The last text-bearing assistant entry is the
 * message the user reads.
 */
export function lastAssistantTextFromTranscript(jsonl: string): string | null {
  let last: string | null = null;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as { role?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
      if (v.role === "user") last = null;
      if (v.role !== "assistant") continue;
      const text = (v.message?.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("\n")
        .trim();
      if (text) last = text;
    } catch {
      // partial trailing line while Cursor is still writing
    }
  }
  return last;
}

export interface RunDoneCheckInput {
  message: string;
  conversationId?: string;
  generationId?: string;
  /** For id-less channels (the Windows observer): when the conversation began. */
  sinceIso?: string;
  source?: "observer";
  /** stop-hook context: whether a follow-up may be sent this time. */
  stop?: { status: string; loopCount: number };
}

export interface RunDoneCheckOutput {
  result: DoneCheckResult;
  followup: string | null;
}

/**
 * One chain = a user turn plus the follow-ups Guardian sent for it. Cursor's
 * loop_count says how many follow-ups the hook has triggered; a stop whose
 * loop_count is exactly one past the stop that sent our last follow-up is the
 * agent answering it. Anything else (the user typed) starts a fresh chain.
 * Verified live (Cursor IDE over WSL, 2026-11-02): loop_count runs 0,1,2,3
 * across follow-ups and resets to 0 on the next user message.
 */
interface FollowupChain {
  ts: string;
  /** loop_count at the stop that sent the pending follow-up; null when nothing is pending. */
  loopAtSend: number | null;
  detFollowups: number;
  /** "Keep going" follow-ups sent in this chain. */
  continues?: number;
  /** Whether the last follow-up was a keep-going, and how many keep-goings in a row got no action back. */
  lastContinued?: boolean;
  stalled?: number;
  /** A "blocked" was challenged once already; the next is accepted. */
  blockedChallenged?: boolean;
  /** The closing wrap-up request was sent. */
  wrapped?: boolean;
}

const CHAINS_KEEP = 20;
const CHAIN_MAX_AGE_MS = 60 * 60 * 1000;

async function readChains(root: string): Promise<Record<string, FollowupChain>> {
  try {
    const v = (await readJsonFile(getGuardianPaths(root).followupChains)) as Record<string, FollowupChain>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

async function writeChain(root: string, conversationId: string, chain: FollowupChain): Promise<void> {
  const all = await readChains(root);
  all[conversationId] = chain;
  const entries = Object.entries(all)
    .sort((a, b) => Date.parse(b[1].ts) - Date.parse(a[1].ts))
    .slice(0, CHAINS_KEEP);
  await writeJsonAtomic(getGuardianPaths(root).followupChains, Object.fromEntries(entries));
}

function continues(chain: FollowupChain | undefined, loopCount: number): chain is FollowupChain {
  return Boolean(
    chain &&
      chain.loopAtSend !== null &&
      loopCount === chain.loopAtSend + 1 &&
      Date.now() - Date.parse(chain.ts) < CHAIN_MAX_AGE_MS,
  );
}

/**
 * Evaluate and record one turn's done check, and re-run the tests after an editing turn. Returns null when
 * the mode is off. Follow-ups come only in enforce mode, from the stop hook, for a turn that completed
 * normally: first the code check (up to maxFollowups per chain), then the goal loop.
 */
export async function runDoneCheck(root: string, input: RunDoneCheckInput): Promise<RunDoneCheckOutput | null> {
  const config = await readConfigSafe(root);
  if (config.doneCheck.mode === "off" && !config.doneCheck.tests.enabled) return null;
  const records = await readAuditTail(root, AUDIT_SCAN);
  const sinceIso = input.sinceIso ?? conversationStart(records, input.conversationId);
  const scope: ConversationScope = {
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(sinceIso ? { sinceIso } : {}),
  };
  if (config.doneCheck.mode === "off") {
    // No block is asked for, but Guardian still re-runs the tests after a turn that edited files.
    const runs = shellRunsInScope(records, await readShellOutputs(root), scope);
    const check = await rerunTests(root, records, runs, scope, config.doneCheck.tests, input);
    if (check) {
      await appendAudit(root, check.record);
      const green = testsOutcome(records, scope, check.record);
      if (green) await appendAudit(root, green);
      await fsp.rm(check.scratch, { recursive: true, force: true }).catch(() => {});
    }
    return null;
  }
  const contract = await readContractSafe(root);
  const outputs = await readShellOutputs(root);
  const turnActions = turnActionCount(records, scope);
  const shellRuns = shellRunsInScope(records, outputs, scope);

  const enforcing =
    config.doneCheck.mode === "enforce" && input.stop !== undefined && input.stop.status === "completed" && Boolean(input.conversationId);
  const loopCount = input.stop?.loopCount ?? 0;
  const prior = enforcing ? (await readChains(root))[input.conversationId!] : undefined;
  const continuing = enforcing && continues(prior, loopCount);
  const chain: FollowupChain = continuing ? prior! : { ts: nowIso(), loopAtSend: null, detFollowups: 0 };

  let result = evaluateDoneCheck(input.message, {
    criterionIds: contract.successCriteria.map((c) => c.id),
    criterionTexts: contract.successCriteria.map((c) => c.text),
    shellRuns,
    turnActions,
    // Answering Guardian's own follow-up still owes the block, even with no new actions.
    ...(continuing ? { required: true } : {}),
    lineCount: workspaceLineCounter(root),
    readFile: workspaceFileReader(root),
  });
  // Guardian's own test re-run — unless the agent is about to be sent back over its block anyway.
  const sendingBack = enforcing && doneCheckFollowup(result) !== null && chain.detFollowups < config.doneCheck.maxFollowups;
  const check = sendingBack ? null : await rerunTests(root, records, shellRuns, scope, config.doneCheck.tests, input);
  try {
  if (check) {
    await appendAudit(root, check.record);
    const green = testsOutcome(records, scope, check.record);
    if (green) await appendAudit(root, green);
    // A "done" over tests this turn broke is contradicted — unless the block declares a gap.
    if (check.record.broke && result.verdict === "pass" && !result.lines.some((l) => l.status === "gap")) {
      result = { ...result, verdict: "fail", problems: [...result.problems, brokeProblem(check.record)] };
    }
  }

  let followup: string | null = null;
  const open = openWork(result);
  let continued = false;
  let wrapped = false;
  // Without a stop-hook id (CLI, observer) the old per-turn cap still applies.
  if (config.doneCheck.mode === "enforce" && input.stop?.status === "completed" && !input.conversationId) {
    followup = loopCount < config.doneCheck.maxFollowups ? doneCheckFollowup(result) : null;
  }
  if (enforcing) {
    const deterministic = doneCheckFollowup(result);
    if (deterministic) {
      if (chain.detFollowups < config.doneCheck.maxFollowups) {
        followup = deterministic;
        chain.detFollowups += 1;
      }
    }
    // The goal loop (Guardian certifies completion): keep going toward the full objective,
    // challenge a first "blocked", stop on a stall, wrap up at the budget. One goal, event-sourced on the tape.
    if (!followup) {
      const cap = config.doneCheck.continueRounds;
      const synced = await syncGoal(root, contract, config.doneCheck.goalRounds);
      let goal = synced.goal;
      // A keep-going answered with no command and no edit made no progress.
      if (continuing && chain.lastContinued) chain.stalled = turnActions === 0 ? (chain.stalled ?? 0) + 1 : 0;
      const stalled = (chain.stalled ?? 0) >= STALL_TURNS;
      const inGoal = (chain.continues ?? 0) > 0;
      const agentHolds = result.verdict === "blocked" && /^(?:me|myself|i|agent|the agent|assistant|ai)\b/i.test(result.lines.find((l) => l.key === "who")?.note ?? "");
      const challengeBlocked = result.verdict === "blocked" && (inGoal || agentHolds) && !chain.blockedChallenged;
      // Completion is certified on evidence, never on the agent's word.
      if (goal && goal.phase === "active" && certifiesComplete(result, { open, testsBroke: check?.record.broke === true, criteria: contract.successCriteria.length })) {
        goal = await completeGoal(root);
      }
      const claimUnverified = goal?.phase === "active" && goal.claimedComplete === true;
      const want = open.length > 0 || challengeBlocked || claimUnverified;
      if (goal && goalArmed(goal) && cap > 0 && !stalled && (chain.continues ?? 0) < cap && want) {
        const round = await startGoalRound(root);
        if (round.admitted) {
          chain.continues = (chain.continues ?? 0) + 1;
          if (challengeBlocked && open.length === 0) chain.blockedChallenged = true;
          const reason =
            open.length > 0
              ? roundReason("open", open, round.goal.roundsStarted, round.goal.maxRounds)
              : challengeBlocked
                ? roundReason("blocked", [result.lines.find((l) => l.key === "what")?.note ?? "the blocker"], round.goal.roundsStarted, round.goal.maxRounds)
                : roundReason("claim", unverifiedReasons(result, contract.successCriteria.length), round.goal.roundsStarted, round.goal.maxRounds);
          followup = goalContinuation(round.goal, reason, synced.objectiveUpdated);
          continued = true;
        } else if (!chain.wrapped) {
          chain.wrapped = true;
          followup = goalBudgetLimit(round.goal, Math.round((Date.now() - Date.parse(round.goal.createdAt)) / 1000));
          wrapped = true;
        }
      } else if (goal && goal.phase === "active" && inGoal && want && !chain.wrapped) {
        chain.wrapped = true;
        if (stalled) {
          const reason = "No progress: the last keep-going rounds brought no command and no edit.";
          goal = await blockGoal(root, goal.revision, { code: "no-progress", message: reason }, "guardian");
          followup = goalBlockedWrapup(goal, reason);
        } else followup = wrapupFollowup(open, false);
        wrapped = true;
      }
      // A "blocked" that holds up (challenged once already, or someone else's blocker) is the goal's state.
      if (goal && goal.phase === "active" && result.verdict === "blocked" && !challengeBlocked && !followup) {
        await blockGoal(root, goal.revision, { code: "agent-reported", message: (result.lines.find((l) => l.key === "what")?.note ?? "blocked").slice(0, 300) }, "agent");
      }
    }
    chain.lastContinued = continued;
    chain.loopAtSend = followup ? loopCount : null;
    chain.ts = nowIso();
    // Also clear a stale pending follow-up the agent never answered (cancelled turn).
    if (followup || continuing || (prior && prior.loopAtSend !== null)) await writeChain(root, input.conversationId!, chain);
  }

  const checkTs = nowIso();
  // The agent just answered a send-back: how did that flag turn out?
  const answered = continuing ? lastSendBack(records, scope) : null;
  if (answered) {
    const outcomes = sendBackOutcomes(
      answered,
      {
        ts: checkTs,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        verdict: result.verdict,
        open,
      },
      editsSince(records, scope, answered.ts),
    );
    for (const o of outcomes) await appendAudit(root, o);
  }

  await appendAudit(root, {
    ts: checkTs,
    kind: "done.check",
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.generationId ? { generationId: input.generationId } : {}),
    verdict: result.verdict,
    required: result.required,
    lines: result.lines,
    problems: result.problems,
    turnActions,
    followupSent: followup !== null,
    ...(open.length ? { open } : {}),
    ...(continued ? { continued: true } : {}),
    ...(wrapped ? { wrapped: true } : {}),
    ...(input.stop ? { loopCount } : {}),
    ...(input.source ? { source: input.source } : {}),
  });
  return { result, followup };
  } finally {
    if (check) await fsp.rm(check.scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Keep-goings answered with no action, in a row, before Guardian stops sending more. */
const STALL_TURNS = 2;
const BROKE_OUTPUT_SHOWN = 300;

function brokeProblem(r: TestsRerunRecord): string {
  const tail = (r.output ?? "").trim().split("\n").filter((l) => l.trim()).slice(-6).join(" | ").slice(-BROKE_OUTPUT_SHOWN);
  return `Guardian re-ran \`${r.command}\` in a clean copy: it fails with this turn's changes (exit ${r.exit}) and passes without them — this turn broke it.${tail ? ` Last output: ${tail}` : ""}`;
}

/** Did this turn edit files? Since this conversation's last done check or test re-run. */
function turnEdited(records: AuditRecord[], scope: ConversationScope): boolean {
  let last = -1;
  records.forEach((r, i) => {
    if ((r.kind === "done.check" || r.kind === "tests.rerun") && inScope(r, scope)) last = i;
  });
  return records
    .slice(last + 1)
    .some((r) => r.kind === "action.observed" && r.actionType === "edit" && inScope(r, scope) && !r.actionValue.startsWith(".cursor/"));
}

interface TestCheck {
  record: TestsRerunRecord;
  testRun: TestRun;
  /** Still the agent's working tree (null if git could not restore it after the baseline run). */
  copy: { dir: string; scratch: string } | null;
  /** Remove when done. */
  scratch: string;
}

/**
 * No model: re-run the project's tests in a throwaway copy after a turn that edited files. When they
 * fail, run them once more with the turn's changes set aside, to tell "broke them" from "already failing".
 */
async function rerunTests(
  root: string,
  records: AuditRecord[],
  shellRuns: ShellRun[],
  scope: ConversationScope,
  tests: GuardianConfig["doneCheck"]["tests"],
  input: { conversationId?: string; source?: "observer" },
): Promise<TestCheck | null> {
  if (!tests.enabled || !turnEdited(records, scope)) return null;
  const copy = await makeReviewCopy(root);
  if (!copy) return null;
  const command = testCommandFromTape(shellRuns, root, copy.dir, tests.command);
  if (!command) {
    await fsp.rm(copy.scratch, { recursive: true, force: true }).catch(() => {});
    return null;
  }
  const started = Date.now();
  const timeoutMs = tests.timeoutSeconds * 1000;
  const testRun = await runProjectTests(copy.dir, copy.scratch, command, timeoutMs);
  let baselineExit: number | "timeout" | undefined;
  let restored = true;
  if (typeof testRun.exit === "number" && testRun.exit !== 0) {
    const b = await runTestsWithoutChanges(copy.dir, copy.scratch, command, timeoutMs);
    if (b.run) baselineExit = b.run.exit;
    restored = b.restored;
  }
  const record: TestsRerunRecord = {
    ts: nowIso(),
    kind: "tests.rerun",
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.source ? { source: input.source } : {}),
    command,
    exit: testRun.exit,
    ...(baselineExit !== undefined ? { baselineExit } : {}),
    broke: baselineExit === 0,
    ...(testRun.exit !== 0 ? { output: testRun.output.slice(-1_500) } : {}),
    durationMs: Date.now() - started,
  };
  return { record, testRun, copy: restored ? copy : null, scratch: copy.scratch };
}
