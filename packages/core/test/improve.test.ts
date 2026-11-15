import { VERIFIED_CHECKS } from "./helpers/review.js";
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, applyImprovement, autoImprove, candidatePath, defaultContract, estimateImprove, labelsFingerprint, recordReviewFeedback, goalHash, getGuardianPaths, harnessPath, improveReviewer, isHeldOut,
  labelledCases, learningBatch, enoughToImprove, loadCases, materializeCase, nowIso, readAuditTail, replayCase, reviewLabels, reviewTemplate, saveCase, undoImprovement, writeHarness, REVIEW_PROMPT, REVIEW_BUDGET_MS, LEARNING_REVIEW_BUDGET_MS,
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
  it("background replays have their own deadline below the adapter's outer timeout", async () => {
    const adapter = await fs.readFile(path.join(REPO_ROOT, "packages/rsi/cgg/adapter.py"), "utf8");
    const outer = Number(adapter.match(/REPLAY_TIMEOUT_S = (\d+)/)?.[1]) * 1000;
    expect(LEARNING_REVIEW_BUDGET_MS).toBeGreaterThan(REVIEW_BUDGET_MS);
    expect(LEARNING_REVIEW_BUDGET_MS).toBeLessThan(outer);
  });

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
    expect(est.searchCallsMax).toBe(2 * (2 + 2 * 43) + est.reviews);
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
if(process.env.CGG_TEST_AGENT_MARKER) fs.writeFileSync(process.env.CGG_TEST_AGENT_MARKER,String(process.pid));
if(process.env.CGG_TEST_AGENT_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.CGG_TEST_AGENT_DELAY));
const say = (o) => process.stdout.write(JSON.stringify({ type: "result", usage: {inputTokens:100,outputTokens:20,cacheReadTokens:40,cacheWriteTokens:0}, result: JSON.stringify(o) }) + "\\n");
if (prompt.includes("You are a harness engineer agent")) {
  const log = prompt.slice(prompt.lastIndexOf("=== INTERACTION LOG ==="));
  if (!log.includes('"action": "edit_file"')) say({ action: "edit_file", path: "reviewer.md", old: "Stay in this folder.", new: "QUIET: only object to what an item needs.\\nStay in this folder." });
  else say({ action: "done", summary: "object only to what an item needs", edits: [{ id: "C1", component: "prompt", hypothesis: "most objections here were overruled", targets_mode: "false flags", why_not_lower_lever: "it is a prose rule", trigger_condition: "every review", predicted_affected: ["x"], retroactive_check: "overruled cases pass; nothing caught is lost; general", regression_risk: "a real gap missed" }] });
 } else if (prompt.includes("Match the same concrete problem")) {
  const body = JSON.parse(prompt.split("INPUT_DATA_JSON:")[1].split("\\n\\nOutput ONLY")[0]);
  say({matches:body.reference_issues.map(t=>({key:t.key,present:body.candidate_findings.length>0,reason:"controlled stand-in"}))});
} else if (prompt.includes("You are a strict reviewer of harness")) say({ verdict: "accept", reasons: [], risk_notes: [] });
else if (prompt.includes("You are the batch analyst")) say({ action: "report", failure_modes: [{ mode: "false-flag", description: "objects to good work", n_tasks: 3 }], capability_gaps: [], success_habits: [] });
else if (prompt.includes("You are a trajectory digester")) say({ action: "return", digest: { summary: "flagged good work" } });
else if (prompt.includes("NO_VERIFICATION")) say({ items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [] });
else if (prompt.includes("QUIET") && !fs.readFileSync(path.join(ws, "a.js"), "utf8").includes("throw new Error")) say({ items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [], checks: ${JSON.stringify(VERIFIED_CHECKS)} });
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

/** Harmless false alarms and actual missing implementations occur in both training and held-out cases. */
async function labelledWorkspace(): Promise<string> {
  const root = await repo();
  let rights = 0;
  for (let i = 0; i < 12; i += 1) {
    const id = `rev_${i}`;
    const label = [1, 2, 3, 4].includes(i) ? "right" : "wrong";
    await fs.writeFile(path.join(root, "a.js"), label === "right" ? 'export function exportCsv(){ throw new Error("not implemented"); }\n' : 'export function exportCsv(){ return "csv"; }\n');
    await saveCase(root, id, contract, { prompt: REVIEW_PROMPT, ...OBJECTION }, nowIso());
    await appendAudit(root, review(id, `h${i}`));
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
    expect(result.run, `${result.run?.reason}\n${log.slice(-3000)}\n${await fs.readFile(path.join(getGuardianPaths(root).dir,"rsi/runs/cgg/jobs/heldout_before/rev_0/trial0.json"),"utf8").catch(()=>"no rev0")}`).toMatchObject({ kept: true });
    const evaluation=JSON.parse(await fs.readFile(path.join(getGuardianPaths(root).dir,"rsi/runs/cgg/jobs/base/eval.json"),"utf8"));
    expect(evaluation.C).toBe(160); // Real RRSI aggregation receives the native-envelope usage.
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
  it("does not search when the initial evaluation is incomplete", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    await writeHarness(root, "reviewer", REVIEW_PROMPT + "\nNO_VERIFICATION");
    const result = await autoImprove(root, rsiPaths());
    expect(result?.run).toMatchObject({ kept: false, reason: expect.stringContaining("no learning search was started") });
    expect((await readAuditTail(root, 500)).some((r) => r.kind === "improve.progress" && r.stage.includes("searching"))).toBe(false);
  }, 300_000);

  it("does not spend on a search that cannot improve an already perfect baseline", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    await writeHarness(root, "reviewer", REVIEW_PROMPT + "\nQUIET");
    const result = await autoImprove(root, rsiPaths());
    expect(result?.run).toMatchObject({ kept: false, reason: expect.stringContaining("already correct on every reserved example") });
    expect((await readAuditTail(root, 500)).some((r) => r.kind === "improve.progress" && r.stage.includes("searching"))).toBe(false);
  }, 300_000);

  it("uses both kinds of feedback within one review when balancing learning", async () => {
    const original=await labelledCases(await labelledWorkspace());
    const mixed=original.map(c=>({...c,label:"right" as const,targets:[{key:"useful",finding:"missing export",label:"right" as const},{key:"nit",finding:"unnecessary complaint",label:"wrong" as const}]}));
    expect(enoughToImprove(mixed)).toBe(true);
    const recent=Array.from({length:24},(_,i)=>({...mixed[0]!,reviewCase:{...mixed[0]!.reviewCase,id:`mixed_${i}`}}));
    const batch=learningBatch([...mixed,...recent]);
    expect(enoughToImprove(batch)).toBe(true);
    expect(batch).toHaveLength(12);
    const onlyPositive=mixed.map(c=>({...c,targets:c.targets.filter(t=>t.label==="right")}));
    expect(enoughToImprove(onlyPositive)).toBe(false);
  });

  it("keeps a bounded recent batch with real catches and false alarms in both splits", async () => {
    const cases = await labelledCases(await labelledWorkspace());
    const history = [...cases, ...Array.from({ length: 24 }, (_, i) => ({ ...cases[0]!, label: "wrong" as const, reviewCase: { ...cases[0]!.reviewCase, id: `recent_${i}` } }))];
    const batch = learningBatch(history);
    expect(batch).toHaveLength(12);
    expect(batch.some((c) => c.reviewCase.id === "recent_23")).toBe(true);
    for (const heldOut of [true, false]) for (const label of ["right", "wrong"]) {
      expect(batch.some((c) => isHeldOut(c.reviewCase.id) === heldOut && c.label === label)).toBe(true);
    }
  });

  it("recovers an interrupted run after its owning process has exited", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    const dead = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const lease = path.join(getGuardianPaths(root).dir, "improvement.lock");
    await fs.writeFile(lease, dead);
    await appendAudit(root, { ts: nowIso(), kind: "improve.start", id: "interrupted" });
    expect((await autoImprove(root, rsiPaths()))?.run?.kept).toBe(true);
    await expect(fs.access(lease)).rejects.toThrow();
  }, 300_000);

  it("new corrections to existing cases can trigger the next batch without requiring new cases", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    await autoImprove(root, rsiPaths());
    const memory=JSON.parse(await fs.readFile(path.join(getGuardianPaths(root).dir,"learning/search-history.json"),"utf8"));
    expect(memory.some((row:{search:{hypothesis?:string}})=>Boolean(row.search.hypothesis))).toBe(true);
    for (const id of ["rev_0", "rev_5", "rev_8", "rev_9"]) await recordReviewFeedback(root, id, 0, "right");
    expect((await autoImprove(root, rsiPaths()))?.status).toBe("done");
    expect((await readAuditTail(root, 1000)).filter((r) => r.kind === "improve.start")).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(path.join(getGuardianPaths(root).dir,"rsi/repo/domains/cgg/data/previous_search.json"),"utf8"))).toEqual(memory.slice(-20));
  }, 300_000);

  it("waits when the held-out cases cannot check retention of real catches", async () => {
    const root = await labelledWorkspace();
    await recordReviewFeedback(root, "rev_2", 0, "wrong");
    await recordReviewFeedback(root, "rev_2", 1, "wrong");
    expect(await autoImprove(root, rsiPaths())).toBeNull();
    expect((await readAuditTail(root, 500)).some((r) => r.kind === "improve.start")).toBe(false);
  });

  it("overlapping refreshes start just one background learning run", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    const results = await Promise.all([autoImprove(root, rsiPaths()), autoImprove(root, rsiPaths())]);
    expect(results.filter((r) => r?.status === "done")).toHaveLength(1);
    expect((await readAuditTail(root, 500)).filter((r) => r.kind === "improve.start")).toHaveLength(1);
  }, 300_000);

  it.each([0, 1])("stops at a background allowance of %i calls and keeps the current reviewer", async (limit) => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    process.env.CGG_RSI_AUTO_CALL_LIMIT = String(limit);
    const result = await autoImprove(root, rsiPaths());
    expect(result?.run).toMatchObject({ kept: false, calls: limit, reason: expect.stringContaining("usage limit") });
    expect(reviewTemplate(root)).toBe(REVIEW_PROMPT);
    expect(await autoImprove(root, rsiPaths())).toBeNull();
  }, 300_000);

  it("keeps feedback but defers model-based learning while the user's goal needs work", async () => {
    const root = await labelledWorkspace();
    await appendAudit(root, { ts: nowIso(), kind: "goal.control", goalHash: goalHash(contract), operation: "resume", actor: "user" });
    expect((await labelledCases(root)).length).toBeGreaterThan(0);
    expect(await autoImprove(root, rsiPaths())).toBeNull();
    expect((await readAuditTail(root, 500)).some((record) => record.kind === "improve.start")).toBe(false);
  });

  it("yields running learning to foreground work and resumes compatible progress without resetting its allowance", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    process.env.CGG_MODEL_ID = "local-test-model";
    process.env.CGG_TEST_AGENT_MARKER = path.join(root, "entered");
    process.env.CGG_TEST_AGENT_DELAY = "2000";
    const running = autoImprove(root, rsiPaths());
    for (let n=0; n<200; n++) {
      if (await fs.access(process.env.CGG_TEST_AGENT_MARKER).then(()=>true).catch(()=>false)) break;
      await new Promise(r=>setTimeout(r,25));
    }
    await appendAudit(root, { ts: nowIso(), kind: "goal.control", goalHash: goalHash(contract), operation: "resume", actor: "user" });
    expect((await running)?.run).toMatchObject({ kept:false, yielded:true });
    const reviewerPid=Number(await fs.readFile(process.env.CGG_TEST_AGENT_MARKER,"utf8"));
    await new Promise(r=>setTimeout(r,100));
    expect(()=>process.kill(reviewerPid,0)).toThrow();
    const base = path.join(getGuardianPaths(root).dir,"learning");
    const pending = JSON.parse(await fs.readFile(path.join(base,"pending.json"),"utf8"));
    const witness=path.join(getGuardianPaths(root).dir,"rsi/resume-witness");
    await fs.writeFile(witness,"preserve compatible progress");
    const spent = JSON.parse(await fs.readFile(path.join(base,"allowance.json"),"utf8")).used;
    expect(spent).toBeGreaterThan(0);
    expect(await autoImprove(root,rsiPaths())).toBeNull();
    await appendAudit(root, { ts: nowIso(), kind: "goal.end", conversationId:"finished", goalHash:goalHash(contract), outcome:"proved" });
    delete process.env.CGG_TEST_AGENT_DELAY;
    delete process.env.CGG_TEST_AGENT_MARKER;
    const resumed = await autoImprove(root,rsiPaths());
    expect(resumed?.run,JSON.stringify(resumed)).toMatchObject({kept:true});
    expect(await fs.readFile(witness,"utf8")).toBe("preserve compatible progress");
    expect(JSON.parse(await fs.readFile(path.join(base,"allowance.json"),"utf8")).used).toBeGreaterThan(spent);
    expect(sh(path.join(getGuardianPaths(root).dir,"rsi/repo"),"cat-file","-t",pending.start).trim()).toBe("commit");
    await expect(fs.access(path.join(base,"pending.json"))).rejects.toThrow();
  }, 120_000);

  it("shares a daily allowance across attempts, waits when spent, and resumes when the user raises it", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    process.env.CGG_MODEL_ID = "local-test-model";
    await fs.writeFile(getGuardianPaths(root).config,JSON.stringify({schemaVersion:2,learning:{dailyCallLimit:1}}));
    const limited = await autoImprove(root,rsiPaths());
    expect(limited?.run).toMatchObject({kept:false,deferredUntil:expect.any(Number),calls:1});
    expect(await autoImprove(root,rsiPaths())).toBeNull();
    await fs.writeFile(getGuardianPaths(root).config,JSON.stringify({schemaVersion:2,learning:{dailyCallLimit:32}}));
    const resumed = await autoImprove(root,rsiPaths());
    expect(resumed?.run,JSON.stringify(resumed)).toMatchObject({kept:true});
    const daily=JSON.parse(await fs.readFile(path.join(getGuardianPaths(root).dir,"learning/allowance.json"),"utf8"));
    expect(daily.used).toBeGreaterThan(1);expect(daily.used).toBeLessThanOrEqual(32);
    await fs.writeFile(getGuardianPaths(root).config,JSON.stringify({schemaVersion:2,learning:{dailyCallLimit:0}}));
    expect(await autoImprove(root,rsiPaths())).toBeNull();
  },120_000);

  it("runs with no click once there are enough verdicts, applies what its gate kept, and doesn't run again on the same verdicts", async () => {
    const root = await labelledWorkspace();
    process.env.GOAL_GUARDIAN_REVIEWER = await stubAgent();
    const result = await autoImprove(root, rsiPaths());
    expect(result?.status).toBe("done");
    expect(result!.run).toMatchObject({ kept: true, auto: true, labels: labelsFingerprint(await labelledCases(root)) });
    expect(result!.run!.calls).toBeLessThanOrEqual(32);
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
    await fs.writeFile(path.join(getGuardianPaths(busy).dir, "improvement.lock"), String(process.pid));
    expect(await autoImprove(busy, rsiPaths())).toBeNull();
  });

  it("keeps missed-work feedback but requires a concrete issue for learning qualification", async () => {
    const root = await repo();
    await saveCase(root, "rev_pass", contract, { prompt: REVIEW_PROMPT, fails: [], extra: [] }, nowIso());
    await appendAudit(root, review("rev_pass", "h", { fails: [], extra: [] }));
    expect(reviewLabels(await readAuditTail(root, 100)).size).toBe(0);
    await recordReviewFeedback(root, "rev_pass", 0, "missed");
    expect(reviewLabels(await readAuditTail(root, 100)).get("rev_pass")).toEqual({ label: "right", source: "missed" });
    // Reopen the work, without inventing the concrete defect a replay must retain.
    expect(await labelledCases(root)).toEqual([]);
    // "Missed" said about a review that did object isn't a verdict on its objections.
    await appendAudit(root, review("rev_obj", "h2"));
    await recordReviewFeedback(root, "rev_obj", 0, "missed");
    expect(reviewLabels(await readAuditTail(root, 100)).has("rev_obj")).toBe(false);
  });
});
