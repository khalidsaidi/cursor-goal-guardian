import { finishReport } from "./helpers/recovery.js";
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, createGoalByTool, updateGoalByTool, defaultContract, engineGoal, getGuardianPaths, goalMidTurnNotice, goalPhaseOf, nowIso, readAuditTail, readContractSafe, readGoalRecords, recordShellOutput,
  recordUserPrompt, runGoalStop, setEngineGoal, writeContract,
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
if (req.op === "status" && s.failStatus) { process.stdout.write(JSON.stringify({ok:false,error:"accounting notification unavailable"}) + "\\n"); process.exit(0); }
if (req.op === "status") { s.status = req.status; fs.writeFileSync(${JSON.stringify(settings)}, JSON.stringify(s)); }
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

describe("complementary goal keepers", () => {
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

  it("DeepSeek completes the goal and Codex receives its status without a second approval", async () => {
    noReviewer();
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    // DeepSeek commits the phase; Codex is notified. Missing reviewers still leave completion unchecked.
    expect(await finishReport(root, report)).toMatchObject({ accepted: true, outcome: "unchecked" });
    expect(codex.log().filter((r) => r.op === "tool")).toEqual([]);
    expect(codex.log()).toContainEqual({ op: "status", status: "complete" });
    expect((await engineGoal(root))?.phase).toBe("complete");
    expect(await kinds(root, "goal.refused")).toEqual([]);
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "unchecked", skipped: [expect.stringContaining("the reviewer didn't run")] }]);
    expect(await stop(root)).toBeNull();
  }, 30_000);

  it("Codex's status-tool restrictions do not veto DeepSeek's completion, pause or block", async () => {
    noReviewer();
    const codex = await fakeCodex();
    codex.set({ refuse: { update_goal: "a second approval should never be requested" } });
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    expect(await finishReport(root, report)).toMatchObject({ accepted: true, outcome: "unchecked" });
    expect((await engineGoal(root))?.phase).toBe("complete");
    const blocked = await workspace();
    await doneWork(blocked);
    expect(await finishReport(blocked, { status: "blocked", proofs: [], changes: [], reason: "no network" })).toMatchObject({ accepted: true });
    expect((await engineGoal(blocked))?.phase).toBe("blocked");
    const paused = await workspace();
    await doneWork(paused);
    await recordUserPrompt(paused, "pause this goal", "c1", "agent");
    expect(await finishReport(paused, { status: "paused", proofs: [], changes: [], userWords: "pause this goal" })).toMatchObject({ accepted: true });
    expect((await engineGoal(paused))?.phase).toBe("paused");
    expect(codex.log().filter(r => r.op === "tool")).toEqual([]);
  }, 30_000);

  it("DeepSeek's refusal leaves the phase and Codex mirror unchanged", async () => {
    noReviewer();
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    await stop(root);
    const offset=codex.log().length;
    expect(await finishReport(root, { status: "blocked", proofs: [], changes: [], reason: "need a tool" })).toMatchObject({ accepted: false, refusedBy: "deepseek" });
    expect((await engineGoal(root))?.phase).toBe("active");
    expect(codex.log().slice(offset).some(r => r.op === "status" && r.status === "blocked")).toBe(false);
  }, 30_000);

  it("a failed accounting notification leaves completion unverified without undoing DeepSeek's decision", async () => {
    noReviewer();
    const codex=await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS=codex.file;
    const root=await workspace();
    await doneWork(root);
    codex.set({failStatus:true});
    expect(await finishReport(root,report)).toMatchObject({accepted:false,outcome:"unverified",refusedBy:"codex"});
    expect((await engineGoal(root))?.phase).toBe("complete");
    expect(await kinds(root,"goal.end")).toMatchObject([{outcome:"unverified",by:"codex"}]);
    expect(codex.log().filter(r=>r.op === "tool")).toEqual([]);
  },30_000);

  it("a stale Codex phase is synchronized without overruling DeepSeek's active goal", async () => {
    noReviewer();
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    codex.set({ status: "paused" });
    expect(await stop(root)).toContain("CODEX SAYS");
    expect(codex.log()).toContainEqual({ op: "status", status: "active" });
    expect((await engineGoal(root))?.phase).toBe("active");
    expect(await kinds(root, "goal.end")).toEqual([]);
  }, 30_000);

  it("Codex's usage limit still stops DeepSeek's next round", async () => {
    noReviewer();
    const codex=await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS=codex.file;
    const root=await workspace();
    await doneWork(root);
    codex.set({ status: "usage_limited", continue: false });
    expect(await stop(root)).toContain("usage_limited");
    expect((await engineGoal(root))?.phase).toBe("blocked");
    expect(await kinds(root,"goal.end")).toMatchObject([{ outcome: "budget_limited", by: "codex" }]);
    expect(codex.log().some(r=>r.op === "status" && r.status === "active")).toBe(false);
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

  it("keeps the full request when ordinary goal tools quote only its headline", async () => {
    const root = await workspace("");
    const first = "Add the requested CSV export.\n- Export records\n- Keep headers\n\nDo not change a.js.";
    await recordUserPrompt(root, first, "c1", "agent");
    expect((await createGoalByTool(root, "Add the requested CSV export.")).isError).toBe(false);
    expect((await readContractSafe(root)).goal).toBe(first);
    const next = "Use JSON export instead.\n- Export records\n- Keep their keys\n\nKeep the existing README unchanged.";
    await recordUserPrompt(root, next, "c1", "agent");
    expect((await updateGoalByTool(root, { action: "edit", objective: "Use JSON export instead." })).isError).toBe(false);
    expect((await readContractSafe(root)).goal).toBe(next);
    expect((await readContractSafe(root)).successCriteria.map(c => c.text)).toEqual(["Export records", "Keep their keys"]);
  });

  it("continues a newly started task even when the agent stops after inspection, before its first edit", async () => {
    const root = await workspace("");
    await recordUserPrompt(root, "Add the requested CSV export.", "c1", "agent");
    expect((await createGoalByTool(root, "Add the requested CSV export.")).isError).toBe(false);
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toContain("<goal_round>");
  });

  it("DeepSeek owns creation even when Codex's create handler would refuse", async () => {
    const codex=await fakeCodex();
    codex.set({ refuse: { create_goal: "stale Codex phase" } });
    process.env.GOAL_GUARDIAN_CODEX_GOALS=codex.file;
    const root=await workspace("");
    await recordUserPrompt(root,"Add CSV export","c1","agent");
    expect((await createGoalByTool(root,"Add CSV export")).isError).toBe(false);
    expect((await engineGoal(root))?.phase).toBe("active");
    expect(codex.log().filter(r=>r.op === "tool")).toEqual([]);
    expect(codex.log().some(r=>r.op === "user_goal" && r.objective === "Add CSV export")).toBe(true);
    // DeepSeek still refuses replacing its unfinished goal.
    expect((await createGoalByTool(root,"Add CSV export")).isError).toBe(true);
  }, 30_000);
});
