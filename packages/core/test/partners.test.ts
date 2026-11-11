import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, createGoalByTool, defaultContract, engineGoal, getGuardianPaths, goalMidTurnNotice, goalPhaseOf, nowIso, readAuditTail, readContractSafe, readGoalRecords, recordShellOutput,
  recordUserPrompt, runGoalStop, setEngineGoal, submitGoalReport, writeContract,
} from "../src/index.js";

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

async function workspace(goal = "Add CSV export"): Promise<string> {
  const root = await tmp("gg-partners-ws-");
  const p = getGuardianPaths(root);
  await fsp.mkdir(p.telemetryDir, { recursive: true });
  await fsp.writeFile(p.config, "{}");
  await fsp.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal, successCriteria: [{ id: "sc_1", text: "the export test passes" }] }));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  sh("init", "-q");
  await fsp.writeFile(path.join(root, "a.js"), "one\n");
  sh("add", "a.js");
  sh("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  return root;
}

/**
 * Stands in for Codex's whole-extension binary. Its answers to update_goal and to the continuation request come
 * from a small settings file the test can change; every request is logged.
 */
async function fakeCodex(): Promise<{ file: string; set: (s: Record<string, unknown>) => void; log: () => Array<Record<string, unknown>> }> {
  const dir = await tmp("gg-partners-codex-");
  const file = path.join(dir, "codex");
  const log = path.join(dir, "requests.jsonl");
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(settings, "{}");
  await fsp.writeFile(file, `#!/usr/bin/env node
const fs = require("fs");
const req = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(req) + "\\n");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(settings)}, "utf8"));
const goal = { goal_id: "g1", objective: "Add CSV export", status: s.status || "active", token_budget: null, tokens_used: 450, time_used_seconds: 12, created_at_ms: 1, updated_at_ms: 2 };
const events = { goal_updated: [], warnings: [] };
let out = { ok: false, error: "unknown op " + req.op };
if (["get", "set", "status", "account", "clear"].includes(req.op)) out = { ok: true, goal };
if (req.op === "turn") out = { ok: true, goal, events };
if (req.op === "user_goal") out = { ok: true, goal, events, fragment: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_internal_context source=\\"user_goal\\">\\nUser set the goal: " + JSON.stringify(req.objective || "") + "\\n</codex_internal_context>" }] } };
if (req.op === "tool") {
  const refuse = s.refuse && s.refuse[req.name + ":" + ((req.arguments || {}).status || "")] || s.refuse && s.refuse[req.name];
  out = { ok: true, goal, events, call: refuse ? { accepted: false, refusal: refuse } : { accepted: true, result: { goal } } };
}
if (req.op === "steering") {
  const cont = s.continue !== false;
  out = { ok: true, goal, steering: { kind: req.kind, answer: req.kind === "continuation"
    ? (cont ? { continue: true, prompt: "CODEX SAYS: Continue working toward the active thread goal.", goal_objective_context: { name: "goal_objective", output: "Add CSV export" } } : { continue: false, status: s.status || "paused" })
    : { prompt: "CODEX NOTICE " + req.kind } } };
}
process.stdout.write(JSON.stringify(out) + "\\n");
`);
  await fsp.chmod(file, 0o755);
  return {
    file,
    set: (s) => fs.writeFileSync(settings, JSON.stringify(s)),
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : []),
  };
}

/** Goal work in chat c1 that Guardian's record backs: the user asked, the agent edited, the test ran. */
async function doneWork(root: string): Promise<void> {
  await recordUserPrompt(root, "add the export", "c1", "agent");
  await tick();
  await fsp.writeFile(path.join(root, "a.js"), "two\n");
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
  await tick();
  await recordShellOutput(root, { command: "make test", output: "12 passed", durationMs: 0 });
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: "make test", conversationId: "c1" });
}
const report = { status: "complete" as const, proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }], changes: [{ file: "a.js", serves: "sc_1" }] };
const stop = (root: string, n = 0) => runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: n, tokens: 100, usage: { input_tokens: 80, cached_input_tokens: 10, output_tokens: 30 } });
const kinds = async (root: string, kind: string) => (await readAuditTail(root, 2000)).filter((r) => r.kind === kind) as Array<Record<string, unknown>>;
const noReviewer = (): void => {
  process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
};

describe("two goal keepers side by side", () => {
  it("a send-back carries DeepSeek's round prompt and Codex's own continuation", async () => {
    noReviewer();
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    const msg = (await stop(root))!;
    expect(msg).toContain("<goal_round>\nObjective: \"Add CSV export\"\nRound: 1/");
    expect(msg).toContain("<goal_objective>\nAdd CSV export\n</goal_objective>\n\nCODEX SAYS: Continue working toward the active thread goal.");
    const order = ["<goal_round>", "CODEX SAYS", "Guardian checks update_goal"].map((x) => msg.indexOf(x));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Codex's own accounting got the turn, with the split Cursor reported.
    expect(codex.log().find((r) => r.op === "turn")).toMatchObject({ usage: { input_tokens: 80, cached_input_tokens: 10, output_tokens: 30 } });
    expect(await kinds(root, "goal.partners")).toMatchObject([{ codex: { ran: true, continues: true } }]);
  }, 30_000);

  it("the goal is complete when Codex's handler and DeepSeek's tool both accept", async () => {
    noReviewer();
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    expect((await submitGoalReport(root, report)).accepted).toBe(true);
    expect(codex.log().some((r) => r.op === "tool")).toBe(false);
    expect(await stop(root)).toBeNull();
    expect(await kinds(root, "goal.refused")).toEqual([]);
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "proved" }]);
    expect(codex.log().filter((r) => r.op === "tool")).toMatchObject([{ name: "update_goal", arguments: { status: "complete" } }]);
    expect((await engineGoal(root))?.phase).toBe("complete");
  }, 30_000);

  it("when one accepts and another refuses, the change doesn't happen and the record says who refused", async () => {
    noReviewer();
    const codex = await fakeCodex();
    codex.set({ refuse: { "update_goal:complete": "Codex says no: the goal isn't complete" } });
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    expect((await submitGoalReport(root, report)).accepted).toBe(true);
    await stop(root);
    expect(await kinds(root, "goal.end")).toEqual([]);
    expect(await kinds(root, "goal.refused")).toMatchObject([{ change: "complete", by: "codex", message: "Codex says no: the goal isn't complete" }]);
    // Codex was asked first and refused, so DeepSeek's service was never asked to complete anything.
    expect((await engineGoal(root))?.phase).not.toBe("complete");
    expect(goalPhaseOf(await readGoalRecords(root), await readContractSafe(root))).toBe("active");
    // The agent's "blocked": DeepSeek's tool accepts it in a turn the user's message opened, Codex's refuses, so
    // DeepSeek's block is taken back.
    codex.set({ refuse: { "update_goal:blocked": "Codex says no to blocked" } });
    const other = await workspace();
    await doneWork(other);
    const answer = await submitGoalReport(other, { status: "blocked", proofs: [], changes: [], reason: "no network" });
    expect(answer).toMatchObject({ accepted: false, refusedBy: "codex", message: "Codex says no to blocked" });
    expect((await engineGoal(other))?.phase).toBe("active");
    expect(await kinds(other, "goal.refused")).toMatchObject([{ change: "blocked", by: "codex" }]);
  }, 30_000);

  it("if Codex's own scheduling starts no continuation because its goal is stopped, the run stops", async () => {
    noReviewer();
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    codex.set({ continue: false, status: "paused" });
    expect(await stop(root)).toBeNull();
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "stopped", reason: "Codex's scheduling started no continuation: its goal is paused" }]);
    expect(await kinds(root, "goal.refused")).toMatchObject([{ change: "continue", by: "codex" }]);
  }, 30_000);

  it("a user's goal change goes through Codex's GoalService, and the agent is shown Codex's own words for it", async () => {
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    expect(await setEngineGoal(root, "Add CSV export", true)).toBe(true);
    expect(await goalMidTurnNotice(root, "c1")).toBeNull();
    const contract = await readContractSafe(root);
    await writeContract(root, { ...contract, goal: "Add JSON export instead" });
    expect(await setEngineGoal(root, "Add JSON export instead", false)).toBe(true);
    expect(codex.log().filter((r) => r.op === "user_goal").map((r) => r.objective)).toEqual(["Add CSV export", "Add JSON export instead"]);
    const notice = (await goalMidTurnNotice(root, "c1"))!;
    expect(notice).toContain('User set the goal: "Add JSON export instead"');
    expect(notice).toContain("CODEX NOTICE objective_updated");
  }, 30_000);

  it("create_goal asks Codex's own handler first; its refusal means no goal is created", async () => {
    const codex = await fakeCodex();
    codex.set({ refuse: { create_goal: "cannot create a new goal because this thread has an unfinished goal" } });
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace("");
    await recordUserPrompt(root, "Add CSV export", "c1", "agent");
    const out = await createGoalByTool(root, "Add CSV export");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("unfinished goal");
    expect(await engineGoal(root)).toBeNull();
    expect(await kinds(root, "goal.refused")).toMatchObject([{ change: "create", by: "codex" }]);
  }, 30_000);
});
