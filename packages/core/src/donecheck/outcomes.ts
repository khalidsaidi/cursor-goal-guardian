/**
 * The outcome of every flag Guardian raises — no model, read off the tape. When the agent answers a
 * send-back, compare the new check with the one that sent it: did the problem clear, and did the agent
 * change files to clear it? When tests a turn broke pass again, say so. These are the labels the
 * case file, and the panel's track record learn from.
 */
import type { AuditRecord, DoneCheckRecord, FlagOutcomeRecord, TestsRerunRecord } from "../schema/audit.js";

type Scope = { conversationId?: string; sinceIso?: string };

function inScope(rec: { ts: string; conversationId?: string }, scope: Scope): boolean {
  if (scope.conversationId && rec.conversationId) return rec.conversationId === scope.conversationId;
  if (!scope.sinceIso) return !scope.conversationId || !rec.conversationId;
  return Date.parse(rec.ts) >= Date.parse(scope.sinceIso);
}

/** Files the agent edited in scope after `sinceTs` (Guardian's own files excluded). */
export function editsSince(records: AuditRecord[], scope: Scope, sinceTs: string): number {
  const since = Date.parse(sinceTs);
  return new Set(
    records
      .filter((r): r is Extract<AuditRecord, { kind: "action.observed" }> => r.kind === "action.observed" && r.actionType === "edit")
      .filter((r) => inScope(r, scope) && Date.parse(r.ts) > since && !r.actionValue.startsWith(".cursor/"))
      .map((r) => r.actionValue),
  ).size;
}

/** The latest done check in scope that sent the agent back. */
export function lastSendBack(records: AuditRecord[], scope: Scope): DoneCheckRecord | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i]!;
    if (r.kind === "done.check" && inScope(r, scope)) return r.followupSent ? r : null;
  }
  return null;
}

interface NewCheck {
  ts: string;
  conversationId?: string;
  /** Deterministic verdict of the answer. */
  verdict: DoneCheckRecord["verdict"];
  /** "Done when" items the answer still leaves open (openWork). */
  open?: string[];
}

/**
 * Outcomes for the send-back the agent just answered.
 */
export function sendBackOutcomes(prev: DoneCheckRecord, next: NewCheck, editsAfter: number): FlagOutcomeRecord[] {
  const base = { ts: next.ts, kind: "flag.outcome" as const, ...(next.conversationId ? { conversationId: next.conversationId } : {}), ref: prev.ts, editsAfter };
  // The wrap-up asks for a summary, not a fix: nothing to score.
  if (prev.wrapped) return [];
  if (prev.continued) {
    // A keep-going: the items it named are closed when the answer no longer leaves them open.
    const key = (s: string) => s.split(":")[0]!;
    const still = new Set((next.open ?? []).map(key));
    const left = (prev.open ?? []).filter((o) => still.has(key(o)));
    return [{
      ...base,
      flag: "keep_going" as const,
      outcome: next.verdict !== "pass" && next.verdict !== "blocked" ? "ignored" : left.length > 0 ? "ignored" : editsAfter > 0 ? "fixed" : "corrected",
      text: (prev.open ?? []).join("; ").slice(0, 600),
    }];
  }
  const cleared = next.verdict === "pass" || next.verdict === "blocked";
  const problems = [...prev.problems, ...prev.lines.filter((l) => l.status === "missing" || l.status === "unsupported" || l.status === "contradicted").map((l) => `${l.key}: ${l.note}`)];
  return [
    {
      ...base,
      flag: "followup" as const,
      outcome: !cleared ? "ignored" : editsAfter > 0 ? "fixed" : "corrected",
      ...(problems.length ? { text: problems.join("; ").slice(0, 600) } : {}),
    },
  ];
}

/** A passing re-run after tests this conversation broke: they are green again. */
export function testsOutcome(records: AuditRecord[], scope: Scope, now: TestsRerunRecord): FlagOutcomeRecord | null {
  if (now.exit !== 0) return null;
  let broke: TestsRerunRecord | null = null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i]!;
    if (r.kind !== "tests.rerun" || !inScope(r, scope) || r.ts === now.ts) continue;
    if (!r.broke) return null; // the latest earlier run was not a break
    broke = r;
    break;
  }
  if (!broke) return null;
  const answered = records.some((r) => r.kind === "flag.outcome" && r.flag === "tests_broke" && r.ref === broke!.ts);
  if (answered) return null;
  return {
    ts: now.ts,
    kind: "flag.outcome",
    ...(now.conversationId ? { conversationId: now.conversationId } : {}),
    flag: "tests_broke",
    ref: broke.ts,
    outcome: "tests_green",
    editsAfter: editsSince(records, scope, broke.ts),
    text: `${broke.command} (exit ${broke.exit})`,
  };
}

/** The user says a flag was a false alarm (the panel's "wrong flag"). */
export function markedWrong(input: { flag: FlagOutcomeRecord["flag"]; ref: string; line?: string; conversationId?: string; ts: string }): FlagOutcomeRecord {
  return {
    ts: input.ts,
    kind: "flag.outcome",
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    flag: input.flag,
    ref: input.ref,
    ...(input.line ? { line: input.line } : {}),
    outcome: "marked_wrong",
    editsAfter: 0,
  };
}

/** Outcome counts for the panel's track record: how Guardian's flags turned out. */
export function flagTrackRecord(records: AuditRecord[], sinceMs: number): Record<FlagOutcomeRecord["outcome"], number> {
  const counts = { fixed: 0, corrected: 0, tests_green: 0, ignored: 0, marked_wrong: 0 };
  for (const r of records) if (r.kind === "flag.outcome" && Date.parse(r.ts) >= sinceMs) counts[r.outcome] += 1;
  return counts;
}

/** One flag and how it turned out: a row of the case file. */
export interface FlagCase {
  flag: FlagOutcomeRecord["flag"];
  ref: string;
  line?: string;
  ts: string;
  conversationId?: string;
  /** What Guardian said. */
  text: string;
  /** For drift: the judge's verdict on it, when it ran. */
  judged?: "confirmed" | "dismissed";
  /** realigned = the agent came back to the goal after a drift nudge; open = no outcome yet. */
  outcome: FlagOutcomeRecord["outcome"] | "realigned" | "open";
  editsAfter?: number;
}

/**
 * Every flag Guardian raised, joined with its outcome. A user's "marked wrong" overrides any
 * other outcome: it is the strongest label there is. Drift outcomes come from the realignment
 * pairing (the agent started/finished a task or recorded a decision soon after the nudge).
 */
export function buildCaseFile(records: AuditRecord[], drift: Array<{ driftId: string; ts: string; actionValue: string; activeTaskTitle: string; status: string; realigned: boolean }>): FlagCase[] {
  const outcomeOf = new Map<string, FlagOutcomeRecord>();
  for (const r of records) {
    if (r.kind !== "flag.outcome") continue;
    const key = [r.flag, r.ref, r.line ?? ""].join("|");
    const prev = outcomeOf.get(key);
    if (!prev || prev.outcome !== "marked_wrong") outcomeOf.set(key, r);
  }
  const cases: FlagCase[] = [];
  const add = (c: Omit<FlagCase, "outcome" | "editsAfter">, fallback: FlagCase["outcome"] = "open"): void => {
    const o = outcomeOf.get([c.flag, c.ref, c.line ?? ""].join("|"));
    cases.push({ ...c, outcome: o?.outcome ?? fallback, ...(o ? { editsAfter: o.editsAfter } : {}) });
  };
  for (const r of records) {
    if (r.kind === "done.check" && r.followupSent && !r.wrapped) {
      const cid = r.conversationId ? { conversationId: r.conversationId } : {};
      if (r.continued) {
        add({ flag: "keep_going", ref: r.ts, ts: r.ts, ...cid, text: (r.open ?? []).join("; ") });
      } else {
        const problems = [...r.problems, ...r.lines.filter((l) => l.status === "missing" || l.status === "unsupported" || l.status === "contradicted").map((l) => `${l.key}: ${l.note}`)];
        add({ flag: "followup", ref: r.ts, ts: r.ts, ...cid, text: problems.join("; ") || r.verdict });
      }
    } else if (r.kind === "loop.repeat") {
      add({ flag: "loop", ref: r.ts, ts: r.ts, ...(r.conversationId ? { conversationId: r.conversationId } : {}), text: `${r.command.slice(0, 200)} ×${r.count}` });
    } else if (r.kind === "tests.rerun" && r.broke) {
      add({ flag: "tests_broke", ref: r.ts, ts: r.ts, ...(r.conversationId ? { conversationId: r.conversationId } : {}), text: `${r.command} (exit ${r.exit})` });
    }
  }
  for (const d of drift) {
    if (d.status === "dismissed" && !outcomeOf.has(["drift", d.driftId, ""].join("|"))) continue;
    add(
      { flag: "drift", ref: d.driftId, ts: d.ts, text: `${d.actionValue} · task: ${d.activeTaskTitle}`, ...(d.status === "confirmed" || d.status === "dismissed" ? { judged: d.status } : {}) },
      d.realigned ? "realigned" : "open",
    );
  }
  return cases.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
