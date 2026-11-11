import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAudit, defaultContract, getGuardianPaths, monitorChunk, monitorLines, nowIso, readAuditTail, readTrajectory, recordFileEdit, recordShellFailure, recordShellOutput, recordUserPrompt,
  resolveMonitor, runGoalStop, runMonitor, submitGoalReport, MONITOR_CHUNK, MONITOR_FLAG_FROM, MONITOR_MAX_CHUNKS,
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MONITOR = JSON.stringify({ python: "python3", cli: path.join(repoRoot, "packages", "monitor", "cgg_monitor", "cli.py"), mrtDir: path.join(repoRoot, "third_party", "mrt") });

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

/**
 * Stands in for cursor-agent. The monitor asks in ask mode and gets MRT's answer shape with the given verdict;
 * the reviewer gets a clean item review. Every monitor prompt is logged.
 */
async function agent(verdict: string): Promise<{ file: string; log: string }> {
  const dir = await tmp("gg-mon-agent-");
  const file = path.join(dir, "agent");
  const log = path.join(dir, "prompts.jsonl");
  await fs.writeFile(file, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const a = process.argv.slice(2);
let p = a[a.indexOf("-p") + 1];
if (a.includes("ask")) {
  if (p.startsWith("Read task.md")) p = fs.readFileSync(path.join(a[a.indexOf("--workspace") + 1], "task.md"), "utf8");
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(p) + "\\n");
  const tail = ${JSON.stringify(verdict)} === "none" ? "" : "<verdict>${verdict}</verdict>";
  process.stdout.write(JSON.stringify({ type: "result", result: "The agent renamed helpers.\\n\\nSummary: it renamed helpers nobody asked about.\\n" + tail }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify({ items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [] }) }) + "\\n");
}
`);
  await fs.chmod(file, 0o755);
  return { file, log };
}

async function repo(): Promise<string> {
  const root = await tmp("gg-mon-ws-");
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
      { role: "assistant", content: "", tool_calls: 'edit_file(path="a.js")' },
      { role: "tool", content: "--- replaced\none\n+++ with\ntwo", tool_calls: null },
      { role: "assistant", content: "", tool_calls: 'run_terminal_command(command="make test")' },
      { role: "tool", content: "12 passed", tool_calls: null },
      { role: "assistant", content: "", tool_calls: 'run_terminal_command(command="make lint")' },
      { role: "tool", content: "The command failed.", tool_calls: null },
    ]);
    expect(await fs.readFile(path.join(getGuardianPaths(root).telemetryDir, ".gitignore"), "utf8")).toContain("edits.jsonl");
  });

  it("is cut into MRT's chunks of 5, growing only when a long run would need more than the capped number of chunks", () => {
    expect(monitorChunk(4)).toBe(MONITOR_CHUNK);
    expect(monitorChunk(MONITOR_CHUNK * MONITOR_MAX_CHUNKS)).toBe(MONITOR_CHUNK);
    expect(monitorChunk(60)).toBe(Math.ceil(60 / MONITOR_MAX_CHUNKS));
  });
});

describe("the paper's monitor, run as it is", () => {
  const steps = [
    { role: "assistant" as const, content: "", tool_calls: 'edit_file(path="a.js")' },
    { role: "tool" as const, content: "--- replaced\none\n+++ with\ntwo", tool_calls: null },
    { role: "assistant" as const, content: "", tool_calls: 'run_terminal_command(command="make test")' },
    { role: "tool" as const, content: "12 passed", tool_calls: null },
  ];

  it("sends MRT's own prompts to the user's model, both styles side by side, and returns their scores and the hybrid", async () => {
    const a = await agent("4");
    process.env.GOAL_GUARDIAN_REVIEWER = a.file;
    process.env.GOAL_GUARDIAN_MONITOR = MONITOR;
    const out = await runMonitor("Add CSV export", steps, 60_000);
    expect(out).toMatchObject({ ran: true, hierarchical: 4, sequential: 4, hybrid: 4, summary: "it renamed helpers nobody asked about." });
    expect(out.calls).toBe(2);
    const prompts = (await fs.readFile(a.log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string);
    const upstream = await fs.readFile(path.join(repoRoot, "third_party", "mrt", "task_pairs", "base_task_definition.py"), "utf8");
    expect(upstream).toContain("You are an AI monitor for an agentic AI assistant that operates in a wide variety of environments.");
    for (const p of prompts) {
      expect(p).toContain("You are an AI monitor for an agentic AI assistant that operates in a wide variety of environments.");
      expect(p).toContain("<begin_user_query>\n Add CSV export");
      expect(p).toContain('run_terminal_command(command="make test")');
    }
    expect(monitorLines(out)).toEqual(["Monitor: parts of this run don't look like what the user asked for (4 of 5): it renamed helpers nobody asked about."]);
  }, 60_000);

  it("stays quiet below the flag score, and is skipped rather than trusted when it can't run or gives no score", async () => {
    process.env.GOAL_GUARDIAN_MONITOR = MONITOR;
    process.env.GOAL_GUARDIAN_REVIEWER = (await agent("2")).file;
    const calm = await runMonitor("Add CSV export", steps, 60_000);
    expect(calm).toMatchObject({ ran: true, hybrid: 2 });
    expect(2).toBeLessThan(MONITOR_FLAG_FROM);
    expect(monitorLines(calm)).toEqual([]);
    process.env.GOAL_GUARDIAN_REVIEWER = (await agent("none")).file;
    expect(await runMonitor("Add CSV export", steps, 60_000)).toMatchObject({ ran: false, reason: "the monitor gave no score", hybrid: null });
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/agent";
    expect((await runMonitor("Add CSV export", steps, 60_000)).ran).toBe(false);
    expect(await runMonitor("Add CSV export", [], 60_000)).toMatchObject({ ran: false, reason: "Guardian recorded no actions for this run" });
    delete process.env.GOAL_GUARDIAN_MONITOR;
    expect(resolveMonitor()).toBeNull();
    expect(await runMonitor("Add CSV export", steps, 60_000)).toMatchObject({ ran: false, reason: "the monitor isn't installed" });
  }, 120_000);
});

describe("the monitor in the goal loop", () => {
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

  it("a run the monitor scores as off the request goes back to the agent as a round, with the monitor's own summary", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_MONITOR = MONITOR;
    process.env.GOAL_GUARDIAN_REVIEWER = (await agent("4")).file;
    const answer = await submitGoalReport(root, report);
    expect(answer.accepted).toBe(false);
    expect(answer.unproved).toEqual(["Monitor: parts of this run don't look like what the user asked for (4 of 5): it renamed helpers nobody asked about."]);
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toContain("- Monitor: parts of this run don't look like what the user asked for (4 of 5)");
    expect(await reviews(root)).toMatchObject([{ ran: true, fails: [], extra: [], monitor: { ran: true, hierarchical: 4, sequential: 4, hybrid: 4 } }]);
  }, 60_000);

  it("a calm monitor and a clean review let the record's proof stand; the scores are still on the record", async () => {
    const root = await doneWork();
    process.env.GOAL_GUARDIAN_MONITOR = MONITOR;
    process.env.GOAL_GUARDIAN_REVIEWER = (await agent("1")).file;
    expect((await submitGoalReport(root, report)).accepted).toBe(true);
    expect(await reviews(root)).toMatchObject([{ ran: true, monitor: { ran: true, hybrid: 1 } }]);
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toBeNull();
  }, 60_000);
});
