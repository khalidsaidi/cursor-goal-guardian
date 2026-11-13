import { finishReport } from "./helpers/recovery.js";
import { VERIFIED_CHECKS } from "./helpers/review.js";
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, defaultContract, getGuardianPaths, goalPhaseOf, readContractSafe, makeReviewCopy, nowIso, parseReview, readAuditTail, recordShellOutput, recordUserPrompt,
  resolveReviewer, reviewLines, reviewPrompt, runGoalStop, runReview, MAX_REVIEWS, REVIEW_HARD_LIMIT, REVIEW_PROMPT,
} from "../src/index.js";

const made: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnv };
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const tick = () => new Promise((r) => setTimeout(r, 3));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

/** A reviewer stand-in: prints the envelope a headless agent prints, or misbehaves. */
async function stub(body: string): Promise<string> {
  const dir = await tmp("gg-stub-");
  const file = path.join(dir, "reviewer");
  await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await fs.chmod(file, 0o755);
  return file;
}
const answering = (answer: unknown) => stub(`process.stdout.write(JSON.stringify({ type: "result", result: ${JSON.stringify(JSON.stringify(answer))} }) + "\\n");`);
const OBJECTS = { checks: VERIFIED_CHECKS, items: [{ id: "sc_1", verdict: "fails", evidence: "the export is a comment, not code" }], extra: [{ file: "util.js", what: "renamed helpers nobody asked about" }] };
const HOLDS = { checks: VERIFIED_CHECKS, items: [{ id: "sc_1", verdict: "holds", evidence: "export works" }], extra: [] };

async function repo(): Promise<string> {
  const root = await tmp("gg-review-ws-");
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.config, "{}");
  await fs.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "the export test passes" }] }));
  sh(root, "init", "-q");
  await fs.writeFile(path.join(root, "a.js"), "one\n");
  sh(root, "add", "a.js");
  sh(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  return root;
}

describe("the reviewer's answer", () => {
  it("is read from the agent's envelope, through prose and fences, keeping only failures and extras", () => {
    const envelope = JSON.stringify({ result: `Sure.\n\`\`\`json\n${JSON.stringify({ items: [...OBJECTS.items, { id: "sc_2", verdict: "holds", evidence: "ok" }], extra: OBJECTS.extra })}\n\`\`\`` });
    expect(parseReview(`noise\n${envelope}\n`)).toEqual({ fails: [{ id: "sc_1", evidence: "the export is a comment, not code" }], extra: [{ file: "util.js", what: "renamed helpers nobody asked about" }], unanswered: [] });
    expect(parseReview(JSON.stringify(HOLDS), ["sc_1"])).toEqual({ fails: [], extra: [], unanswered: [] });
    expect(parseReview('Here: {"items": [], "extra": [{"file": "", "what": ""}]}')).toEqual({ fails: [], extra: [], unanswered: [] });
  });

  it("every done-when item needs a clear verdict: a no in any words objects, and a missing or unclear one is unanswered, never holds", () => {
    const says = (items: unknown[]) => parseReview(JSON.stringify({ items, extra: [] }), ["sc_1", "sc_2"]);
    // An empty list answers for nothing.
    expect(says([])).toMatchObject({ fails: [], unanswered: ["sc_1", "sc_2"] });
    // One item left out.
    expect(says([{ id: "sc_1", verdict: "holds", evidence: "ok" }])).toMatchObject({ fails: [], unanswered: ["sc_2"] });
    // A no that doesn't use the word "fails".
    for (const verdict of ["NOT DONE", "not met", "partial", "does not hold", "incomplete", "fails"]) {
      expect(says([{ id: "sc_1", verdict: "holds", evidence: "ok" }, { id: "sc_2", verdict, evidence: "the test is a placeholder" }])).toMatchObject({ fails: [{ id: "sc_2", evidence: "the test is a placeholder" }], unanswered: [] });
    }
    // Neither yes nor no.
    expect(says([{ id: "sc_1", verdict: "holds", evidence: "ok" }, { id: "sc_2", verdict: "inconclusive", evidence: "couldn't run it" }])).toMatchObject({ fails: [], unanswered: ["sc_2"] });
    expect(says([{ id: "sc_1", verdict: "Holds.", evidence: "ok" }, { id: "sc_2", verdict: "passes", evidence: "ok" }])).toMatchObject({ fails: [], unanswered: [] });
  });

  it("does not turn missing, inconclusive or unevidenced build/API checks into proved work", () => {
    const parse = (answer: unknown) => {
      const v = answer as { checks?: unknown[] };
      return parseReview(JSON.stringify(v.checks ? { ...v, checks: [...v.checks, VERIFIED_CHECKS[2]] } : v), ["sc_1"], true);
    };
    expect(parse({ ...HOLDS, checks: undefined })).toMatchObject({ fails: [], unanswered: ["build", "public_api", "behavior"] });
    expect(parse({ ...HOLDS, checks: [VERIFIED_CHECKS[0], { id: "public_api", verdict: "holds", evidence: "" }] })).toMatchObject({ unanswered: ["public_api"] });
    expect(parse({ ...HOLDS, checks: [VERIFIED_CHECKS[0], { id: "public_api", verdict: "unclear", evidence: "could not import the built entry" }] })).toMatchObject({ unanswered: ["public_api"] });
    expect(parse({ ...HOLDS, checks: [VERIFIED_CHECKS[0], VERIFIED_CHECKS[0], VERIFIED_CHECKS[1]] })).toMatchObject({ unanswered: ["build"] });
    expect(parse({ ...HOLDS, checks: [{ id: "build", verdict: "fails", evidence: "build exited zero but logged an error and omitted the browser bundle" }, VERIFIED_CHECKS[1]] })).toMatchObject({ fails: [{ id: "build", evidence: expect.stringContaining("omitted") }], unanswered: [] });
    expect(parse({ ...HOLDS, checks: [{ id: "build", verdict: "not_applicable", evidence: "only documentation changed; no build step" }, VERIFIED_CHECKS[1]] })).toMatchObject({ unanswered: [] });
  });

  it("nothing usable is nothing: an error envelope, prose, or JSON without items", () => {
    expect(parseReview(JSON.stringify({ is_error: true, result: JSON.stringify(OBJECTS) }))).toBeNull();
    expect(parseReview("I could not check this project.")).toBeNull();
    expect(parseReview('{"verdict": "fails"} {"items": "nope"}')).toBeNull();
  });

  it("each objection is one line, labelled as the reviewer's", () => {
    expect(reviewLines({ fails: OBJECTS.items.map((i) => ({ id: i.id, evidence: i.evidence })), extra: OBJECTS.extra })).toEqual([
      "Reviewer: sc_1 isn't done: the export is a comment, not code",
      "Reviewer: util.js isn't needed by any item: renamed helpers nobody asked about",
    ]);
  });
});

describe("the reviewer's instructions", () => {
  it("carry the goal and its items, or the goal alone", async () => {
    const prompt = reviewPrompt({ goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "tests pass" }] });
    expect(prompt).toContain("Add CSV export");
    expect(prompt).toContain("- sc_1: tests pass");
    expect(reviewPrompt({ goal: "Fix it", successCriteria: [] })).toContain("- goal: the goal as stated");
    expect(REVIEW_PROMPT).toContain('"extra"');
  });

  it("can be replaced from a file, for testing other wordings", async () => {
    const file = path.join(await tmp("gg-prompt-"), "p.txt");
    await fs.writeFile(file, "Review {goal}:\n{items}");
    process.env.GOAL_GUARDIAN_REVIEW_PROMPT = file;
    expect(reviewPrompt({ goal: "X", successCriteria: [{ id: "sc_1", text: "y" }] })).toContain("Review X:\n- sc_1: y");
    expect(reviewPrompt({ goal: "X", successCriteria: [] })).toContain("Required verification before accepting completion");
  });
});

describe("running a review", () => {
  it("finds the reviewer from the setting, and nothing when it isn't there", async () => {
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
    expect(resolveReviewer()).toBeNull();
    const file = await answering(HOLDS);
    process.env.GOAL_GUARDIAN_REVIEWER = file;
    expect(resolveReviewer()).toBe(file);
  });

  it("is skipped, never fatal, when there is no reviewer, no git, a bad prompt file, or it is already inside a review", async () => {
    const root = await repo();
    const contract = { goal: "g", successCriteria: [] };
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
    expect(await runReview(root, contract)).toMatchObject({ ran: false, reason: "cursor-agent isn't installed" });
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(HOLDS);
    expect(await runReview(await tmp("gg-nogit-"), contract)).toMatchObject({ ran: false, reason: expect.stringContaining("git") });
    process.env.GOAL_GUARDIAN_REVIEW_PROMPT = "/nonexistent/prompt.txt";
    expect(await runReview(root, contract)).toMatchObject({ ran: false, reason: expect.stringContaining("prompt") });
    delete process.env.GOAL_GUARDIAN_REVIEW_PROMPT;
    process.env.GOAL_GUARDIAN_REVIEWING = "1";
    expect(await runReview(root, contract)).toMatchObject({ ran: false, reason: "already inside a review" });
  });

  it("is skipped when the reviewer hangs past its budget, fails, or answers nonsense", async () => {
    const root = await repo();
    const contract = { goal: "g", successCriteria: [] };
    process.env.GOAL_GUARDIAN_REVIEWER = await stub("setTimeout(() => {}, 60000);");
    expect(await runReview(root, contract, 300)).toMatchObject({ ran: false, reason: expect.stringContaining("longer than") });
    process.env.GOAL_GUARDIAN_REVIEWER = await stub("process.exit(3);");
    expect(await runReview(root, contract)).toMatchObject({ ran: false, reason: "the reviewer exited with 3" });
    process.env.GOAL_GUARDIAN_REVIEWER = await stub('console.log("no idea");');
    expect(await runReview(root, contract)).toMatchObject({ ran: false, reason: expect.stringContaining("couldn't be read") });
  });

  it("does not accept a reviewer repairing its copy instead of reviewing the submitted work", async () => {
    const root = await repo();
    const original = await fs.readFile(path.join(root, "a.js"), "utf8");
    process.env.GOAL_GUARDIAN_REVIEWER = await stub(`require("fs").writeFileSync("a.js", "fixed only in review copy"); console.log(JSON.stringify({result:${JSON.stringify(JSON.stringify(HOLDS))}}));`);
    expect(await runReview(root, { goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "t" }] })).toMatchObject({ ran: false, reason: expect.stringContaining("reviewer changed submitted files") });
    expect(await fs.readFile(path.join(root, "a.js"), "utf8")).toBe(original);
  });

  it("allows generated build outputs but not tests added only in the review copy", async () => {
    const root = await repo();
    process.env.GOAL_GUARDIAN_REVIEWER = await stub(`const fs=require("fs"); fs.mkdirSync("dist"); fs.writeFileSync("dist/index.js", "built"); console.log(JSON.stringify({result:${JSON.stringify(JSON.stringify(HOLDS))}}));`);
    expect(await runReview(root, { goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "t" }] })).toMatchObject({ ran: true });
    process.env.GOAL_GUARDIAN_REVIEWER = await stub(`require("fs").writeFileSync("new.test.js", "tests not in the submitted project"); console.log(JSON.stringify({result:${JSON.stringify(JSON.stringify(HOLDS))}}));`);
    expect(await runReview(root, { goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "t" }] })).toMatchObject({ ran: false, reason: expect.stringContaining("new.test.js") });
  });

  it("works in a copy of the project as the agent left it, without Guardian's files, and reports what it found", async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, "a.js"), "changed\n");
    await fs.writeFile(path.join(root, "new.js"), "new\n");
    await fs.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    const seen = path.join(await tmp("gg-seen-"), "seen.json");
    process.env.GOAL_GUARDIAN_REVIEWER = await stub(`const fs = require("fs");
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd(), files: fs.readdirSync("."), a: fs.readFileSync("a.js", "utf8"), reviewing: process.env.GOAL_GUARDIAN_REVIEWING, args: process.argv.slice(2) }));
process.stdout.write(JSON.stringify({ result: ${JSON.stringify(JSON.stringify(OBJECTS))} }));`);
    const outcome = await runReview(root, { goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "t" }] });
    expect(outcome).toMatchObject({ ran: true, fails: [{ id: "sc_1" }], extra: [{ file: "util.js" }] });
    const view = JSON.parse(await fs.readFile(seen, "utf8")) as { cwd: string; files: string[]; a: string; reviewing: string; args: string[] };
    expect(path.resolve(view.cwd)).not.toBe(path.resolve(root));
    expect(view.files).toEqual(expect.arrayContaining(["a.js", "new.js", "node_modules"]));
    expect(view.files).not.toContain(".cursor");
    expect(view.a).toBe("changed\n");
    expect(view.reviewing).toBe("1");
    expect(view.args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--workspace"]));
    await expect(fs.access(view.cwd)).rejects.toThrow(); // the copy is gone afterwards
  });

  it("can't copy a folder that is only part of a repository", async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, "sub"));
    expect(await makeReviewCopy(path.join(root, "sub"))).toBeNull();
  });
});

describe("the reviewer in the goal loop", () => {
  async function doneWork(): Promise<string> {
    const root = await repo();
    await recordUserPrompt(root, "add the export", "c1", "agent");
    await tick();
    await fs.writeFile(path.join(root, "a.js"), "two\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    await tick();
    await recordShellOutput(root, { command: "make test", output: "12 passed", durationMs: 0 });
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: "make test", conversationId: "c1" });
    return root;
  }
  const report = { status: "complete" as const, proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }], changes: [{ file: "a.js", serves: "sc_1" }] };
  const stop = (root: string, n = 0) => runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: n });
  const kinds = async (root: string, kind: string) => (await readAuditTail(root, 1000)).filter((r) => r.kind === kind) as Array<Record<string, unknown>>;

  it("passed source tests cannot hide a failed package build or public API check", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = await answering({ ...HOLDS, checks: [{ id: "build", verdict: "fails", evidence: "build exits zero but omits the UMD bundle" }, { id: "public_api", verdict: "fails", evidence: "require(package) returns an object instead of the existing callable API" }, VERIFIED_CHECKS[2]] });
    const answer = await finishReport(root, report);
    expect(answer.accepted).toBe(false);
    expect(answer.unproved).toEqual(expect.arrayContaining([expect.stringContaining("omits the UMD"), expect.stringContaining("existing callable API")]));
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toContain("existing callable API");
  }, 60_000);

  it("a review with no verification evidence is unchecked, never proved", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = await answering({ ...HOLDS, checks: [] });
    expect(await finishReport(root, report)).toMatchObject({ accepted: true, outcome: "unchecked", message: expect.stringContaining("build, public_api, behavior") });
  }, 60_000);

  it("an objection reaches the agent at once and comes back as a round; the review is on the record", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(OBJECTS);
    const answer = await finishReport(root, report);
    expect(answer.accepted).toBe(false);
    expect(answer.message).toContain("independent reviewer");
    expect(answer.unproved).toEqual(reviewLines({ fails: [{ id: "sc_1", evidence: OBJECTS.items[0]!.evidence }], extra: [] }));
    const round = await stop(root);
    expect(round).toContain("Reviewer: sc_1 isn't done: the export is a comment, not code");
    expect(await kinds(root, "goal.review")).toMatchObject([{ ran: true, fails: [{ id: "sc_1" }] }]);
    expect(round).not.toContain("util.js");
  });

  it("a clean review, or one that couldn't run, lets the record's proof stand", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(HOLDS);
    expect((await finishReport(root, report)).accepted).toBe(true);
    expect(await stop(root)).toBeNull();
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "proved" }]);
    const other = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
    expect((await finishReport(other, report)).accepted).toBe(true);
    expect(await kinds(other, "goal.review")).toMatchObject([{ ran: false, reason: "cursor-agent isn't installed" }, { ran: false, reason: "cursor-agent isn't installed" }]);
    expect(await stop(other)).toBeNull();
  });

  it("a verdict on a state stands: the same project and report are never reviewed twice, and stay disputed until the project changes", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(OBJECTS);
    expect((await finishReport(root, report)).accepted).toBe(false);
    expect(await stop(root, 0)).toContain("Reviewer:");
    // The same report on the same project: no second roll of the dice, even with a reviewer that would now pass it.
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(HOLDS);
    expect(await finishReport(root, report)).toMatchObject({ accepted: false, outcome: "disputed", unproved: expect.arrayContaining(["Reviewer: sc_1 isn't done: the export is a comment, not code"]) });
    expect(await stop(root, 1)).toBeNull();
    // And again after the run ended disputed: still disputed, still one review, one end.
    expect(await finishReport(root, report)).toMatchObject({ accepted: false, outcome: "disputed" });
    expect(await kinds(root, "goal.review")).toHaveLength(1);
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "disputed", reviewer: expect.arrayContaining(["Reviewer: sc_1 isn't done: the export is a comment, not code"]) }]);
    expect(goalPhaseOf(await readAuditTail(root, 1000), await readContractSafe(root))).toBe("active");
    // The project changes: that is a new state, and it gets its own review.
    await change(root, "three\n");
    expect(await finishReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(await kinds(root, "goal.review")).toHaveLength(2);
  });

  it("a cached verdict from an older policy cannot satisfy the new completion checks", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(OBJECTS);
    expect((await finishReport(root, report)).accepted).toBe(false);
    const file = getGuardianPaths(root).audit;
    const records = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    for (const r of records) if (r.kind === "goal.review") r.policy = "older-policy";
    await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(HOLDS);
    expect(await finishReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(await kinds(root, "goal.review")).toHaveLength(2);
  });

  it("a review that passed a state isn't run again for the same state", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(HOLDS);
    process.env.GOAL_GUARDIAN_CODEX_GOALS = "/nonexistent/codex-goals";
    // Codex's code doesn't run, so nothing is accepted; the review that ran is on the record.
    expect(await finishReport(root, report)).toMatchObject({ accepted: false, outcome: "unverified" });
    expect(await finishReport(root, report)).toMatchObject({ accepted: false });
    expect(await kinds(root, "goal.review")).toHaveLength(1);
  });

  const change = async (root: string, text: string): Promise<void> => {
    await tick();
    await fs.writeFile(path.join(root, "a.js"), text);
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    await tick();
    await recordShellOutput(root, { command: "make test", output: "12 passed", durationMs: 0 });
  };

  it("an objection can't be escaped by changing something else: each changed state is reviewed again, past the usual limit", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(OBJECTS);
    for (let n = 0; n < MAX_REVIEWS; n += 1) {
      if (n > 0) await change(root, `state ${n}\n`);
      expect((await finishReport(root, report)).accepted).toBe(false);
      expect(await stop(root, n)).toContain("Reviewer:");
    }
    // A cosmetic change after two objections gets a fresh review, which still objects: not accepted, not "unchecked".
    await change(root, "three\n");
    const third = await finishReport(root, report);
    expect(third).toMatchObject({ accepted: false });
    expect(third.outcome).toBeUndefined();
    expect(third.unproved).toEqual(expect.arrayContaining([expect.stringContaining("Reviewer: sc_1 isn't done")]));
    expect(await kinds(root, "goal.review")).toHaveLength(MAX_REVIEWS + 1);
    expect(await stop(root, MAX_REVIEWS)).toContain("Reviewer:");
    // The same state reported again is disputed at once: the review that saw it objected.
    expect(await finishReport(root, report)).toMatchObject({ accepted: false, outcome: "disputed" });
    expect(await kinds(root, "goal.review")).toHaveLength(MAX_REVIEWS + 1);
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "disputed", reviewer: expect.arrayContaining(["Reviewer: sc_1 isn't done: the export is a comment, not code"]) }]);
  });

  it("the cost is bounded: after the hard limit of reviews a still-objected run ends disputed, never unchecked", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(OBJECTS);
    for (let n = 0; n < REVIEW_HARD_LIMIT; n += 1) {
      if (n > 0) await change(root, `state ${n}\n`);
      expect((await finishReport(root, report)).accepted).toBe(false);
      expect(await stop(root, n)).toContain("Reviewer:");
    }
    expect(await kinds(root, "goal.review")).toHaveLength(REVIEW_HARD_LIMIT);
    await change(root, "one more cosmetic change\n");
    expect(await finishReport(root, report)).toMatchObject({ accepted: false, outcome: "disputed" });
    expect(await kinds(root, "goal.review")).toHaveLength(REVIEW_HARD_LIMIT);
    const [end] = await kinds(root, "goal.end");
    expect(end).toMatchObject({ outcome: "disputed", changedSinceReview: true, reason: expect.stringContaining("no reviews are left") });
    // Reporting that same unreviewed state again, even to a reviewer that would now pass it, doesn't reopen it.
    process.env.GOAL_GUARDIAN_REVIEWER = await answering(HOLDS);
    expect(await finishReport(root, report)).toMatchObject({ accepted: false, outcome: "disputed" });
    expect(await kinds(root, "goal.review")).toHaveLength(REVIEW_HARD_LIMIT);
    expect(await kinds(root, "goal.end")).toHaveLength(1);
  });
});
