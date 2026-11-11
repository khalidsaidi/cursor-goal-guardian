import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAudit, codexBudgetLimit, codexContinuation, codexGoals, codexGoalsHome, codexObjectiveUpdated, controlGoal, defaultContract, getGuardianPaths, goalBudget, goalPhaseOf, goalTurnContext, nowIso,
  readAuditTail, readContractSafe, readGoalRecords, recordUserPrompt, resolveCodexGoals, runGoalStop, setEngineGoal, setGoalBudget, type CodexGoalRequest,
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const template = (name: string): string => fs.readFileSync(path.join(repoRoot, "third_party", "codex", "codex-rs", "ext", "goal", "templates", "goals", name), "utf8");

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

/**
 * Stands in for goal-guardian-codex-goals: the same requests and answers, with the store's rules that matter here
 * (a new goal starts from zero, an edit keeps usage, active at or over budget is budget_limited), and a log of
 * every request it was sent.
 */
async function fakeStore(): Promise<{ file: string; log: () => CodexGoalRequest[] }> {
  const dir = await tmp("gg-codex-fake-");
  const file = path.join(dir, "store");
  const log = path.join(dir, "requests.jsonl");
  await fsp.writeFile(file, `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const home = process.argv[process.argv.indexOf("--home") + 1];
const state = path.join(home, "goal.json");
const req = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(req) + "\\n");
let g = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : null;
const limit = (x) => { if (x.status === "active" && x.token_budget !== null && x.tokens_used >= x.token_budget) x.status = "budget_limited"; return x; };
const fresh = () => limit({ goal_id: "g" + Date.now() + Math.random(), objective: req.objective, status: "active", token_budget: req.token_budget ?? null, tokens_used: 0, time_used_seconds: 0, created_at_ms: Date.now(), updated_at_ms: Date.now() });
if (req.op === "set") {
  if (req.fresh || !g || g.status === "complete") g = fresh();
  else { g.objective = req.objective; if ("token_budget" in req) g.token_budget = req.token_budget; limit(g); }
} else if (req.op === "status" && g) { g.status = req.status; limit(g); }
else if (req.op === "account" && g && (g.status === "active" || g.status === "budget_limited")) { g.tokens_used += req.tokens; g.time_used_seconds += req.seconds; limit(g); }
else if (req.op === "clear") g = null;
if (g) fs.writeFileSync(state, JSON.stringify(g)); else if (fs.existsSync(state)) fs.rmSync(state);
process.stdout.write(JSON.stringify({ ok: true, goal: g }) + "\\n");
`);
  await fsp.chmod(file, 0o755);
  return { file, log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as CodexGoalRequest) : []) };
}

async function workspace(goal = "Add CSV export"): Promise<string> {
  const root = await tmp("gg-codex-ws-");
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

/** A turn of goal work in chat c1: the user speaks, the agent edits. */
async function turn(root: string, text: string): Promise<void> {
  await recordUserPrompt(root, text, "c1", "agent");
  await tick();
  await fsp.writeFile(path.join(root, "a.js"), `${text}\n`);
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
  await tick();
}
const stop = (root: string, tokens: number, loopCount = 0) => runGoalStop(root, { conversationId: "c1", status: "completed", loopCount, tokens });
const ends = async (root: string) => (await readAuditTail(root, 1000)).filter((r) => r.kind === "goal.end") as Array<Record<string, unknown>>;

describe("Codex's prompts carry the budget as steering.rs renders it", () => {
  it("no budget is none and unbounded; a budget shows what is left, never below zero", () => {
    expect(codexContinuation(120)).toContain("- Tokens used: 120\n- Token budget: none\n- Tokens remaining: unbounded");
    expect(codexContinuation(120, 1000)).toContain("- Tokens used: 120\n- Token budget: 1000\n- Tokens remaining: 880");
    expect(codexContinuation(1500, 1000)).toContain("- Tokens remaining: 0");
    expect(codexObjectiveUpdated("x", 5)).toContain("- Token budget: none\n- Tokens remaining: unknown");
    expect(codexObjectiveUpdated("x", 5, 50)).toContain("- Token budget: 50\n- Tokens remaining: 45");
  });

  it("the budget-limit prompt is Codex's template, word for word", () => {
    const expected = template("budget_limit.md").replace("{{ objective }}", "Ship &lt;it&gt;").replace("{{ time_used_seconds }}", "42").replace("{{ tokens_used }}", "1100").replace("{{ token_budget }}", "1000").trimEnd();
    expect(codexBudgetLimit("Ship <it>", { tokensUsed: 1100, tokenBudget: 1000, timeUsedSeconds: 42 })).toBe(expected);
  });
});

describe("Codex's goal store beside the goal loop", () => {
  it("is a no-op where the binary isn't installed: nothing changes and nothing fails", async () => {
    process.env.GOAL_GUARDIAN_CODEX_GOALS = "";
    const root = await workspace();
    expect(resolveCodexGoals()).toBeNull();
    expect(await codexGoals(root, { op: "get" })).toEqual({ ran: false, reason: "Codex's goal store isn't installed", goal: null });
    expect(await goalBudget(root)).toBeNull();
    await turn(root, "add the export");
    const round = await stop(root, 500);
    expect(round).toContain("- Tokens used: 500\n- Token budget: none\n- Tokens remaining: unbounded");
    expect(fs.existsSync(codexGoalsHome(root))).toBe(false);
  });

  it("is told each change DeepSeek's service accepted: a new goal, an edit, pause, resume, done", async () => {
    const store = await fakeStore();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = store.file;
    const root = await workspace();
    expect(await setEngineGoal(root, "Add CSV export", true)).toBe(true);
    await controlGoal(root, "pause");
    await controlGoal(root, "resume");
    await fsp.writeFile(getGuardianPaths(root).contract, JSON.stringify({ ...(await readContractSafe(root)), goal: "Add CSV and JSON export" }));
    expect(await setEngineGoal(root, "Add CSV and JSON export", false)).toBe(true);
    await controlGoal(root, "done");
    expect(store.log()).toEqual([
      { op: "set", objective: "Add CSV export", fresh: true },
      { op: "status", status: "paused" },
      { op: "status", status: "active" },
      { op: "set", objective: "Add CSV and JSON export" },
      { op: "status", status: "complete" },
    ]);
    expect(fs.readFileSync(path.join(codexGoalsHome(root), ".gitignore"), "utf8")).toBe("*\n");
  });

  it("each stop accounts the turn, and the send-back shows the store's usage and budget", async () => {
    const store = await fakeStore();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = store.file;
    const root = await workspace();
    await turn(root, "add the export");
    // The goal was in the contract before the store knew it: the first accounting gives it to the store.
    const first = await stop(root, 400);
    expect(store.log().map((r) => r.op)).toEqual(["account", "set", "account"]);
    expect(store.log()[0]).toMatchObject({ op: "account", tokens: 400 });
    expect(first).toContain("- Tokens used: 400\n- Token budget: none\n- Tokens remaining: unbounded");
    expect((await setGoalBudget(root, 1000)).goal).toMatchObject({ token_budget: 1000, tokens_used: 400, status: "active" });
    await fsp.writeFile(path.join(root, "a.js"), "more\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    await tick();
    expect(await stop(root, 100, 1)).toContain("- Tokens used: 500\n- Token budget: 1000\n- Tokens remaining: 500");
    expect(await goalBudget(root)).toMatchObject({ tokens_used: 500, token_budget: 1000 });
  });

  it("a goal that reaches its budget gets Codex's budget-limit prompt and no more send-backs, until the budget is raised", async () => {
    const store = await fakeStore();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = store.file;
    const root = await workspace();
    await turn(root, "add the export");
    await stop(root, 400);
    await setGoalBudget(root, 1000);
    await fsp.writeFile(path.join(root, "a.js"), "more\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    await tick();
    const closing = await stop(root, 700, 1);
    const stored = (await goalBudget(root))!;
    expect(stored).toMatchObject({ status: "budget_limited", tokens_used: 1100, token_budget: 1000 });
    const codexText = template("budget_limit.md").replace("{{ objective }}", "Add CSV export").replace("{{ time_used_seconds }}", String(stored.time_used_seconds)).replace("{{ tokens_used }}", "1100").replace("{{ token_budget }}", "1000").trimEnd();
    expect(closing).toBe(`Goal Guardian: the goal has used its token budget. Don't start new work.\n\n${codexText}`);
    expect((await ends(root)).at(-1)).toMatchObject({ outcome: "budget_limited", reason: "1100 of 1000 tokens used" });
    // The agent's reply to the closing message isn't sent back, and a new message alone doesn't lift the budget.
    expect(await stop(root, 50, 2)).toBeNull();
    const context = await goalTurnContext(root);
    expect(context).toContain("stopped at its token budget (1100 of 1000 tokens used)");
    expect(context).toContain("guardian_change_goal with token_budget");
    // Raising it lets Codex's rule make the goal active again, and DeepSeek's service resumes it.
    expect((await setGoalBudget(root, 5000)).goal).toMatchObject({ status: "active", token_budget: 5000, tokens_used: 1100 });
    expect(goalPhaseOf(await readGoalRecords(root), await readContractSafe(root))).toBe("active");
    expect(await goalTurnContext(root)).toContain("This workspace has an open goal the user set.");
    // A budget still under the usage keeps it stopped: that is Codex's rule, not Guardian's.
    await turn(root, "carry on");
    expect(await stop(root, 5000)).toContain("the goal has used its token budget");
    expect((await setGoalBudget(root, 6000)).goal).toMatchObject({ status: "budget_limited" });
  });
});

const realBinary = path.join(repoRoot, "dist-bin", `${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}-${os.arch() === "arm64" ? "arm64" : "x64"}`, `goal-guardian-codex-goals${process.platform === "win32" ? ".exe" : ""}`);

describe.skipIf(!fs.existsSync(realBinary))("the real binary: Codex's own store", () => {
  it("sets a goal, accounts past its budget, limits it, and goes on once the budget is raised", async () => {
    process.env.GOAL_GUARDIAN_CODEX_GOALS = realBinary;
    const root = await workspace();
    expect((await codexGoals(root, { op: "set", objective: "Add CSV export", token_budget: 1000, fresh: true })).goal).toMatchObject({ status: "active", tokens_used: 0, token_budget: 1000 });
    expect((await codexGoals(root, { op: "account", tokens: 400, seconds: 30 })).goal).toMatchObject({ status: "active", tokens_used: 400, time_used_seconds: 30 });
    expect((await codexGoals(root, { op: "account", tokens: 700, seconds: 5 })).goal).toMatchObject({ status: "budget_limited", tokens_used: 1100 });
    expect((await setGoalBudget(root, 5000)).goal).toMatchObject({ status: "active", token_budget: 5000, tokens_used: 1100 });
    expect((await codexGoals(root, { op: "status", status: "complete" })).goal).toMatchObject({ status: "complete" });
    expect((await codexGoals(root, { op: "teleport" } as unknown as CodexGoalRequest))).toMatchObject({ ran: false });
    expect(fs.existsSync(path.join(codexGoalsHome(root), "goals_1.sqlite"))).toBe(true);
  }, 30_000);
});
