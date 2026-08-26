import type { AuditRecord, LexicalDriftRecord } from "../schema/audit.js";
import type { GuardianAction } from "../schema/state.js";

export const REALIGNMENT_ACTION_TYPES = ["START_TASK", "ADD_DECISION", "COMPLETE_TASK", "PIN_CONTEXT"] as const;

export type DriftStatus = "pending" | "confirmed" | "dismissed";

export interface PairedDrift {
  driftId: string;
  episodeId: string;
  ts: string;
  actionType: LexicalDriftRecord["actionType"];
  actionValue: string;
  activeTaskId: string;
  activeTaskTitle: string;
  /** Semantic review status; pending = unreviewed lexical signal. */
  status: DriftStatus;
  verdictRationale: string | null;
  realigned: boolean;
  realignment: { ts: string; type: string } | null;
}

export interface DriftTelemetry {
  drift24h: number;
  realign24h: number;
  unresolved: number;
  health: "stable" | "recovering" | "drifting";
  entries: PairedDrift[];
}

export interface PairingOptions {
  now: Date;
  windowMs?: number;
  horizonMs?: number;
  maxEntries?: number;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;

function ms(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Pair each lexical drift with its semantic verdict (by driftId) and with the
 * first realignment action inside the match window (by time — realignments
 * carry no drift reference, so the window heuristic survives from v1 here,
 * and only here).
 */
export function pairDriftTelemetry(
  records: AuditRecord[],
  actions: GuardianAction[],
  options: PairingOptions,
): DriftTelemetry {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const horizonStart = options.now.getTime() - (options.horizonMs ?? DEFAULT_HORIZON_MS);
  const maxEntries = options.maxEntries ?? 12;

  const drifts = records
    .filter((r): r is LexicalDriftRecord => r.kind === "drift.lexical")
    .filter((r) => ms(r.ts) > 0)
    .sort((a, b) => ms(a.ts) - ms(b.ts));

  const verdictByDrift = new Map<string, { verdict: "confirmed" | "dismissed"; rationale: string }>();
  for (const r of records) {
    if (r.kind === "drift.verdict") verdictByDrift.set(r.driftId, { verdict: r.verdict, rationale: r.rationale });
  }

  const realignments = actions
    .filter((a) => (REALIGNMENT_ACTION_TYPES as readonly string[]).includes(a.type))
    .map((a) => ({ ts: a.ts, tsMs: ms(a.ts), type: a.type }))
    .filter((a) => a.tsMs > 0)
    .sort((a, b) => a.tsMs - b.tsMs);

  const entries: PairedDrift[] = drifts.map((drift) => {
    const tsMs = ms(drift.ts);
    const verdict = verdictByDrift.get(drift.driftId) ?? null;
    const match = realignments.find((a) => a.tsMs >= tsMs && a.tsMs <= tsMs + windowMs) ?? null;
    return {
      driftId: drift.driftId,
      episodeId: drift.episodeId,
      ts: drift.ts,
      actionType: drift.actionType,
      actionValue: drift.actionValue,
      activeTaskId: drift.activeTaskId,
      activeTaskTitle: drift.activeTaskTitle,
      status: verdict?.verdict ?? "pending",
      verdictRationale: verdict?.rationale ?? null,
      realigned: match !== null,
      realignment: match ? { ts: match.ts, type: match.type } : null,
    };
  });

  const inHorizon = entries.filter((e) => ms(e.ts) >= horizonStart && e.status !== "dismissed");
  const drift24h = inHorizon.length;
  const realign24h = inHorizon.filter((e) => e.realigned).length;
  const unresolved = inHorizon.filter((e) => !e.realigned).length;
  const health: DriftTelemetry["health"] = drift24h === 0 ? "stable" : unresolved === 0 ? "recovering" : "drifting";

  return {
    drift24h,
    realign24h,
    unresolved,
    health,
    entries: entries.slice(-maxEntries).reverse(),
  };
}
