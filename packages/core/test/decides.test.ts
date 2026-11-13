/**
 * What an independent audit found wrong at a6b3289, as tests: the goal keepers' own code decides, a goal keeper or
 * a check that didn't run is never passed over, and the second check sees the finished project.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, defaultContract, getGuardianPaths, goalHash, goalPhaseOf, nowIso, readAuditTail, readContractSafe, readShellOutputs, recordShellOutput, recordUserPrompt,
  resumeMissedGoal, reviewEvidence, runGoalStop, runGoalTool, submitGoalReport, engineGoal,
} from "../src/index.js";
import { STANDIN_EVALUATOR } from "./helpers/setup.js";

const made: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnv };
  for (const d of made.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});
const tick = () => new Promise((r) => setTimeout(r, 3));
async function tmp(prefix: string): Promise<string> {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

/** A git project with a goal, as Guardian's files hold it. */
async function repo(): Promise<string> {
  const root = await tmp("gg-decides-");
  const p = getGuardianPaths(root);
  await fsp.mkdir(p.telemetryDir, { recursive: true });
  await fsp.writeFile(p.config, "{}");
  await fsp.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "the export test passes" }] }));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  sh("init", "-q");
  await fsp.writeFile(path.join(root, "a.js"), "one\n");
  sh("add", "a.js");
  sh("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  return root;
}
/** Goal work in chat c1 that Guardian's record backs. `spoke` false leaves out the user's message Cursor's hook reports. */
async function work(root: string, spoke = true): Promise<void> {
  if (spoke) await recordUserPrompt(root, "add the export", "c1", "agent");
  await tick();
  await fsp.writeFile(path.join(root, "a.js"), "two\n");
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
  await tick();
  await recordShellOutput(root, { command: "make test", output: "12 passed", durationMs: 0 });
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: "make test", conversationId: "c1" });
}
const report = { status: "complete" as const, proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }], changes: [{ file: "a.js", serves: "sc_1" }] };
const stop = (root: string, n = 0) => runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: n });
const kinds = async (root: string, kind: string) => (await readAuditTail(root, 2000)).filter((r) => r.kind === kind) as Array<Record<string, unknown>>;
const phase = async (root: string) => goalPhaseOf(await readAuditTail(root, 2000), await readContractSafe(root));

describe("the goal keepers' own code decides", () => {
  it("the user's missed-work correction reopens the same goal without restarting it for unrelated or repeated feedback", async () => {
    const root = await repo();
    await work(root);
    await submitGoalReport(root, report);
    const original = await readContractSafe(root);
    const id = String((await kinds(root, "goal.review"))[0]!.id);
    expect(await resumeMissedGoal(root, "some-older-review")).toBe(false);
    expect(await phase(root)).toBe("complete");
    expect(await resumeMissedGoal(root, id)).toBe(true);
    expect(await phase(root)).toBe("active");
    expect(await readContractSafe(root)).toEqual(original);
    expect(await kinds(root, "goal.control")).toMatchObject([{ operation: "resume", actor: "user" }]);
    expect(await resumeMissedGoal(root, id)).toBe(false);
  });

  it("overlapping completion reports run the independent checks only once", async () => {
    const root = await repo();
    await work(root);
    const [first, overlap] = await Promise.all([submitGoalReport(root, report), submitGoalReport(root, report)]);
    expect(first).toMatchObject({ accepted: true, outcome: "proved" });
    expect(overlap).toMatchObject({ accepted: false, verificationPending: true });
    expect(overlap.message).toContain("already running");
    expect(await kinds(root, "goal.report")).toHaveLength(1);
    expect(await kinds(root, "goal.review")).toHaveLength(1);
    expect(await kinds(root, "goal.end")).toHaveLength(1);
    expect(fs.existsSync(path.join(getGuardianPaths(root).telemetryDir, "completion.lock"))).toBe(false);
  });

  it("honors a report lock owned by another process and recovers it after that process exits", async () => {
    const root = await repo();
    await work(root);
    const lock = path.join(getGuardianPaths(root).telemetryDir, "completion.lock");
    // A short-lived independent process supplies a genuinely departed owner PID.
    const deadPid = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
    fs.writeFileSync(lock, String(process.ppid));
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, verificationPending: true });
    expect(await kinds(root, "goal.review")).toHaveLength(0);
    fs.writeFileSync(lock, String(deadPid));
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(await kinds(root, "goal.review")).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("a goal is proved in the report both accept, and only there: both checks clean, Codex's handler and DeepSeek's tool each saying yes", async () => {
    const root = await repo();
    await work(root);
    const answer = await submitGoalReport(root, report);
    expect(answer).toMatchObject({ accepted: true, outcome: "proved" });
    // What the agent is told to do next is DeepSeek's own wrap-up, from its tool; Codex's answer is beside it.
    expect(answer.message).toContain("<goal_complete>");
    expect(answer.message).toContain("Independent verification completed: Reviewer: ran; evaluator: ran");
    expect(answer.codex).toMatchObject({ goal: { status: "complete" } });
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "proved", proved: expect.arrayContaining([{ criterion: "goal", command: "make test", recordedAt: expect.any(String) }]) }]);
    expect((await engineGoal(root))?.phase).toBe("complete");
    expect(await stop(root)).toBeNull();
    expect(await kinds(root, "goal.end")).toHaveLength(1);
  });

  it("a goal keeper whose code didn't run is never passed over: nothing is proved, and the run ends unverified, naming it", async () => {
    const root = await repo();
    await work(root);
    process.env.GOAL_GUARDIAN_CODEX_GOALS = "";
    const answer = await submitGoalReport(root, report);
    expect(answer).toMatchObject({ accepted: false, outcome: "unverified", refusedBy: "codex" });
    expect(answer.message).toContain("Codex's goal program isn't installed");
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "unverified", by: "codex", reason: "Codex's goal program isn't installed" }]);
    expect(await kinds(root, "goal.refused")).toMatchObject([{ change: "complete", by: "codex" }]);
    // DeepSeek's tool was never asked to complete anything, and the goal stays open.
    expect((await engineGoal(root))?.phase).toBe("active");
    expect(await phase(root)).toBe("active");
    expect(await stop(root)).toBeNull();
  });

  it("a Codex that can't run during a round is said in the send-back and on the record", async () => {
    const root = await repo();
    await work(root);
    process.env.GOAL_GUARDIAN_CODEX_GOALS = "";
    const round = (await stop(root))!;
    expect(round).toContain("- Codex's goal code didn't run (Codex's goal extension isn't installed). Until it does, this goal can't be recorded as proved.");
    expect(await kinds(root, "goal.partners")).toMatchObject([{ codex: { ran: false } }]);
  });

  it("no turn is made up for their tools: with no message from the user on their log, their own refusal comes back", async () => {
    const root = await repo();
    const refused = await runGoalTool(root, "get_goal", {});
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain("goal tools require an open model turn");
    await recordUserPrompt(root, "add the export", "c1", "agent");
    expect((await runGoalTool(root, "get_goal", {})).isError).toBe(false);
  });

  it("no round is armed without a message from the user on their log: their driver starts nothing, and that is on the record", async () => {
    const root = await repo();
    await work(root, false);
    expect(await stop(root)).toBeNull();
    expect(await kinds(root, "goal.round")).toEqual([]);
    expect(await kinds(root, "goal.refused")).toMatchObject([{ change: "continue", by: "deepseek", message: expect.stringContaining("no message from the user is on their log") }]);
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "stopped", by: "deepseek" }]);
    // With the user's message there, the same stop is a round.
    const other = await repo();
    await work(other);
    expect(await stop(other)).toContain("<goal_round>");
  });

  it("Guardian's stall rule is named as Guardian's on the record", async () => {
    const root = await repo();
    await recordUserPrompt(root, "add the export", "c1", "agent");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    await fsp.writeFile(path.join(root, "a.js"), "two\n");
    for (let n = 0; n < 3; n += 1) expect(await stop(root, n)).not.toBeNull();
    expect(await stop(root, 3)).toBeNull();
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "stalled", by: "guardian" }]);
  });
});

describe("a check that didn't run is never 'proved'", () => {
  it("can verify later repairs on the same goal after an unchecked close, without rerunning unchanged work", async () => {
    const root = await repo();
    await work(root);
    const reviewer = process.env.GOAL_GUARDIAN_REVIEWER;
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
    await submitGoalReport(root, report);
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "unchecked" });
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, message: expect.stringContaining("already closed") });
    const original = await readContractSafe(root);
    await fsp.writeFile(path.join(root, "a.js"), "repaired after unchecked close\n");
    if (reviewer === undefined) delete process.env.GOAL_GUARDIAN_REVIEWER;
    else process.env.GOAL_GUARDIAN_REVIEWER = reviewer;
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(await readContractSafe(root)).toEqual(original);
    expect(await phase(root)).toBe("complete");
    await fsp.writeFile(path.join(root, "a.js"), "changed after proved completion\n");
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, message: expect.stringContaining("already closed") });
  });

  it("an obsolete review's recovery does not consume the current policy's recovery attempt", async () => {
    const root = await repo();
    await work(root);
    await appendAudit(root, { ts: nowIso(), kind: "goal.recovery", goalHash: goalHash(await readContractSafe(root)), reportTs: nowIso(), reviewId: "obsolete-policy-review", skipped: ["old check timed out"] });
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, verificationPending: true });
    expect(await phase(root)).toBe("active");
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "unchecked" });
  });

  it("no reviewer: both goal keepers accept, and the goal is complete but unchecked, with why, and the agent is told to say so", async () => {
    const root = await repo();
    await work(root);
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, verificationPending: true });
    expect(await phase(root)).toBe("active");
    expect(await kinds(root, "goal.end")).toHaveLength(0);
    expect(await stop(root)).toContain("Do not hand those commands to the user");
    const answer = await submitGoalReport(root, report);
    expect(answer).toMatchObject({ accepted: true, outcome: "unchecked" });
    expect(answer.message).toMatch(/^Verification incomplete: this work is unchecked\./);
    expect(answer.message).toContain("recorded as complete but unchecked, not proved, because the reviewer didn't run: cursor-agent isn't installed");
    expect(answer.message).toContain("full independent verification is incomplete");
    expect(answer.message).toContain("Reviewer: did not run; evaluator: ran");
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "unchecked", skipped: ["the reviewer didn't run: cursor-agent isn't installed"] }]);
    expect(await phase(root)).toBe("complete");
  });

  it("no evaluator: the same, naming the evaluator", async () => {
    const root = await repo();
    await work(root);
    process.env.GOAL_GUARDIAN_EVALUATOR = JSON.stringify({ python: "/nonexistent/python", cli: __filename, adkDir: os.tmpdir(), site: os.tmpdir() });
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, verificationPending: true });
    const answer = await submitGoalReport(root, report);
    expect(answer).toMatchObject({ accepted: true, outcome: "unchecked", message: expect.stringMatching(/^Verification incomplete: this work is unchecked\./) });
    expect(answer.message).toContain("Reviewer: ran; evaluator: did not run");
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "unchecked", skipped: [expect.stringContaining("the evaluator didn't run")] }]);
  });
});

describe("the second check sees the finished project", () => {
  it("the evidence lists the project's real changes and marks a cited command or file that isn't there as ABSENT", async () => {
    const root = await repo();
    await work(root);
    await recordShellOutput(root, { command: "node test.js", output: "all good", durationMs: 0 });
    const steps = reviewEvidence(
      root,
      [
        { criterion: "sc_1", command: "make test", quote: "12 passed" },
        { criterion: "sc_1", command: "node test.js", quote: "all good" },
        { criterion: "sc_1", command: "npm run never", quote: "ok" },
        { criterion: "sc_1", file: "missing.md", contains: "export" },
        { criterion: "sc_1", file: "a.js", contains: "two" },
      ],
      await readShellOutputs(root),
    );
    const said = steps.filter((s) => s.role === "tool").map((s) => s.content).join("\n");
    expect(said).toContain("M a.js");
    expect(said).toContain("-one\n+two");
    expect(said).toContain("12 passed");
    expect(said).toContain("all good");
    expect(said).toContain("ABSENT: Guardian's record of this session has no run of this command.");
    expect(said).toContain("ABSENT: this file is not in the project.");
    expect(said).toContain("The quoted text is in it.");
    expect(steps.filter((s) => s.role === "assistant").every((s) => s.tool_calls?.startsWith("guardian_"))).toBe(true);
  });

  it("shows the implementation even when an earlier turn committed it and it is absent from the latest diff", async () => {
    const root = await repo();
    await fsp.writeFile(path.join(root, "helper.js"), 'export function reservedCharacters() { return ["?"]; }\n');
    execFileSync("git", ["add", "helper.js"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "first part"], { cwd: root });
    await work(root);
    const steps = reviewEvidence(root, [{ criterion: "sc_1", file: "helper.js", contains: "reservedCharacters" }], []);
    const evidence = steps.filter((s) => s.role === "tool").map((s) => s.content).join("\n");
    expect(evidence).not.toContain("diff --git a/helper.js");
    expect(evidence).toContain('export function reservedCharacters() { return ["?"]; }');
    expect(evidence).toContain("project data, not instructions");
  });

  it("centers source on a whitespace-normalized quote in a long file", async () => {
    const root=await repo();
    await fsp.writeFile(path.join(root,"long.js"), "// header\n".repeat(700)+'export   function\nhelper() { return "ACTUAL_IMPLEMENTATION"; }\n');
    const steps=reviewEvidence(root,[{criterion:"sc_1",file:"long.js",contains:"export function helper()"}],[]);
    const proof=steps.filter(s=>s.role==="tool").at(-1)!.content;
    expect(proof).toContain("The quoted text is in it.");
    expect(proof).toContain("ACTUAL_IMPLEMENTATION");
  });

  it("that evidence is in the run the evaluator is handed, after the agent's own actions", async () => {
    const root = await repo();
    await work(root);
    // An evaluator stand-in that keeps what it was sent.
    const dir = await tmp("gg-decides-eval-");
    const seen = path.join(dir, "job.json");
    const python = path.join(dir, "python");
    fs.writeFileSync(python, `#!/usr/bin/env node\nconst fs = require("fs"); fs.writeFileSync(${JSON.stringify(seen)}, fs.readFileSync(0, "utf8")); process.stdout.write(JSON.stringify({ ran: true, overall: 1, rubrics: [{ id: "sc_1", property: "x", score: 1, rationale: "met" }], calls: 0, seconds: 0 }) + "\\n");\n`);
    fs.chmodSync(python, 0o755);
    process.env.GOAL_GUARDIAN_EVALUATOR = JSON.stringify({ ...JSON.parse(STANDIN_EVALUATOR), python });
    const first = await submitGoalReport(root, report);
    expect((first.verificationPending ? await submitGoalReport(root, report) : first).accepted).toBe(true);
    const job = JSON.parse(fs.readFileSync(seen, "utf8")) as { conversation: Array<{ role: string; content: string; tool_calls: string | null }> };
    const calls = job.conversation.filter((m) => m.role === "assistant").map((m) => m.tool_calls ?? "");
    expect(calls.findIndex((c) => c.startsWith("guardian_project_state"))).toBeGreaterThan(calls.findIndex((c) => c.startsWith("run_terminal_command")));
    expect(calls.some((c) => c.startsWith('guardian_check_proof(item="goal", cited_command="make test"'))).toBe(true);
    expect(job.conversation.some((m) => m.role === "tool" && m.content.includes("-one\n+two"))).toBe(true);
  });
});


describe("finishing the work after a failed check", () => {
  async function counted(command: string, failFirst: boolean): Promise<{ file: string; calls: () => number }> {
    const dir = await tmp("gg-recovery-");
    const count = path.join(dir, "calls");
    const file = path.join(dir, "check.cjs");
    await fsp.writeFile(file, `#!/usr/bin/env node
const fs=require("fs"), cp=require("child_process");
const count=${JSON.stringify(count)};const n=fs.existsSync(count)?Number(fs.readFileSync(count,"utf8")):0;fs.writeFileSync(count,String(n+1));
if (${failFirst} && n===0) process.exit(72);
const input=fs.readFileSync(0,"utf8");const r=cp.spawnSync(${JSON.stringify(command)},process.argv.slice(2),{input,encoding:"utf8",env:process.env});process.stdout.write(r.stdout||"");process.exit(r.status??1);
`);
    await fsp.chmod(file, 0o755);
    return { file, calls: () => Number(fs.readFileSync(count, "utf8")) };
  }

  it("recovers a crashed reviewer in the same run, preserving the successful evaluator", async () => {
    const root = await repo(); await work(root);
    const reviewer = await counted(process.env.GOAL_GUARDIAN_REVIEWER!, true);
    const original = JSON.parse(STANDIN_EVALUATOR);
    const evaluator = await counted(original.python, false);
    process.env.GOAL_GUARDIAN_REVIEWER = reviewer.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = JSON.stringify({ ...original, python: evaluator.file });
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, verificationPending: true });
    expect(await phase(root)).toBe("active");
    expect(await kinds(root, "goal.end")).toHaveLength(0);
    expect(await stop(root)).toContain("retry unfinished independent checks once");
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(reviewer.calls()).toBe(2); expect(evaluator.calls()).toBe(1);
    expect(await stop(root, 1)).toBeNull();
  });

  it("rechecks the project when recovery work changes code", async () => {
    const root = await repo(); await work(root);
    const reviewer = await counted(process.env.GOAL_GUARDIAN_REVIEWER!, false);
    const original = JSON.parse(STANDIN_EVALUATOR);
    const evaluator = await counted(original.python, true);
    process.env.GOAL_GUARDIAN_REVIEWER = reviewer.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = JSON.stringify({ ...original, python: evaluator.file });
    expect(await submitGoalReport(root, report)).toMatchObject({ verificationPending: true });
    await fsp.writeFile(path.join(root, "a.js"), "fixed during recovery\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    await tick(); await recordShellOutput(root, { command: "make test", output: "12 passed", durationMs: 0 });
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(reviewer.calls()).toBe(2); expect(evaluator.calls()).toBe(2);
  });

  it("does not reroll an actual objection after a failed-check recovery", async () => {
    const root = await repo(); await work(root);
    const dir = await tmp("gg-negative-"); const negative = path.join(dir, "reviewer");
    await fsp.writeFile(negative, `#!/usr/bin/env node
console.log(JSON.stringify({items:[{id:"sc_1",verdict:"fails",evidence:"actual export behavior is broken"}],extra:[],checks:[{id:"build",verdict:"holds",evidence:"built"},{id:"public_api",verdict:"holds",evidence:"imported"},{id:"behavior",verdict:"fails",evidence:"actual export behavior is broken"}]}));
`);
    await fsp.chmod(negative, 0o755);
    const reviewer = await counted(negative, true); process.env.GOAL_GUARDIAN_REVIEWER = reviewer.file;
    expect(await submitGoalReport(root, report)).toMatchObject({ verificationPending: true });
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false });
    const calls = reviewer.calls();
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, outcome: "disputed" });
    expect(reviewer.calls()).toBe(calls);
  });

  it("can retry a cached unfinished check after the user returns to an interrupted run", async () => {
    const root = await repo(); await work(root);
    const reviewer = await counted(process.env.GOAL_GUARDIAN_REVIEWER!, true); process.env.GOAL_GUARDIAN_REVIEWER = reviewer.file;
    expect(await submitGoalReport(root, report)).toMatchObject({ verificationPending: true });
    await runGoalStop(root, { conversationId: "c1", status: "cancelled", loopCount: 0 });
    await recordUserPrompt(root, "continue the original goal", "c1", "agent");
    // The new human scope needs a current check immediately, not another cached-pending handoff.
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(reviewer.calls()).toBe(2);
  });

  it("recovers a crashed evaluator without repeating a successful project review", async () => {
    const root = await repo(); await work(root);
    const reviewer = await counted(process.env.GOAL_GUARDIAN_REVIEWER!, false);
    const original = JSON.parse(STANDIN_EVALUATOR);
    const evaluator = await counted(original.python, true);
    process.env.GOAL_GUARDIAN_REVIEWER = reviewer.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = JSON.stringify({ ...original, python: evaluator.file });
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: false, verificationPending: true });
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "proved" });
    expect(reviewer.calls()).toBe(1); expect(evaluator.calls()).toBe(2);
  });
});
