/**
 * The goal loop. When the agent stops after working on a goal, Guardian compares its report with Guardian's own
 * record and sends it back with the facts, until the goal is proved, the agent is truly blocked, the user set it
 * aside, the work stalls, or the rounds run out. It coordinates the goal keepers and independent checks; it never blocks a user tool.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { getGuardianPaths } from "../paths.js";
import { appendAudit, readAuditTail, readGoalRecords } from "../audit/log.js";
import { newId, nowIso } from "../clock.js";
import { readContractSafe } from "../safeReaders.js";
import type { Contract } from "../schema/contract.js";
import type { AuditRecord, GoalEndRecord, GoalReportRecord, GoalControlRecord, GoalReviewRecord, GoalRoundRecord, UserMessageRecord } from "../schema/audit.js";
import { capturedEvidence, projectPath, userAsked, userSaidLatest, type GoalEvaluation } from "./evaluate.js";
import { CLOSING, goalBlock, goalBudgetLimitMessage, goalChangedMessage, goalClosingMessage, goalRoundMessage } from "./prompts.js";
import { budgetOf, codexGoals, codexTool, codexTurn, resolveCodexGoals, type CodexGoal, type CodexGoalAnswer, type CodexToolAnswer, type CodexUsage } from "./codexGoals.js";
import { reviewEvidence } from "./evidence.js";
import { verificationState } from "./verificationState.js";
import { codexContinuationTurn, codexNotice, codexSaid, codexUserFragment, codexUserSet, codexUserStatus, recordRefusal } from "./partners.js";
import { BLOCKED_AFTER_CONSECUTIVE_ROUNDS, CODEX_TOOLS, ROUND_LIMIT_CODE, deepseekBlockThreshold } from "./originals.js";
import { captureGoal, parseRequest } from "./capture.js";
import { writeContract } from "../contractStore.js";
import { criteriaFromTexts } from "../schema/contract.js";
import { EngineRefused, engineRun, type EngineOp, type EngineResult, type EngineToolResult } from "./engine.js";
import { engineView, type EngineGoal } from "./engineFold.js";
import { MAX_REVIEWS, REVIEW_POLICY, REVIEW_BUDGET_MS, REVIEW_HARD_LIMIT, completionScope, adjudicate, claimsToAdjudicate, objectionLines, runReview, reviewTemplate } from "./review.js";
import { GOAL_RESTORED, guardContract } from "./guard.js";
import { EVALUATOR_BUDGET_MS, runEvaluator } from "./evaluator.js";
import { readTrajectory } from "./trajectory.js";
import { saveCase } from "./cases.js";
import { folderChanges, readCommitted, readFolder, readFolderAtMessage, readShellOutputs, readShrunkFiles, readTree, readUserPrompts, type TreeState } from "./record.js";

/** Per user message. Only real progress keeps a run going this long: see NO_PROGRESS_ROUNDS. */
export const GOAL_MAX_ROUNDS = 20;
/** Cursor's own cap: every round plus the closing hand-off. */
export const GOAL_LOOP_LIMIT = GOAL_MAX_ROUNDS + 1;
/** DeepSeek Harness's threshold, which is also the one Codex's prompt names. */
export const GOAL_BLOCKED_AFTER_TURNS = BLOCKED_AFTER_CONSECUTIVE_ROUNDS;
/** How the hook sees the agent's report: a call to Guardian's update_goal. */
const REPORT_CALL = `/${CODEX_TOOLS.update.name}`;
/** Rounds in a row with nothing changed before Guardian stops sending the agent back. */
const NO_PROGRESS_ROUNDS = 3;
/** The blocker code DeepSeek's goal tool records for a block the model itself reported (tool-goal/src/index.ts). */
const MODEL_REPORTED_CODE = "model-reported";
/** Guardian's own blocker code, in the form their service requires. */
const NO_PROGRESS_CODE = "no-progress";

/** The chat on a run's end when no hook named the chat that reported. */
const UNKNOWN_CHAT = "unknown";

/** Long enough that a proved goal stays proved through a long session. */
const TAPE_WINDOW = 20_000;

const GUARDIAN_FILES = /^\.cursor\/goal-guardian\/(contract|state|actions)/;

export function goalHash(contract: Pick<Contract, "goal" | "successCriteria"> & Partial<Pick<Contract, "constraints">>): string {
  return createHash("sha256").update(JSON.stringify({ goal: contract.goal.trim(), criteria: contract.successCriteria.map((c) => c.text), constraints: contract.constraints ?? [] })).digest("hex").slice(0, 16);
}

const isEdit = (r: AuditRecord): r is Extract<AuditRecord, { kind: "action.observed" }> => r.kind === "action.observed" && r.actionType === "edit";
/** Goal work happens in the project: not in Guardian's own files, and not outside the root. */
const inProject = (file: string): boolean => !file.startsWith(".cursor/") && !file.startsWith("../") && !path.isAbsolute(file);

interface Sequence {
  /** Everything after the last time this chat's goal run closed. */
  records: AuditRecord[];
  rounds: GoalRoundRecord[];
  report: GoalReportRecord | null;
  editedFiles: string[];
  /** This chat edited something, or a command changed something, since the user's latest message. */
  changedThisTurn: boolean;
  goalFileEdited: boolean;
  lastEditTs: string | null;
  /** What was already changed when this run began. */
  dirtyAtStart: Set<string>;
  tree: TreeState | null;
  /** The chat's latest mode: "none" when a message arrived with no mode at all, which is Cmd+K. */
  mode: string | null;
}

/**
 * A tool can't see which chat called it, but the hook just before it can: a report belongs to the chat whose
 * call to the tool came right before it. With no such call on the record it counts for whoever asks.
 */
function reportsOf(records: AuditRecord[], conversationId: string | undefined): GoalReportRecord[] {
  const out: GoalReportRecord[] = [];
  let caller: string | undefined;
  for (const r of records) {
    if (r.kind === "action.observed" && r.actionType === "mcp" && r.actionValue.endsWith(REPORT_CALL)) caller = r.conversationId;
    if (r.kind === "goal.report") {
      if (caller === undefined || conversationId === undefined || caller === conversationId) out.push(r);
      caller = undefined;
    }
  }
  return out;
}

/** The chat about to report: the one whose hook just announced the call. Unknown means every chat's work counts. */
function reportingChat(all: AuditRecord[]): string | undefined {
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const r = all[i]!;
    if (r.kind === "action.observed" && r.actionType === "mcp" && r.actionValue.endsWith(REPORT_CALL)) return r.conversationId;
  }
  return undefined;
}

function readSequence(root: string, all: AuditRecord[], conversationId: string | undefined, hash: string): Sequence {
  const mineOnly = <T extends { conversationId?: string | undefined }>(r: T): boolean => conversationId === undefined || r.conversationId === conversationId;
  let from = 0;
  all.forEach((r, i) => {
    // A run ended by a report whose chat the hook didn't name ends it for whoever asks.
    if (r.kind === "goal.end" && (mineOnly(r) || r.conversationId === UNKNOWN_CHAT)) from = i + 1;
  });
  const records = all.slice(from);
  const mine = records.filter(isEdit).filter(mineOnly);
  const lastEdit = [...all].reverse().find((r) => isEdit(r) && inProject(r.actionValue));
  const reports = reportsOf(records, conversationId).filter((r) => !r.goalHash || r.goalHash === hash);
  const messages = records.filter((r): r is UserMessageRecord => r.kind === "user.message" && mineOnly(r));
  const latestMessage = messages[messages.length - 1];
  const tree = readTree(root);
  // Files a command changed, measured from what was already changed when this run began.
  // The first message that came with a reading of the tree: a folder can become a git repository after a run began.
  const firstRead = messages.find((m) => m.dirty);
  const before = new Set(firstRead?.dirty ?? []);
  const byCommand = firstRead?.dirty && tree ? tree.paths.filter((f) => !before.has(f)) : [];
  const atLatest = new Set(latestMessage?.dirty ?? []);
  const newThisTurn = latestMessage?.dirty && tree ? tree.paths.some((f) => !atLatest.has(f)) : false;
  const sinceLatest = latestMessage ? mine.filter((r) => Date.parse(r.ts) >= Date.parse(latestMessage.ts)) : mine;
  // A file can change because the person saved it. It's the agent's change only if the agent ran a command this turn.
  const ranCommand = records.some((r) => r.kind === "action.observed" && r.actionType === "shell" && mineOnly(r) && (!latestMessage || Date.parse(r.ts) >= Date.parse(latestMessage.ts)));
  // Work a command committed before the turn ended leaves the tree clean: the commit the project moved to shows it.
  const firstHead = messages.find((m) => m.head)?.head;
  const committed = tree?.head && firstHead ? readCommitted(root, firstHead, tree.head) : [];
  const committedThisTurn = Boolean(tree?.head && latestMessage?.head && tree.head !== latestMessage.head);
  // Outside git there is no tree to read: the folder itself, against how it was when the user's message arrived.
  const folderBefore = tree ? null : readFolderAtMessage(root);
  const folderNow = folderBefore ? readFolder(root) : null;
  const outside = folderBefore && folderNow ? folderChanges(folderBefore, folderNow) : [];
  return {
    records,
    rounds: records.filter((r): r is GoalRoundRecord => r.kind === "goal.round" && mineOnly(r)),
    report: reports[reports.length - 1] ?? null,
    editedFiles: [...new Set([...mine.map((r) => r.actionValue), ...byCommand, ...committed, ...outside].filter(inProject))],
    changedThisTurn: ((newThisTurn || committedThisTurn || outside.length > 0) && ranCommand) || sinceLatest.some((r) => inProject(r.actionValue)),
    goalFileEdited: mine.some((r) => GUARDIAN_FILES.test(r.actionValue)),
    lastEditTs: lastEdit?.ts ?? null,
    dirtyAtStart: before,
    tree,
    mode: latestMessage ? (latestMessage.mode ?? "none") : null,
  };
}

/** Modes where the agent edits on the user's behalf. Unknown means no message was seen, so don't hold it back. */
const NOT_GOAL_WORK = new Set(["none", "chat", "ask", "plan", "project"]);
export function agentMode(mode: string | null | undefined): boolean {
  return !mode || !NOT_GOAL_WORK.has(mode);
}

export type GoalPhase = "none" | "active" | "paused" | "complete";

/**
 * Where the goal stands, read from DeepSeek Harness's own fold over the engine events Guardian saved in these
 * records. Guardian keeps those events in step with its own goal file, which is the master copy. Their `blocked` is a goal Guardian still shows as open (the run that blocked says
 * so); a completed goal whose words differ from the contract's has been replaced by a new request. Records with no
 * engine events (a workspace from before the engine) are read the old way.
 */
export function goalPhaseOf(all: AuditRecord[], contract: Pick<Contract, "goal" | "successCriteria">): GoalPhase {
  if (!contract.goal.trim()) return "none";
  const view = engineView(all);
  if (view === undefined) return legacyGoalPhase(all, contract);
  if (view === null) return "active";
  if (view.phase === "complete") return view.objective === contract.goal.trim() ? "complete" : "active";
  return view.phase === "paused" ? "paused" : "active";
}

/** The phase as Guardian's own records gave it before the engine: only read to seed the engine in an older workspace. */
export function legacyGoalPhase(all: AuditRecord[], contract: Pick<Contract, "goal" | "successCriteria">): GoalPhase {
  if (!contract.goal.trim()) return "none";
  const hash = goalHash(contract);
  let phase: GoalPhase = "active";
  for (const r of all) {
    if (r.kind === "goal.end" && r.goalHash === hash && r.outcome === "proved") phase = "complete";
    if (r.kind === "goal.control" && r.goalHash === hash) {
      phase = r.operation === "pause" ? "paused" : r.operation === "resume" ? "active" : "complete";
    }
  }
  return phase;
}

/**
 * One change through DeepSeek's goal service, with the contract's words and, for a workspace older than the engine,
 * the phase Guardian's own records showed. Returns null when their service refuses; anything else is thrown.
 */
async function engine(root: string, contract: Pick<Contract, "goal" | "successCriteria">, op: EngineOp, objective = contract.goal, mirror = true): Promise<EngineResult | null> {
  const done = await engineTry(root, contract, op, objective, mirror);
  return done.ok ? done.result : null;
}

/** The same, keeping their own words when they refuse. */
async function engineTry(root: string, contract: Pick<Contract, "goal" | "successCriteria">, op: EngineOp, objective = contract.goal, mirror = true): Promise<{ ok: true; result: EngineResult } | { ok: false; message: string }> {
  try {
    const result = await engineRun(root, objective, legacyGoalPhase(await readGoalRecords(root), contract), op);
    // Agent state changes are mirrored explicitly after DeepSeek accepts them.
    if (mirror && !("by" in op && op.by === "agent")) await tellCodexStore(root, objective, op);
    return { ok: true, result };
  } catch (err) {
    // Their code refusing is an answer. Their code not being reachable (another process holds the goal's log) is not:
    // that is thrown, so nothing is taken as decided.
    if (err instanceof EngineRefused && err.code !== "ENGINE_BUSY") return { ok: false, message: err.message };
    throw err;
  }
}

/**
 * One of DeepSeek's goal tools, run through their own tool pipeline with their authority checks. `goal_id` and
 * `revision` default to the current goal's, so a call in Codex's shape (a status, no ref) still reaches their tool.
 */
export async function runGoalTool(root: string, name: "get_goal" | "create_goal" | "update_goal", args: Record<string, unknown>): Promise<EngineToolResult> {
  const contract = await readContractSafe(root);
  const view = engineView(await readGoalRecords(root));
  const filled = name === "update_goal" && view ? { goal_id: view.id, revision: view.revision, ...args } : args;
  // A goal the contract holds and their log doesn't yet (an older workspace) is created first, so their tool has it.
  const objective = name === "create_goal" || !contract.goal.trim() ? undefined : contract.goal;
  try {
    const result = await engineRun(root, objective, legacyGoalPhase(await readGoalRecords(root), contract), { type: "tool", name, args: filled });
    return result.tool ?? { isError: true, text: "their tool gave no result", contexts: [] };
  } catch (err) {
    if (err instanceof EngineRefused) return { isError: true, text: err.message, contexts: [] };
    throw err;
  }
}

/** DeepSeek's /goal command, run through their command runtime: the text after "/goal". */
export async function runGoalCommand(root: string, input: string): Promise<{ kind: string; text: string; goal: EngineGoal | null }> {
  try {
    const result = await engineRun(root, undefined, "none", { type: "command", input });
    return { ...(result.command ?? { kind: "error", text: "their command gave no result" }), goal: result.goal };
  } catch (err) {
    if (err instanceof EngineRefused) return { kind: "error", text: err.message, goal: null };
    throw err;
  }
}

/**
 * After one of their tools or their /goal command changed the objective, the contract (the home of the goal's
 * words and its "done when" items) follows their log: a new objective replaces the goal, a cleared one empties it.
 */
async function contractFollowsEngine(root: string, items: string[] = [], codexOp: EngineOp = { type: "sync" }): Promise<void> {
  const contract = await readContractSafe(root);
  const view = engineView(await readGoalRecords(root));
  if (view === undefined) return;
  const objective = view?.objective ?? "";
  if (objective === contract.goal.trim()) {
    if (codexOp.type === "create") await tellCodexStore(root, objective, codexOp);
    return;
  }
  const saved = await writeContract(root, { ...contract, goal: objective, successCriteria: criteriaFromTexts(items) });
  if (objective) {
    const conversationId = reportingChat(await readAuditTail(root, TAPE_WINDOW));
    await appendAudit(root, { ts: nowIso(), kind: "goal.set", goalHash: goalHash(saved), ...(conversationId ? { conversationId } : {}) });
  }
  await tellCodexStore(root, objective, codexOp);
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Codex's own get_goal answer, through its real handler, or undefined where its extension isn't installed. */
export async function codexGetGoal(root: string): Promise<unknown> {
  const asked = await codexToolOrMissing(root, "get_goal");
  return asked.answer ? codexSaid(asked.answer) : { did_not_run: asked.missing };
}

const NOT_THE_USERS = "only the user sets or changes the goal. Pass the objective in their own words, quoted exactly from their latest message.";

/**
 * Their create_goal, for the agent. Guardian's own rule comes first (the goal is the user's words), then their tool
 * decides with its rules: a direct human turn, and no unfinished goal already there.
 */
export async function createGoalByTool(root: string, objective: string, maxGoalRounds?: number): Promise<EngineToolResult> {
  await guardContract(root).catch(() => false);
  const prompts = await readUserPrompts(root);
  if (prompts && !userSaidLatest(objective, prompts)) return { isError: true, text: `Not created: ${NOT_THE_USERS}`, contexts: [] };
  const { goal, items } = parseRequest(prompts?.at(-1) ?? objective);
  // DeepSeek owns creation and its unfinished-goal/authority rules. Codex receives the accepted objective
  // through its GoalService so its budget ledger and continuation context follow the same goal.
  const out = await runGoalTool(root, "create_goal", { objective: goal, ...(maxGoalRounds ? { max_goal_rounds: maxGoalRounds } : {}) });
  if (out.isError) {
    await recordRefusal(root, goalHash(await readContractSafe(root)), "create", "deepseek", out.text);
    return out;
  }
  await contractFollowsEngine(root, items, { type: "create" });
  return out;
}

/** Their update_goal actions that Guardian's report path doesn't cover: edit (the user's new words) and resume. */
export async function updateGoalByTool(root: string, args: { goal_id?: string; revision?: number; action: "edit" | "resume"; objective?: string; max_goal_rounds?: number }): Promise<EngineToolResult> {
  await guardContract(root).catch(() => false);
  let items: string[] = [];
  const pass: Record<string, unknown> = { action: args.action, ...(args.goal_id ? { goal_id: args.goal_id } : {}), ...(args.revision ? { revision: args.revision } : {}), ...(args.max_goal_rounds ? { max_goal_rounds: args.max_goal_rounds } : {}) };
  if (args.action === "edit" && args.objective?.trim()) {
    const prompts = await readUserPrompts(root);
    if (prompts && !userSaidLatest(args.objective, prompts)) return { isError: true, text: `Not changed: ${NOT_THE_USERS}`, contexts: [] };
    const parsed = parseRequest(prompts?.at(-1) ?? args.objective);
    items = parsed.items;
    pass.objective = parsed.goal;
  }
  const out = await runGoalTool(root, "update_goal", pass);
  if (!out.isError && args.action === "edit") await contractFollowsEngine(root, items);
  if (!out.isError && args.action === "resume") await tellCodexStore(root, (await readContractSafe(root)).goal, { type: "resume" });
  return out;
}

/** The text after the command word, when a message is itself the /goal command (or Guardian's /guardian-goal skill for it). */
export function goalCommandIn(message: string): string | null {
  const m = /^\s*\/(?:guardian-goal|goal)(?![\w-])[ \t]*([\s\S]*)$/i.exec(message);
  return m ? m[1]!.trim() : null;
}

/**
 * Their /goal command, for the user. Anything but the bare status view changes the goal, so where Cursor reports
 * the user's messages, the user's latest message must itself be the command: a message that merely contains the
 * word "pause" or "clear" is not one. What runs is what the user typed after the command, read by DeepSeek's own
 * command handler; the agent only passes it on.
 */
export async function runUserGoalCommand(root: string, input: string): Promise<{ kind: string; text: string }> {
  await guardContract(root).catch(() => false);
  let typed = input.trim();
  if (typed) {
    const plain = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
    const latest = (await readUserPrompts(root))?.at(-1);
    if (latest !== undefined) {
      const fromUser = goalCommandIn(latest);
      if (fromUser === null || plain(fromUser) !== plain(typed)) {
        return { kind: "error", text: "Not run: /goal commands that change the goal are the user's. The user's latest message has to be the command itself (/goal or /guardian-goal followed by what to do); pass exactly what they typed after it." };
      }
      typed = fromUser;
    }
  }
  const out = await runGoalCommand(root, typed);
  if (out.kind === "success" && typed) {
    await contractFollowsEngine(root);
    const contract = await readContractSafe(root);
    const control = typed.toLowerCase();
    if (contract.goal.trim() && (control === "pause" || control === "resume")) {
      await appendAudit(root, { ts: nowIso(), kind: "goal.control", goalHash: goalHash(contract), operation: control, actor: "user" });
      await tellCodexStore(root, contract.goal, { type: control });
    }
  }
  return { kind: out.kind, text: out.text };
}

/** The goal as DeepSeek's log has it, read with their fold. */
export async function engineGoal(root: string): Promise<EngineGoal | null> {
  return engineView(await readGoalRecords(root)) ?? null;
}

/** Guardian's blocker code for a goal stopped by Codex's token budget. */
const BUDGET_LIMIT_CODE = "budget-limit";

/**
 * Codex's goal store is told each change DeepSeek's service accepted, so its usage and budget stay with the same
 * goal: the objective (a new goal starts its usage from zero, an edit keeps it) and the status. Never blocks.
 */
async function tellCodexStore(root: string, objective: string, op: EngineOp): Promise<void> {
  if (!resolveCodexGoals() || op.type === "round" || op.type === "tool" || op.type === "command" || op.type === "user-message") return;
  if (!objective.trim()) {
    await codexGoals(root, { op: "clear" });
    return;
  }
  // The user's own changes go through Codex's GoalService, as its app-server does for them; a block is Guardian's
  // own stop (stalled, a limit), which Codex has no user path for, so its store is told directly.
  if (op.type === "sync" || op.type === "create") await codexUserSet(root, objective, op.type === "create");
  else if (op.type === "block") await codexGoals(root, { op: "status", status: "blocked" });
  else await codexUserStatus(root, op.type === "pause" ? "paused" : op.type === "resume" ? "active" : "complete");
}

/** The goal's usage and budget as Codex's store has them, or null where the store isn't installed or has no goal. */
export async function goalBudget(root: string): Promise<CodexGoal | null> {
  return resolveCodexGoals() ? (await codexGoals(root, { op: "get" })).goal : null;
}

/**
 * Set, raise or remove (null) the goal's token budget in Codex's store. A goal that had stopped at its budget goes
 * on if Codex's own rule now lets it be active again: usage still at or over the budget keeps it stopped.
 */
export async function setGoalBudget(root: string, tokenBudget: number | null): Promise<CodexGoalAnswer> {
  const contract = await readContractSafe(root);
  if (!contract.goal.trim()) return { ran: false, reason: "No goal is set.", goal: null };
  const set = await codexGoals(root, { op: "set", objective: contract.goal, token_budget: tokenBudget });
  if (!set.ran || set.goal?.status !== "budget_limited") return set;
  const active = await codexGoals(root, { op: "status", status: "active" });
  if (active.goal?.status === "active" && engineView(await readGoalRecords(root))?.phase === "blocked") await engine(root, contract, { type: "resume" }, contract.goal, false);
  return active;
}

/** This turn's tokens and seconds go to Codex's store; its answer says where the budget stands. */
async function accountTurn(root: string, seq: Sequence, conversationId: string, tokens: number | undefined, split?: CodexUsage): Promise<CodexGoal | null> {
  if (!resolveCodexGoals()) return null;
  // A stale phase copy must not become a second authority or cause this turn's usage to be skipped.
  // Never re-create a missing ledger, and never override Codex's own usage/budget stop.
  const ledger = await codexGoals(root, { op: "get" });
  if (ledger.ran && ledger.goal && ["paused", "blocked", "complete"].includes(ledger.goal.status)) {
    await codexGoals(root, { op: "status", status: "active" });
  }
  const starts = seq.records.filter((r) => (r.kind === "user.message" || r.kind === "goal.round") && r.conversationId === conversationId).map((r) => Date.parse(r.ts));
  const seconds = starts.length ? Math.max(0, Math.round((Date.now() - Math.max(...starts)) / 1000)) : 0;
  // Codex's own turn accounting (turn start, token usage, turn stop) where its extension is installed: it works out
  // the usage and the budget switch itself. An older binary without it gets the bare store call below.
  const turn = await codexTurn(root, { turnId: `${conversationId}:${Date.now()}`, usage: split ?? { input_tokens: Math.max(0, tokens ?? 0), output_tokens: 0 }, seconds });
  if (turn.ran && turn.goal) return turn.goal;
  const request = { op: "account" as const, tokens: Math.max(0, tokens ?? 0), seconds };
  const first = await codexGoals(root, request);
  // A store with no goal is left as it is: Guardian doesn't put a goal into Codex's store behind its back.
  return first.goal;
}

/** A missing accounting ledger cannot support verified completion. State authority stays with DeepSeek. */
async function codexLedgerIssue(root: string): Promise<string | null> {
  if (!resolveCodexGoals()) return "Codex's goal program isn't installed";
  const held = await codexGoals(root, { op: "get" });
  if (!held.ran) return held.reason ?? "Codex's accounting ledger didn't answer";
  if (!held.goal) return "Codex's goal store holds no goal while DeepSeek's log has an open one";
  return null;
}

/** Codex's own tool handler, or why its code didn't run. Not running is never the same as accepting. */
async function codexToolOrMissing(root: string, name: "get_goal" | "create_goal" | "update_goal", args: Record<string, unknown> = {}): Promise<{ answer: CodexToolAnswer; missing: null } | { answer: null; missing: string }> {
  if (!resolveCodexGoals()) return { answer: null, missing: "Codex's goal program isn't installed" };
  const out = await codexTool(root, name, args);
  return out.ran ? { answer: out, missing: null } : { answer: null, missing: `Codex's goal program didn't answer${out.reason ? `: ${out.reason}` : ""}` };
}

type StateChangeAnswer =
  | { ok: true; result: EngineResult; codex: unknown }
  | { ok: false; by: "deepseek" | "codex"; message: string; missing?: true };

/** DeepSeek decides state changes; Codex is notified to keep accounting/continuation on that state. */
async function changeGoalState(
  root: string,
  contract: Pick<Contract, "goal" | "successCriteria">,
  op: Extract<EngineOp, { type: "pause" | "complete" | "block" }>,
  conversationId?: string,
): Promise<StateChangeAnswer> {
  const status = op.type === "pause" ? "paused" : op.type === "complete" ? "complete" : "blocked";
  await engineTry(root, contract, { type: "sync" }, contract.goal, false).catch(() => undefined);
  // Completion still needs a working accounting integration, not a second opinion on the phase.
  if (op.type === "complete") {
    const issue = await codexLedgerIssue(root);
    if (issue) return { ok: false, by: "codex", missing: true, message: issue };
  }
  let accepted: Awaited<ReturnType<typeof engineTry>>;
  try { accepted = await engineTry(root, contract, { ...op, by: "agent" }, contract.goal, false); }
  catch (err) {
    return { ok: false, by: "deepseek", missing: true, message: `DeepSeek's goal code didn't run: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!accepted.ok) {
    await recordRefusal(root, goalHash(contract), status, "deepseek", accepted.message, conversationId);
    return { ok: false, by: "deepseek", message: accepted.message };
  }
  const mirrored = await codexGoals(root, { op: "status", status });
  if (!mirrored.ran || !mirrored.goal || mirrored.goal.status !== status) {
    const message = mirrored.reason ?? `Codex's accounting copy did not record ${status}`;
    if (op.type === "complete") return { ok: false, by: "codex", missing: true, message };
    return { ok: true, result: accepted.result, codex: { did_not_run: message } };
  }
  return { ok: true, result: accepted.result, codex: { notified: status } };
}

/** Record a goal in DeepSeek's service: a new one, or the open one with the user's new words. False when refused. */
export async function setEngineGoal(root: string, objective: string, startOver: boolean): Promise<boolean> {
  const contract = await readContractSafe(root);
  return (await engine(root, contract, { type: startOver ? "create" : "sync" }, objective)) !== null;
}

/**
 * The user's controls. Resuming and closing are refused from anywhere else: the panel is the only caller. DeepSeek's
 * service makes the change (pause, resume, complete); what it refuses, such as pausing a goal that isn't active,
 * doesn't happen.
 */
export async function controlGoal(root: string, operation: GoalControlRecord["operation"]): Promise<void> {
  const contract = await readContractSafe(root);
  if (!contract.goal.trim()) return;
  if (!(await engine(root, contract, { type: operation === "done" ? "complete" : operation }))) return;
  await appendAudit(root, { ts: nowIso(), kind: "goal.control", goalHash: goalHash(contract), operation, actor: "user" });
}

/** The user's "this wasn't done" corrects the current goal, not just a future reviewer. */
export async function resumeMissedGoal(root: string, reviewId: string): Promise<boolean> {
  const contract = await readContractSafe(root);
  const records = await readAuditTail(root, TAPE_WINDOW);
  if (goalPhaseOf(records, contract) !== "complete") return false;
  const hash = goalHash(contract);
  const ended = [...records].reverse().find((r) => r.kind === "goal.end" && r.goalHash === hash);
  if (ended?.kind !== "goal.end" || !["proved", "unchecked"].includes(ended.outcome)) return false;
  const review = [...records].reverse().find((r) => r.kind === "goal.review" && r.goalHash === hash && Date.parse(r.ts) <= Date.parse(ended.ts));
  if (review?.kind !== "goal.review" || review.id !== reviewId || !review.ran || objectionLines(review).length) return false;
  if (!await setEngineGoal(root, contract.goal, true)) return false;
  await appendAudit(root, { ts: nowIso(), kind: "goal.control", goalHash: hash, operation: "resume", actor: "user" });
  return true;
}

/** Nothing more to ask: proved anywhere, or this chat's agent can't report at all, and the goal hasn't changed since. */
function settled(all: AuditRecord[], hash: string, conversationId: string): boolean {
  return all.some((r) => r.kind === "goal.end" && r.goalHash === hash && r.noReport === true && r.conversationId === conversationId);
}

/** A file the agent edited and then put back has nothing to account for. Outside git the edits are all there is. */
function stillChanged(seq: Sequence): string[] {
  if (!seq.tree) return seq.editedFiles;
  const changed = new Set(seq.tree.paths);
  return seq.editedFiles.filter((f) => changed.has(f));
}

async function evaluate(root: string, _contract: Contract, report: Pick<GoalReportRecord, "proofs" | "changes" | "removed">, seq: Sequence): Promise<GoalEvaluation> {
  return { unproved: [], unclaimed: [], extras: [], proved: await capturedEvidence(root, await readShellOutputs(root), stillChanged(seq), report.proofs) };
}

/**
 * The turn under way was opened by the user's own message: no goal round has been sent since it. DeepSeek's tool
 * applies its rounds threshold only inside goal rounds, so a block reported here is accepted at once.
 */
function userOpenedTurn(seq: Sequence): boolean {
  const messages = seq.records.filter((r) => r.kind === "user.message");
  const latest = messages[messages.length - 1];
  return !seq.rounds.some((r) => !latest || Date.parse(r.ts) >= Date.parse(latest.ts));
}

/** The goal and its items as one text, for telling the user's new words from a piece of the goal. */
const goalWords = (contract: Pick<Contract, "goal" | "successCriteria">): string => [contract.goal, ...contract.successCriteria.map((c) => c.text)].join("\n");

export type GoalReportInput = Omit<GoalReportRecord, "ts" | "kind">;

export interface GoalReportAnswer {
  accepted: boolean;
  /** Verification could not finish; the goal stays active for one recovery pass. */
  verificationPending?: true;
  message: string;
  unproved: string[];
  unclaimed: string[];
  /** The result of DeepSeek's own tool, where the call reached it. */
  their?: string;
  /** Codex accounting synchronization result; it is not a second phase approval. */
  codex?: unknown;
  /** Which of the goal keepers refused the change, when one did. */
  refusedBy?: string;
  /** How the run ended, when this report ended it: proved, unchecked, disputed or unverified. */
  outcome?: "proved" | "unchecked" | "disputed" | "unverified";
}

/** The agent's report, answered at once so it can fix what doesn't hold without waiting for a round. */
export async function submitGoalReport(root: string, input: GoalReportInput, opts: { evaluatorBudgetMs?: number } = {}): Promise<GoalReportAnswer> {
  // MCP calls can overlap, including across restarted servers after a client timeout.
  // Claim the report before reading the audit so the same work cannot start two paid reviews.
  const dir = getGuardianPaths(root).telemetryDir;
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "completion.lock");
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const before = fs.statSync(lock);
        const pid = Number(fs.readFileSync(lock, "utf8"));
        let abandoned = false;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (e) { abandoned = (e as NodeJS.ErrnoException).code === "ESRCH"; }
        } else abandoned = Date.now() - before.mtimeMs > 600_000;
        if (abandoned && fs.statSync(lock).ino === before.ino) { fs.unlinkSync(lock); continue; }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      return { accepted: false, verificationPending: true, unproved: [], unclaimed: [], message: "Independent checks for this workspace are already running. Do not submit another completion report while they run; wait for the pending result. Do not repeat tests or change finished work just to keep busy." };
    }
  }
  if (fd === undefined) return { accepted: false, verificationPending: true, unproved: [], unclaimed: [], message: "Another completion report is being processed. Wait for its result before reporting again." };
  try {
    return await submitGoalReportLocked(root, input, opts);
  } finally {
    const inode = fs.fstatSync(fd).ino;
    fs.closeSync(fd);
    try { if (fs.statSync(lock).ino === inode) fs.unlinkSync(lock); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}

async function submitGoalReportLocked(root: string, input: GoalReportInput, opts: { evaluatorBudgetMs?: number }): Promise<GoalReportAnswer> {
  // The goal is the user's: a contract file changed by anything else is put back before the report is judged.
  if (await guardContract(root)) {
    const restored = await readContractSafe(root);
    return { accepted: false, message: [GOAL_RESTORED, ...goalBlock(restored.goal, restored.successCriteria)].join("\n"), unproved: ["Guardian's goal file was changed without the user and has been put back"], unclaimed: [] };
  }
  const contract = await readContractSafe(root);
  const hash = goalHash(contract);
  let all = await readAuditTail(root, TAPE_WINDOW);
  const none = { unproved: [], unclaimed: [] };
  const phase = goalPhaseOf(all, contract);
  if (phase === "none") return { accepted: false, ...none, message: "No goal is set." };
  if (phase === "paused") return { accepted: false, ...none, message: CLOSING.paused };
  if (phase === "complete") {
    const ended = [...all].reverse().find((r) => r.kind === "goal.end" && r.goalHash === hash);
    const reviewed = ended?.kind === "goal.end" && ended.outcome === "unchecked"
      ? [...all].reverse().find((r) => r.kind === "goal.review" && r.goalHash === hash && Date.parse(r.ts) <= Date.parse(ended.ts))
      : undefined;
    const previous = ended?.kind === "goal.end" && ended.outcome === "unchecked"
      ? ended.tree ?? (!ended.changedSinceReview && reviewed?.kind === "goal.review" ? reviewed.tree : undefined)
      : undefined;
    const current = previous ? verificationState(root) : null;
    const userClosed = ended && all.some((r) => r.kind === "goal.control" && r.goalHash === hash && r.operation === "done" && Date.parse(r.ts) >= Date.parse(ended.ts));
    if (input.status !== "complete" || !current || current === previous || userClosed) {
      return { accepted: false, ...none, message: "This goal is already closed. There's nothing to report." };
    }
    // Unchecked is a bounded end to checking, not a permanent ban on checking later repairs.
    // Keep the original objective and criteria while reopening its goal-keeper state for changed work.
    if (!await setEngineGoal(root, contract.goal, true)) return { accepted: false, ...none, message: "The repaired work could not be reopened for verification." };
    all = await readAuditTail(root, TAPE_WINDOW);
  }
  const seq = readSequence(root, all, reportingChat(all), hash);
  const reportTs = nowIso();
  await appendAudit(root, { ts: reportTs, kind: "goal.report", goalHash: hash, ...input });
  if (input.status === "set_aside") {
    const prompts = await readUserPrompts(root);
    if (prompts && !userAsked(input.userWords, prompts, goalWords(contract))) {
      return { accepted: false, ...none, message: "Not set aside: pass the user's request in user_words, quoted exactly from their latest message. Words from an earlier message, or a piece of the goal itself, don't count. If they didn't ask for this, keep working on the goal." };
    }
    return { accepted: true, ...none, message: CLOSING.setAside };
  }
  if (input.status === "paused") {
    // Guardian requires the user's explicit request before DeepSeek may pause the goal.
    const prompts = await readUserPrompts(root);
    if (!prompts || !userAsked(input.userWords, prompts, goalWords(contract))) {
      return { accepted: false, ...none, message: "Not paused: pass the user's request to pause in user_words, quoted exactly from their latest message. Words from an earlier message, or a piece of the goal itself, don't count. If they didn't ask for this, keep working on the goal." };
    }
    // Their update_goal decides: it pauses only in a turn the user's own message opened.
    // Codex is notified after DeepSeek accepts the pause.
    const paused = await changeGoalState(root, contract, { type: "pause" }, reportingChat(all));
    if (!paused.ok) return { accepted: false, ...none, message: `Not paused: ${paused.message}`, refusedBy: paused.by };
    await appendAudit(root, { ts: nowIso(), kind: "goal.control", goalHash: hash, operation: "pause", actor: "agent" });
    return { accepted: true, ...none, message: CLOSING.paused, ...(paused.codex !== undefined ? { codex: paused.codex } : {}) };
  }
  if (input.status === "blocked") {
    if (!input.reason?.trim()) return { accepted: false, ...none, message: "Say what is blocking you in reason." };
    // Their update_goal decides, with its own threshold: in a goal round it refuses before enough rounds have
    // passed; in a turn the user's message opened it accepts at once. Its wrap-up instruction is the answer.
    // Codex is notified after DeepSeek accepts the block.
    const blocked = await changeGoalState(root, contract, { type: "block", code: MODEL_REPORTED_CODE, message: input.reason.trim() }, reportingChat(all));
    if (!blocked.ok) return { accepted: false, ...none, message: blocked.message, refusedBy: blocked.by };
    const closing = blocked.result.tool?.contexts[0] ?? CLOSING.blocked(contract.goal, input.reason);
    // Their rule accepts a block at once in a turn the user's own message opened. Nothing checked it, and the agent
    // and the user are told so.
    const firstTurn = userOpenedTurn(seq);
    return { accepted: true, ...none, message: firstTurn ? `${closing}\n\n${BLOCKED_AT_WORD}` : closing, ...(blocked.result.tool ? { their: blocked.result.tool.text } : {}), ...(blocked.codex !== undefined ? { codex: blocked.codex } : {}) };
  }
  // Use captured results and files directly. Independent checks decide whether the requested work is done.
  const result = await evaluate(root, contract, input, seq);
  // File labels are hints, not authority to undo working code. Scope is checked against the actual diff.
  const chat = reportingChat(all);
  const who = chat ?? UNKNOWN_CHAT;
  const labels = new Map(input.changes.map((c) => [projectPath(root, c.file), c.serves]));
  const receipt = { proved: result.proved, extras: [], changes: [...new Set([...stillChanged(seq), ...labels.keys()])].map((file) => ({ file, serves: labels.get(file) && labels.get(file) !== "extra" ? labels.get(file)! : "observed" })), ...(input.removed?.length ? { removed: input.removed } : {}) };
  // The two independent checks assess the actual work. The reviewer checks each item in a copy of the project; Google
  // ADK's evaluator judges the recorded run and the finished project against the user's own items. A check that
  // didn't run is named, and its goal can't be recorded as proved.
  const skipped: string[] = [];
  let independentChecks = "No independent check result is available for this report";
  let reviewedId: string | undefined;
  const checkSummary = (r: Pick<GoalReviewRecord, "ran" | "evaluator">): string => `Reviewer: ${r.ran ? "ran" : "did not run"}; evaluator: ${r.evaluator ? (r.evaluator.ran ? "ran" : "did not run") : "no result recorded"}`;
  let changedSinceReview = false;
  const reviews = reviewsOf(seq, hash);
  const last = reviews[reviews.length - 1];
  let checkAttempts = reviews.length;
  const workState = verificationState(root);
  const scopedIds = new Set(all.filter((r) => r.kind === "goal.review" && r.goalHash === hash && r.policy === REVIEW_POLICY).map((r) => r.kind === "goal.review" ? r.id : undefined));
  const correction = [...all].reverse().find((r) => r.kind === "review.feedback" && scopedIds.has(r.reviewId) && (r.label === "wrong" || r.label === "missed"));
  const correctionKey = correction?.ts ?? "";
  const currentRequest = (await readUserPrompts(root))?.at(-1) ?? contract.goal;
  const reviewContract = { ...contract, currentRequest };
  const reviewerKey = (() => { try { return createHash("sha256").update(JSON.stringify([reviewTemplate(root), correctionKey, currentRequest])).digest("hex"); } catch { return undefined; } })();
  const corrected = new Set(all.filter((r) => r.kind === "review.feedback" && (r.label === "wrong" || r.label === "missed")).map((r) => r.kind === "review.feedback" ? r.reviewId : ""));
  const sameState = !last || (workState !== null && last.tree === workState);
  const standing = last ? objectionLines(last) : [];
  // A definite verdict on a state stands across runs. Only unfinished checks get the bounded recovery retry;
  // a repeated completion report cannot reroll an objection.
  const outputs = await readShellOutputs(root);
  const commandResults = new Map<string, { failed: boolean; output: string }>();
  for (const o of outputs) commandResults.set(o.command.replace(/\s+/g, " ").trim(), { failed: o.failed === true, output: o.output });
  const stateKey = createHash("sha256").update(JSON.stringify([REVIEW_POLICY, correctionKey, currentRequest, workState ?? reportTs, [...commandResults].sort(([a], [b]) => a.localeCompare(b))])).digest("hex").slice(0, 16);
  const recovery = [...seq.records].reverse().find((r) => r.kind === "goal.recovery" && r.goalHash === hash && reviews.some((review) => review.id === r.reviewId));
  const recoveryUntried = recovery && !seq.records.slice(seq.records.indexOf(recovery) + 1).some((r) => r.kind === "goal.review" && r.goalHash === hash && r.policy === REVIEW_POLICY);
  const retryBase = recoveryUntried && recovery.kind === "goal.recovery" && recovery.reviewId
    ? [...all].reverse().find((r): r is GoalReviewRecord => r.kind === "goal.review" && r.id === recovery.reviewId && r.policy === REVIEW_POLICY)
    : undefined;
  const prior = [...all].reverse().find((r): r is GoalReviewRecord => r.kind === "goal.review" && r.policy === REVIEW_POLICY && r.reviewerKey === reviewerKey && !corrected.has(r.id ?? "") && r.goalHash === hash && r.stateKey === stateKey);
  /** What a review left unchecked: a check that didn't run, or an item it gave no verdict on. */
  const unchecked = (r: Pick<GoalReviewRecord, "ran" | "reason" | "unanswered" | "evaluator" | "extra" | "adjudication">): string[] => [
    ...(r.ran ? [] : [`the reviewer didn't run: ${r.reason ?? "no reason given"}`]),
    ...(r.ran && r.unanswered?.length ? [`the reviewer gave no clear verdict on ${r.unanswered.join(", ")}`] : []),
    ...(r.evaluator && !r.evaluator.ran ? [`the evaluator didn't run: ${r.evaluator.reason ?? "no reason given"}`] : []),
    ...(r.evaluator?.ran && r.evaluator.unanswered?.length ? [`the evaluator gave no score for ${r.evaluator.unanswered.join(", ")}`] : []),
    ...([...r.extra.map((_, i) => `reviewer_extra_${i + 1}`), ...(r.evaluator?.ran && r.evaluator.failed.some((f) => f.id === "extra") ? ["extra"] : [])].some((id) => !r.adjudication?.ran || (!r.adjudication.confirmed.some((c) => c.id === id) && !r.adjudication.dismissed.some((c) => c.id === id))) ? [`the check of claimed unrelated changes did not finish: ${r.adjudication?.reason ?? "inconclusive findings"}`] : []),
  ];
  // New project work, recorded evidence, reviewer instructions or feedback can require a fresh check,
  // within the hard bound. Repeated reports alone do not buy another review.
  const fresh = reviews.length < MAX_REVIEWS || ((!sameState || last?.stateKey !== stateKey || last?.reviewerKey !== reviewerKey || corrected.has(last?.id ?? "")) && reviews.length < REVIEW_HARD_LIMIT);
  // A run that ended disputed over this very state (reviewed, or left unreviewed when the reviews ran out) stays
  // disputed however often it is reported: only a changed project is looked at again.
  const lastEnd = [...all].reverse().find((r): r is GoalEndRecord => r.kind === "goal.end" && r.goalHash === hash);
  if (lastEnd?.outcome === "disputed" && lastEnd.stateKey === stateKey) {
    return { accepted: false, outcome: "disputed", message: DISPUTED_SAME, unproved: lastEnd.reviewer ?? [], unclaimed: [] };
  }
  if (prior && (!retryBase || objectionLines(prior).length)) {
    const lines = objectionLines(prior);
    if (lines.length) {
      // It objected to this very state and nothing has changed: disputed, and it stays so until the project changes.
      const already = lastEnd?.outcome === "disputed" && Date.parse(lastEnd.ts) >= Date.parse(prior.ts);
      if (!already) await end(root, seq, who, hash, "disputed", { stateKey, reviewer: lines, reason: "the review objected to this very state and report, and nothing has changed since: its verdict stands until the project changes", ...receipt });
      return { accepted: false, outcome: "disputed", message: DISPUTED_SAME, unproved: lines, unclaimed: [] };
    }
    reviewedId = prior.id;
    independentChecks = checkSummary(prior);
    skipped.push(...unchecked(prior));
  } else if (fresh || (retryBase && reviews.length < REVIEW_HARD_LIMIT)) {
    const reuseReview = workState ? [...all].reverse().find((r): r is GoalReviewRecord => r.kind === "goal.review" && r.policy === REVIEW_POLICY && r.reviewerKey === reviewerKey && !corrected.has(r.id ?? "") && r.goalHash === hash && r.tree === workState && r.ran && !r.unanswered?.length) : undefined;
    const reuseEvaluator = workState ? [...all].reverse().find((r): r is GoalReviewRecord => r.kind === "goal.review" && r.policy === REVIEW_POLICY && !corrected.has(r.id ?? "") && r.goalHash === hash && r.tree === workState && r.stateKey === stateKey && r.evaluator?.ran === true && !r.evaluator.unanswered?.length)?.evaluator : undefined;
    const asked = [contract.goal, ...(contract.successCriteria.length ? ["Done when:", ...contract.successCriteria.map((c) => `- ${c.text}`)] : []), ...(contract.constraints.length ? ["User constraints:", ...contract.constraints] : []), completionScope(currentRequest)].join("\n");
    const claimed = `Check the requested work against the current project and recorded evidence. Captured evidence: ${JSON.stringify(result.proved)}. Observed changed files: ${JSON.stringify(stillChanged(seq))}. Agent file labels are hints, not scope verdicts.`;
    const checksStarted = Date.now();
    const [outcome, evaluator] = await Promise.all([
      reuseReview ? Promise.resolve({ ...reuseReview, unanswered: reuseReview.unanswered ?? [], prompt: undefined }) : runReview(root, reviewContract),
      reuseEvaluator ? Promise.resolve({ ...reuseEvaluator, unanswered: reuseEvaluator.unanswered ?? [] }) : Promise.all([readTrajectory(root, seq.records[0]?.ts ?? null), readShellOutputs(root)]).then(([conversation, outputs]) =>
        // The finished project goes in after the run: its real changes, and each cited proof against the record.
        runEvaluator({ userQuery: asked, items: contract.successCriteria.map((c) => ({ id: c.id, text: c.text })), conversation: [...conversation, ...reviewEvidence(root, result.proved, outputs)], report: claimed }, opts.evaluatorBudgetMs ?? EVALUATOR_BUDGET_MS),
      ),
    ]);
    // Settle disagreements in either direction against a fresh project copy. A supporting declaration must not
    // become a permanent false veto just because the reviewer, rather than the evaluator, objected to it.
    // Confirmed and unclear objections stand; evidence-backed dismissals remain on the record, not in send-backs.
    const claims = claimsToAdjudicate(outcome, evaluator);
    // Without progress notices Cursor ends a silent tool call at 120 s, so the extra call gets what is left of that.
    const adjudicateBudget = opts.evaluatorBudgetMs ? REVIEW_BUDGET_MS : Math.max(15_000, SILENT_CALL_MS - (Date.now() - checksStarted));
    const adjudication = claims.length ? await adjudicate(root, reviewContract, claims, adjudicateBudget) : undefined;
    const id = newId("rev");
    const ts = nowIso();
    // What it looked at is kept, so the review can be replayed later when Guardian tries to improve it.
    const skippedCase = reuseReview ? `reused the check from ${reuseReview.id}; no new reviewer case` : outcome.ran && outcome.prompt ? await saveCase(root, id, reviewContract, { prompt: outcome.prompt, fails: outcome.fails, extra: outcome.extra }, ts).catch(() => "the case couldn't be saved") : null;
    const record = {
      policy: REVIEW_POLICY, reviewerKey, ...(outcome.checks ? { checks: outcome.checks } : {}), ...(outcome.verdicts ? { verdicts: outcome.verdicts } : {}), ran: outcome.ran, ...(outcome.reason ? { reason: outcome.reason } : {}), seconds: outcome.seconds, fails: outcome.fails, extra: outcome.extra,
      ...(outcome.unanswered.length ? { unanswered: outcome.unanswered } : {}), stateKey, ...(workState ? { tree: workState } : {}), evaluator,
      ...(adjudication ? { adjudication } : {}),
    };
    await appendAudit(root, {
      ts, kind: "goal.review", ...(chat ? { conversationId: chat } : {}), goalHash: hash, reportTs, id,
      ...(outcome.ran ? (skippedCase ? { caseSaved: false, caseSkipped: skippedCase } : { caseSaved: true }) : {}),
      ...record,
    });
    checkAttempts += 1;
    const lines = objectionLines(record);
    if (lines.length) {
      return { accepted: false, message: REVIEW_OBJECTS, unproved: lines, unclaimed: [] };
    }
    reviewedId = id;
    independentChecks = checkSummary(record);
    skipped.push(...unchecked(record));
  } else if (standing.length) {
    // The reviews are used up and the last one objected. Whether or not the agent changed something since, that
    // objection was never answered by a review that passed: the run ends disputed, never accepted.
    const why = sameState ? `the review still objects to this state after ${reviews.length} reviews` : `the last of this run's ${reviews.length} reviews objected, the project changed after it, and no reviews are left to check the change`;
    await end(root, seq, who, hash, "disputed", { stateKey, reviewer: standing, reason: why, ...(sameState ? {} : { changedSinceReview: true }), ...receipt });
    return { accepted: false, outcome: "disputed", message: DISPUTED, unproved: standing, unclaimed: [] };
  } else {
    if (!sameState) {
      changedSinceReview = true;
      skipped.push(`the project changed after the last of this run's ${reviews.length} reviews and wasn't reviewed again`);
    }
    // This branch has no valid cached verdict and no review budget. A clean older result does not
    // establish completion for changed evidence, reviewer instructions, feedback or verification policy.
    skipped.push("no current independent verification is available and this run's review budget is exhausted");
    if (last) {
      reviewedId = last.id;
      independentChecks = checkSummary(last);
      skipped.push(...unchecked(last));
    }
  }
  if (skipped.length && !recovery && checkAttempts < REVIEW_HARD_LIMIT) {
    await appendAudit(root, { ts: nowIso(), kind: "goal.recovery", ...(chat ? { conversationId: chat } : {}), goalHash: hash, reportTs, ...(reviewedId ? { reviewId: reviewedId } : {}), skipped });
    return { accepted: false, verificationPending: true, ...none, message: verificationRecoveryMessage(skipped) };
  }
  if (workState && verificationState(root) !== workState) {
    return { accepted: false, ...none, message: "The project changed while verification was running. Report the current work again so only checks for the changed state are repeated." };
  }
  // Independent checks assess the work; DeepSeek commits completion and Codex receives that state.
  // A missing or failed integration is unverified, never a second state-approval rule.
  const completed = await changeGoalState(root, contract, { type: "complete" }, chat);
  if (!completed.ok) {
    if (!completed.missing) return { accepted: false, ...none, message: `Not completed: ${completed.message}`, refusedBy: completed.by };
    await end(root, seq, who, hash, "unverified", { by: completed.by, reason: completed.message, ...(skipped.length ? { skipped } : {}), ...receipt });
    return { accepted: false, outcome: "unverified", ...none, message: unverifiedMessage(completed.message), refusedBy: completed.by };
  }
  const outcome = skipped.length ? "unchecked" : "proved";
  await end(root, seq, who, hash, outcome, { stateKey, ...(workState ? { tree: workState } : {}), ...(outcome === "proved" ? { verifiedItems: contract.successCriteria.map((c) => c.id) } : {}), ...(skipped.length ? { skipped } : {}), ...(changedSinceReview ? { changedSinceReview: true } : {}), ...receipt });
  const closing = completed.result.tool?.contexts[0] ?? CLOSING.proved(contract.goal);
  return {
    accepted: true, outcome, ...none,
    message: skipped.length ? `${uncheckedMessage(skipped, independentChecks)}\n\n${closing}` : `Independent verification completed: ${independentChecks}. Summarize what was accomplished for the user; mention checks only when useful to explain the result.\n\n${closing}`,
    ...(completed.result.tool ? { their: completed.result.tool.text } : {}),
    ...(completed.codex !== undefined ? { codex: completed.codex } : {}),
  };
}

const BLOCKED_AT_WORD = "Guardian: recorded as blocked on the first turn, at your word alone: no round was tried and nothing checked the obstacle. Say exactly that to the user in your closing message.";
const DISPUTED_SAME = "Recorded as disputed, not proved: the independent review already objected to this very state, and nothing has changed since. Reporting again doesn't get another review. Either fix what it objects to and report again, or tell the user plainly what the review says is wrong and why you disagree, and stop.";
const DISPUTED = "Recorded as disputed, not proved: the independent review objected and its reviews for this run are used up. Don't report again. Tell the user plainly what the review says is wrong and what you did about it, and stop.";
const unverifiedMessage = (why: string): string => `Recorded as unverified, not proved: ${why}. Verified completion needs DeepSeek's state transition and a working Codex accounting copy. Don't report again. Tell the user this, and what you finished, and stop.`;
const verificationRecoveryMessage = (skipped: string[]): string => `Completion is still pending: ${skipped.join("; ")}. A check that could not finish is not proof that your work is wrong. Keep working in this run: use the existing local tools to run the relevant tests and build, exercise the affected public entry points, and fix any actual failures within the user's goal. Do not hand those commands to the user when you can run them. If those checks already passed on the current work, use their recorded results; do not repeat them or change correct code just to create activity. Then call ${CODEX_TOOLS.update.name} again with the current completion report. Guardian will retry unfinished independent checks once, retaining usable results on unchanged work. If a check still cannot finish, Guardian will end unchecked rather than loop forever. Do not claim the goal is proved or ask the user to repair Guardian before doing the useful work you can do.`;

const uncheckedMessage = (skipped: string[], checks: string): string => `Verification incomplete: this work is unchecked.\n\nSummarize what was accomplished for the user and briefly disclose which independent checks could not finish. Do not describe the work as independently verified. Independent check results on the last reviewed state: ${checks}. Guardian: recorded as complete but unchecked, not proved, because ${skipped.join("; ")}. Make clear that full independent verification is incomplete without reciting internal statuses or imposing a fixed reply format. Distinguish checks that ran from checks that did not. Do not claim that no independent check ran unless both the reviewer and evaluator failed to run.`;

/** How long a report's checks may take in all when nothing keeps Cursor's tool call alive (it ends a silent call at 120 s). */
const SILENT_CALL_MS = 110_000;
const REVIEW_OBJECTS = "Not accepted yet: an independent reviewer checked the project and objects. Fix what holds up, then report again. A report on the same unchanged project won't be reviewed a second time: where the reviewer is wrong, say why with evidence to the user.";

/** Reviews of this goal in this run, oldest first. */
function reviewsOf(seq: Sequence, hash: string): GoalReviewRecord[] {
  const reviews = seq.records.filter((r): r is GoalReviewRecord => r.kind === "goal.review" && r.policy === REVIEW_POLICY && r.goalHash === hash);
  const ids = new Set(reviews.map((r) => r.id));
  const correction = [...seq.records].reverse().find((r) => r.kind === "review.feedback" && ids.has(r.reviewId) && (r.label === "wrong" || r.label === "missed"));
  return correction ? reviews.filter((r) => Date.parse(r.ts) > Date.parse(correction.ts)) : reviews;
}

/** Nothing moved since the round before: no edit in this chat, the same files, the same open items. */
function noProgress(seq: Sequence, conversationId: string, last: GoalRoundRecord | undefined, unproved: string[]): boolean {
  if (!last) return false;
  const edited = seq.records.some((r) => isEdit(r) && r.conversationId === conversationId && Date.parse(r.ts) > Date.parse(last.ts));
  const sameTree = (seq.tree?.fingerprint ?? undefined) === last.tree;
  return !edited && sameTree && JSON.stringify(unproved) === JSON.stringify(last.unproved);
}

async function end(root: string, seq: Sequence, conversationId: string, hash: string, outcome: GoalEndRecord["outcome"], rest: Partial<GoalEndRecord> = {}, tokens?: number): Promise<void> {
  const ts = nowIso();
  const spent = seq.rounds.reduce((sum, r) => sum + (r.tokens ?? 0), tokens ?? 0);
  const began = seq.records.find((r) => r.kind === "user.message" || r.kind === "goal.round" || isEdit(r))?.ts;
  await appendAudit(root, {
    ts,
    kind: "goal.end",
    conversationId,
    goalHash: hash,
    outcome,
    rounds: seq.rounds.length,
    ...(spent > 0 ? { tokens: spent } : {}),
    ...(began ? { seconds: Math.max(0, Math.round((Date.parse(ts) - Date.parse(began)) / 1000)) } : {}),
    ...(seq.goalFileEdited ? { goalFileEdited: true } : {}),
    ...rest,
  });
}

/** End of a turn. Returns what to send the agent, or null to let it stop. */
export async function runGoalStop(root: string, input: { conversationId?: string; status: string; loopCount: number; tokens?: number; usage?: CodexUsage }): Promise<string | null> {
  const { conversationId, loopCount } = input;
  if (!conversationId) return null;
  // The goal is the user's: a contract file changed by anything else is put back before this turn is judged.
  const restoredGoal = await guardContract(root, conversationId);
  let contract = await readContractSafe(root);
  const phaseNow = goalPhaseOf(await readGoalRecords(root), contract);
  if (phaseNow === "none" || phaseNow === "complete") {
    // A command can change files with no edit hook firing: this is the last chance to catch the first change.
    const before = readSequence(root, await readAuditTail(root, TAPE_WINDOW), conversationId, "");
    if (!agentMode(before.mode) || !before.changedThisTurn || !(await captureGoal(root, conversationId))) {
      if (phaseNow === "none") return null;
    } else contract = await readContractSafe(root);
  }
  const hash = goalHash(contract);
  const all = await readAuditTail(root, TAPE_WINDOW);
  // Closed or paused by whoever had the right to: nothing to ask. A paused run can't be restarted from here.
  if (goalPhaseOf(all, contract) !== "active" || settled(all, hash, conversationId)) return null;
  const seq = readSequence(root, all, conversationId, hash);

  // Cmd+K and the read-only modes aren't goal work, and a send-back would run in the same mode.
  if (!agentMode(seq.mode)) return null;

  // A cancelled or failed turn is never restarted on its own.
  if (input.status !== "completed") {
    if (seq.rounds.length || seq.editedFiles.length) await end(root, seq, conversationId, hash, "stopped", { by: "cursor", reason: `the turn ended ${input.status || "without completing"}` }, input.tokens);
    return null;
  }
  // Answering a question or asking one isn't goal work; a run already closed stays closed.
  const latestUser = [...seq.records].reverse().find((r) => r.kind === "user.message");
  const startedThisTurn = latestUser?.kind === "user.message" && latestUser.conversationId === conversationId && seq.records.some((r) =>
    r.kind === "goal.set" && r.goalHash === hash && (!r.conversationId || r.conversationId === conversationId) && Date.parse(r.ts) >= Date.parse(latestUser.ts));
  if (loopCount === 0 && !seq.changedThisTurn && !seq.report && !startedThisTurn) return null;
  if (loopCount > 0 && seq.rounds.length === 0) return null;

  // Goal work happened this turn: its tokens and time go to Codex's store, whatever the turn's outcome.
  const usage = await accountTurn(root, seq, conversationId, input.tokens, input.usage);

  const partners = { codex: { ran: false } as { ran: boolean; reason?: string; continues?: boolean; status?: string } };
  const notePartners = (): Promise<void> => appendAudit(root, { ts: nowIso(), kind: "goal.partners", conversationId, goalHash: hash, ...partners }).catch(() => undefined);

  let unproved: string[] = [];
  let unclaimed = stillChanged(seq);
  let extras: string[] = [];
  let reviewer: string[] = [];
  const notes: string[] = [];
  if (restoredGoal) notes.push(`- ${GOAL_RESTORED}`);
  const lastRound = seq.rounds[seq.rounds.length - 1];

  if (seq.report) {
    const prompts = seq.report.status === "set_aside" ? await readUserPrompts(root) : null;
    if (seq.report.status === "set_aside" && (!prompts || userAsked(seq.report.userWords, prompts, goalWords(contract)))) {
      await end(root, seq, conversationId, hash, "set_aside", { by: "guardian", reason: seq.report.reason ?? seq.report.userWords ?? "" }, input.tokens);
      return null;
    }
    // A blocked claim speaks for the turn it was made in, not the rounds after it.
    const freshClaim = !lastRound || Date.parse(seq.report.ts) >= Date.parse(lastRound.ts);
    if (seq.report.status === "blocked" && freshClaim) {
      // Their update_goal already answered this claim when it was made: if it accepted, their log says blocked.
      const view = engineView(await readGoalRecords(root));
      if (view?.phase === "blocked" && view.blockedReason?.code === MODEL_REPORTED_CODE) {
        // No goal round came since the user's message: by their rule it was accepted at once, at the agent's word.
        await end(root, seq, conversationId, hash, "blocked", { reason: seq.report.reason ?? view.blockedReason.message, ...(userOpenedTurn(seq) ? { by: "deepseek" as const, atAgentsWord: true } : {}) }, input.tokens);
        return null;
      }
      notes.push("- Blocked isn't accepted yet: try the ways around it first.");
    }
    const result = await evaluate(root, contract, seq.report, seq);
    unproved = result.unproved;
    unclaimed = [];
    // An extra the agent was already told about and still keeps is the user's call: reported, not re-argued.
    const warned = new Set(seq.rounds.flatMap((r) => r.extras));
    extras = [];
    const reviews = reviewsOf(seq, hash);
    const objected = [...reviews].reverse().find((r) => objectionLines(r).length > 0);
    const latest = reviews[reviews.length - 1];
    // The reviewer objected to this very report: that goes back as a round, like anything else that doesn't hold.
    if (seq.report.status === "complete" && latest && latest.reportTs === seq.report.ts && objected === latest) reviewer = objectionLines(latest);
    // A report that holds now but wasn't accepted when it was made (the project moved in between) is asked for
    // again: completion is committed only for the report and project state checked at that moment.
    if (seq.report.status === "complete" && !unproved.length && !unclaimed.length && !extras.length && !reviewer.length) {
      const pending = [...seq.records].reverse().find((r) => r.kind === "goal.recovery" && r.goalHash === hash);
      notes.push(pending?.kind === "goal.recovery" && latest?.id === pending.reviewId
        ? `- ${verificationRecoveryMessage(pending.skipped)}`
        : `- Your last report holds against Guardian's record now. Call ${CODEX_TOOLS.update.name} again so it can be accepted.`);
    }
  } else {
    notes.push("- No report yet.");
  }

  if (lastRound && lastRound.goalHash !== hash) {
    notes.unshift("- The goal on record changed. Ask the user before removing any finished work.");
  }

  // Codex's store says the goal has reached its token budget: no more send-backs, and Codex's own prompt closes it.
  if (usage?.status === "budget_limited") {
    await engine(root, contract, { type: "block", code: BUDGET_LIMIT_CODE, message: `${usage.tokens_used} of ${usage.token_budget} tokens used` }, contract.goal, false);
    await end(root, seq, conversationId, hash, "budget_limited", { by: "codex", unproved, reason: `${usage.tokens_used} of ${usage.token_budget} tokens used` }, input.tokens);
    await notePartners();
    return goalBudgetLimitMessage(contract.goal, budgetOf(usage), await codexNotice(root, "budget_limit"));
  }

  const idle = noProgress(seq, conversationId, lastRound, unproved);
  const idleRounds = idle ? [...seq.rounds].reverse().findIndex((r) => !r.idle) : -1;
  const idleInARow = idle ? (idleRounds === -1 ? seq.rounds.length : idleRounds) + 1 : 0;
  if (idleInARow >= NO_PROGRESS_ROUNDS) {
    // Guardian's own rule: neither Codex nor DeepSeek stops a run that has stopped moving.
    const why = `Guardian's own rule: nothing has changed for ${NO_PROGRESS_ROUNDS} rounds`;
    await engine(root, contract, { type: "block", code: NO_PROGRESS_CODE, message: why });
    await end(root, seq, conversationId, hash, "stalled", {
      by: "guardian",
      unproved,
      ...(seq.report ? {} : { noReport: true, reason: "The agent never reported. Check that Guardian's MCP server is switched on in Cursor's settings." }),
    }, input.tokens);
    return seq.report ? goalClosingMessage(contract.goal, contract.successCriteria, `nothing has changed for ${NO_PROGRESS_ROUNDS} rounds, so Guardian is stopping here.`, unproved, "no-progress") : null;
  }
  if (loopCount >= GOAL_MAX_ROUNDS) {
    // Cursor's own limit, not a goal keeper's: it delivers no more follow-ups for this message. The goal itself is
    // left as their code has it; this is only the last hand-off Cursor allows.
    await end(root, seq, conversationId, hash, "limit", { by: "cursor", unproved, reason: `Cursor's limit of ${GOAL_MAX_ROUNDS} follow-ups for one message` }, input.tokens);
    return goalClosingMessage(contract.goal, contract.successCriteria, `that was the last of the ${GOAL_MAX_ROUNDS} follow-ups Cursor allows for one message.`, unproved, "follow-up-limit");
  }
  // A goal the user changed since their code last saw it (typed in the panel, say) reaches both goal keepers first,
  // through their own create or edit, so each decides about the goal the contract now holds.
  const held = engineView(all);
  if (!held || held.objective !== contract.goal.trim() || held.phase === "complete") {
    await engineTry(root, contract, { type: held?.phase === "complete" ? "create" : "sync" }).catch(() => undefined);
  }
  // Whether another round starts is DeepSeek's round driver's decision: it reserves the round against the goal's own
  // cap and builds the prompt. If its code can't run at all, the run ends unverified and says so.
  let admitted: EngineResult | null;
  try {
    try {
      admitted = await engine(root, contract, { type: "round" });
    } catch (err) {
      // Another process was changing the goal (the tools server answering a call, say). Wait and ask once more.
      if (!(err instanceof EngineRefused) || err.code !== "ENGINE_BUSY") throw err;
      await new Promise((r) => setTimeout(r, 500));
      admitted = await engine(root, contract, { type: "round" });
    }
    if (!admitted?.prompt && loopCount === 0 && engineView(await readGoalRecords(root))?.phase === "blocked") {
      // Guardian's policy for their blocked phase: the user's new message is the human-authorized edge that resumes it.
      if (await engine(root, contract, { type: "resume" })) admitted = await engine(root, contract, { type: "round" });
    }
  } catch (err) {
    const why = `DeepSeek's goal code didn't run: ${err instanceof Error ? err.message : String(err)}`;
    await recordRefusal(root, hash, "continue", "deepseek", why, conversationId);
    await end(root, seq, conversationId, hash, "unverified", { by: "deepseek", unproved, reason: why }, input.tokens);
    return goalClosingMessage(contract.goal, contract.successCriteria, `${why}, so Guardian can't keep this goal going or record it as proved.`, unproved, "unverified");
  }
  if (!admitted?.goal || !admitted.prompt) {
    // Their driver started no round. If that is because the goal used all its rounds, their log now says blocked
    // with their round-limit code, and the agent gets the closing message. Otherwise their no is recorded and stands.
    const view = engineView(await readGoalRecords(root));
    if (view?.phase !== "blocked" || view.blockedReason?.code !== ROUND_LIMIT_CODE) {
      const why = admitted?.declined ?? `DeepSeek's round driver started no round${view ? `: its goal is ${view.phase}` : ""}`;
      await recordRefusal(root, hash, "continue", "deepseek", why, conversationId);
      await end(root, seq, conversationId, hash, "stopped", { by: "deepseek", unproved, reason: why }, input.tokens);
      return null;
    }
    // Their cap, their code and message; but where their resume refused before their driver could block the goal,
    // it was Guardian that recorded the block through their service, and the record says that.
    await end(root, seq, conversationId, hash, "limit", { by: admitted?.roundLimitByGuardian ? "guardian" : "deepseek", unproved, reason: `DeepSeek's cap of ${view.maxGoalRounds} rounds for one goal${admitted?.roundLimitByGuardian ? "; their resume refused at the cap, so Guardian recorded their round-limit block through their service" : ""}` }, input.tokens);
    return goalClosingMessage(contract.goal, contract.successCriteria, `the goal used all ${view.maxGoalRounds} of its rounds.`, unproved);
  }
  // DeepSeek admits rounds; Codex supplies continuation instructions and its own usage/budget limits.
  const codexTurnNow = await codexContinuationTurn(root);
  partners.codex = codexTurnNow.ran ? { ran: true, continues: codexTurnNow.continues, ...(codexTurnNow.status ? { status: codexTurnNow.status } : {}) } : { ran: false, ...(codexTurnNow.reason ? { reason: codexTurnNow.reason } : {}) };
  await notePartners();
  if (codexTurnNow.stops) {
    const why = `Codex's continuation stopped at its ${codexTurnNow.status} limit`;
    await engine(root, contract, { type: "block", code: BUDGET_LIMIT_CODE, message: why }, contract.goal, false);
    await recordRefusal(root, hash, "continue", "codex", why, conversationId);
    await end(root, seq, conversationId, hash, "budget_limited", { by: "codex", unproved, reason: why }, input.tokens);
    return goalClosingMessage(contract.goal, contract.successCriteria, why, unproved, "budget_limited");
  }
  // A goal keeper that didn't run is said, to the record above and to the agent: without it nothing can be proved.
  if (!codexTurnNow.ran) notes.push(`- Codex's goal code didn't run (${codexTurnNow.reason ?? "no reason given"}). Until it does, this goal can't be recorded as proved.`);
  const round = loopCount + 1;
  notes.push(...reviewer.map((l) => `- ${l}`));
  // Who let this round start, each in its own right, so the record doesn't credit one with another's decision.
  const decidedBy = {
    guardian: `its gates passed: goal work this turn in an agent mode, a completed turn, the goal not yet accepted${idle ? ", nothing changed since last round" : ""}`,
    deepseek: `its round driver admitted round ${admitted.goal.roundsStarted} of ${admitted.goal.maxGoalRounds}`,
    codex: codexTurnNow.ran ? (codexTurnNow.continues ? "its scheduling submitted a continuation turn" : `its scheduling gave no prompt (goal ${codexTurnNow.status ?? "unknown"})`) : `did not run: ${codexTurnNow.reason ?? "no reason given"}`,
  };
  await appendAudit(root, { ts: nowIso(), kind: "goal.round", conversationId, goalHash: hash, round, idle, decidedBy, ...(admitted.rearmed ? { armedByGuardian: true } : {}), ...(reviewer.length ? { reviewer } : {}), ...(input.tokens ? { tokens: input.tokens } : {}), ...(seq.tree ? { tree: seq.tree.fingerprint } : {}), unproved, unclaimed, extras, goalFileEdited: seq.goalFileEdited });
  const latestMessage = (await readUserPrompts(root))?.at(-1);
  // Usage and budget from Codex's store; where it isn't installed, the tokens Guardian saw and no budget.
  const tokensUsed = usage ? usage.tokens_used : seq.rounds.reduce((sum, r) => sum + (r.tokens ?? 0), input.tokens ?? 0);
  return goalRoundMessage(contract.goal, contract.successCriteria, { latestMessage, round, maxRounds: GOAL_MAX_ROUNDS, goalRound: admitted.goal.roundsStarted, goalMaxRounds: admitted.goal.maxGoalRounds, goalRoundPrompt: admitted.prompt, tokensUsed, tokenBudget: usage?.token_budget ?? null, ...(codexTurnNow.continues ? { codexPrompt: codexTurnNow.prompt, codexObjectiveContext: codexTurnNow.goalObjectiveContext } : {}), unproved, unclaimed, extras, goalFileEdited: seq.goalFileEdited, notes });
}

/**
 * The stop handler itself failed. An agent must not be let go in silence with the goal neither kept going nor
 * verified: the run is recorded unverified with the reason, and the agent is told once. Never throws, never blocks.
 */
export async function goalStopFailed(root: string, conversationId: string | undefined, err: unknown): Promise<string | null> {
  try {
    if (!conversationId) return null;
    const contract = await readContractSafe(root);
    const records = await readGoalRecords(root);
    if (goalPhaseOf(records, contract) !== "active") return null;
    const hash = goalHash(contract);
    const lastEnd = [...records].reverse().find((r) => r.kind === "goal.end" && r.conversationId === conversationId);
    // Said once: a second failure in a row would only repeat it.
    if (lastEnd?.kind === "goal.end" && lastEnd.outcome === "unverified" && lastEnd.by === "guardian" && lastEnd.goalHash === hash) return null;
    const why = `Guardian's stop handler failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    await appendAudit(root, { ts: nowIso(), kind: "goal.end", conversationId, goalHash: hash, outcome: "unverified", by: "guardian", reason: why });
    return goalClosingMessage(contract.goal, contract.successCriteria, `${why}, so this goal was neither kept going nor verified.`, [], "unverified");
  } catch {
    return null;
  }
}

/** Goes with every message the user sends, so the goal survives compaction and old chats reopened. Not shown as a message. */
export async function goalTurnContext(root: string): Promise<string | null> {
  await guardContract(root);
  const contract = await readContractSafe(root);
  const records = await readGoalRecords(root);
  // Guardian's policy for DeepSeek's blocked phase: this message from the user is the human-authorized edge that
  // resumes the goal. A paused goal is different: only the panel resumes it, as their own tool also refuses to.
  if (contract.goal.trim() && engineView(records)?.phase === "blocked") {
    // Stopped at its token budget: a message alone doesn't lift that. The user raises or removes the budget.
    const lastEnd = [...records].reverse().find((r) => r.kind === "goal.end" && r.goalHash === goalHash(contract));
    if (lastEnd?.kind === "goal.end" && lastEnd.outcome === "budget_limited") {
      return [`This workspace's goal stopped at its token budget (${lastEnd.reason ?? "budget used up"}). Don't work on it unless this message raises or removes the budget: then call guardian_change_goal with token_budget and the user's words in user_words, and carry on.`, ...goalBlock(contract.goal, contract.successCriteria)].join("\n");
    }
    await engine(root, contract, { type: "resume" }).catch(() => null);
  }
  const phase = goalPhaseOf(records, contract);
  if (phase === "none") return "No goal is on record. If this message asks for new implementation, repair or other project changes, call create_goal with the user's request before beginning work. Guardian preserves their full recorded message and can then continue unfinished work even before the first edit. A question alone needs no goal. If this message asks to continue earlier work, look in past chats and recent commits to find out what it was.";
  if (phase !== "active") return null;
  return [
    `This workspace has an open goal the user set. Work on it only if this message asks for it, or asks to continue or finish: that means the whole goal, and report with ${CODEX_TOOLS.update.name} when it's done. If this message limits the work or asks for something separate, do only that, leave the rest of the goal alone, and call ${CODEX_TOOLS.update.name} with status set_aside and the message's own words in user_words before you stop. A limit in an earlier message ended with that message.`,
    ...goalBlock(contract.goal, contract.successCriteria),
  ].join("\n");
}

/** Said to a running agent after its next tool call, once per change: the user paused, or changed the goal. */
export async function goalMidTurnNotice(root: string, conversationId: string | undefined): Promise<string | null> {
  if (!conversationId) return null;
  const contract = await readContractSafe(root);
  const hash = goalHash(contract);
  const records = await readGoalRecords(root);
  const phase = goalPhaseOf(records, contract);
  const seen = [...records].reverse().find((r) => r.kind === "goal.notice" && r.conversationId === conversationId) as Extract<AuditRecord, { kind: "goal.notice" }> | undefined;
  if (seen?.goalHash === hash && seen.phase === phase) return null;
  await appendAudit(root, { ts: nowIso(), kind: "goal.notice", conversationId, goalHash: hash, phase });
  const justSet = phase === "active" && seen?.goalHash !== hash && records.some((r) => r.kind === "goal.set" && r.goalHash === hash && r.conversationId === conversationId);
  if (justSet) {
    return [`Guardian recorded the user's request as the goal, word for word. Don't reword it. Use these ids when you report with ${CODEX_TOOLS.update.name}. If the user limited this message to part of it, do that part, then call ${CODEX_TOOLS.update.name} with status set_aside and their words in user_words before you stop.`, ...goalBlock(contract.goal, contract.successCriteria)].join("\n");
  }
  // The first look in a chat only sets the baseline: the goal came with the user's message.
  if (!seen) return null;
  // A first goal being declared isn't a change, and the chat that declared it already knows it.
  if (seen.goalHash !== hash && contract.goal.trim() && seen.phase !== "none") {
    const stored = await goalBudget(root);
    const tokensUsed = stored ? stored.tokens_used : records.reduce((sum, r) => sum + (r.kind === "goal.round" && r.conversationId === conversationId ? (r.tokens ?? 0) : 0), 0);
    // Codex's own words for the change, where its extension runs: its "User set the goal" fragment and its notice.
    return goalChangedMessage(contract.goal, contract.successCriteria, tokensUsed, stored?.token_budget ?? null, { fragment: await codexUserFragment(root), notice: await codexNotice(root, "objective_updated", contract.goal) });
  }
  return phase === "paused" ? CLOSING.paused : null;
}

/** The chat most recently at work, so the user's pause can stop it. */
export function lastActiveConversation(records: AuditRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i]!;
    if ((r.kind === "action.observed" || r.kind === "goal.round") && r.conversationId) return r.conversationId;
  }
  return null;
}
