import { checkedReview } from "./helpers/review.js";
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  adjudicatePrompt, appendAudit, buildPanelViewModel, claimsToAdjudicate, goalHash, defaultContract, dismissedLines, getGuardianPaths, nowIso, objectionLines, parseAdjudication, readAuditTail, recordFileEdit,
  recordShellOutput, recordUserPrompt, runGoalStop, submitGoalReport, type EvaluatorClaim,
} from "../src/index.js";

const made: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnv };
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const tick = () => new Promise((r) => setTimeout(r, 3));

async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

async function script(body: string): Promise<string> {
  const file = path.join(await tmp("gg-adj-bin-"), "bin");
  await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await fs.chmod(file, 0o755);
  return file;
}

/** Stands in for the evaluator's adapter: prints one result line. */
const evaluatorSaying = async (result: unknown): Promise<string> => {
  const bin = await script(`process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(result))} + "\\n"));`);
  return JSON.stringify({ python: bin, cli: bin, adkDir: path.dirname(bin), site: path.dirname(bin) });
};

/**
 * Stands in for cursor-agent as the reviewer. Asked to review, it gives `review`; asked about the evaluator's claims,
 * it gives `claims` (or prose when that is a string). Every prompt about claims is logged.
 */
async function reviewer(review: unknown, claims: unknown): Promise<{ file: string; log: string }> {
  const dir = await tmp("gg-adj-agent-");
  const log = path.join(dir, "claims.jsonl");
  const file = await script(`
const fs = require("fs");
const a = process.argv.slice(2);
let p = a[a.indexOf("-p") + 1];
if (p.startsWith("Read .cursor/goal-guardian/review-task.md")) p = fs.readFileSync(".cursor/goal-guardian/review-task.md", "utf8");
const say = (text) => process.stdout.write(JSON.stringify({ type: "result", result: text }) + "\\n");
if (p.includes("The claims:")) {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(p) + "\\n");
  say(${JSON.stringify(typeof claims === "string" ? claims : JSON.stringify({ claims }))});
} else say(${JSON.stringify(JSON.stringify({ ...checkedReview(review), ...review as object }))});`);
  return { file, log };
}
const HOLDS = { items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [] };
const asked = async (log: string): Promise<string[]> => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string);

async function doneWork(): Promise<string> {
  const root = await tmp("gg-adj-ws-");
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.config, "{}");
  await fs.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "the export test passes" }] }));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  sh("init", "-q");
  await fs.writeFile(path.join(root, "a.js"), "one\n");
  sh("add", "a.js");
  sh("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  await recordUserPrompt(root, "add the export", "c1", "agent");
  await tick();
  await fs.writeFile(path.join(root, "a.js"), "two\n");
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
  await recordFileEdit(root, "a.js", [{ old_string: "one", new_string: "two" }]);
  await tick();
  await recordShellOutput(root, { command: "make test", output: "12 passed", durationMs: 0 });
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: "make test", conversationId: "c1" });
  return root;
}
const report = { status: "complete" as const, proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }], changes: [{ file: "a.js", serves: "sc_1" }] };
const reviews = async (root: string) => (await readAuditTail(root, 1000)).filter((r) => r.kind === "goal.review") as Array<Record<string, unknown>>;
const ends = async (root: string) => (await readAuditTail(root, 1000)).filter((r) => r.kind === "goal.end") as Array<Record<string, unknown>>;
const SC1 = { id: "sc_1", property: "the export test passes", score: 0, rationale: "the export renames by substring, so it corrupts other names" };
const EXTRA = { id: "extra", property: "The agent changed nothing that the user's request does not need.", score: 0, rationale: "it edited the type declarations" };
/** The evaluator judged every rubric: those given as not met, the rest as met. */
const evaluatorObjects = (...failed: Array<{ id: string }>) =>
  evaluatorSaying({ ran: true, overall: 0, rubrics: [...failed, ...[{ ...SC1, score: 1 }, { ...EXTRA, score: 1 }].filter((r) => !failed.some((f) => f.id === r.id))], calls: 5, seconds: 20 });

describe("what the evaluator alone objects to is checked against the project before it counts", () => {
  const claims: EvaluatorClaim[] = [
    { id: "sc_1", property: "the export test passes", rationale: "renames by substring" },
    { id: "extra", property: "nothing extra", rationale: "edited the type declarations" },
  ];

  it("checks item disagreements and each individual scope claim", () => {
    const evaluator = { ran: true, failed: claims };
    expect(claimsToAdjudicate({ fails: [], extra: [] }, evaluator)).toEqual(claims);
    expect(claimsToAdjudicate({ fails: [{ id: "sc_1", evidence: "x" }], extra: [] }, evaluator)).toEqual([claims[1]]);
    expect(claimsToAdjudicate({ fails: [], extra: [{ file: "a.d.ts", what: "types" }] }, evaluator)).toEqual([...claims, { id: "reviewer_extra_1", property: "unrequested change in a.d.ts", rationale: "types" }]);
    expect(claimsToAdjudicate({ fails: [], extra: [] }, { ran: false, failed: claims })).toEqual([]);
    expect(claimsToAdjudicate({ fails: [], extra: [] }, undefined)).toEqual([]);
  });

  it("the reviewer is given each claim word for word and told to check the project, not the claim", () => {
    const prompt = adjudicatePrompt({ goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "the export test passes" }], reviewFeedback:[{finding:"Unrequested uppercase filename complaint",judgment:"wrong"}] }, claims);
    expect(prompt).toContain("- sc_1 (the export test passes) is not met: renames by substring");
    expect(prompt).toContain("- extra (the run changed things the request doesn't need): edited the type declarations");
    expect(prompt).toContain("Do not take a claim's word for anything.");
    expect(prompt).toContain("- sc_1: the export test passes");
    expect(prompt).toContain('"finding":"Unrequested uppercase filename complaint","judgment":"wrong"');
  });

  it("an answer is confirmed, dismissed with evidence, or unclear: silence and a bare dismissal never dismiss", () => {
    const say = (c: unknown) => JSON.stringify({ result: JSON.stringify({ claims: c }) });
    expect(parseAdjudication(say([{ id: "sc_1", verdict: "dismissed", evidence: "index.js:12 compares the whole name" }, { id: "extra", verdict: "Confirmed", evidence: "util.js renamed" }]), claims)).toEqual({
      confirmed: [{ id: "extra", evidence: "util.js renamed" }],
      dismissed: [{ ...claims[0], evidence: "index.js:12 compares the whole name" }],
      unclear: [],
    });
    expect(parseAdjudication(say([{ id: "sc_1", verdict: "dismissed", evidence: "" }]), claims)).toEqual({ confirmed: [], dismissed: [], unclear: ["sc_1", "extra"] });
    expect(parseAdjudication(say([{ id: "sc_1", verdict: "unclear", evidence: "couldn't run the tests" }, { id: "extra", verdict: "probably fine", evidence: "x" }]), claims)).toEqual({ confirmed: [], dismissed: [], unclear: ["sc_1", "extra"] });
    expect(parseAdjudication("I looked and it seems fine.", claims)).toBeNull();
    expect(parseAdjudication(JSON.stringify({ is_error: true, result: "x" }), claims)).toBeNull();
  });

  it("a dismissed claim isn't an objection; a confirmed one carries the reviewer's evidence", () => {
    const review = { fails: [], extra: [], evaluator: { ran: true, failed: claims } };
    expect(objectionLines(review)).toHaveLength(2);
    const settled = { ...review, adjudication: { ran: true, confirmed: [{ id: "extra", evidence: "util.js renamed" }], dismissed: [{ ...claims[0]!, evidence: "index.js:12 compares the whole name" }] } };
    expect(objectionLines(settled)).toEqual(["Evaluator: meaningful unrelated change: util.js renamed"]);
    expect(dismissedLines(settled)).toEqual(["The evaluator raised sc_1 (renames by substring); the reviewer checked the project and dismissed it: index.js:12 compares the whole name"]);
  });
});

describe("the panel", () => {
  it("shows what the evaluator raised and the reviewer dismissed, beside any objection that stands", () => {
    const contract = { ...defaultContract(), goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "the export test passes" }] };
    const review = {
      ts: "2026-11-11T10:00:00.000Z", kind: "goal.review" as const, goalHash: goalHash(contract), reportTs: "2026-11-11T09:59:00.000Z", id: "rev_1", ran: true, seconds: 10, fails: [], extra: [],
      evaluator: { ran: true, overall: 0, rubrics: 2, failed: [{ id: "sc_1", property: "the export test passes", rationale: "renames by substring" }], calls: 5, seconds: 20 },
      adjudication: { ran: true, seconds: 15, confirmed: [], unclear: [], dismissed: [{ id: "sc_1", property: "the export test passes", rationale: "renames by substring", evidence: "a.js:3 compares the whole name" }] },
    };
    const vm = buildPanelViewModel({ setUp: true, contract, records: [], goalRecords: [review], now: new Date("2026-11-11T10:01:00.000Z") });
    expect(vm.reviews).toMatchObject([{ id: "rev_1", lines: [], dismissed: ["The evaluator raised sc_1 (renames by substring); the reviewer checked the project and dismissed it: a.js:3 compares the whole name"] }]);
  });
});

describe("the adjudication in the goal loop", () => {
  it("dismissed: the agent isn't sent back, the goal is proved, and the claim stays on the record with the reviewer's evidence", async () => {
    const root = await doneWork();
    const r = await reviewer(HOLDS, [{ id: "sc_1", verdict: "dismissed", evidence: "a.js compares the whole name; make test prints 12 passed" }]);
    process.env.GOAL_GUARDIAN_REVIEWER = r.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = await evaluatorObjects(SC1);
    const answer = await submitGoalReport(root, report);
    expect(answer).toMatchObject({ accepted: true, outcome: "proved" });
    expect(await asked(r.log)).toHaveLength(1);
    expect((await asked(r.log))[0]).toContain("the export renames by substring, so it corrupts other names");
    expect(await reviews(root)).toMatchObject([{ evaluator: { failed: [{ id: "sc_1" }] }, adjudication: { ran: true, confirmed: [], unclear: [], dismissed: [{ id: "sc_1", evidence: "a.js compares the whole name; make test prints 12 passed" }] } }]);
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toBeNull();
    expect(await ends(root)).toMatchObject([{ outcome: "proved" }]);
  }, 60_000);

  it("confirmed: the claim goes back to the agent with the reviewer's evidence, and the same state stays disputed", async () => {
    const root = await doneWork();
    const r = await reviewer(HOLDS, [{ id: "sc_1", verdict: "confirmed", evidence: "node -e shows rename('foobar','foo') changes foobar" }]);
    process.env.GOAL_GUARDIAN_REVIEWER = r.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = await evaluatorObjects(SC1);
    const answer = await submitGoalReport(root, report);
    expect(answer.accepted).toBe(false);
    expect(answer.unproved).toEqual([
      "Evaluator: sc_1 isn't met (the export test passes): the export renames by substring, so it corrupts other names The reviewer checked the project and confirms it: node -e shows rename('foobar','foo') changes foobar",
    ]);
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toContain("The reviewer checked the project and confirms it");
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, outcome: "disputed" });
    expect(await asked(r.log)).toHaveLength(1);
  }, 60_000);

  it("not adjudicated: no clear answer, an unreadable answer or no evidence leaves the claim standing, and the record says so", async () => {
    for (const [claimsAnswer, expected] of [
      [[{ id: "sc_1", verdict: "unclear", evidence: "the tests need packages that aren't installed" }], { ran: true, unclear: ["sc_1"] }],
      [[{ id: "sc_1", verdict: "dismissed", evidence: "" }], { ran: true, unclear: ["sc_1"] }],
      ["I looked at it and it seems fine.", { ran: false, reason: "the reviewer's answer on the evaluator's claims couldn't be read", unclear: ["sc_1"] }],
    ] as const) {
      const root = await doneWork();
      process.env.GOAL_GUARDIAN_REVIEWER = (await reviewer(HOLDS, claimsAnswer)).file;
      process.env.GOAL_GUARDIAN_EVALUATOR = await evaluatorObjects(SC1);
      const answer = await submitGoalReport(root, report);
      expect(answer.accepted).toBe(false);
      expect(answer.unproved).toEqual(["Evaluator: sc_1 isn't met (the export test passes): the export renames by substring, so it corrupts other names"]);
      expect(await reviews(root)).toMatchObject([{ adjudication: { ...expected, confirmed: [], dismissed: [] } }]);
    }
  }, 120_000);

  it("shared item failures stand, while each scope opinion still gets checked", async () => {
    const root = await doneWork();
    const r = await reviewer({ items: [{ id: "sc_1", verdict: "fails", evidence: "the export is a comment" }], extra: [{ file: "a.d.ts", what: "types nobody asked for" }] }, [{ id: "sc_1", verdict: "dismissed", evidence: "x" }]);
    process.env.GOAL_GUARDIAN_REVIEWER = r.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = await evaluatorObjects(SC1, EXTRA);
    const answer = await submitGoalReport(root, report);
    expect(answer.accepted).toBe(false);
    expect(answer.unproved).toHaveLength(2);
    expect(answer.unproved.join()).not.toContain("types nobody asked");
    expect(await asked(r.log)).toHaveLength(1);
    expect((await reviews(root))[0]).toHaveProperty("adjudication");
  }, 60_000);

  it("unconfirmed scope opinions remain incomplete verification, not instructions to change correct work", async () => {
    const root = await doneWork();
    const r = await reviewer({ items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [{ file: "a.d.ts", what: "types nobody asked for" }] }, [{ id: "sc_1", verdict: "dismissed", evidence: "make test passes on the final a.js" }]);
    process.env.GOAL_GUARDIAN_REVIEWER = r.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = await evaluatorObjects(SC1, EXTRA);
    const answer = await submitGoalReport(root, report);
    expect(answer.accepted).toBe(false);
    expect(answer.verificationPending).toBe(true);
    expect(answer.unproved).toEqual([]);
    const sent = await asked(r.log);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("- sc_1 (the export test passes) is not met");
    expect(sent[0]).toContain("- extra (");
    expect(sent[0]).toContain("reviewer_extra_1");
  }, 60_000);
});


describe("reviewer-only objections are checked too", () => {
  it("a supporting type declaration can be dismissed without changing completed work", async () => {
    const root = await doneWork();
    const r = await reviewer({ ...HOLDS, extra: [{ file: "export.d.ts", what: "adds the requested export declaration" }] }, [{ id: "reviewer_extra_1", verdict: "dismissed", evidence: "the declaration belongs to the requested CSV export, with no unrelated change" }]);
    process.env.GOAL_GUARDIAN_REVIEWER = r.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = await evaluatorObjects();
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
    const records = await reviews(root);
    expect(records).toMatchObject([{ extra: [{ file: "export.d.ts" }], adjudication: { dismissed: [{ id: "reviewer_extra_1" }] } }]);
    expect(objectionLines(records[0] as never)).toEqual([]);
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toBeNull();
  }, 60_000);

  it("a dismissed behavior claim cannot survive as a duplicate aggregate veto", async () => {
    const root = await doneWork();
    const review = checkedReview({ items: [{ id: "sc_1", verdict: "fails", evidence: "requires an additional data model the user did not ask for" }], extra: [] });
    review.checks = review.checks.map((c) => c.id === "behavior" ? { ...c, verdict: "fails", evidence: "same additional data model claim" } : c);
    const r = await reviewer(review, [
      { id: "reviewer_item_1", verdict: "dismissed", evidence: "the export works as requested; the extra requirement is not in the goal" },
      { id: "reviewer_item_2", verdict: "dismissed", evidence: "the aggregate repeats the same unsupported requirement" },
    ]);
    process.env.GOAL_GUARDIAN_REVIEWER = r.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = await evaluatorObjects();
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
  }, 60_000);

  it("a confirmed unrelated change asks for a fix; an unclear scope check does not", async () => {
    for (const verdict of ["confirmed", "unclear"]) {
      const root = await doneWork();
      const r = await reviewer({ ...HOLDS, extra: [{ file: "util.js", what: "renames unrelated existing helpers" }] }, [{ id: "reviewer_extra_1", verdict, evidence: "util.js changes the old unrelated name" }]);
      process.env.GOAL_GUARDIAN_REVIEWER = r.file;
      process.env.GOAL_GUARDIAN_EVALUATOR = await evaluatorObjects();
      const answer = await submitGoalReport(root, report);
      expect(answer.accepted).toBe(false);
      if (verdict === "confirmed") expect(answer.unproved).toContain("Reviewer: util.js needs attention: util.js changes the old unrelated name");
      else { expect(answer.verificationPending).toBe(true); expect(answer.unproved).toEqual([]); }
    }
  }, 60_000);

  it("an unanswered evaluator rubric cannot overrule the reviewer", () => {
    const review = { fails: [{ id: "sc_1", evidence: "broken" }], extra: [{ file: "util.js", what: "unrelated" }] };
    expect(claimsToAdjudicate(review, { ran: true, failed: [], unanswered: ["sc_1", "extra"] })).toEqual([{ id: "reviewer_extra_1", property: "unrequested change in util.js", rationale: "unrelated" }]);
    expect(claimsToAdjudicate({ fails: [{ id: "build", evidence: "bundle absent" }], extra: [] }, { ran: true, failed: [] })).toEqual([]);
  });
});
