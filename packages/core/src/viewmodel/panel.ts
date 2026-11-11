import { goalHash, goalPhaseOf } from "../goal/loop.js";
import type { Contract } from "../schema/contract.js";
import type { AuditRecord, GoalReviewRecord, ImproveRunRecord } from "../schema/audit.js";
import { enoughToImprove, improveRunning, reviewLabels, type ReviewLabel } from "../goal/improve.js";
import { objectionLines } from "../goal/review.js";

export interface TourStep {
  id: "connect" | "ask" | "steer" | "center";
  label: string;
  hint: string;
  done: boolean;
}

export interface PanelTour {
  steps: TourStep[];
  doneCount: number;
  total: number;
  /** False once dismissed or every step is done — the section disappears for good. */
  visible: boolean;
}

export interface PanelViewModel {
  setUp: boolean;
  goal: string;
  constraints: string[];
  successCriteria: Array<{ id: string; text: string; done: boolean }>;
  /** Where the goal stands, in one word and a lamp. */
  status: { lamp: "idle" | "on" | "warn"; word: string };
  /** The latest run on the goal: still going, or how it ended and what backs it. */
  goalRun: {
    ts: string;
    outcome: "working" | "proved" | "blocked" | "set_aside" | "stalled" | "limit" | "stopped";
    /** The last review objected and the project changed afterwards, unreviewed. */
    changedSinceReview: boolean;
    round: number | null;
    detail: string[];
    extras: string[];
    /** Changed files grouped by the done-when item the agent says each serves. */
    changes: Array<{ serves: string; files: string[] }>;
    /** The independent reviewer's objections: its opinion, for the user to weigh. */
    reviewer: string[];
    goalFileEdited: boolean;
    rounds: number | null;
    seconds: number | null;
    tokens: number | null;
  } | null;
  /** Recent reviews that objected, each objection open to the user's verdict. */
  reviews: Array<{ id: string; lines: string[]; feedback: Array<ReviewLabel | null>; label: { label: ReviewLabel; source: "user" | "fixed" | "overruled" } | null }>;
  /** Guardian improving its own reviewer from those verdicts. */
  improve: {
    labelled: number;
    ready: boolean;
    running: boolean;
    /** Where a running improvement has got to. */
    stage: string | null;
    usingImproved: boolean;
    latest: { id: string; kept: boolean; reason: string; heldOut: number; old?: { correct: number }; new?: { correct: number }; diff: string; hypotheses: string[]; applied: boolean } | null;
  };
  /** Cursor doesn't load project hooks in an untrusted workspace. */
  hooksDisabled: boolean;
  /** Where the goal stands, for the panel's controls. */
  goalPhase: "none" | "active" | "paused" | "complete";
  /** The guided first-ten-minutes checklist; steps tick from the real tape. */
  tour: PanelTour;
}

export interface PanelInputs {
  /** The goal loop's records in full, so its receipts survive past the tape window. */
  goalRecords?: AuditRecord[];
  workspaceTrusted?: boolean;
  setUp: boolean;
  contract: Contract;
  records: AuditRecord[];
  now: Date;
  /** The workspace runs its own improved reviewer instead of the built-in one. */
  improvedReviewer?: boolean;
  /** Host memory: the Command Center has been opened at least once here. */
  commandCenterUsed?: boolean;
  /** Host memory: the user hid the get-started tour. */
  tourDismissed?: boolean;
}

/**
 * The get-started tour is Guardian pointed at its own onboarding: each step
 * completes from evidence on the tape, not from clicking "next". Steps mirror
 * the README's "Your first 10 minutes" exactly.
 */
function buildTour(inputs: PanelInputs): PanelTour {
  const { contract, records } = inputs;
  const steps: TourStep[] = [
    {
      id: "connect",
      label: "Connect Guardian",
      hint: "done — this workspace is wired up",
      done: inputs.setUp,
    },
    {
      id: "ask",
      label: "Ask your agent for something",
      hint: "your request becomes the goal",
      done: contract.goal.trim().length > 0 || records.length > 0,
    },
    {
      id: "steer",
      label: "Type /guardian in the chat",
      hint: "a plain-language briefing of the session",
      // The briefing reads the goal with get_goal; nothing else asks the agent to.
      done: records.some((r) => r.kind === "action.observed" && r.actionType === "mcp" && r.actionValue.endsWith("/get_goal")),
    },
    {
      id: "center",
      label: "Open the Command Center",
      hint: "click the Guardian item in the status bar",
      done: inputs.commandCenterUsed === true,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return {
    steps,
    doneCount,
    total: steps.length,
    visible: inputs.setUp && inputs.tourDismissed !== true && doneCount < steps.length,
  };
}

function proofLine(p: { criterion: string; command?: string | undefined; quote?: string | undefined; file?: string | undefined; contains?: string | undefined }): string {
  return p.command !== undefined ? `${p.criterion}: ran ${p.command}, printed "${p.quote ?? ""}"` : `${p.criterion}: ${p.file ?? ""} contains "${p.contains ?? ""}"`;
}

function groupChanges(changes: Array<{ file: string; serves: string }>): Array<{ serves: string; files: string[] }> {
  const by = new Map<string, string[]>();
  for (const c of changes) by.set(c.serves, [...new Set([...(by.get(c.serves) ?? []), c.file])]);
  return [...by].map(([serves, files]) => ({ serves, files }));
}

function buildGoalRun(records: AuditRecord[]): PanelViewModel["goalRun"] {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i]!;
    if (r.kind === "goal.round") {
      return { ts: r.ts, outcome: "working", changedSinceReview: false, round: r.round, detail: [...r.unproved], extras: r.extras, changes: [], reviewer: r.reviewer ?? [], goalFileEdited: r.goalFileEdited === true, rounds: null, seconds: null, tokens: r.tokens ?? null };
    }
    if (r.kind === "goal.end") {
      const detail = r.outcome === "proved" ? (r.proved ?? []).map(proofLine) : r.reason ? [r.reason] : (r.unproved ?? []);
      return { ts: r.ts, outcome: r.outcome, changedSinceReview: r.changedSinceReview === true, round: null, detail, extras: r.extras ?? [], changes: groupChanges(r.changes ?? []), reviewer: r.reviewer ?? [], goalFileEdited: r.goalFileEdited === true, rounds: r.rounds ?? null, seconds: r.seconds ?? null, tokens: r.tokens ?? null };
    }
  }
  return null;
}

function goalStatus(phase: PanelViewModel["goalPhase"], run: PanelViewModel["goalRun"]): PanelViewModel["status"] {
  if (phase === "none") return { lamp: "idle", word: "no goal" };
  if (phase === "paused") return { lamp: "idle", word: "paused" };
  // The record backs every item, but the review still objects to this very state: not a clean "proved".
  if (phase === "complete" && run?.outcome === "proved" && run.reviewer.length) return { lamp: "warn", word: "disputed" };
  if (phase === "complete") return run?.outcome === "proved" ? { lamp: "on", word: "proved" } : { lamp: "idle", word: "closed" };
  if (run?.outcome === "blocked") return { lamp: "warn", word: "blocked" };
  if (run?.outcome === "stalled" || run?.outcome === "limit") return { lamp: "warn", word: "stalled" };
  return { lamp: "on", word: "active" };
}

/** The items the latest proved run on this goal backed. Nothing else ticks: not a claim, and not the user's "done". */
function provedItems(records: AuditRecord[], contract: Contract): Set<string> {
  const hash = goalHash(contract);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i]!;
    if (r.kind === "goal.end" && r.outcome === "proved" && r.goalHash === hash) return new Set((r.proved ?? []).map((p) => p.criterion));
  }
  return new Set();
}

const REVIEWS_SHOWN = 3;

function buildReviews(records: AuditRecord[]): PanelViewModel["reviews"] {
  const labels = reviewLabels(records);
  const feedback = new Map<string, Map<number, ReviewLabel>>();
  for (const r of records) if (r.kind === "review.feedback") feedback.set(r.reviewId, (feedback.get(r.reviewId) ?? new Map()).set(r.index, r.label));
  return records
    .filter((r): r is GoalReviewRecord & { id: string } => r.kind === "goal.review" && Boolean(r.id) && objectionLines(r).length > 0)
    .slice(-REVIEWS_SHOWN)
    .reverse()
    .map((r) => {
      const lines = objectionLines(r);
      return { id: r.id, lines, feedback: lines.map((_, i) => feedback.get(r.id)?.get(i) ?? null), label: labels.get(r.id) ?? null };
    });
}

function buildImprove(records: AuditRecord[], usingImproved: boolean): PanelViewModel["improve"] {
  const saved = new Set(records.filter((r): r is GoalReviewRecord => r.kind === "goal.review" && r.caseSaved === true && Boolean(r.id)).map((r) => r.id!));
  const labelled = [...reviewLabels(records)].filter(([id]) => saved.has(id)).map(([, l]) => l);
  const runs = records.filter((r): r is ImproveRunRecord => r.kind === "improve.run");
  const last = runs[runs.length - 1];
  const applies = records.filter((r) => r.kind === "improve.apply" || r.kind === "improve.undo");
  const lastApply = applies[applies.length - 1];
  const applied = Boolean(last && usingImproved && lastApply?.kind === "improve.apply" && lastApply.runId === last.id);
  return {
    labelled: labelled.length,
    ready: enoughToImprove(labelled),
    running: improveRunning(records),
    stage: improveRunning(records) ? ([...records].reverse().find((r) => r.kind === "improve.progress") as { stage?: string } | undefined)?.stage ?? null : null,
    usingImproved,
    latest: last ? { id: last.id, kept: last.kept, reason: last.reason, heldOut: last.heldOut, ...(last.old ? { old: last.old } : {}), ...(last.new ? { new: last.new } : {}), diff: last.diff, hypotheses: last.hypotheses, applied } : null,
  };
}

/** Pure projection: everything the panel renders, computed from disk artifacts. */
export function buildPanelViewModel(inputs: PanelInputs): PanelViewModel {
  const { contract, records, now } = inputs;

  if (!inputs.setUp) {
    return {
      setUp: false,
      goal: "",
      constraints: [],
      successCriteria: [],
      status: { lamp: "idle", word: "no goal" },
      goalRun: null,
      reviews: [],
      improve: { labelled: 0, ready: false, running: false, stage: null, usingImproved: false, latest: null },
      goalPhase: "none",
      hooksDisabled: inputs.workspaceTrusted === false,
      tour: buildTour(inputs),
    };
  }

  const goalRun = buildGoalRun(inputs.goalRecords ?? records);

  const goalRecords = inputs.goalRecords ?? records;
  const goalPhase = goalPhaseOf(goalRecords, contract);
  const proved = provedItems(goalRecords, contract);

  return {
    setUp: true,
    goal: contract.goal,
    constraints: contract.constraints,
    successCriteria: contract.successCriteria.map((c) => ({ ...c, done: proved.has(c.id) })),
    status: goalStatus(goalPhase, goalRun),
    goalRun,
    reviews: buildReviews(goalRecords),
    improve: buildImprove(goalRecords, inputs.improvedReviewer === true),
    hooksDisabled: inputs.workspaceTrusted === false,
    goalPhase,
    tour: buildTour(inputs),
  };
}
