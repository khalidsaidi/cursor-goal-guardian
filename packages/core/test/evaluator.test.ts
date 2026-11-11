import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAudit, defaultContract, evaluatorLines, getGuardianPaths, nowIso, parseEvaluator, readAuditTail, readTrajectory, recordFileEdit, recordShellFailure, recordShellOutput, recordUserPrompt,
  resolveEvaluator, runEvaluator, runGoalStop, submitGoalReport,
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ADAPTER = path.join(repoRoot, "packages", "evaluator");
const SITE = path.join(ADAPTER, ".site");
const REAL = JSON.stringify({ python: "python3", cli: path.join(ADAPTER, "cgg_evaluator", "cli.py"), adkDir: path.join(repoRoot, "third_party", "adk-python", "src"), site: SITE });
/** ADK's dependencies are installed by `pip install --target packages/evaluator/.site -r packages/evaluator/requirements.txt`. */
const haveAdkDeps = fsSync.existsSync(path.join(SITE, "pydantic"));

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
  const file = path.join(await tmp("gg-eval-bin-"), "bin");
  await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await fs.chmod(file, 0o755);
  return file;
}

/** Stands in for the whole adapter: prints one result line, whatever it is asked. */
const adapterSaying = async (result: unknown): Promise<string> => {
  const bin = await script(`process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(result))} + "\\n"));`);
  return JSON.stringify({ python: bin, cli: bin, adkDir: path.dirname(bin), site: path.dirname(bin) });
};

/**
 * Stands in for cursor-agent. ADK's judge asks in ask mode and gets a verdict per rubric in ADK's own answer format;
 * the reviewer gets a clean item review. Every judge prompt is logged.
 */
async function agent(verdicts: Record<string, "yes" | "no">): Promise<{ file: string; log: string }> {
  const dir = await tmp("gg-eval-agent-");
  const log = path.join(dir, "prompts.jsonl");
  const answer = Object.entries(verdicts).map(([id, v]) => `ID: ${id}\nProperty: p\nRationale: judged ${v} for ${id}.\nVerdict: ${v}`).join("\n\n");
  const file = await script(`
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
let p = a[a.indexOf("-p") + 1];
if (a.includes("ask")) {
  if (p.startsWith("Read task.md")) p = fs.readFileSync(path.join(a[a.indexOf("--workspace") + 1], "task.md"), "utf8");
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(p) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", result: ${JSON.stringify(answer)} }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify({ items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [] }) }) + "\\n");
}`);
  return { file, log };
}

async function repo(): Promise<string> {
  const root = await tmp("gg-eval-ws-");
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.config, "{}");
  await fs.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "the export test passes" }] }));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  sh("init", "-q");
  await fs.writeFile(path.join(root, "a.js"), "one\n");
  sh("add", "a.js");
  sh("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  return root;
}

const steps = [
  { role: "assistant" as const, content: "", tool_calls: 'edit_file(path="a.js")' },
  { role: "tool" as const, content: "--- replaced\none\n+++ with\ntwo", tool_calls: null },
  { role: "assistant" as const, content: "", tool_calls: 'run_terminal_command(command="make test")' },
  { role: "tool" as const, content: "12 passed", tool_calls: null },
];
const job = { userQuery: "Add CSV export\nDone when:\n- the export test passes", items: [{ id: "sc_1", text: "the export test passes" }], conversation: steps, report: "I report the goal complete." };

describe("the run as Guardian saw it", () => {
  it("is every command with its output and every edit with its text, in order, from the start of the run", async () => {
    const root = await repo();
    await recordShellOutput(root, { command: "old command", output: "before the run", durationMs: 0 });
    await tick();
    const since = nowIso();
    await tick();
    await recordFileEdit(root, "a.js", [{ old_string: "one", new_string: "two" }]);
    await tick();
    await recordShellOutput(root, { command: "make test", output: "12 passed", durationMs: 0 });
    await tick();
    await recordShellFailure(root, "make lint");
    await recordFileEdit(root, ".cursor/goal-guardian/contract.json", [{ old_string: "x", new_string: "y" }]);
    expect(await readTrajectory(root, since)).toEqual([
      ...steps,
      { role: "assistant", content: "", tool_calls: 'run_terminal_command(command="make lint")' },
      { role: "tool", content: "The command failed.", tool_calls: null },
    ]);
    expect(await fs.readFile(path.join(getGuardianPaths(root).telemetryDir, ".gitignore"), "utf8")).toContain("edits.jsonl");
  });
});

describe("the evaluator's answer", () => {
  it("keeps the rubrics ADK judged not met, with the judge's own rationale, as one line each", () => {
    const out = parseEvaluator(JSON.stringify({ ran: true, overall: 0.333, rubrics: [
      { id: "sc_1", property: "the export test passes", score: 0, rationale: "the test asserts nothing" },
      { id: "sc_2", property: "the readme documents it", score: 1, rationale: "documented" },
      { id: "extra", property: "The agent changed nothing that the user's request does not need.", score: 0, rationale: "it renamed helpers" },
    ], calls: 5, seconds: 21.4 }))!;
    expect(out).toMatchObject({ ran: true, overall: 0.333, rubrics: 3, calls: 5, seconds: 21 });
    expect(evaluatorLines(out)).toEqual([
      "Evaluator: sc_1 isn't met (the export test passes): the test asserts nothing",
      "Evaluator: the run changed things the request doesn't need: it renamed helpers",
    ]);
  });

  it("nothing usable is nothing: no result line, or a run that judged no rubric", () => {
    expect(parseEvaluator("Traceback (most recent call last)")).toBeNull();
    expect(parseEvaluator(JSON.stringify({ ran: true, rubrics: [{ id: "sc_1", score: null }], calls: 5, seconds: 3 }))).toMatchObject({ ran: false, reason: "the evaluator judged no rubric" });
    expect(parseEvaluator(JSON.stringify({ ran: false, reason: "cursor-agent isn't installed", rubrics: [], calls: 0, seconds: 0 }))).toMatchObject({ ran: false, reason: "cursor-agent isn't installed" });
  });
});

describe("running the evaluator", () => {
  it("is skipped, never trusted and never thrown, when it isn't there, hangs, or has nothing to judge", async () => {
    delete process.env.GOAL_GUARDIAN_EVALUATOR;
    expect(resolveEvaluator()).toBeNull();
    expect(await runEvaluator(job, 5_000)).toMatchObject({ ran: false, reason: "the evaluator isn't installed" });
    process.env.GOAL_GUARDIAN_EVALUATOR = await adapterSaying({ ran: true, overall: 1, rubrics: [{ id: "sc_1", property: "p", score: 1, rationale: "ok" }], calls: 5, seconds: 2 });
    expect(await runEvaluator({ ...job, conversation: [] }, 5_000)).toMatchObject({ ran: false, reason: "Guardian recorded no actions for this run" });
    expect(await runEvaluator(job, 5_000)).toMatchObject({ ran: true, failed: [] });
    const hung = await script("setTimeout(() => {}, 60_000);");
    process.env.GOAL_GUARDIAN_EVALUATOR = JSON.stringify({ python: hung, cli: hung, adkDir: path.dirname(hung), site: path.dirname(hung) });
    expect(await runEvaluator(job, 300)).toMatchObject({ ran: false, reason: "the evaluator took longer than 0s" });
    process.env.GOAL_GUARDIAN_REVIEWING = "1";
    expect(await runEvaluator(job, 5_000)).toMatchObject({ ran: false, reason: "already inside a review" });
  });

  it.skipIf(!haveAdkDeps)("Google ADK's own evaluator judges the run: its prompt, the user's items as rubrics, five samples", async () => {
    const a = await agent({ sc_1: "yes", extra: "no" });
    process.env.GOAL_GUARDIAN_REVIEWER = a.file;
    process.env.GOAL_GUARDIAN_EVALUATOR = REAL;
    const out = await runEvaluator(job, 60_000);
    expect(out).toMatchObject({ ran: true, overall: 0.5, rubrics: 2, calls: 5 });
    expect(out.failed).toEqual([{ id: "extra", property: "The agent changed nothing that the user's request does not need.", rationale: "judged no for extra." }]);
    const prompts = (await fs.readFile(a.log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string);
    const adk = await fs.readFile(path.join(repoRoot, "third_party", "adk-python", "src", "google", "adk", "evaluation", "rubric_based_multi_turn_trajectory_evaluator.py"), "utf8");
    const mission = "Your mission is to evaluate the quality of responses generated by an AI agent in a multi-turn conversation.";
    expect(adk).toContain(mission);
    expect(prompts).toHaveLength(5);
    for (const p of prompts) {
      expect(p).toContain(mission);
      expect(p).toContain('"property": "the export test passes"');
      expect(p).toContain("make test");
      expect(p).toContain("Add CSV export");
    }
  }, 60_000);
});

describe("the evaluator in the goal loop", () => {
  async function doneWork(): Promise<string> {
    const root = await repo();
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

  it("a rubric ADK judges not met goes back to the agent as a round, in the judge's words, and is on the record", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = (await agent({})).file;
    process.env.GOAL_GUARDIAN_EVALUATOR = await adapterSaying({ ran: true, overall: 0.5, rubrics: [
      { id: "sc_1", property: "the export test passes", score: 1, rationale: "passes" },
      { id: "extra", property: "The agent changed nothing that the user's request does not need.", score: 0, rationale: "it renamed helpers nobody asked about" },
    ], calls: 5, seconds: 20 });
    const answer = await submitGoalReport(root, report);
    expect(answer.accepted).toBe(false);
    expect(answer.unproved).toEqual(["Evaluator: the run changed things the request doesn't need: it renamed helpers nobody asked about"]);
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toContain("- Evaluator: the run changed things the request doesn't need");
    expect(await reviews(root)).toMatchObject([{ ran: true, fails: [], extra: [], evaluator: { ran: true, overall: 0.5, rubrics: 2, failed: [{ id: "extra" }] } }]);
  }, 60_000);

  it("every rubric met and a clean review let the record's proof stand; the judgement is still on the record", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_REVIEWER = (await agent({})).file;
    process.env.GOAL_GUARDIAN_EVALUATOR = await adapterSaying({ ran: true, overall: 1, rubrics: [{ id: "sc_1", property: "the export test passes", score: 1, rationale: "passes" }], calls: 5, seconds: 20 });
    expect((await submitGoalReport(root, report)).accepted).toBe(true);
    expect(await reviews(root)).toMatchObject([{ ran: true, evaluator: { ran: true, overall: 1, failed: [] } }]);
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toBeNull();
  }, 60_000);
});
