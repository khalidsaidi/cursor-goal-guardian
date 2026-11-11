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
  appendAudit, defaultContract, getGuardianPaths, goalPhaseOf, nowIso, readAuditTail, readContractSafe, readShellOutputs, recordShellOutput, recordUserPrompt,
  reviewEvidence, runGoalStop, runGoalTool, submitGoalReport, engineGoal,
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
  it("a goal is proved in the report both accept, and only there: both checks clean, Codex's handler and DeepSeek's tool each saying yes", async () => {
    const root = await repo();
    await work(root);
    const answer = await submitGoalReport(root, report);
    expect(answer).toMatchObject({ accepted: true, outcome: "proved" });
    // What the agent is told to do next is DeepSeek's own wrap-up, from its tool; Codex's answer is beside it.
    expect(answer.message).toContain("<goal_complete>");
    expect(answer.codex).toMatchObject({ goal: { status: "complete" } });
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "proved", proved: [{ criterion: "sc_1" }] }]);
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
  it("no reviewer: both goal keepers accept, and the goal is complete but unchecked, with why, and the agent is told to say so", async () => {
    const root = await repo();
    await work(root);
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
    const answer = await submitGoalReport(root, report);
    expect(answer).toMatchObject({ accepted: true, outcome: "unchecked" });
    expect(answer.message).toContain("recorded as complete but unchecked, not proved, because the reviewer didn't run: cursor-agent isn't installed");
    expect(answer.message).toContain("this work was not independently checked");
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "unchecked", skipped: ["the reviewer didn't run: cursor-agent isn't installed"] }]);
    expect(await phase(root)).toBe("complete");
  });

  it("no evaluator: the same, naming the evaluator", async () => {
    const root = await repo();
    await work(root);
    process.env.GOAL_GUARDIAN_EVALUATOR = JSON.stringify({ python: "/nonexistent/python", cli: __filename, adkDir: os.tmpdir(), site: os.tmpdir() });
    expect(await submitGoalReport(root, report)).toMatchObject({ accepted: true, outcome: "unchecked" });
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
    const said = steps.filter((s) => s.role === "tool").map((s) => s.content);
    // The project as it is: the changed file and its diff.
    expect(said[0]).toContain("M a.js");
    expect(said[1]).toContain("-one\n+two");
    expect(said[2]).toContain("On Guardian's record: ran 1 time(s)");
    expect(said[2]).toContain("The quoted line is in that output.");
    // The command ran, by the record, but the file it names is not in the project: the judge is shown that.
    expect(said[3]).toContain("Named in the command and ABSENT from the project: test.js");
    expect(said[4]).toContain("ABSENT: Guardian's record of this session has no run of this command.");
    expect(said[5]).toBe("ABSENT: this file is not in the project.");
    expect(said[6]).toContain("The quoted text is in it.");
    expect(steps.filter((s) => s.role === "assistant").every((s) => s.tool_calls?.startsWith("guardian_"))).toBe(true);
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
    expect((await submitGoalReport(root, report)).accepted).toBe(true);
    const job = JSON.parse(fs.readFileSync(seen, "utf8")) as { conversation: Array<{ role: string; content: string; tool_calls: string | null }> };
    const calls = job.conversation.filter((m) => m.role === "assistant").map((m) => m.tool_calls ?? "");
    expect(calls.findIndex((c) => c.startsWith("guardian_project_state"))).toBeGreaterThan(calls.findIndex((c) => c.startsWith("run_terminal_command")));
    expect(calls.some((c) => c.startsWith('guardian_check_proof(item="sc_1", cited_command="make test"'))).toBe(true);
    expect(job.conversation.some((m) => m.role === "tool" && m.content.includes("-one\n+two"))).toBe(true);
  });
});
