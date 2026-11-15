/**
 * OpenAI Codex's own goal code, run beside DeepSeek's goal service: its goal store (usage accounting, a token budget,
 * the `budget_limited` status) and, further down, its whole goal extension (tool handlers, accounting, the user-facing
 * goal service, continuation scheduling). All of it is Codex's crates, unmodified, behind Guardian's command-line
 * binary (packages/codex-goals). Guardian's own goal file is the master copy; DeepSeek's service holds the phase,
 * revision and rounds Guardian reads back, and Codex's store is told the same changes and keeps the usage.
 *
 * Nothing here blocks or throws. Where the binary isn't installed every call answers `ran: false`; the goal loop
 * then can't end a run as proved and records it as unverified.
 */
import { spawn as nodeSpawn } from "node:child_process";
import crossSpawn from "cross-spawn";
const spawn = crossSpawn as typeof nodeSpawn;
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getGuardianPaths } from "../paths.js";

/** Codex's goal, with Codex's own field names. */
export interface CodexGoal {
  goal_id: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export type CodexGoalRequest =
  | { op: "get" }
  /** fresh: a new goal, usage from zero. token_budget left out keeps the budget; null removes it. */
  | { op: "set"; objective: string; token_budget?: number | null; fresh?: boolean }
  | { op: "status"; status: CodexGoal["status"] }
  | { op: "account"; tokens: number; seconds: number }
  | { op: "clear" };

export interface CodexGoalAnswer {
  /** False when the binary isn't there, failed or timed out: nothing was read or changed. */
  ran: boolean;
  reason?: string;
  goal: CodexGoal | null;
}

const BINARY = "goal-guardian-codex-goals";
const TIMEOUT_MS = 5000;

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The binary: an explicit path (tests and the rig), else beside Guardian's own binaries. Null when there is none. */
export function resolveCodexGoals(): string | null {
  const configured = process.env.GOAL_GUARDIAN_CODEX_GOALS;
  if (configured !== undefined) return configured && isFile(configured) ? configured : null;
  const beside = path.join(path.dirname(process.execPath), `${BINARY}${process.platform === "win32" ? ".exe" : ""}`);
  return isFile(beside) ? beside : null;
}

/** Where Codex's store keeps this workspace's goal. */
export function codexGoalsHome(root: string): string {
  return path.join(getGuardianPaths(root).dir, "codex");
}

type Raw = { ran: true; answer: Record<string, unknown> } | { ran: false; reason: string };

/** One JSON request to the binary, one JSON answer back. Never throws. */
async function ask(root: string, request: Record<string, unknown>, timeoutMs: number): Promise<Raw> {
  const binary = resolveCodexGoals();
  if (!binary) return { ran: false, reason: "Codex's goal store isn't installed" };
  const home = codexGoalsHome(root);
  try {
    await fsp.mkdir(home, { recursive: true });
    // The store is sqlite files holding the goal's words and usage: never let them reach a commit.
    await fsp.writeFile(path.join(home, ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);
  } catch {
    return { ran: false, reason: "Codex's goal store has nowhere to live" };
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const done = (v: Raw): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const failed = (reason: string): Raw => ({ ran: false, reason });
    const child = spawn(binary, ["--home", home], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(failed("Codex's goal store took too long"));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.on("error", (err) => done(failed(`Codex's goal store couldn't start: ${err.message}`)));
    child.on("close", () => {
      try {
        const answer = JSON.parse(stdout.trim().split("\n").pop() ?? "") as Record<string, unknown>;
        done(answer.ok === true ? { ran: true, answer } : failed(typeof answer.error === "string" ? answer.error : "Codex's goal store refused"));
      } catch {
        done(failed("Codex's goal store gave no answer"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
}

/** One request to Codex's store. Never throws. */
export async function codexGoals(root: string, request: CodexGoalRequest): Promise<CodexGoalAnswer> {
  const raw = await ask(root, request, TIMEOUT_MS);
  return raw.ran ? { ran: true, goal: (raw.answer.goal as CodexGoal | null | undefined) ?? null } : { ran: false, reason: raw.reason, goal: null };
}

// ---- Codex's whole goal extension -------------------------------------------------------------------------------
// The requests below run Codex's goal extension itself (codex-rs/ext/goal), not only its store: its tool handlers,
// its accounting, its user-facing goal service and its continuation scheduling. See packages/codex-goals.

/** A turn's token usage so far, in Codex's own fields. */
export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/** What Codex's extension emitted while it handled the request. */
export interface CodexEvents {
  goal_updated: unknown[];
  warnings: string[];
}

const NO_EVENTS: CodexEvents = { goal_updated: [], warnings: [] };
const eventsOf = (v: unknown): CodexEvents => {
  const e = (v ?? {}) as Partial<CodexEvents>;
  return { goal_updated: Array.isArray(e.goal_updated) ? e.goal_updated : [], warnings: Array.isArray(e.warnings) ? e.warnings : [] };
};
const goalOf = (v: unknown): CodexGoal | null => (v as CodexGoal | null | undefined) ?? null;

export interface CodexToolSpec {
  name: string;
  /** Codex's ToolSpec as it serializes it: type, name, description, parameters. */
  spec: { type?: string; name?: string; description?: string; parameters?: unknown; [key: string]: unknown };
}

/** Codex's tool definitions, from its own executors. */
export async function codexToolSpecs(root: string): Promise<{ ran: boolean; reason?: string; tools: CodexToolSpec[] }> {
  const raw = await ask(root, { op: "tool_specs" }, TIMEOUT_MS);
  if (!raw.ran) return { ran: false, reason: raw.reason, tools: [] };
  return { ran: true, tools: Array.isArray(raw.answer.tools) ? (raw.answer.tools as CodexToolSpec[]) : [] };
}

export interface CodexToolAnswer {
  ran: boolean;
  reason?: string;
  /** Codex's handler accepted the call. */
  accepted: boolean;
  /** Codex's own result for an accepted call. */
  result: unknown;
  /** The item Codex would put in the model's history for this call. */
  modelOutput: unknown;
  /** Codex's own words to the model when it refuses. */
  refusal: string | null;
  goal: CodexGoal | null;
  events: CodexEvents;
}

/** One tool call (get_goal, create_goal, update_goal) through Codex's real handler. */
export async function codexTool(root: string, name: string, args: Record<string, unknown> = {}, turn: { turnId?: string; usage?: CodexUsage; maxGoalTokenBudget?: number } = {}): Promise<CodexToolAnswer> {
  const raw = await ask(root, { op: "tool", name, arguments: args, ...(turn.turnId ? { turn_id: turn.turnId } : {}), ...(turn.usage ? { usage: turn.usage } : {}), ...(turn.maxGoalTokenBudget ? { max_goal_token_budget: turn.maxGoalTokenBudget } : {}) }, TIMEOUT_MS);
  if (!raw.ran) return { ran: false, reason: raw.reason, accepted: false, result: null, modelOutput: null, refusal: null, goal: null, events: NO_EVENTS };
  const call = (raw.answer.call ?? {}) as { accepted?: boolean; result?: unknown; model_output?: unknown; refusal?: string };
  return { ran: true, accepted: call.accepted === true, result: call.result ?? null, modelOutput: call.model_output ?? null, refusal: typeof call.refusal === "string" ? call.refusal : null, goal: goalOf(raw.answer.goal), events: eventsOf(raw.answer.events) };
}

/** One finished agent turn through Codex's own accounting: turn start, token usage, turn stop. */
export async function codexTurn(root: string, turn: { turnId: string; usage: CodexUsage; seconds?: number }): Promise<CodexGoalAnswer & { events: CodexEvents }> {
  const raw = await ask(root, { op: "turn", turn_id: turn.turnId, usage: turn.usage, seconds: turn.seconds ?? 0 }, TIMEOUT_MS);
  return raw.ran ? { ran: true, goal: goalOf(raw.answer.goal), events: eventsOf(raw.answer.events) } : { ran: false, reason: raw.reason, goal: null, events: NO_EVENTS };
}

export interface CodexUserGoalAnswer extends CodexGoalAnswer {
  /** Codex's own context item for the change ("User set the goal: ..."), as it enters the model's history. */
  fragment: unknown;
  /** The fragment's text. */
  fragmentText: string;
  cleared: boolean;
  events: CodexEvents;
}

const textOf = (item: unknown): string => {
  const content = (item as { content?: Array<{ text?: unknown }> } | null)?.content;
  return Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
};

/** A goal change made by the user, through Codex's GoalService as its app-server does. */
export async function codexUserGoal(root: string, change: { objective?: string; status?: CodexGoal["status"]; token_budget?: number | null; clear?: boolean; maxGoalTokenBudget?: number }): Promise<CodexUserGoalAnswer> {
  const { maxGoalTokenBudget, ...rest } = change;
  const raw = await ask(root, { op: "user_goal", ...rest, ...(maxGoalTokenBudget ? { max_goal_token_budget: maxGoalTokenBudget } : {}) }, TIMEOUT_MS);
  if (!raw.ran) return { ran: false, reason: raw.reason, goal: null, fragment: null, fragmentText: "", cleared: false, events: NO_EVENTS };
  return { ran: true, goal: goalOf(raw.answer.goal), fragment: raw.answer.fragment ?? null, fragmentText: textOf(raw.answer.fragment), cleared: raw.answer.cleared === true, events: eventsOf(raw.answer.events) };
}

export interface CodexSteeringAnswer {
  ran: boolean;
  reason?: string;
  /** continuation: Codex decided to start another turn for this goal. */
  continues: boolean;
  /** Codex's own steering prompt, as it sent it. Null when it sent none. */
  prompt: string | null;
  /** continuation: the objective as Codex hands it to its agent, in its "goal_objective" context item. */
  goalObjectiveContext: string | null;
  /** The goal's status in Codex's store after its decision, when it reported one. */
  status: string | null;
}

/** Codex's scheduling takes longer than a store call: it starts one of its own threads to make the decision. */
const STEERING_TIMEOUT_MS = 30_000;

/**
 * What Codex's own scheduling sends its agent for this goal: its continuation turn when the thread is idle, or the
 * notice it injects mid-turn when the user edits the objective or the budget is reached. Guardian's stop hook
 * delivers it, because in Cursor nothing else can start the agent's next turn.
 */
export async function codexSteering(root: string, want: { kind: "continuation" | "objective_updated" | "budget_limit"; updatePlan?: boolean; newObjective?: string }): Promise<CodexSteeringAnswer> {
  const none: CodexSteeringAnswer = { ran: false, continues: false, prompt: null, goalObjectiveContext: null, status: null };
  const raw = await ask(root, { op: "steering", kind: want.kind, update_plan: want.updatePlan === true, ...(want.newObjective ? { new_objective: want.newObjective } : {}) }, STEERING_TIMEOUT_MS);
  if (!raw.ran) return { ...none, reason: raw.reason };
  const answer = ((raw.answer.steering as { answer?: Record<string, unknown> } | null)?.answer ?? {}) as { continue?: boolean; prompt?: unknown; goal_objective_context?: { output?: unknown } | null; status?: unknown };
  const prompt = typeof answer.prompt === "string" ? answer.prompt : null;
  const objective = answer.goal_objective_context?.output;
  return { ran: true, continues: want.kind === "continuation" ? answer.continue === true : prompt !== null, prompt, goalObjectiveContext: typeof objective === "string" ? objective : null, status: typeof answer.status === "string" ? answer.status : null };
}

/** Codex's budget as its prompts show it. */
export interface CodexBudget {
  tokensUsed: number;
  tokenBudget: number | null;
  timeUsedSeconds: number;
}

export function budgetOf(goal: CodexGoal): CodexBudget {
  return { tokensUsed: goal.tokens_used, tokenBudget: goal.token_budget, timeUsedSeconds: goal.time_used_seconds };
}
