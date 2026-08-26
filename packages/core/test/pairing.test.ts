import { describe, it, expect } from "vitest";
import {
  pairDriftTelemetry,
  summarizeSession,
  defaultState,
  type AuditRecord,
  type GuardianAction,
} from "../src/index.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60 * 1000).toISOString();

function driftRecord(id: string, tsMinAgo: number): AuditRecord {
  return {
    ts: at(tsMinAgo),
    kind: "drift.lexical",
    driftId: id,
    episodeId: `ep_${id}`,
    actionType: "shell",
    actionValue: "docker build .",
    activeTaskId: "t1",
    activeTaskTitle: "Ship CSV export",
    taskTerms: ["csv"],
    actionTerms: ["docker", "build"],
    confidence: "medium",
  };
}

function verdictRecord(id: string, verdict: "confirmed" | "dismissed", tsMinAgo: number): AuditRecord {
  return { ts: at(tsMinAgo), kind: "drift.verdict", driftId: id, verdict, judge: "cursor-agent", confidence: 0.9, rationale: "r" };
}

function action(type: GuardianAction["type"], tsMinAgo: number): GuardianAction {
  return { id: `a${tsMinAgo}`, ts: at(tsMinAgo), actor: "agent", type, payload: {} };
}

describe("drift/realignment pairing", () => {
  it("pairs a drift with the first realignment inside the 15-minute window", () => {
    const t = pairDriftTelemetry([driftRecord("d1", 60)], [action("ADD_DECISION", 50)], { now: NOW });
    expect(t.entries[0]).toMatchObject({ driftId: "d1", realigned: true, realignment: { type: "ADD_DECISION" } });
    expect(t.realign24h).toBe(1);
    expect(t.unresolved).toBe(0);
    expect(t.health).toBe("recovering");
  });

  it("a realignment outside the window does not pair", () => {
    const t = pairDriftTelemetry([driftRecord("d1", 60)], [action("START_TASK", 40)], { now: NOW });
    expect(t.entries[0]?.realigned).toBe(false);
    expect(t.unresolved).toBe(1);
    expect(t.health).toBe("drifting");
  });

  it("a realignment before the drift never pairs", () => {
    const t = pairDriftTelemetry([driftRecord("d1", 60)], [action("START_TASK", 70)], { now: NOW });
    expect(t.entries[0]?.realigned).toBe(false);
  });

  it("only realignment action types count", () => {
    const t = pairDriftTelemetry([driftRecord("d1", 60)], [action("OPEN_QUESTION", 55)], { now: NOW });
    expect(t.entries[0]?.realigned).toBe(false);
  });

  it("verdicts fold in by driftId; dismissed drifts leave the 24h counts", () => {
    const records = [
      driftRecord("d1", 90),
      driftRecord("d2", 60),
      verdictRecord("d1", "dismissed", 30),
      verdictRecord("d2", "confirmed", 30),
    ];
    const t = pairDriftTelemetry(records, [], { now: NOW });
    const byId = Object.fromEntries(t.entries.map((e) => [e.driftId, e]));
    expect(byId.d1?.status).toBe("dismissed");
    expect(byId.d2?.status).toBe("confirmed");
    expect(t.drift24h).toBe(1);
    expect(t.unresolved).toBe(1);
  });

  it("drifts older than the horizon are listed but not counted", () => {
    const t = pairDriftTelemetry([driftRecord("old", 60 * 30), driftRecord("new", 10)], [], { now: NOW });
    expect(t.entries).toHaveLength(2);
    expect(t.drift24h).toBe(1);
  });

  it("no drifts -> stable health and empty entries", () => {
    const t = pairDriftTelemetry([], [action("START_TASK", 5)], { now: NOW });
    expect(t).toMatchObject({ drift24h: 0, realign24h: 0, unresolved: 0, health: "stable", entries: [] });
  });

  it("entries are newest-first and capped", () => {
    const records = Array.from({ length: 20 }, (_, i) => driftRecord(`d${i}`, 200 - i));
    const t = pairDriftTelemetry(records, [], { now: NOW, maxEntries: 5 });
    expect(t.entries).toHaveLength(5);
    expect(t.entries[0]?.driftId).toBe("d19");
  });
});

describe("summarizeSession", () => {
  it("aggregates tasks, drift health, and 24h counts", () => {
    const state = defaultState();
    state.goal = "Ship CSV export";
    state.tasks = [
      { id: "t1", title: "serializer", status: "doing" },
      { id: "t2", title: "filters", status: "todo" },
      { id: "t3", title: "tests", status: "done" },
    ];
    state.activeTaskId = "t1";

    const records: AuditRecord[] = [
      driftRecord("d1", 60),
      verdictRecord("d1", "confirmed", 30),
      driftRecord("d2", 20),
      { ts: at(15), kind: "policy.advisory", severity: "caution", actionType: "shell", actionValue: "git reset --hard", rule: "git reset --hard*", reason: "" },
      { ts: at(5), kind: "intent.declared", intentId: "i1", summary: "implement serializer" },
    ];

    const s = summarizeSession(state, records, [action("ADD_DECISION", 55)], NOW);
    expect(s.activeTask).toEqual({ id: "t1", title: "serializer" });
    expect(s.tasks).toEqual({ todo: 1, doing: 1, done: 1 });
    expect(s.counts24h).toEqual({ driftPending: 1, driftConfirmed: 1, driftDismissed: 0, advisories: 1, intents: 1 });
    expect(s.drift.health).toBe("drifting");
  });
});
