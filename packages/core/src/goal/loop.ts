/**
 * The goal loop. When the agent stops after working on a goal, Guardian compares its report with Guardian's own
 * record and sends it back with the facts, until the goal is proved, the agent is truly blocked, the user set it
 * aside, the work stalls, or the rounds run out. It never runs the project's commands, never calls a model, never blocks a tool.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { appendAudit, readAuditTail, readGoalRecords } from "../audit/log.js";
import { newId, nowIso } from "../clock.js";
import { readContractSafe } from "../safeReaders.js";
import type { Contract } from "../schema/contract.js";
import type { AuditRecord, GoalEndRecord, GoalReportRecord, GoalControlRecord, GoalReviewRecord, GoalRoundRecord, UserMessageRecord } from "../schema/audit.js";
import { evaluateReport, projectPath, userSaid, type GoalEvaluation } from "./evaluate.js";
import { CLOSING, goalBlock, goalBudgetLimitMessage, goalChangedMessage, goalClosingMessage, goalRoundMessage } from "./prompts.js";
import { budgetOf, codexGoals, codexTurn, resolveCodexGoals, type CodexGoal, type CodexGoalAnswer, type CodexUsage } from "./codexGoals.js";
import { codexAgentTool, codexContinuationTurn, codexNotice, codexSaid, codexUserFragment, codexUserSet, codexUserStatus, recordRefusal } from "./partners.js";
import { BLOCKED_AFTER_CONSECUTIVE_ROUNDS, CODEX_TOOLS, ROUND_LIMIT_CODE, deepseekBlockThreshold } from "./originals.js";
import { captureGoal, parseRequest } from "./capture.js";
import { writeContract } from "../contractStore.js";
import { criteriaFromTexts } from "../schema/contract.js";
import { EngineRefused, engineRun, type EngineOp, type EngineResult, type EngineToolResult } from "./engine.js";
import { engineView, type EngineGoal } from "./engineFold.js";
import { MAX_REVIEWS, objectionLines, runReview } from "./review.js";
import { EVALUATOR_BUDGET_MS, runEvaluator } from "./evaluator.js";
import { readTrajectory } from "./trajectory.js";
import { saveCase } from "./cases.js";
import { readShellOutputs, readShrunkFiles, readTree, readUserPrompts, type TreeState } from "./record.js";

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

/** Long enough that a proved goal stays proved through a long session. */
const TAPE_WINDOW = 20_000;

const GUARDIAN_FILES = /^\.cursor\/goal-guardian\/(contract|state|actions)/;

export function goalHash(contract: Pick<Contract, "goal" | "successCriteria">): string {
  return createHash("sha256").update(JSON.stringify({ goal: contract.goal.trim(), criteria: contract.successCriteria.map((c) => c.text) })).digest("hex").slice(0, 16);
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
    if (r.kind === "goal.end" && mineOnly(r)) from = i + 1;
  });
  const records = all.slice(from);
  const mine = records.filter(isEdit).filter(mineOnly);
  const lastEdit = [...all].reverse().find((r) => isEdit(r) && inProject(r.actionValue));
  const reports = reportsOf(records, conversationId).filter((r) => !r.goalHash || r.goalHash === hash);
  const messages = records.filter((r): r is UserMessageRecord => r.kind === "user.message" && mineOnly(r));
  const latestMessage = messages[messages.length - 1];
  const tree = readTree(root);
  // Files a command changed, measured from what was already changed when this run began.
  const before = new Set(messages[0]?.dirty ?? []);
  const byCommand = messages[0]?.dirty && tree ? tree.paths.filter((f) => !before.has(f)) : [];
  const atLatest = new Set(latestMessage?.dirty ?? []);
  const newThisTurn = latestMessage?.dirty && tree ? tree.paths.some((f) => !atLatest.has(f)) : false;
  const sinceLatest = latestMessage ? mine.filter((r) => Date.parse(r.ts) >= Date.parse(latestMessage.ts)) : mine;
  // A file can change because the person saved it. It's the agent's change only if the agent ran a command this turn.
  const ranCommand = records.some((r) => r.kind === "action.observed" && r.actionType === "shell" && mineOnly(r) && (!latestMessage || Date.parse(r.ts) >= Date.parse(latestMessage.ts)));
  return {
    records,
    rounds: records.filter((r): r is GoalRoundRecord => r.kind === "goal.round" && mineOnly(r)),
    report: reports[reports.length - 1] ?? null,
    editedFiles: [...new Set([...mine.map((r) => r.actionValue), ...byCommand].filter(inProject))],
    changedThisTurn: (newThisTurn && ranCommand) || sinceLatest.some((r) => inProject(r.actionValue)),
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
 * Where the goal stands. DeepSeek Harness's goal service is the authority: its own fold over the engine events in
 * these records gives the phase. Their `blocked` is a goal Guardian still shows as open (the run that blocked says
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
    // A change the agent asked for reaches Codex through Codex's own update_goal handler (bothTools), not this mirror.
    if (mirror && !("by" in op && op.by === "agent")) await tellCodexStore(root, objective, op);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof EngineRefused) return { ok: false, message: err.message };
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
async function contractFollowsEngine(root: string, items: string[] = []): Promise<void> {
  const contract = await readContractSafe(root);
  const view = engineView(await readGoalRecords(root));
  if (view === undefined) return;
  const objective = view?.objective ?? "";
  if (objective === contract.goal.trim()) return;
  const saved = await writeContract(root, { ...contract, goal: objective, successCriteria: criteriaFromTexts(items) });
  if (objective) await appendAudit(root, { ts: nowIso(), kind: "goal.set", goalHash: goalHash(saved) });
  await tellCodexStore(root, objective, { type: "sync" });
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
  return codexSaid(await codexAgentTool(root, "get_goal"));
}

const NOT_THE_USERS = "only the user sets or changes the goal. Pass the objective in their own words, quoted exactly from their message.";

/**
 * Their create_goal, for the agent. Guardian's own rule comes first (the goal is the user's words), then their tool
 * decides with its rules: a direct human turn, and no unfinished goal already there.
 */
export async function createGoalByTool(root: string, objective: string, maxGoalRounds?: number): Promise<EngineToolResult> {
  const prompts = await readUserPrompts(root);
  if (prompts && !userSaid(objective, prompts)) return { isError: true, text: `Not created: ${NOT_THE_USERS}`, contexts: [] };
  const { goal, items } = parseRequest(objective);
  const hash = goalHash(await readContractSafe(root));
  // Codex's own create_goal handler is asked first: like DeepSeek's, it refuses while an unfinished goal exists. The
  // goal is created only if both accept; if DeepSeek's then refuses, Codex's new goal is taken back.
  const codex = await codexAgentTool(root, "create_goal", { objective: goal });
  if (codex && !codex.accepted) {
    await recordRefusal(root, hash, "create", "codex", codex.refusal ?? "Codex's create_goal refused");
    return { isError: true, text: JSON.stringify({ refused_by: "codex", codex: codexSaid(codex) }), contexts: [] };
  }
  const out = await runGoalTool(root, "create_goal", { objective: goal, ...(maxGoalRounds ? { max_goal_rounds: maxGoalRounds } : {}) });
  if (out.isError) {
    if (codex) await codexGoals(root, { op: "clear" });
    await recordRefusal(root, hash, "create", "deepseek", out.text);
    return out;
  }
  await contractFollowsEngine(root, items);
  return codex ? { ...out, text: JSON.stringify({ their: parseJson(out.text), codex: codexSaid(codex) }) } : out;
}

/** Their update_goal actions that Guardian's report path doesn't cover: edit (the user's new words) and resume. */
export async function updateGoalByTool(root: string, args: { goal_id?: string; revision?: number; action: "edit" | "resume"; objective?: string; max_goal_rounds?: number }): Promise<EngineToolResult> {
  let items: string[] = [];
  const pass: Record<string, unknown> = { action: args.action, ...(args.goal_id ? { goal_id: args.goal_id } : {}), ...(args.revision ? { revision: args.revision } : {}), ...(args.max_goal_rounds ? { max_goal_rounds: args.max_goal_rounds } : {}) };
  if (args.action === "edit" && args.objective?.trim()) {
    const prompts = await readUserPrompts(root);
    if (prompts && !userSaid(args.objective, prompts)) return { isError: true, text: `Not changed: ${NOT_THE_USERS}`, contexts: [] };
    const parsed = parseRequest(args.objective);
    items = parsed.items;
    pass.objective = parsed.goal;
  }
  const out = await runGoalTool(root, "update_goal", pass);
  if (!out.isError && args.action === "edit") await contractFollowsEngine(root, items);
  if (!out.isError && args.action === "resume") await tellCodexStore(root, (await readContractSafe(root)).goal, { type: "resume" });
  return out;
}

/**
 * Their /goal command, for the user. Anything but the bare status view changes the goal, so where Cursor reports
 * the user's messages the command must be in the user's latest one: the agent can't issue it on its own.
 */
export async function runUserGoalCommand(root: string, input: string): Promise<{ kind: string; text: string }> {
  const typed = input.trim();
  if (typed) {
    const plain = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
    const latest = (await readUserPrompts(root))?.at(-1);
    if (latest !== undefined && !plain(latest).includes(plain(typed))) {
      return { kind: "error", text: "Not run: /goal commands that change the goal are the user's. Pass exactly what they typed after the command in their latest message." };
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
  const starts = seq.records.filter((r) => (r.kind === "user.message" || r.kind === "goal.round") && r.conversationId === conversationId).map((r) => Date.parse(r.ts));
  const seconds = starts.length ? Math.max(0, Math.round((Date.now() - Math.max(...starts)) / 1000)) : 0;
  // Codex's own turn accounting (turn start, token usage, turn stop) where its extension is installed: it works out
  // the usage and the budget switch itself. An older binary without it gets the bare store call below.
  const turn = await codexTurn(root, { turnId: `${conversationId}:${Date.now()}`, usage: split ?? { input_tokens: Math.max(0, tokens ?? 0), output_tokens: 0 }, seconds });
  if (turn.ran && turn.goal) return turn.goal;
  const request = { op: "account" as const, tokens: Math.max(0, tokens ?? 0), seconds };
  const first = await codexGoals(root, request);
  if (!first.ran || first.goal) return first.goal;
  // The store has no goal yet (one set before the store was installed, or in the panel): give it this one first.
  const contract = await readContractSafe(root);
  if (!contract.goal.trim() || !(await codexGoals(root, { op: "set", objective: contract.goal })).goal) return null;
  return (await codexGoals(root, request)).goal;
}

/**
 * A change the agent asked for through update_goal goes to both projects' own tools: DeepSeek's (through its tool
 * pipeline, with its authority checks) and Codex's (its real handler). It happens only if both accept. The one
 * likelier to refuse is asked first, and if the second refuses, the first is put back: DeepSeek's `complete` can't
 * be undone, so Codex goes first there; its `blocked` and `paused` can (their resume), so DeepSeek goes first.
 */
async function bothTools(
  root: string,
  contract: Pick<Contract, "goal" | "successCriteria">,
  op: Extract<EngineOp, { type: "pause" | "complete" | "block" }>,
  conversationId?: string,
): Promise<{ ok: true; result: EngineResult; codex: unknown } | { ok: false; by: "deepseek" | "codex"; message: string }> {
  const hash = goalHash(contract);
  const status = op.type === "pause" ? "paused" : op.type === "complete" ? "complete" : "blocked";
  const refuse = async (by: "deepseek" | "codex", message: string): Promise<{ ok: false; by: "deepseek" | "codex"; message: string }> => {
    await recordRefusal(root, hash, status, by, message, conversationId);
    return { ok: false, by, message };
  };
  const theirs = (): Promise<{ ok: true; result: EngineResult } | { ok: false; message: string }> => engineTry(root, contract, { ...op, by: "agent" }, contract.goal, false);
  if (op.type === "complete") {
    const codex = await codexAgentTool(root, "update_goal", { status });
    if (codex && !codex.accepted) return refuse("codex", codex.refusal ?? "Codex's update_goal refused");
    const ds = await theirs();
    if (!ds.ok) {
      if (codex) await codexGoals(root, { op: "status", status: "active" });
      return refuse("deepseek", ds.message);
    }
    if (!codex) await tellCodexStore(root, contract.goal, op);
    return { ok: true, result: ds.result, codex: codexSaid(codex) };
  }
  const ds = await theirs();
  if (!ds.ok) return refuse("deepseek", ds.message);
  const codex = await codexAgentTool(root, "update_goal", { status });
  if (codex && !codex.accepted) {
    await engine(root, contract, { type: "resume" }, contract.goal, false);
    return refuse("codex", codex.refusal ?? "Codex's update_goal refused");
  }
  if (!codex) await tellCodexStore(root, contract.goal, op);
  return { ok: true, result: ds.result, codex: codexSaid(codex) };
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

async function evaluate(root: string, contract: Contract, report: Pick<GoalReportRecord, "proofs" | "changes" | "removed">, seq: Sequence): Promise<GoalEvaluation> {
  // Files already emptied before this run began are the user's own business.
  const shrunk = readShrunkFiles(root).filter((f) => !seq.dirtyAtStart.has(f.file));
  return evaluateReport(root, contract, report, { outputs: await readShellOutputs(root), lastEditTs: seq.lastEditTs, editedFiles: stillChanged(seq), tree: seq.tree?.fingerprint ?? null, shrunk });
}

export type GoalReportInput = Omit<GoalReportRecord, "ts" | "kind">;

export interface GoalReportAnswer {
  accepted: boolean;
  message: string;
  unproved: string[];
  unclaimed: string[];
  /** The result of DeepSeek's own tool, where the call reached it. */
  their?: string;
  /** What Codex's own update_goal handler answered, where the call reached it. */
  codex?: unknown;
  /** Which of the goal keepers refused the change, when one did. */
  refusedBy?: string;
}

/** The agent's report, answered at once so it can fix what doesn't hold without waiting for a round. */
export async function submitGoalReport(root: string, input: GoalReportInput, opts: { evaluatorBudgetMs?: number } = {}): Promise<GoalReportAnswer> {
  const contract = await readContractSafe(root);
  const hash = goalHash(contract);
  const all = await readAuditTail(root, TAPE_WINDOW);
  const none = { unproved: [], unclaimed: [] };
  const phase = goalPhaseOf(all, contract);
  if (phase === "none") return { accepted: false, ...none, message: "No goal is set." };
  if (phase === "paused") return { accepted: false, ...none, message: CLOSING.paused };
  if (phase === "complete") return { accepted: false, ...none, message: "This goal is already closed. There's nothing to report." };
  const seq = readSequence(root, all, reportingChat(all), hash);
  const reportTs = nowIso();
  await appendAudit(root, { ts: reportTs, kind: "goal.report", goalHash: hash, ...input });
  if (input.status === "set_aside") {
    const prompts = await readUserPrompts(root);
    if (prompts && !userSaid(input.userWords, prompts)) {
      return { accepted: false, ...none, message: "Not set aside: pass the user's request in user_words, quoted exactly from their latest message. If they didn't ask for this, keep working on the goal." };
    }
    return { accepted: true, ...none, message: CLOSING.setAside };
  }
  if (input.status === "paused") {
    // Codex's update_goal lets the agent pause only at the user's explicit request; Guardian asks to see the request.
    const prompts = await readUserPrompts(root);
    if (!prompts || !userSaid(input.userWords, prompts)) {
      return { accepted: false, ...none, message: "Not paused: pass the user's request to pause in user_words, quoted exactly from their latest message. If they didn't ask for this, keep working on the goal." };
    }
    // Their update_goal decides: it pauses only in a turn the user's own message opened.
    // Codex's update_goal then decides too; the pause happens only if both accept.
    const paused = await bothTools(root, contract, { type: "pause" }, reportingChat(all));
    if (!paused.ok) return { accepted: false, ...none, message: `Not paused: ${paused.message}`, refusedBy: paused.by };
    await appendAudit(root, { ts: nowIso(), kind: "goal.control", goalHash: hash, operation: "pause", actor: "agent" });
    return { accepted: true, ...none, message: CLOSING.paused, ...(paused.codex !== undefined ? { codex: paused.codex } : {}) };
  }
  if (input.status === "blocked") {
    if (!input.reason?.trim()) return { accepted: false, ...none, message: "Say what is blocking you in reason." };
    // Their update_goal decides, with its own threshold: in a goal round it refuses before enough rounds have
    // passed; in a turn the user's message opened it accepts at once. Its wrap-up instruction is the answer.
    // Codex's update_goal then decides too; the goal is blocked only if both accept.
    const blocked = await bothTools(root, contract, { type: "block", code: MODEL_REPORTED_CODE, message: input.reason.trim() }, reportingChat(all));
    if (!blocked.ok) return { accepted: false, ...none, message: blocked.message, refusedBy: blocked.by };
    return { accepted: true, ...none, message: blocked.result.tool?.contexts[0] ?? CLOSING.blocked(contract.goal, input.reason), ...(blocked.result.tool ? { their: blocked.result.tool.text } : {}), ...(blocked.codex !== undefined ? { codex: blocked.codex } : {}) };
  }
  const result = await evaluate(root, contract, input, seq);
  if (result.unproved.length || result.unclaimed.length) {
    return { accepted: false, message: "Not accepted yet: fix what's listed and report again.", unproved: result.unproved, unclaimed: result.unclaimed };
  }
  // Guardian's record agrees. One independent review tries to prove it wrong, a limited number of times per run:
  // the reviewer checks each item in a copy of the project, and Google ADK's evaluator judges the recorded run against
  // the user's own items.
  if (reviewsOf(seq, hash).length < MAX_REVIEWS) {
    const asked = [contract.goal, ...(contract.successCriteria.length ? ["Done when:", ...contract.successCriteria.map((c) => `- ${c.text}`)] : [])].join("\n");
    const claimed = `I report the goal complete. Proofs: ${JSON.stringify(input.proofs)}. Changed files: ${JSON.stringify(input.changes)}.`;
    const [outcome, evaluator] = await Promise.all([
      runReview(root, contract),
      readTrajectory(root, seq.records[0]?.ts ?? null).then((conversation) =>
        runEvaluator({ userQuery: asked, items: contract.successCriteria.map((c) => ({ id: c.id, text: c.text })), conversation, report: claimed }, opts.evaluatorBudgetMs ?? EVALUATOR_BUDGET_MS),
      ),
    ]);
    const chat = reportingChat(all);
    const id = newId("rev");
    const ts = nowIso();
    // What it looked at is kept, so the review can be replayed later when Guardian tries to improve it.
    const skippedCase = outcome.ran && outcome.prompt ? await saveCase(root, id, contract, { prompt: outcome.prompt, fails: outcome.fails, extra: outcome.extra }, ts).catch(() => "the case couldn't be saved") : null;
    await appendAudit(root, {
      ts, kind: "goal.review", ...(chat ? { conversationId: chat } : {}), goalHash: hash, reportTs, id,
      ...(outcome.ran ? (skippedCase ? { caseSaved: false, caseSkipped: skippedCase } : { caseSaved: true }) : {}),
      ran: outcome.ran, ...(outcome.reason ? { reason: outcome.reason } : {}), seconds: outcome.seconds, fails: outcome.fails, extra: outcome.extra, ...(seq.tree ? { tree: seq.tree.fingerprint } : {}), evaluator,
    });
    const lines = objectionLines({ ...outcome, evaluator });
    if (lines.length) {
      return { accepted: false, message: REVIEW_OBJECTS, unproved: lines, unclaimed: [] };
    }
  }
  return { accepted: true, ...none, message: CLOSING.proved(contract.goal) };
}

const REVIEW_OBJECTS = "Not accepted yet: an independent reviewer checked the project and objects. Fix what holds up; where it's wrong, say why with evidence. Then report again.";

/** Reviews of this goal in this run, oldest first. */
function reviewsOf(seq: Sequence, hash: string): GoalReviewRecord[] {
  return seq.records.filter((r): r is GoalReviewRecord => r.kind === "goal.review" && r.goalHash === hash);
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
    if (seq.rounds.length || seq.editedFiles.length) await end(root, seq, conversationId, hash, "stopped", {}, input.tokens);
    return null;
  }
  // Answering a question or asking one isn't goal work; a run already closed stays closed.
  if (loopCount === 0 && !seq.changedThisTurn && !seq.report) return null;
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
  const lastRound = seq.rounds[seq.rounds.length - 1];

  if (seq.report) {
    const prompts = seq.report.status === "set_aside" ? await readUserPrompts(root) : null;
    if (seq.report.status === "set_aside" && (!prompts || userSaid(seq.report.userWords, prompts))) {
      await end(root, seq, conversationId, hash, "set_aside", { reason: seq.report.reason ?? seq.report.userWords ?? "" }, input.tokens);
      return null;
    }
    // A blocked claim speaks for the turn it was made in, not the rounds after it.
    const freshClaim = !lastRound || Date.parse(seq.report.ts) >= Date.parse(lastRound.ts);
    if (seq.report.status === "blocked" && freshClaim) {
      // Their update_goal already answered this claim when it was made: if it accepted, their log says blocked.
      const view = engineView(await readGoalRecords(root));
      if (view?.phase === "blocked" && view.blockedReason?.code === MODEL_REPORTED_CODE) {
        await end(root, seq, conversationId, hash, "blocked", { reason: seq.report.reason ?? view.blockedReason.message }, input.tokens);
        return null;
      }
      notes.push("- Blocked isn't accepted yet: try the ways around it first.");
    }
    const result = await evaluate(root, contract, seq.report, seq);
    unproved = result.unproved;
    unclaimed = result.unclaimed;
    // An extra the agent was already told about and still keeps is the user's call: reported, not re-argued.
    const warned = new Set(seq.rounds.flatMap((r) => r.extras));
    extras = result.extras.filter((f) => !warned.has(f));
    const reviews = reviewsOf(seq, hash);
    const objected = [...reviews].reverse().find((r) => objectionLines(r).length > 0);
    const latest = reviews[reviews.length - 1];
    // The reviewer objected to this very report: that goes back as a round, like anything else that doesn't hold.
    if (seq.report.status === "complete" && latest && latest.reportTs === seq.report.ts && objected === latest) reviewer = objectionLines(latest);
    const holds = seq.report.status === "complete" && !unproved.length && !unclaimed.length && !extras.length && !reviewer.length;
    if (holds) {
      // Reviews ran out with an objection: the record decides. If nothing changed since, the objection stands and goes
      // to the user; if the agent changed the project after it, that final state simply wasn't reviewed again.
      const last = objected && reviews.length >= MAX_REVIEWS && reviews.indexOf(objected) === reviews.length - 1 ? objected : null;
      const changedSince = Boolean(last?.tree && seq.tree && last.tree !== seq.tree.fingerprint);
      const standing = last && !changedSince ? objectionLines(last) : [];
      // Codex's update_goal handler and DeepSeek's update_goal tool each complete the goal; if either refuses,
      // nothing is recorded as proved and the refusal is on the record.
      const completed = await bothTools(root, contract, { type: "complete" }, conversationId);
      await notePartners();
      if (!completed.ok) return null;
      await end(root, seq, conversationId, hash, "proved", { ...(standing.length ? { reviewer: standing } : {}), ...(changedSince ? { changedSinceReview: true } : {}), proved: result.proved, extras: result.extras, changes: seq.report.changes.map((c) => ({ file: projectPath(root, c.file), serves: c.serves })), ...(seq.report.removed?.length ? { removed: seq.report.removed } : {}) }, input.tokens);
      return null;
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
    await end(root, seq, conversationId, hash, "budget_limited", { unproved, reason: `${usage.tokens_used} of ${usage.token_budget} tokens used` }, input.tokens);
    await notePartners();
    return goalBudgetLimitMessage(contract.goal, budgetOf(usage), await codexNotice(root, "budget_limit"));
  }

  const idle = noProgress(seq, conversationId, lastRound, unproved);
  const idleRounds = idle ? [...seq.rounds].reverse().findIndex((r) => !r.idle) : -1;
  const idleInARow = idle ? (idleRounds === -1 ? seq.rounds.length : idleRounds) + 1 : 0;
  if (idleInARow >= NO_PROGRESS_ROUNDS) {
    const why = `nothing has changed for ${NO_PROGRESS_ROUNDS} rounds`;
    await engine(root, contract, { type: "block", code: NO_PROGRESS_CODE, message: why });
    await end(root, seq, conversationId, hash, "stalled", {
      unproved,
      ...(seq.report ? {} : { noReport: true, reason: "The agent never reported. Check that Guardian's MCP server is switched on in Cursor's settings." }),
    }, input.tokens);
    return seq.report ? goalClosingMessage(contract.goal, contract.successCriteria, `nothing has changed for ${NO_PROGRESS_ROUNDS} rounds, so Guardian is stopping here.`, unproved, "no-progress") : null;
  }
  if (loopCount >= GOAL_MAX_ROUNDS) {
    // As DeepSeek's round driver does when rounds run out: the goal is blocked with its round-limit code.
    await engine(root, contract, { type: "block", code: ROUND_LIMIT_CODE, message: `that was the last of ${GOAL_MAX_ROUNDS} rounds for one message` });
    await end(root, seq, conversationId, hash, "limit", { unproved }, input.tokens);
    return goalClosingMessage(contract.goal, contract.successCriteria, `that was the last of ${GOAL_MAX_ROUNDS} rounds.`, unproved);
  }
  // The round is admitted by DeepSeek's service, which counts it against the goal's own cap.
  let admitted = await engine(root, contract, { type: "round" });
  if (!admitted?.prompt && loopCount === 0 && engineView(await readGoalRecords(root))?.phase === "blocked") {
    // Guardian's policy for their blocked phase: the user's new message is the human-authorized edge that resumes it.
    if (await engine(root, contract, { type: "resume" })) admitted = await engine(root, contract, { type: "round" });
  }
  if (!admitted?.goal || !admitted.prompt) {
    // Their driver started no round. If that is because the goal used all its rounds, their log now says blocked
    // with their round-limit code, and the agent gets the closing message.
    const view = engineView(await readGoalRecords(root));
    if (view?.phase !== "blocked" || view.blockedReason?.code !== ROUND_LIMIT_CODE) return null;
    await end(root, seq, conversationId, hash, "limit", { unproved }, input.tokens);
    return goalClosingMessage(contract.goal, contract.successCriteria, `the goal used all ${view.maxGoalRounds} of its rounds.`, unproved);
  }
  // Codex's own scheduling is asked for its continuation turn. If its goal is in a state it doesn't continue from,
  // the run stops; where its extension isn't installed, its prompt is rendered from its template as before.
  const codexTurnNow = await codexContinuationTurn(root);
  partners.codex = codexTurnNow.ran ? { ran: true, continues: codexTurnNow.continues, ...(codexTurnNow.status ? { status: codexTurnNow.status } : {}) } : { ran: false, ...(codexTurnNow.reason ? { reason: codexTurnNow.reason } : {}) };
  await notePartners();
  if (codexTurnNow.stops) {
    const why = `Codex's scheduling started no continuation: its goal is ${codexTurnNow.status}`;
    await recordRefusal(root, hash, "continue", "codex", why, conversationId);
    await end(root, seq, conversationId, hash, "stopped", { unproved, reason: why }, input.tokens);
    return null;
  }
  const round = loopCount + 1;
  notes.push(...reviewer.map((l) => `- ${l}`));
  await appendAudit(root, { ts: nowIso(), kind: "goal.round", conversationId, goalHash: hash, round, idle, ...(reviewer.length ? { reviewer } : {}), ...(input.tokens ? { tokens: input.tokens } : {}), ...(seq.tree ? { tree: seq.tree.fingerprint } : {}), unproved, unclaimed, extras, goalFileEdited: seq.goalFileEdited });
  const latestMessage = (await readUserPrompts(root))?.at(-1);
  // Usage and budget from Codex's store; where it isn't installed, the tokens Guardian saw and no budget.
  const tokensUsed = usage ? usage.tokens_used : seq.rounds.reduce((sum, r) => sum + (r.tokens ?? 0), input.tokens ?? 0);
  return goalRoundMessage(contract.goal, contract.successCriteria, { latestMessage, round, maxRounds: GOAL_MAX_ROUNDS, goalRound: admitted.goal.roundsStarted, goalMaxRounds: admitted.goal.maxGoalRounds, goalRoundPrompt: admitted.prompt, tokensUsed, tokenBudget: usage?.token_budget ?? null, ...(codexTurnNow.continues ? { codexPrompt: codexTurnNow.prompt, codexObjectiveContext: codexTurnNow.goalObjectiveContext } : {}), unproved, unclaimed, extras, goalFileEdited: seq.goalFileEdited, notes });
}

/** Goes with every message the user sends, so the goal survives compaction and old chats reopened. Not shown as a message. */
export async function goalTurnContext(root: string): Promise<string | null> {
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
    await engine(root, contract, { type: "resume" });
  }
  const phase = goalPhaseOf(records, contract);
  if (phase === "none") return "No goal is on record. Guardian records the user's request as the goal, word for word, when you first change something. If this message asks to continue earlier work, look in past chats and recent commits to find out what it was.";
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
