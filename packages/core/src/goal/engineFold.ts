/**
 * Reading the goal's state from DeepSeek Harness's own event log. Guardian persists that log, event by event, as
 * `goal.engine` audit records; the state is whatever DeepSeek's own `foldGoal` (packages/goal/goal/src/fold.ts,
 * from the published @deepseek-ai/dsh-goal) says those events add up to. Nothing here decides a phase.
 *
 * The package is loaded on demand: Guardian's hook runs on every command and edit, and only the events that read
 * the goal pay for it. The audit readers load it when they meet engine records, so a read stays synchronous.
 */
import type { AuditRecord } from "../schema/audit.js";

/** The current goal as DeepSeek's fold reports it. */
export interface EngineGoal {
  id: string;
  revision: number;
  objective: string;
  /** DeepSeek's durable phases. */
  phase: "active" | "paused" | "blocked" | "complete";
  blockedReason?: { code: string; message: string };
  maxGoalRounds: number;
  /** Admitted goal rounds, counted by DeepSeek's fold. */
  roundsStarted: number;
}

interface Folded {
  goal?: Omit<EngineGoal, "roundsStarted">;
  roundsStarted: number;
}

let fold: ((events: readonly never[]) => Folded) | null = null;

/** Load DeepSeek's `foldGoal`. Idempotent; the audit readers call it when a log holds engine records. */
export async function loadEngineFold(): Promise<void> {
  if (fold) return;
  const mod = await import("@deepseek-ai/dsh-goal");
  fold = mod.foldGoal as unknown as (events: readonly never[]) => Folded;
}

export type EngineEvent = Record<string, unknown>;

/** The engine's events in these records, oldest first: everything after the last reset. */
export function engineEvents(records: readonly AuditRecord[]): EngineEvent[] {
  let events: EngineEvent[] = [];
  for (const r of records) {
    if (r.kind !== "goal.engine") continue;
    if (r.reset) events = [];
    else if (r.event) events.push(r.event);
  }
  return events;
}

/**
 * The goal DeepSeek's fold finds in these records: the goal, null when the log holds none current (never created,
 * or cleared), undefined when there is no engine log to read (an older workspace, or records built by hand).
 */
export function engineView(records: readonly AuditRecord[]): EngineGoal | null | undefined {
  const events = engineEvents(records);
  if (!events.length || !fold) return undefined;
  try {
    const folded = fold(events as never[]);
    return folded.goal ? { ...folded.goal, roundsStarted: folded.roundsStarted } : null;
  } catch {
    // A log their strict replay rejects is no authority: the caller falls back, and the next mutation resets it.
    return undefined;
  }
}
