/**
 * OpenAI Codex's own goal store, run beside DeepSeek's goal service for what that one doesn't have: usage accounting,
 * a token budget and the `budget_limited` status. The store is Codex's `codex-state` crate, unmodified, behind
 * Guardian's small command-line binary (packages/codex-goals). DeepSeek's service stays the authority for the goal's
 * phase, revision and rounds; Codex's store is told the same changes and keeps the usage.
 *
 * Nothing here blocks or throws. Where the binary isn't installed every call answers `ran: false` and Guardian works
 * as it did without budgets.
 */
import { spawn } from "node:child_process";
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

/** One request to Codex's store. Never throws. */
export async function codexGoals(root: string, request: CodexGoalRequest): Promise<CodexGoalAnswer> {
  const binary = resolveCodexGoals();
  if (!binary) return { ran: false, reason: "Codex's goal store isn't installed", goal: null };
  const home = codexGoalsHome(root);
  try {
    await fsp.mkdir(home, { recursive: true });
    // The store is sqlite files holding the goal's words and usage: never let them reach a commit.
    await fsp.writeFile(path.join(home, ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);
  } catch {
    return { ran: false, reason: "Codex's goal store has nowhere to live", goal: null };
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const done = (v: CodexGoalAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const failed = (reason: string): CodexGoalAnswer => ({ ran: false, reason, goal: null });
    const child = spawn(binary, ["--home", home], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(failed("Codex's goal store took too long"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.on("error", (err) => done(failed(`Codex's goal store couldn't start: ${err.message}`)));
    child.on("close", () => {
      try {
        const answer = JSON.parse(stdout.trim().split("\n").pop() ?? "") as { ok?: boolean; error?: string; goal?: CodexGoal | null };
        done(answer.ok === true ? { ran: true, goal: answer.goal ?? null } : failed(answer.error ?? "Codex's goal store refused"));
      } catch {
        done(failed("Codex's goal store gave no answer"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(request));
  });
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
