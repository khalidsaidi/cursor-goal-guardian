import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runRescore,
  loadVerdicts,
  buildJudgePrompt,
  parseJudgeOutput,
  appendAudit,
  readAuditTail,
  defaultState,
  defaultConfig,
  parseConfig,
  criteriaFromTexts,
  type AuditRecord,
  type Clock,
  type DriftCandidate,
  type DriftJudge,
  type DriftJudgement,
} from "../src/index.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/judge");
const NOW = new Date("2026-01-01T12:00:00.000Z");
const clock: Clock = { now: () => NOW };
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60 * 1000).toISOString();

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-rescore-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

function driftRecord(id: string, minAgo: number): AuditRecord {
  return {
    ts: at(minAgo),
    kind: "drift.lexical",
    driftId: id,
    episodeId: `ep_${id}`,
    actionType: "shell",
    actionValue: `docker build ${id}`,
    activeTaskId: "t1",
    activeTaskTitle: "Ship CSV export",
    taskTerms: ["csv"],
    actionTerms: ["docker", "build"],
    confidence: "medium",
  };
}

function fakeJudge(script: (candidates: DriftCandidate[]) => DriftJudgement[] | Promise<DriftJudgement[]>): DriftJudge & { calls: DriftCandidate[][] } {
  const calls: DriftCandidate[][] = [];
  return {
    id: "fake",
    calls,
    isAvailable: async () => ({ ok: true }),
    judge: async (candidates) => {
      calls.push(candidates);
      return script(candidates);
    },
  };
}

const state = (() => {
  const s = defaultState();
  s.goal = "Ship CSV export";
  s.successCriteria = criteriaFromTexts(["export works"]);
  s.constraints = ["no new deps"];
  return s;
})();

describe("rescorer", () => {
  it("batches pending drifts into one judge call and records verdicts on both the cache and the tape", async () => {
    const root = await makeRoot();
    await appendAudit(root, driftRecord("d1", 60));
    await appendAudit(root, driftRecord("d2", 30));
    const judge = fakeJudge((cands) => cands.map((c, i) => ({ driftId: c.driftId, verdict: i === 0 ? "confirmed" : "dismissed", confidence: 0.9, rationale: "r" })));

    const result = await runRescore(root, state, defaultConfig(), judge, clock);
    expect(result).toEqual({ judged: 2, recorded: 2, calledJudge: true });
    expect(judge.calls).toHaveLength(1);

    const cache = await loadVerdicts(root);
    expect(cache.entries.d1?.verdict).toBe("confirmed");
    expect(cache.entries.d2?.verdict).toBe("dismissed");
    const verdictRecords = (await readAuditTail(root)).filter((r) => r.kind === "drift.verdict");
    expect(verdictRecords).toHaveLength(2);
  });

  it("never re-judges cached drifts and returns without a call when nothing is pending", async () => {
    const root = await makeRoot();
    await appendAudit(root, driftRecord("d1", 60));
    const judge = fakeJudge((cands) => cands.map((c) => ({ driftId: c.driftId, verdict: "confirmed", confidence: 1, rationale: "" })));
    await runRescore(root, state, defaultConfig(), judge, clock);

    const second = await runRescore(root, state, defaultConfig(), judge, clock);
    expect(second).toEqual({ judged: 0, recorded: 0, calledJudge: false });
    expect(judge.calls).toHaveLength(1);
  });

  it("respects batchSize and leaves the overflow pending for the next pass", async () => {
    const root = await makeRoot();
    for (let i = 0; i < 5; i++) await appendAudit(root, driftRecord(`d${i}`, 60 - i));
    const config = parseConfig({ drift: { semantic: { batchSize: 3 } } });
    const judge = fakeJudge((cands) => cands.map((c) => ({ driftId: c.driftId, verdict: "dismissed", confidence: 0.5, rationale: "" })));

    const first = await runRescore(root, state, config, judge, clock);
    expect(first.judged).toBe(3);
    const second = await runRescore(root, state, config, judge, clock);
    expect(second.judged).toBe(2);
  });

  it("skips drifts older than 24h", async () => {
    const root = await makeRoot();
    await appendAudit(root, driftRecord("stale", 60 * 30));
    await appendAudit(root, driftRecord("fresh", 30));
    const judge = fakeJudge((cands) => cands.map((c) => ({ driftId: c.driftId, verdict: "confirmed", confidence: 1, rationale: "" })));
    const result = await runRescore(root, state, defaultConfig(), judge, clock);
    expect(result.judged).toBe(1);
    expect((await loadVerdicts(root)).entries.stale).toBeUndefined();
  });

  it("a judge crash records nothing and leaves candidates pending", async () => {
    const root = await makeRoot();
    await appendAudit(root, driftRecord("d1", 30));
    const judge = fakeJudge(() => Promise.reject(new Error("boom")));
    const result = await runRescore(root, state, defaultConfig(), judge, clock);
    expect(result).toEqual({ judged: 1, recorded: 0, calledJudge: true });
    expect((await loadVerdicts(root)).entries).toEqual({});
    // The pending candidate is retried next pass.
    const retry = await runRescore(root, state, defaultConfig(), judge, clock);
    expect(retry.calledJudge).toBe(true);
  });

  it("filters garbage judgements: unknown driftIds, bad verdicts, out-of-range confidence", async () => {
    const root = await makeRoot();
    await appendAudit(root, driftRecord("d1", 30));
    const judge = fakeJudge(() => [
      { driftId: "ghost", verdict: "confirmed", confidence: 0.9, rationale: "" },
      { driftId: "d1", verdict: "maybe" as never, confidence: 0.9, rationale: "" },
      { driftId: "d1", verdict: "confirmed", confidence: 7, rationale: "" },
    ]);
    const result = await runRescore(root, state, defaultConfig(), judge, clock);
    expect(result.recorded).toBe(0);
    expect((await loadVerdicts(root)).entries).toEqual({});
  });
});

describe("cursor-agent judge prompt and parser (real recorded captures)", () => {
  const candidates: DriftCandidate[] = [
    { driftId: "d1", actionType: "shell", actionValue: "docker build -t theme .", activeTaskTitle: "Ship CSV export" },
    { driftId: "d2", actionType: "read", actionValue: "src/theme/dark.css", activeTaskTitle: "Ship CSV export", criterionText: "export works" },
  ];

  it("prompt includes goal, criteria, constraints, numbered candidates, and the output contract", () => {
    const prompt = buildJudgePrompt(candidates, { goal: "Ship CSV export", successCriteria: ["export works"], constraints: ["no new deps"] });
    expect(prompt).toContain("Goal: Ship CSV export");
    expect(prompt).toContain("- export works");
    expect(prompt).toContain("- no new deps");
    expect(prompt).toContain("0. [shell] docker build -t theme .");
    expect(prompt).toContain("(criterion: export works)");
    expect(prompt).toContain("ONLY a JSON array");
  });

  async function fixture(name: string): Promise<string> {
    return fs.readFile(path.join(FIXTURES, name), "utf8");
  }

  it("parses a clean array envelope (recorded)", async () => {
    const out = parseJudgeOutput(await fixture("clean-array.json"), candidates);
    expect(out).toEqual([
      { driftId: "d1", verdict: "confirmed", confidence: 0.9, rationale: "unrelated to goal" },
      { driftId: "d2", verdict: "dismissed", confidence: 0.7, rationale: "neutral housekeeping" },
    ]);
  });

  it("parses prose + markdown-fenced arrays (recorded)", async () => {
    const out = parseJudgeOutput(await fixture("prose-and-fence.json"), candidates);
    expect(out).toEqual([
      { driftId: "d1", verdict: "dismissed", confidence: 0.8, rationale: "prerequisite work" },
      { driftId: "d2", verdict: "confirmed", confidence: 0.95, rationale: "unrelated theme work" },
    ]);
  });

  it("yields no judgements when the result has no array (recorded)", async () => {
    expect(parseJudgeOutput(await fixture("no-array.json"), candidates)).toEqual([]);
  });

  it("tolerates non-envelope stdout and rejects duplicates/out-of-range indexes", () => {
    const raw = '[{"index":0,"verdict":"confirmed","confidence":0.6,"rationale":"a"},{"index":0,"verdict":"dismissed","confidence":0.5,"rationale":"dupe"},{"index":9,"verdict":"confirmed","confidence":0.5,"rationale":"ghost"}]';
    expect(parseJudgeOutput(raw, candidates)).toEqual([
      { driftId: "d1", verdict: "confirmed", confidence: 0.6, rationale: "a" },
    ]);
  });

  it("returns nothing for error envelopes and garbage", () => {
    expect(parseJudgeOutput('{"is_error":true,"result":"[]"}', candidates)).toEqual([]);
    expect(parseJudgeOutput("total garbage", candidates)).toEqual([]);
  });
});
