import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, defaultContract, getGuardianPaths, nowIso, readAuditTail, recordShellOutput,
  recordUserPrompt, recordShellFailure, submitGoalReport, writeContract, loadCases,
} from "../src/index.js";
import { writeHarness } from "../src/goal/harness.js";
import { verificationState } from "../src/goal/verificationState.js";

const dirs: string[] = [];
const original = { ...process.env };
afterEach(async () => {
  process.env = { ...original };
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const goal = { goal: "Add normalized tags", successCriteria: [{ id: "sc_1", text: "normalize trims, lowercases and deduplicates tags" }] };
const correct = `exports.base=x=>x; exports.normalize=xs=>[...new Set(xs.map(x=>x.trim().toLowerCase()).filter(Boolean))];\n`;
const test = `const a=require('node:assert/strict'),m=require('./index.cjs');a.deepEqual(m.normalize([' A ','a','B','']),['a','b']);a.equal(m.base('x'),'x');console.log('behavior passed');\n`;
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cgg-outcomes-")); dirs.push(dir);
  const root = path.join(dir, "project"); await fs.mkdir(root);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "test");
  await fs.writeFile(path.join(root, "index.cjs"), "exports.base=x=>x;\n"); git("add", "."); git("commit", "-qm", "base");
  const p = getGuardianPaths(root); await fs.mkdir(p.telemetryDir, { recursive: true }); await fs.writeFile(p.config, "{}");
  await writeContract(root, { ...defaultContract(), ...goal }); await recordUserPrompt(root, goal.goal, "c", "agent");
  await fs.writeFile(path.join(root, "index.cjs"), correct); await fs.writeFile(path.join(root, "test.cjs"), test);
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "index.cjs", conversationId: "c" });
  const ran = spawnSync(process.execPath, ["test.cjs"], { cwd: root, encoding: "utf8" });
  expect(ran.status).toBe(0); await recordShellOutput(root, { command: "node test.cjs", output: ran.stdout });
  const reviewLog = path.join(dir, "reviews"), evaluatorLog = path.join(dir, "evaluations"), evaluationInput = path.join(dir, "evaluation-input.json");
  const reviewer = path.join(dir, "reviewer.cjs");
  // Execute the actual project tests in the review copy. Findings reflect behavior, not report metadata.
  await fs.writeFile(reviewer, `#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process');const a=process.argv.slice(2),p=a[a.indexOf('-p')+1]||'',w=a[a.indexOf('--workspace')+1];
fs.appendFileSync(${JSON.stringify(reviewLog)},'x');
const r=cp.spawnSync(process.execPath,['test.cjs',...(p.includes('The claims:')?['more']:[])],{cwd:w,encoding:'utf8'});const ok=r.status===0,e=ok?'behavior passed':'Behavior test failed: '+(r.stdout+r.stderr).slice(-200);
if(p.includes('The claims:')) {const ids=p.split(String.fromCharCode(10)).filter(l=>l.startsWith('- ')&&l.includes(' (')).map(l=>l.slice(2).split(' ')[0]); console.log(JSON.stringify({claims:ids.map(id=>({id,verdict:ok?'dismissed':'confirmed',evidence:e}))}));}
else console.log(JSON.stringify({items:[{id:'sc_1',verdict:ok?'holds':'fails',evidence:e}],extra:[],checks:[{id:'build',verdict:'not_applicable',evidence:'plain CommonJS project with no build step'},{id:'public_api',verdict:'holds',evidence:'required the public index.cjs entry'},{id:'behavior',verdict:ok?'holds':'fails',evidence:e}]}));
`); await fs.chmod(reviewer, 0o755); process.env.GOAL_GUARDIAN_REVIEWER = reviewer;
  const adapter = JSON.parse(process.env.GOAL_GUARDIAN_EVALUATOR!);
  const evaluator = path.join(dir, "evaluator.cjs");
  await fs.writeFile(evaluator, `#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process');fs.appendFileSync(${JSON.stringify(evaluatorLog)},'x');const input=fs.readFileSync(0);fs.writeFileSync(${JSON.stringify(evaluationInput)},input);const r=cp.spawnSync(${JSON.stringify(adapter.python)},process.argv.slice(2),{input,encoding:'utf8',env:process.env});process.stdout.write(r.stdout||'');process.exit(r.status??1);
`); await fs.chmod(evaluator, 0o755);
  process.env.GOAL_GUARDIAN_EVALUATOR = JSON.stringify({ ...adapter, python: evaluator });
  const calls = (file: string) => syncFs.existsSync(file) ? syncFs.readFileSync(file, "utf8").length : 0;
  return { root, git, evaluationInput, reviews: () => calls(reviewLog), evaluations: () => calls(evaluatorLog) };
}
const request = { status: "complete" as const, proofs: [], changes: [] };

describe("outcome-focused completion", () => {
  it("finishes ordinary working code without copied quotes or file labels", async () => {
    const f = await fixture();
    expect(await submitGoalReport(f.root, request)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(f.reviews()).toBe(1); expect(f.evaluations()).toBe(1);
    const end = (await readAuditTail(f.root)).find(r => r.kind === "goal.end");
    expect(end).toMatchObject({ proved: expect.arrayContaining([{ criterion: "goal", command: "node test.cjs", recordedAt: expect.any(String) }]) });
  });
  it("sends a normal unfinished implementation back because its behavior fails", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.root, "index.cjs"), "exports.base=x=>x; exports.normalize=xs=>xs;\n");
    const result = await submitGoalReport(f.root, request);
    expect(result.accepted).toBe(false); expect(result.unproved.join(" ")).toContain("Behavior test failed");
    const calls = f.reviews();
    expect(await submitGoalReport(f.root, { ...request, changes: [{ file: "index.cjs", serves: "sc_1" }] })).toMatchObject({ accepted: false, outcome: "disputed" });
    expect(f.reviews()).toBe(calls);
  });
  it("reuses valid checks after a commit and a changed report, with the work unchanged", async () => {
    const f = await fixture(); const codex = process.env.GOAL_GUARDIAN_CODEX_GOALS;
    process.env.GOAL_GUARDIAN_CODEX_GOALS = "";
    expect(await submitGoalReport(f.root, request)).toMatchObject({ outcome: "unverified" });
    const state = verificationState(f.root); f.git("add", "index.cjs", "test.cjs"); f.git("commit", "-qm", "completed work");
    expect(verificationState(f.root)).toBe(state);
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex; await recordUserPrompt(f.root, goal.goal, "c", "agent");
    expect(await submitGoalReport(f.root, { ...request, proofs: [{ criterion: "sc_1", command: "node test.cjs", quote: "copied summary" }], changes: [{ file: "index.cjs", serves: "extra" }] })).toMatchObject({ accepted: true, outcome: "proved" });
    expect(f.reviews()).toBe(1); expect(f.evaluations()).toBe(1);
  });
  it("invalidates checks when the work changes, including generated public entries", async () => {
    const f = await fixture(); const codex = process.env.GOAL_GUARDIAN_CODEX_GOALS;
    await fs.mkdir(path.join(f.root, "dist")); await fs.writeFile(path.join(f.root, ".gitignore"), "dist/\n");
    await fs.writeFile(path.join(f.root, "dist/index.cjs"), correct);
    process.env.GOAL_GUARDIAN_CODEX_GOALS = ""; await submitGoalReport(f.root, request);
    const state = verificationState(f.root); await fs.writeFile(path.join(f.root, "dist/index.cjs"), "broken output\n");
    expect(verificationState(f.root)).not.toBe(state);
    await fs.writeFile(path.join(f.root, "index.cjs"), "exports.base=x=>x; exports.normalize=xs=>xs;\n");
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex; await recordUserPrompt(f.root, goal.goal, "c", "agent");
    expect((await submitGoalReport(f.root, request)).accepted).toBe(false); expect(f.reviews()).toBeGreaterThan(1);
  });
  it("uses an improved reviewer template while retaining the unchanged evaluator result", async () => {
    const f = await fixture(); const codex = process.env.GOAL_GUARDIAN_CODEX_GOALS;
    process.env.GOAL_GUARDIAN_CODEX_GOALS = ""; await submitGoalReport(f.root, request);
    await writeHarness(f.root, "reviewer", "Goal: {goal}\nItems: {items}\nCheck the requested behavior carefully.");
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex; await recordUserPrompt(f.root, goal.goal, "c", "agent");
    expect(await submitGoalReport(f.root, request)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(f.reviews()).toBe(2); expect(f.evaluations()).toBe(1);
  });
  it("checks again when the user corrects a review instead of treating the old result as permanently valid", async () => {
    const f = await fixture(); const codex = process.env.GOAL_GUARDIAN_CODEX_GOALS;
    process.env.GOAL_GUARDIAN_CODEX_GOALS = ""; await submitGoalReport(f.root, request);
    const review = (await readAuditTail(f.root)).find((r) => r.kind === "goal.review");
    if (!review || review.kind !== "goal.review" || !review.id) throw new Error("missing review");
    await appendAudit(f.root, { ts: nowIso(), kind: "review.feedback", reviewId: review.id, index: 0, label: "missed" });
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex; await recordUserPrompt(f.root, goal.goal, "c", "agent");
    expect(await submitGoalReport(f.root, request)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(f.reviews()).toBe(2); expect(f.evaluations()).toBe(2);
  });

  it("reviews the full saved goal under the latest turn's continuation request", async () => {
    const f = await fixture();
    const old = "Add normalized tags.\n- Normalize tags\n- Check the public API\n\nDo only item 1 for now, then stop.";
    const currentRequest = "Carry on with the original goal and finish all remaining work.";
    const contract = { ...defaultContract(), goal: old, successCriteria: [{ id: "sc_1", text: "Normalize tags" }, { id: "sc_2", text: "Check the public API" }] };
    await writeContract(f.root, contract);
    await recordUserPrompt(f.root, old, "c", "agent");
    await recordUserPrompt(f.root, currentRequest, "c", "agent");
    const reviewer = path.join(path.dirname(f.root), "scope-reviewer.cjs");
    await fs.writeFile(reviewer, `#!/usr/bin/env node
const cp=require('child_process'),a=process.argv.slice(2),p=a[a.indexOf('-p')+1]||'',w=a[a.indexOf('--workspace')+1];
const actual=cp.spawnSync(process.execPath,['test.cjs'],{cwd:w,encoding:'utf8'});
const current=p.includes(${JSON.stringify('Latest user request for this turn:\n' + currentRequest)});
console.log(JSON.stringify({items:[{id:'sc_1',verdict:actual.status===0?'holds':'fails',evidence:actual.stdout+actual.stderr},{id:'sc_2',verdict:current?'holds':'unclear',evidence:current?'Required the actual public module and ran its behavior tests':'Only the original first-part scope was supplied'}],extra:[],checks:[{id:'build',verdict:'not_applicable',evidence:'plain CommonJS module'},{id:'public_api',verdict:'holds',evidence:'required index.cjs in behavior tests'},{id:'behavior',verdict:'holds',evidence:'actual behavior tests passed'}]}));
`);
    await fs.chmod(reviewer, 0o755); process.env.GOAL_GUARDIAN_REVIEWER = reviewer;
    expect(await submitGoalReport(f.root, request)).toMatchObject({ accepted: true, outcome: "proved" });
    const events = await readAuditTail(f.root);
    expect(events.some(e => e.kind === "goal.recovery")).toBe(false);
    expect(JSON.parse(await fs.readFile(f.evaluationInput, "utf8")).user_query).toContain(`Latest user request for this turn:\n${currentRequest}`);
    expect(await loadCases(f.root)).toMatchObject([{ currentRequest }]);
  });

  it("does not reuse a completion verdict under a different human turn's scope", async () => {
    const f = await fixture(), codex = process.env.GOAL_GUARDIAN_CODEX_GOALS;
    process.env.GOAL_GUARDIAN_CODEX_GOALS = ""; await submitGoalReport(f.root, request);
    const state = verificationState(f.root);
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex;
    await recordUserPrompt(f.root, "Carry on with all remaining work on the original goal.", "c", "agent");
    expect(await submitGoalReport(f.root, request)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(verificationState(f.root)).toBe(state);
    expect(f.reviews()).toBe(2); expect(f.evaluations()).toBe(2);
  });

  async function earlierCleanReviews(f: Awaited<ReturnType<typeof fixture>>, count: number) {
    const codex = process.env.GOAL_GUARDIAN_CODEX_GOALS;
    process.env.GOAL_GUARDIAN_CODEX_GOALS = "";
    expect(await submitGoalReport(f.root, request)).toMatchObject({ outcome: "unverified" });
    const review = (await readAuditTail(f.root)).find(r => r.kind === "goal.review");
    if (!review || review.kind !== "goal.review") throw new Error("missing earlier review");
    // Earlier checks can miss a defect. Seed their clean results in the current run so that
    // the regression exercises the budget fallback rather than ordinary first-review behavior.
    for (let i = 0; i < count; i++) await appendAudit(f.root, { ...review, ts: nowIso(), id: `earlier-${i}` });
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex;
  }

  async function lateFailingProbe(count: number) {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "index.cjs"), "exports.normalize=xs=>xs.map(x=>x.trim().toLowerCase());\n");
    await fs.writeFile(path.join(f.root, "test.cjs"), `const a=require('node:assert/strict'),m=require('./index.cjs');const more=process.argv[2]==='more';a.deepEqual(m.normalize(more?[' A ','a']:[' A ',' B ']),more?['a']:['a','b']);console.log('behavior passed');\n`);
    const adapter = JSON.parse(process.env.GOAL_GUARDIAN_EVALUATOR!);
    const evaluator = path.join(path.dirname(f.root), "evidence-evaluator.cjs");
    await fs.writeFile(evaluator, `#!/usr/bin/env node
const fs=require('fs'),job=JSON.parse(fs.readFileSync(0,'utf8')),failed=JSON.stringify(job).includes('ERR_ASSERTION');
console.log(JSON.stringify({ran:true,overall:failed?0:1,rubrics:[{id:'sc_1',property:'deduplicate tags',score:failed?0:1,rationale:failed?'The new duplicate-input test failed':'Earlier examples passed'},{id:'extra',property:'scope',score:1,rationale:'requested work only'}],calls:0,seconds:0}));
`);
    await fs.chmod(evaluator, 0o755);
    process.env.GOAL_GUARDIAN_EVALUATOR = JSON.stringify({ ...adapter, python: evaluator });
    await earlierCleanReviews(f, count);
    const before = verificationState(f.root);
    const ran = spawnSync(process.execPath, ["test.cjs", "more"], { cwd: f.root, encoding: "utf8" });
    expect(ran.status).toBe(1);
    await recordShellOutput(f.root, { command: "node test.cjs more", output: ran.stdout + ran.stderr });
    await recordShellFailure(f.root, "node test.cjs more");
    expect(verificationState(f.root)).toBe(before);
    return f;
  }

  it("checks new failing evidence after the usual review allowance instead of using an older pass", async () => {
    const f = await lateFailingProbe(2);
    const before = (await readAuditTail(f.root)).filter(r => r.kind === "goal.review").length;
    const result = await submitGoalReport(f.root, request);
    expect(result.accepted).toBe(false);
    expect(result.unproved.join(" ")).toContain("duplicate-input test failed");
    expect((await readAuditTail(f.root)).filter(r => r.kind === "goal.review").length).toBe(before + 1);
  });

  it("cannot mark new failed evidence proved when the hard review limit is exhausted", async () => {
    const f = await lateFailingProbe(4);
    expect(await submitGoalReport(f.root, request)).toMatchObject({ outcome: "unchecked" });
    const end = (await readAuditTail(f.root)).filter(r => r.kind === "goal.end").at(-1);
    expect(end).toMatchObject({ skipped: expect.arrayContaining([expect.stringContaining("review budget is exhausted")]) });
  });

  it("still reuses valid checks when the review allowance is exhausted but nothing relevant changed", async () => {
    const f = await fixture();
    await earlierCleanReviews(f, 4);
    const calls = f.reviews(), evaluations = f.evaluations();
    expect(await submitGoalReport(f.root, request)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(f.reviews()).toBe(calls);
    expect(f.evaluations()).toBe(evaluations);
  });

  it.each(["template", "feedback", "policy"])("requires a current verdict after a %s change", async (change) => {
    const f = await fixture();
    await earlierCleanReviews(f, 4);
    if (change === "template") await writeHarness(f.root, "reviewer", "Goal: {goal}\nItems: {items}\nCheck behavior with the new instructions.");
    else if (change === "feedback") {
      for (let i = 0; i < 4; i++) await appendAudit(f.root, { ts: nowIso(), kind: "review.feedback", reviewId: `earlier-${i}`, index: 0, label: "missed" });
    } else {
      const p = getGuardianPaths(f.root);
      // A previous version's clean verdict must not satisfy the current verification policy.
      const records = await readAuditTail(f.root);
      const audit = path.join(p.telemetryDir, "audit.jsonl");
      await fs.writeFile(audit, records.map(r => JSON.stringify(r.kind === "goal.review" ? { ...r, policy: "previous-policy" } : r)).join("\n") + "\n");
    }
    const calls = f.reviews();
    if (change === "template") {
      expect(await submitGoalReport(f.root, request)).toMatchObject({ outcome: "unchecked" });
      expect(f.reviews()).toBe(calls);
    } else {
      // Explicit correction or a new verification policy starts a fresh review allowance.
      expect(await submitGoalReport(f.root, request)).toMatchObject({ outcome: "proved" });
      expect(f.reviews()).toBe(calls + 1);
    }
  });

});
