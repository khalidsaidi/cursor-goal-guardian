import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  parseContract,
  defaultContract,
  criteriaFromTexts,
  parseConfig,
  defaultConfig,
  parseAuditRecord,
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

describe("config schema", () => {
  it("an empty config is valid, and settings for removed features are dropped", () => {
    expect(parseConfig({})).toEqual({ schemaVersion: 2 });
    expect(parseConfig({
      notify: "vocal",
      nudgeCooldownMinutes: 5,
      drift: { lexical: { sensitivity: "strict" } },
      advisories: { shellRules: [{ pattern: "npm publish*", severity: "alert" }], neutralCommands: ["ls"] },
      requirePermitForShell: true,
    })).toEqual({ schemaVersion: 2 });
  });

  it("round-trips the default config", () => {
    const c = defaultConfig();
    expect(parseConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
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
      kind: "policy.advisory",
      severity: "alert",
      actionType: "shell",
      actionValue: "rm -rf /",
      rule: "rm -rf *",
      reason: "destructive filesystem command",
    },
    { ts: nowIso(), kind: "intent.declared", intentId: "int_1", summary: "implement serializer" },
    { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: "pnpm test" },
  ];

  it("round-trips every record kind", () => {
    for (const r of records) {
      expect(parseAuditRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
    }
  });

  it("discriminates on kind and rejects unknown kinds", () => {
    expect(() => parseAuditRecord({ ts: nowIso(), kind: "permit.issued" })).toThrow();
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

describe("learning preferences",()=>{
 it("preserves allowance settings while dropping retired options",()=>{
  expect(parseConfig({schemaVersion:2,oldSetting:true,learning:{dailyCallLimit:0,callLimit:12}})).toEqual({schemaVersion:2,learning:{dailyCallLimit:0,callLimit:12}});
  expect(()=>parseConfig({learning:{dailyCallLimit:-1}})).toThrow();
 });
});
