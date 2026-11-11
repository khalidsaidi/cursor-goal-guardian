/**
 * The two goal keepers side by side. DeepSeek Harness's service (engine.ts) and Codex's goal extension
 * (codexGoals.ts) each run their own code, unmodified, and Guardian passes every event to both. Neither is in
 * charge of the other: a change to the goal happens only if both accept it, and if either says the run is over,
 * it is over. This file holds the parts of that joining that
 * aren't specific to one moment of the goal loop; the moments themselves are in loop.ts.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAudit } from "../audit/log.js";
import { nowIso } from "../clock.js";
import type { GoalRefusedRecord } from "../schema/audit.js";
import { useCodexToolSpecs } from "./originals.js";
import { codexGoals, codexGoalsHome, codexSteering, codexTool, codexToolSpecs, codexUserGoal, resolveCodexGoals, type CodexGoal, type CodexSteeringAnswer, type CodexToolAnswer } from "./codexGoals.js";

/** Put on the record that a change didn't happen, and who refused it. */
export async function recordRefusal(root: string, goalHash: string, change: string, by: GoalRefusedRecord["by"], message: string, conversationId?: string): Promise<void> {
  await appendAudit(root, { ts: nowIso(), kind: "goal.refused", ...(conversationId ? { conversationId } : {}), goalHash, change, by, message: message.slice(0, 600) }).catch(() => undefined);
}

const FRAGMENT_FILE = "user-goal-fragment.txt";

/**
 * The user set or changed the goal: Codex's own GoalService records it, as its app-server does for a user's edit,
 * and its "User set the goal: ..." context fragment is kept for the agent. Where the binary has no such request
 * (an older build, or none), the bare store is told instead. Never blocks.
 */
export async function codexUserSet(root: string, objective: string, fresh: boolean): Promise<void> {
  if (!resolveCodexGoals()) return;
  // A new goal starts its usage from zero; an edit keeps it. The store's own `fresh` does that.
  if (fresh) await codexGoals(root, { op: "set", objective, fresh: true });
  const set = await codexUserGoal(root, { objective });
  if (!set.ran) {
    if (!fresh) await codexGoals(root, { op: "set", objective });
    return;
  }
  if (set.fragmentText.trim()) await fsp.writeFile(path.join(codexGoalsHome(root), FRAGMENT_FILE), set.fragmentText).catch(() => undefined);
}

/** A status the user set (pause, resume, done from the panel): Codex's GoalService, else its bare store. */
export async function codexUserStatus(root: string, status: CodexGoal["status"]): Promise<void> {
  if (!resolveCodexGoals()) return;
  const set = await codexUserGoal(root, { status });
  if (!set.ran) await codexGoals(root, { op: "status", status });
}

/** Codex's own words for the user's latest goal change ("User set the goal: ..."), or "" where it gave none. */
export async function codexUserFragment(root: string): Promise<string> {
  return (await fsp.readFile(path.join(codexGoalsHome(root), FRAGMENT_FILE), "utf8").catch(() => "")).trim();
}

/**
 * Codex's tool definitions from its own executors, put in place of the copy read out of its source. Asked once, at
 * the MCP server's start, in a throwaway home (the definitions don't depend on any goal). False where its
 * extension isn't installed: the copy from its source stays.
 */
export async function loadCodexToolSpecs(): Promise<boolean> {
  if (!resolveCodexGoals()) return false;
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "gg-codex-specs-")).catch(() => null);
  if (!scratch) return false;
  try {
    const specs = await codexToolSpecs(scratch);
    return specs.ran && useCodexToolSpecs(specs.tools);
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** One of Codex's goal tools through its real handler, or null where its extension isn't installed. */
export async function codexAgentTool(root: string, name: "get_goal" | "create_goal" | "update_goal", args: Record<string, unknown> = {}): Promise<CodexToolAnswer | null> {
  if (!resolveCodexGoals()) return null;
  const out = await codexTool(root, name, args);
  return out.ran ? out : null;
}

/** What Codex's handler told the model: its refusal, or its own result. */
export function codexSaid(out: CodexToolAnswer | null): unknown {
  if (!out) return undefined;
  return out.accepted ? (out.result ?? out.modelOutput) : { refused: out.refusal ?? "Codex's tool refused" };
}

/** Codex's statuses in which its scheduling starts no continuation turn. */
const CODEX_STOPPED = new Set(["paused", "blocked", "complete", "budget_limited", "usage_limited"]);

export interface CodexContinuation {
  ran: boolean;
  reason?: string;
  /** Codex's scheduling started a continuation turn: its prompt and its goal_objective context are what it sent. */
  continues: boolean;
  /** Codex's goal isn't in a state it continues from: by the joining rule, the run stops. */
  stops: boolean;
  prompt: string | null;
  goalObjectiveContext: string | null;
  status: string | null;
}

/** Ask Codex's own scheduling for its continuation turn. Never throws. */
export async function codexContinuationTurn(root: string): Promise<CodexContinuation> {
  const none: CodexContinuation = { ran: false, continues: false, stops: false, prompt: null, goalObjectiveContext: null, status: null };
  if (!resolveCodexGoals()) return { ...none, reason: "Codex's goal extension isn't installed" };
  const s: CodexSteeringAnswer = await codexSteering(root, { kind: "continuation" });
  if (!s.ran) return { ...none, ...(s.reason ? { reason: s.reason } : {}) };
  const continues = s.continues && Boolean(s.prompt);
  return { ran: true, continues, stops: !continues && s.status !== null && CODEX_STOPPED.has(s.status), prompt: s.prompt, goalObjectiveContext: s.goalObjectiveContext, status: s.status };
}

/** Codex's own mid-turn notice (objective edited, or budget reached), or null where it gave none. */
export async function codexNotice(root: string, kind: "objective_updated" | "budget_limit", newObjective?: string): Promise<string | null> {
  if (!resolveCodexGoals()) return null;
  const s = await codexSteering(root, { kind, ...(newObjective ? { newObjective } : {}) });
  return s.ran ? s.prompt : null;
}
