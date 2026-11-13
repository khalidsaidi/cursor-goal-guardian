import { VERIFIED_CHECKS } from "./helpers/review.js";
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, applyImprovement, autoImprove, candidatePath, defaultContract, estimateImprove, labelsFingerprint, recordReviewFeedback, goalHash, getGuardianPaths, harnessPath, improveReviewer, isHeldOut,
  labelledCases, loadCases, materializeCase, nowIso, readAuditTail, replayCase, reviewLabels, reviewTemplate, saveCase, undoImprovement, REVIEW_PROMPT,
  type AuditRecord, type RsiPaths,
} from "../src/index.js";

const made: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnv };
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

const contract = { ...defaultContract(), goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "the export test passes" }] };

async function repo(): Promise<string> {
  const root = await tmp("gg-improve-ws-");
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.contract, JSON.stringify(contract));
  sh(root, "init", "-q");
  await fs.writeFile(path.join(root, "a.js"), "one\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".cursor/\n");
  sh(root, "add", "a.js", ".gitignore");
  sh(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  // The agent's work: an edit, a new text file and a new binary file.
  await fs.writeFile(path.join(root, "a.js"), "one\ntwo\n");
  await fs.writeFile(path.join(root, "new.txt"), "fresh\n");
  await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0, 255, 1, 254]));
  return root;
}

const OBJECTION = { fails: [{ id: "sc_1", evidence: "the export is a comment" }], extra: [{ file: "util.js", what: "renamed helpers" }] };
const review = (id: string, goalHash: string, objections = OBJECTION): AuditRecord =>
  ({ ts: nowIso(), kind: "goal.review", goalHash, reportTs: nowIso(), id, caseSaved: true, ran: true, seconds: 1, ...objections }) as AuditRecord;
const tick = () => new Promise((r) => setTimeout(r, 3));

describe("a review's case", () => {
  it("saves what the review saw and rebuilds it elsewhere: edits, new files, binaries", async () => {
    const root = await repo();
    expect(await saveCase(root, "rev_1", contract, { prompt: "p", ...OBJECTION }, nowIso())).toBeNull();
    const [c] = await loadCases(root);
    expect(c).toMatchObject({ id: "rev_1", goal: "Add CSV export", flagged: true, prompt: "p" });
    // The case never reaches a commit.
    expect(sh(root, "status", "--porcelain", "--ignored", ".cursor")).not.toContain("cases/rev_1/case.json\n?? ");
    const copy = await materializeCase(root, c!);
    made.push(copy!.scratch);
    expect(await fs.readFile(path.join(copy!.dir, "a.js"), "utf8")).toBe("one\ntwo\n");
    expect(await fs.readFile(path.join(copy!.dir, "new.txt"), "utf8")).toBe("fresh\n");
    expect([...(await fs.readFile(path.join(copy!.dir, "blob.bin")))]).toEqual([0, 255, 1, 254]);
    expect(sh(copy!.dir, "diff", "HEAD", "--stat")).toContain("a.js");
  });

  it("retains explicit constraints when learning replays a saved project", async () => {
    const root = await repo();
    const constrained = { ...contract, constraints: ["Do not change a.js."], currentRequest: "Continue the original goal and finish the remaining work." };
    const prompt = `${REVIEW_PROMPT}\n\nUser constraints:\n- Do not change a.js.`;
    expect(await saveCase(root, "restricted", constrained, { prompt, fails: [], extra: [{ file: "a.js", what: "changed a file the user required unchanged" }] }, nowIso())).toBeNull();
    const [saved] = await loadCases(root);
    expect(saved?.constraints).toEqual(constrained.constraints);
    expect(saved?.currentRequest).toBe(constrained.currentRequest);
    const reviewer = path.join(await tmp("gg-constraint-reviewer-"), "agent");
    await fs.writeFile(reviewer, `#!/usr/bin/env node
const cp=require('child_process'),a=process.argv.slice(2),p=a[a.indexOf('-p')+1]||'',w=a[a.indexOf('--workspace')+1];
if(!p.includes('Latest user request for this turn:'+String.fromCharCode(10)+'Continue the original goal and finish the remaining work.'))process.exit(2);
const changed=cp.execFileSync('git',['diff','HEAD','--','a.js'],{cwd:w,encoding:'utf8'}).length>0;
const extra=p.includes('Do not change a.js.')&&changed?[{file:'a.js',what:'Changed the file the user required unchanged'}]:[];
console.log(JSON.stringify({items:[{id:'sc_1',verdict:'holds',evidence:'export present'}],extra,checks:${JSON.stringify(VERIFIED_CHECKS)}}));
`);
    await fs.chmod(reviewer, 0o755); process.env.GOAL_GUARDIAN_REVIEWER = reviewer;
    expect(await replayCase(root, "restricted", REVIEW_PROMPT)).toMatchObject({ ran: true, flagged: true, extra: [{ file: "a.js", what: expect.stringContaining("required unchanged") }] });
    // A legacy record with known restrictions but no saved constraint field cannot supply a fair replay.
    delete saved!.constraints;
    const file = path.join(getGuardianPaths(root).dir, "cases", "restricted", "case.json");
    await fs.writeFile(file, JSON.stringify(saved));
    expect(await replayCase(root, "restricted", REVIEW_PROMPT)).toMatchObject({ ran: false, flagged: null, reason: expect.stringContaining("did not retain") });
    saved!.constraints = constrained.constraints;
    delete saved!.currentRequest;
    await fs.writeFile(file, JSON.stringify(saved));
    expect(await replayCase(root, "restricted", REVIEW_PROMPT)).toMatchObject({ ran: false, flagged: null, reason: expect.stringContaining("user request active") });
  });

  it("isn't saved when the work is too big, or there's no commit to replay it on", async () => {
    const root = await repo();
    expect(await saveCase(root, "rev_big", contract, { prompt: "p", ...OBJECTION }, nowIso(), 10)).toMatch(/over/);
    const bare = await tmp("gg-improve-bare-");
    sh(bare, "init", "-q");
    expect(await saveCase(bare, "rev_x", contract, { prompt: "p", ...OBJECTION }, nowIso())).toMatch(/no commit/);
    expect(await loadCases(root)).toEqual([]);
  });
});

describe("labels come from explicit user feedback", () => {
  it("explicit verdicts label reviews; compliance and agent arguments do not", async () => {
    const records: AuditRecord[] = [];
    records.push(review("fixed", "h1"));
    records.push({ ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js" } as AuditRecord);
    records.push(review("fixed-pass", "h1", { fails: [], extra: [] }));
    records.push(review("overruled", "h2"));
    records.push({ ts: nowIso(), kind: "goal.control", goalHash: "h2", operation: "done", actor: "user" } as AuditRecord);
    records.push(review("argued", "h3"));
    records.push(review("argued-again", "h3"));
    records.push(review("user-right", "h4"));
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "user-right", index: 1, label: "right" });
    records.push(review("user-wrong", "h5"));
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "user-wrong", index: 0, label: "wrong" });
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "user-wrong", index: 1, label: "wrong" });
    records.push(review("half-said", "h6"));
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "half-said", index: 0, label: "wrong" });
    // An explicit verdict still labels a review after the goal was marked done.
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "overruled", index: 0, label: "right" });
    const labels = reviewLabels(records);
    expect(labels.has("fixed")).toBe(false);
    expect(labels.get("overruled")).toEqual({ label: "right", source: "user" });
    expect(labels.get("user-right")).toEqual({ label: "right", source: "user" });
    expect(labels.get("user-wrong")).toEqual({ label: "wrong", source: "user" });
    expect(labels.has("argued")).toBe(false);
    expect(labels.has("half-said")).toBe(false);
    expect(labels.has("fixed-pass")).toBe(false);
  });

  it("does not turn obedience to a formatting complaint or closing a goal into training feedback", () => {
    const complaint = review("style", "h", { fails: [], extra: [{ file: "index.d.ts", what: "reformat this already-working declaration" }] });
    const records: AuditRecord[] = [complaint,
      { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "index.d.ts" } as AuditRecord,
      review("pass", "h", { fails: [], extra: [] }),
      review("closed", "other"),
      { ts: nowIso(), kind: "goal.control", goalHash: "other", operation: "done", actor: "user" } as AuditRecord,
    ];
    expect(reviewLabels(records).size).toBe(0);
    records.push({ ts: nowIso(), kind: "review.feedback", reviewId: "style", index: 0, label: "wrong" });
    expect(reviewLabels(records).get("style")).toEqual({ label: "wrong", source: "user" });
  });

  it("a passing review with no change in between labels nothing", () => {
    const labels = reviewLabels([review("a", "h"), review("b", "h", { fails: [], extra: [] })]);
    expect(labels.has("a")).toBe(false);
  });
});

describe("the split and the cost", () => {
  it("a case always lands on the same side, about a third held out", () => {
    const ids = Array.from({ length: 600 }, (_, i) => `rev_${i}`);
    expect(ids.map(isHeldOut)).toEqual(ids.map(isHeldOut));
    const share = ids.filter(isHeldOut).length / ids.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.42);
  });

  it("the cost shown before a run counts held-out reviews twice and every candidate's evolve reviews", () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({ reviewCase: { id: `rev_${i}` }, label: "right", source: "user" })) as never;
    const est = estimateImprove(cases, { T: 2, m: 2, k: 1, repair_rounds: 2 });
    expect(est.evolve + est.heldOut).toBe(12);
    expect(est.reviews).toBe(2 * est.heldOut + est.evolve * 5);
    expect(est.searchCallsMax).toBe(2 * (2 + 2 * 43));
  });
});

describe("applying and undoing an improvement", () => {
  it("the workspace's own reviewer replaces the built-in one until undone", async () => {
    const root = await repo();
    await fs.mkdir(path.dirname(candidatePath(root, "improve_1")), { recursive: true });
    await fs.writeFile(candidatePath(root, "improve_1"), `${REVIEW_PROMPT}\nOnly object to what the goal needs.`);
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
    await applyImprovement(root, "improve_1");
    expect(reviewTemplate(root)).toContain("Only object to what the goal needs.");
    await undoImprovement(root);
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
    const kinds = (await readAuditTail(root, 100)).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["improve.apply", "improve.undo"]));
  });

  it("a version that drops a placeholder is ignored", async () => {
    const root = await repo();
    await fs.mkdir(path.dirname(harnessPath(root, "reviewer")), { recursive: true });
    await fs.writeFile(harnessPath(root, "reviewer"), "no placeholders here");
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
  });
});

const REPO_ROOT = path.resolve(__dirname, "../../..");
const HOOK_CLI = path.join(REPO_ROOT, "packages", "hook", "dist", "cli.cjs");

/**
 * A stand-in for the headless Cursor agent, speaking each protocol it meets: Guardian's reviewer, and RRSI's
 * analyst, digester, proposer and critic. As the proposer it adds a QUIET line to the reviewer; as a reviewer it
 * objects unless its instructions hold that line.
 */
async function stubAgent(): Promise<string> {
  const dir = await tmp("gg-improve-stub-");
  const file = path.join(dir, "agent");
  await fs.writeFile(
    file,
    `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
let prompt = a[a.indexOf("-p") + 1];
const ws = a[a.indexOf("--workspace") + 1];
if (prompt.startsWith("Read task.md")) prompt = fs.readFileSync(path.join(ws, "task.md"), "utf8");
const say = (o) => process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(o) }) + "\\n");
if (prompt.includes("You are a harness engineer agent")) {
  const log = prompt.slice(prompt.lastIndexOf("=== INTERACTION LOG ==="));
  if (!log.includes('"action": "edit_file"')) say({ action: "edit_file", path: "reviewer.md", old: "Stay in this folder.", new: "QUIET: only object to what an item needs.\\nStay in this folder." });
  else say({ action: "done", summary: "object only to what an item needs", edits: [{ id: "C1", component: "prompt", hypothesis: "most objections here were overruled", targets_mode: "false flags", why_not_lower_lever: "it is a prose rule", trigger_condition: "every review", predicted_affected: ["x"], retroactive_check: "overruled cases pass; nothing caught is lost; general", regression_risk: "a real gap missed" }] });
} else if (prompt.includes("You are a strict reviewer of harness")) say({ verdict: "accept", reasons: [], risk_notes: [] });
else if (prompt.includes("You are the batch analyst")) say({ action: "report", failure_modes: [{ mode: "false-flag", description: "objects to good work", n_tasks: 3 }], capability_gaps: [], success_habits: [] });
else if (prompt.includes("You are a trajectory digester")) say({ action: "return", digest: { summary: "flagged good work" } });
else if (prompt.includes("NO_VERIFICATION")) say({ items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [] });
else if (prompt.includes("QUIET")) say({ items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [], checks: ${JSON.stringify(VERIFIED_CHECKS)} });
else say({ items: [{ id: "sc_1", verdict: "fails", evidence: "nope" }], extra: [], checks: ${JSON.stringify(VERIFIED_CHECKS)} });
`,
  );
  await fs.chmod(file, 0o755);
  return file;
}

const PYTHON = process.env.GOAL_GUARDIAN_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
/** The stand-in agents are scripts run through their shebang line, which Windows doesn't honour. */
const posixOnly = process.platform === "win32";

const rsiPaths = (): RsiPaths => ({
  python: PYTHON,
  rrsiDir: path.join(REPO_ROOT, "third_party", "rrsi"),
  domainDir: path.join(REPO_ROOT, "packages", "rsi", "cgg"),
  replay: [process.execPath, HOOK_CLI, "replay-review"],
});

/** Cases where the reviewer objected; held-out ones are all labelled wrong, so a quieter reviewer scores better. */
async function labelledWorkspace(): Promise<string> {
  const root = await repo();
  let rights = 0;
  for (let i = 0; i < 12; i += 1) {
    const id = `rev_${i}`;
    await saveCase(root, id, contract, { prompt: REVIEW_PROMPT, ...OBJECTION }, nowIso());
    await appendAudit(root, review(id, `h${i}`));
    const label = isHeldOut(id) || rights >= 3 ? "wrong" : "right";
    if (label === "right") rights += 1;
    await appendAudit(root, { ts: nowIso(), kind: "review.feedback", reviewId: id, index: 0, label });
    await appendAudit(root, { ts: nowIso(), kind: "review.feedback", reviewId: id, index: 1, label });
    await tick();
  }
  expect(rights).toBeGreaterThan(0);
  await appendAudit(root, { ts: nowIso(), kind: "goal.end", conversationId: "completed-work", goalHash: goalHash(contract), outcome: "proved" });
  return root;
}

describe.skipIf(posixOnly)("Guardian's RRSI domain", () => {
  it("passes its own Python checks against a temp checkout and a fake agent", () => {
    const out = execFileSync(PYTHON, ["-m", "unittest", "tests/test_cgg_domain.py"], {
      cwd: path.join(REPO_ROOT, "packages", "rsi"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toBe("");
  }, 120_000);
});

describe.skipIf(posixOnly)("replaying one saved review, as RRSI does", () => {
  it("re-runs a case with another prompt and says whether it flagged", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    const first = await replayCase(root, "rev_0", REVIEW_PROMPT);
    expect(first, JSON.stringify(first)).toMatchObject({ ran: true, flagged: true });
    expect(await replayCase(root, "rev_0", `${REVIEW_PROMPT}\nQUIET`)).toMatchObject({ ran: true, flagged: false });
    expect(await replayCase(root, "nope", REVIEW_PROMPT)).toMatchObject({ ran: false, flagged: null });
    expect(await replayCase(root, "rev_0", `${REVIEW_PROMPT}\nNO_VERIFICATION`)).toMatchObject({ ran: true, flagged: null, unanswered: ["build", "public_api", "behavior"] });
  }, 60_000);
});

describe.skipIf(posixOnly)("one improvement try with Google's RRSI, start to finish", () => {
  it("RRSI's winner does better on cases it never saw, and waits for the user to apply it", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    const result = await improveReviewer(root, rsiPaths());
    const log = await fs.readFile(path.join(getGuardianPaths(root).dir, "rsi", "rrsi.log"), "utf8").catch(() => "");
    expect(result.status, log.slice(-3000)).toBe("done");
    expect(result.run, `${result.run?.reason}\n${log.slice(-3000)}`).toMatchObject({ kept: true });
    expect(result.run!.new!.correct).toBeGreaterThan(result.run!.old!.correct);
    expect(result.run!.diff).toContain("+ QUIET");
    expect(result.run!.hypotheses.join(" ")).toContain("overruled");
    expect(await fs.readFile(candidatePath(root, result.run!.id), "utf8")).toContain("QUIET");
    // RRSI's own record of the search is there to read.
    expect(log).toMatch(/baseline/);
    // Nothing changes until the user applies it.
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
    const kinds = (await readAuditTail(root, 500)).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["improve.start", "improve.progress", "improve.run"]));
  }, 300_000);

  it("won't start without enough labelled cases of both kinds", async () => {
    const root = await repo();
    expect((await improveReviewer(root, rsiPaths())).status).toBe("not-enough");
    expect(await labelledCases(root)).toEqual([]);
  });
});

describe.skipIf(posixOnly)("Guardian improving its reviewer by itself", () => {
  it("keeps feedback but defers model-based learning while the user's goal needs work", async () => {
    const root = await labelledWorkspace();
    await appendAudit(root, { ts: nowIso(), kind: "goal.control", goalHash: goalHash(contract), operation: "resume", actor: "user" });
    expect((await labelledCases(root)).length).toBeGreaterThan(0);
    expect(await autoImprove(root, rsiPaths())).toBeNull();
    expect((await readAuditTail(root, 500)).some((record) => record.kind === "improve.start")).toBe(false);
  });

  it("runs with no click once there are enough verdicts, applies what its gate kept, and doesn't run again on the same verdicts", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    const result = await autoImprove(root, rsiPaths());
    expect(result?.status).toBe("done");
    expect(result!.run).toMatchObject({ kept: true, auto: true, labels: labelsFingerprint(await labelledCases(root)) });
    // Kept by the gate (better on held-out cases, no catch lost), so it is in use at once, and on the record as automatic.
    expect(reviewTemplate(root)).toContain("QUIET");
    const records = await readAuditTail(root, 500);
    expect(records.find((r) => r.kind === "improve.start")).toMatchObject({ auto: true, reviews: expect.any(Number), searchCallsMax: expect.any(Number) });
    expect(records.find((r) => r.kind === "improve.apply")).toMatchObject({ runId: result!.run!.id, auto: true });
    // The same verdicts again: nothing to do. A few more verdicts than last time: still not a new batch.
    expect(await autoImprove(root, rsiPaths())).toBeNull();
    await undoImprovement(root);
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
  }, 300_000);

  it("does nothing without enough verdicts of both kinds, or while a run is going", async () => {
    const root = await repo();
    expect(await autoImprove(root, rsiPaths())).toBeNull();
    const busy = await labelledWorkspace();
    await appendAudit(busy, { ts: nowIso(), kind: "improve.start", id: "improve_running" });
    expect(await autoImprove(busy, rsiPaths())).toBeNull();
  });

  it("learns from a miss: a review that passed work the user then says wasn't done should have objected", async () => {
    const root = await repo();
    await saveCase(root, "rev_pass", contract, { prompt: REVIEW_PROMPT, fails: [], extra: [] }, nowIso());
    await appendAudit(root, review("rev_pass", "h", { fails: [], extra: [] }));
    expect(reviewLabels(await readAuditTail(root, 100)).size).toBe(0);
    await recordReviewFeedback(root, "rev_pass", 0, "missed");
    expect(reviewLabels(await readAuditTail(root, 100)).get("rev_pass")).toEqual({ label: "right", source: "missed" });
    // It is a replayable case like any other, labelled as one the reviewer should have flagged.
    expect(await labelledCases(root)).toMatchObject([{ label: "right", source: "missed", reviewCase: { id: "rev_pass", flagged: false } }]);
    // "Missed" said about a review that did object isn't a verdict on its objections.
    await appendAudit(root, review("rev_obj", "h2"));
    await recordReviewFeedback(root, "rev_obj", 0, "missed");
    expect(reviewLabels(await readAuditTail(root, 100)).has("rev_obj")).toBe(false);
  });
});
