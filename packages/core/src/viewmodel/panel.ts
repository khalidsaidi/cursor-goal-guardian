import type { GuardianState, GuardianAction, Task } from "../schema/state.js";
import type { AuditRecord } from "../schema/audit.js";
import { summarizeSession, type SessionSummary } from "../telemetry/summary.js";
import type { PairedDrift } from "../telemetry/pairing.js";

export interface PanelTask {
  id: string;
  title: string;
  active: boolean;
  criterionId: string | null;
}

export interface PanelDriftEntry {
  driftId: string;
  ts: string;
  status: PairedDrift["status"];
  realigned: boolean;
  realignmentType: string | null;
  label: string;
  detail: string;
}

export interface PanelViewModel {
  setUp: boolean;
  goal: string;
  constraints: string[];
  successCriteria: Array<{ id: string; text: string; done: boolean }>;
  activeTask: { id: string; title: string } | null;
  board: { todo: PanelTask[]; doing: PanelTask[]; done: PanelTask[] };
  health: SessionSummary["drift"]["health"];
  counts24h: SessionSummary["counts24h"];
  driftFeed: PanelDriftEntry[];
  /** Confirmed, un-realigned drifts in the last 24h — the view badge number. */
  badge: number;
  semantic: { consented: boolean; available: boolean; pendingCount: number };
  /** Latest whole-tape judge verdict, if any. */
  sessionReview: { verdict: "on_course" | "off_course"; confidence: number; rationale: string; ts: string; flaggedActions: string[] } | null;
  /** One honest sentence when the tape suggests the CONTRACT (not the agent) is stale. */
  suggestion: string | null;
}

export interface PanelInputs {
  setUp: boolean;
  state: GuardianState;
  records: AuditRecord[];
  actions: GuardianAction[];
  now: Date;
  semanticConsented: boolean;
  semanticAvailable: boolean;
}

function toPanelTask(t: Task, activeId: string | null): PanelTask {
  return { id: t.id, title: t.title, active: t.id === activeId, criterionId: t.criterionId ?? null };
}

function driftLabel(entry: PairedDrift): string {
  const base =
    entry.status === "confirmed"
      ? "Drift confirmed"
      : entry.status === "dismissed"
        ? "Dismissed by review"
        : "Possible drift (unreviewed)";
  return entry.realigned ? `${base} — realigned` : base;
}

/** Pure projection: everything the panel renders, computed from disk artifacts. */
export function buildPanelViewModel(inputs: PanelInputs): PanelViewModel {
  const { state, records, actions, now } = inputs;

  if (!inputs.setUp) {
    return {
      setUp: false,
      goal: "",
      constraints: [],
      successCriteria: [],
      activeTask: null,
      board: { todo: [], doing: [], done: [] },
      health: "stable",
      counts24h: { driftPending: 0, driftConfirmed: 0, driftDismissed: 0, advisories: 0, intents: 0 },
      driftFeed: [],
      badge: 0,
      semantic: { consented: inputs.semanticConsented, available: inputs.semanticAvailable, pendingCount: 0 },
      sessionReview: null,
      suggestion: null,
    };
  }

  const summary = summarizeSession(state, records, actions, now);
  const doneByCriterion = new Set(
    state.tasks.filter((t) => t.status === "done" && t.criterionId).map((t) => t.criterionId as string),
  );

  const driftFeed: PanelDriftEntry[] = summary.drift.entries.map((entry) => ({
    driftId: entry.driftId,
    ts: entry.ts,
    status: entry.status,
    realigned: entry.realigned,
    realignmentType: entry.realignment?.type ?? null,
    label: driftLabel(entry),
    detail: `[${entry.actionType}] ${entry.actionValue} · task: ${entry.activeTaskTitle}`,
  }));

  const horizon = now.getTime() - 24 * 60 * 60 * 1000;
  const badge = summary.drift.entries.filter(
    (e) => e.status === "confirmed" && !e.realigned && Date.parse(e.ts) >= horizon,
  ).length;

  let sessionReview: PanelViewModel["sessionReview"] = null;
  for (const r of records) {
    if (r.kind === "session.review" && (!sessionReview || Date.parse(r.ts) > Date.parse(sessionReview.ts))) {
      sessionReview = { verdict: r.verdict, confidence: r.confidence, rationale: r.rationale, ts: r.ts, flaggedActions: r.flaggedActions };
    }
  }

  // Trust hierarchy: an unreviewed lexical signal should not outvote a
  // confident whole-tape verdict. With nothing CONFIRMED and open, and the
  // judge reading the session as on course, "drifting" softens to recovering.
  let health = summary.drift.health;
  const confirmedOpen = summary.drift.entries.some(
    (e) => e.status === "confirmed" && !e.realigned && Date.parse(e.ts) >= horizon,
  );
  if (health === "drifting" && !confirmedOpen && sessionReview?.verdict === "on_course" && sessionReview.confidence >= 0.7) {
    health = "recovering";
  }

  const persistentlyOff =
    (summary.drift.health === "drifting" && summary.drift.unresolved >= 3) ||
    (sessionReview?.verdict === "off_course" && sessionReview.confidence >= 0.7);
  const suggestion = persistentlyOff
    ? "A lot of recent work reads as off-goal. If the goal actually changed, update the contract or record a decision — the guardian scores against what's declared, not what's intended."
    : null;

  return {
    setUp: true,
    goal: state.goal,
    constraints: state.constraints,
    successCriteria: state.successCriteria.map((c) => ({ ...c, done: doneByCriterion.has(c.id) })),
    activeTask: summary.activeTask,
    board: {
      todo: state.tasks.filter((t) => t.status === "todo").map((t) => toPanelTask(t, state.activeTaskId)),
      doing: state.tasks.filter((t) => t.status === "doing").map((t) => toPanelTask(t, state.activeTaskId)),
      done: state.tasks.filter((t) => t.status === "done").map((t) => toPanelTask(t, state.activeTaskId)),
    },
    health,
    counts24h: summary.counts24h,
    driftFeed,
    badge,
    semantic: {
      consented: inputs.semanticConsented,
      available: inputs.semanticAvailable,
      pendingCount: summary.counts24h.driftPending,
    },
    sessionReview,
    suggestion,
  };
}
