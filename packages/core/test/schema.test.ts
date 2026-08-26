import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  parseContract,
  defaultContract,
  criteriaFromTexts,
  parseState,
  parseAction,
  defaultState,
  parseConfig,
  defaultConfig,
  parseAuditRecord,
  parseVerdictCache,
  emptyVerdictCache,
  getGuardianPaths,
  getLegacyPaths,
  newId,
  nowIso,
  systemClock,
  type AuditRecord,
} from "../src/index.js";

describe("contract schema", () => {
  it("round-trips the default contract", () => {
    const c = defaultContract();
    expect(parseContract(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it("generates stable sc_n criterion ids", () => {
    expect(criteriaFromTexts(["a", "b"])).toEqual([
      { id: "sc_1", text: "a" },
      { id: "sc_2", text: "b" },
    ]);
  });

  it("rejects v1-shaped contracts (snake_case, no schemaVersion)", () => {
    expect(() =>
      parseContract({ goal: "g", success_criteria: ["x"], constraints: [] }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() => parseContract({ ...defaultContract(), extra: 1 })).toThrow();
  });
});

describe("state schema", () => {
  it("round-trips a populated state", () => {
    const s = defaultState();
    s.goal = "Ship CSV export";
    s.successCriteria = criteriaFromTexts(["export works"]);
    s.tasks = [{ id: "t1", title: "export works", status: "doing", criterionId: "sc_1" }];
    s.activeTaskId = "t1";
    s.decisions = [{ id: "d1", text: "hand-rolled serializer", rationale: "no deps", ts: nowIso() }];
    s.openQuestions = [{ id: "q1", text: "hidden columns?", ts: nowIso(), status: "open" }];
    expect(parseState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("rejects v1-shaped states (active_task, _meta)", () => {
    expect(() =>
      parseState({ ...defaultState(), active_task: null }),
    ).toThrow();
  });

  it("rejects invalid task status", () => {
    const s = defaultState();
    expect(() =>
      parseState({ ...s, tasks: [{ id: "t1", title: "x", status: "blocked" }] }),
    ).toThrow();
  });

  it("parses every known action type and rejects unknown ones", () => {
    const base = { id: "a1", ts: nowIso(), actor: "agent" as const, payload: {} };
    expect(parseAction({ ...base, type: "MIGRATE_IMPORT" }).type).toBe("MIGRATE_IMPORT");
    expect(parseAction({ ...base, type: "SET_GOAL" }).type).toBe("SET_GOAL");
    expect(() => parseAction({ ...base, type: "ISSUE_PERMIT" })).toThrow();
  });
});

describe("config schema", () => {
  it("fills every knob from an empty object", () => {
    const c = parseConfig({});
    expect(c.notify).toBe("balanced");
    expect(c.nudgeCooldownMinutes).toBe(10);
    expect(c.drift.lexical).toEqual({ enabled: true, sensitivity: "balanced" });
    expect(c.drift.semantic.judge).toBe("cursor-agent");
    expect(c.drift.semantic.sessionCallCap).toBe(20);
    expect(c.advisories.remindWhenNoActiveTask).toBe(true);
    expect(c.advisories.shellRules).toEqual([]);
  });

  it("merges a partial user config over defaults", () => {
    const c = parseConfig({
      notify: "quiet",
      drift: { lexical: { sensitivity: "strict" } },
      advisories: { shellRules: [{ pattern: "npm publish*", severity: "alert", reason: "release" }] },
    });
    expect(c.notify).toBe("quiet");
    expect(c.drift.lexical.sensitivity).toBe("strict");
    expect(c.drift.lexical.enabled).toBe(true);
    expect(c.drift.semantic.batchSize).toBe(10);
    expect(c.advisories.shellRules[0]?.severity).toBe("alert");
  });

  it("round-trips the default config", () => {
    const c = defaultConfig();
    expect(parseConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it("rejects legacy permit-era severities and knobs", () => {
    expect(() =>
      parseConfig({ advisories: { shellRules: [{ pattern: "x", severity: "PERMIT_REQUIRED" }] } }),
    ).toThrow();
    expect(() => parseConfig({ requirePermitForShell: true })).toThrow();
    expect(() => parseConfig({ autoRevertUnauthorizedEdits: false })).toThrow();
  });
});

describe("audit record schema", () => {
  const records: AuditRecord[] = [
    { ts: nowIso(), kind: "hook.event", event: "beforeShellExecution" },
    {
      ts: nowIso(),
      kind: "drift.lexical",
      driftId: "drift_1",
      episodeId: "ep_1",
      actionType: "shell",
      actionValue: "docker build .",
      activeTaskId: "t1",
      activeTaskTitle: "Ship CSV export",
      taskTerms: ["csv", "export"],
      actionTerms: ["docker", "build"],
      confidence: "medium",
    },
    {
      ts: nowIso(),
      kind: "drift.verdict",
      driftId: "drift_1",
      verdict: "confirmed",
      judge: "cursor-agent",
      confidence: 0.9,
      rationale: "unrelated to CSV export",
    },
    {
      ts: nowIso(),
      kind: "policy.advisory",
      severity: "alert",
      actionType: "shell",
      actionValue: "rm -rf /",
      rule: "rm -rf *",
      reason: "destructive filesystem command",
    },
    { ts: nowIso(), kind: "intent.declared", intentId: "int_1", summary: "implement serializer" },
  ];

  it("round-trips every record kind", () => {
    for (const r of records) {
      expect(parseAuditRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
    }
  });

  it("discriminates on kind and rejects unknown kinds", () => {
    expect(() => parseAuditRecord({ ts: nowIso(), kind: "permit.issued" })).toThrow();
  });

  it("rejects verdict confidence outside 0..1", () => {
    expect(() =>
      parseAuditRecord({
        ts: nowIso(),
        kind: "drift.verdict",
        driftId: "d",
        verdict: "confirmed",
        judge: "j",
        confidence: 1.5,
        rationale: "",
      }),
    ).toThrow();
  });
});

describe("verdict cache schema", () => {
  it("round-trips a cache with entries", () => {
    const cache = emptyVerdictCache();
    cache.entries["drift_1"] = {
      verdict: "dismissed",
      judge: "cursor-agent",
      confidence: 0.7,
      rationale: "reading config is neutral",
      ts: nowIso(),
    };
    expect(parseVerdictCache(JSON.parse(JSON.stringify(cache)))).toEqual(cache);
  });
});

describe("paths", () => {
  it("lays out v2 paths under .cursor/goal-guardian", () => {
    const p = getGuardianPaths("/ws");
    expect(p.contract).toBe(path.join("/ws", ".cursor", "goal-guardian", "contract.json"));
    expect(p.audit).toBe(path.join("/ws", ".cursor", "goal-guardian", "telemetry", "audit.jsonl"));
    expect(p.migrationMarker).toBe(path.join("/ws", ".cursor", "goal-guardian", "migration.json"));
  });

  it("lays out legacy v1 paths including the .ai split", () => {
    const p = getLegacyPaths("/ws");
    expect(p.auditLog).toBe(path.join("/ws", ".ai", "goal-guardian", "audit.log"));
    expect(p.reducer).toBe(path.join("/ws", ".cursor", "goal-guardian", "reducer.js"));
  });
});

describe("clock and ids", () => {
  it("newId prefixes and randomizes", () => {
    const a = newId("drift");
    const b = newId("drift");
    expect(a).toMatch(/^drift_[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it("nowIso uses the injected clock", () => {
    const fixed = { now: () => new Date("2026-01-02T03:04:05.000Z") };
    expect(nowIso(fixed)).toBe("2026-01-02T03:04:05.000Z");
    expect(typeof nowIso(systemClock)).toBe("string");
  });
});
