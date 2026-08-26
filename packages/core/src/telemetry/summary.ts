import type { AuditRecord } from "../schema/audit.js";
import type { GuardianAction, GuardianState } from "../schema/state.js";
import { pairDriftTelemetry, type DriftTelemetry } from "./pairing.js";

export interface SessionSummary {
  goal: string;
  activeTask: { id: string; title: string } | null;
  tasks: { todo: number; doing: number; done: number };
  drift: DriftTelemetry;
  counts24h: {
    driftPending: number;
    driftConfirmed: number;
    driftDismissed: number;
    advisories: number;
    intents: number;
  };
}

/** The flight-recorder read: everything the status bar, panel tiles, and guardian_get_status share. */
export function summarizeSession(
  state: GuardianState,
  records: AuditRecord[],
  actions: GuardianAction[],
  now: Date,
): SessionSummary {
  const drift = pairDriftTelemetry(records, actions, { now });
  const horizonStart = now.getTime() - 24 * 60 * 60 * 1000;
  const inHorizon = (ts: string): boolean => {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) && parsed >= horizonStart;
  };

  const verdicts = new Map<string, "confirmed" | "dismissed">();
  for (const r of records) {
    if (r.kind === "drift.verdict") verdicts.set(r.driftId, r.verdict);
  }
  const driftRecords = records.filter((r) => r.kind === "drift.lexical" && inHorizon(r.ts));

  const activeTask = state.activeTaskId
    ? state.tasks.find((t) => t.id === state.activeTaskId) ?? null
    : null;

  return {
    goal: state.goal,
    activeTask: activeTask ? { id: activeTask.id, title: activeTask.title } : null,
    tasks: {
      todo: state.tasks.filter((t) => t.status === "todo").length,
      doing: state.tasks.filter((t) => t.status === "doing").length,
      done: state.tasks.filter((t) => t.status === "done").length,
    },
    drift,
    counts24h: {
      driftPending: driftRecords.filter((r) => r.kind === "drift.lexical" && !verdicts.has(r.driftId)).length,
      driftConfirmed: driftRecords.filter((r) => r.kind === "drift.lexical" && verdicts.get(r.driftId) === "confirmed").length,
      driftDismissed: driftRecords.filter((r) => r.kind === "drift.lexical" && verdicts.get(r.driftId) === "dismissed").length,
      advisories: records.filter((r) => r.kind === "policy.advisory" && inHorizon(r.ts)).length,
      intents: records.filter((r) => r.kind === "intent.declared" && inHorizon(r.ts)).length,
    },
  };
}
