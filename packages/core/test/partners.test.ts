import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendAudit, controlGoal, createGoalByTool, defaultContract, engineGoal, getGuardianPaths, goalMidTurnNotice, goalPhaseOf, goalTurnContext, guardianRuleContent, nowIso, ralphActive, ralphCancel, ralphHome,
  ralphIteration, ralphPromiseInstruction, ralphStart, ralphStop, ralphUnavailable, readAgentResponse, readAuditTail, readContractSafe, readGoalRecords, recordAgentResponse, recordShellOutput,
  recordUserPrompt, runGoalStop, setEngineGoal, submitGoalReport, writeContract, GOAL_MAX_ROUNDS, RALPH_PROMISE,
} from "../src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RALPH = path.join(repoRoot, "third_party", "claude-plugins-official", "plugins", "ralph-loop");
const vendored = (...p: string[]): string => fs.readFileSync(path.join(RALPH, ...p), "utf8");

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

describe("Ralph Loop's own scripts, as they are", () => {
  it("the vendored plugin is here whole, with its licence", () => {
    for (const f of ["LICENSE", "README.md", "hooks/stop-hook.sh", "hooks/hooks.json", "scripts/setup-ralph-loop.sh", "commands/ralph-loop.md", "commands/cancel-ralph.md", "commands/help.md"]) expect(fs.existsSync(path.join(RALPH, f))).toBe(true);
    expect(fs.existsSync(path.join(RALPH, "..", "..", "LICENSE"))).toBe(true);
  });

  it("its setup script starts a loop in Guardian's folder, not in the project's .claude", async () => {
    process.env.GOAL_GUARDIAN_RALPH = RALPH;
    expect(ralphUnavailable()).toBeNull();
    const root = await workspace();
    const started = await ralphStart(root, "Add CSV export\nDone when:\n- sc_1: the export test passes", { maxIterations: 21, sessionId: "c1" });
    expect(started.ran).toBe(true);
    expect(started.said).toContain("Ralph loop activated in this session!");
    expect(ralphActive(root)).toBe(true);
    expect(fs.existsSync(path.join(root, ".claude"))).toBe(false);
    const state = fs.readFileSync(path.join(ralphHome(root), ".claude", "ralph-loop.local.md"), "utf8");
    expect(state).toContain("iteration: 1\nsession_id: c1\nmax_iterations: 21\ncompletion_promise: \"GOAL COMPLETE\"");
    expect(state).toContain("Add CSV export\nDone when:\n- sc_1: the export test passes");
    // Its instruction about the promise is its own script's text, word for word.
    const said = ralphPromiseInstruction(started.said);
    expect(said).toContain(`  <promise>${RALPH_PROMISE}</promise>`);
    for (const line of ["CRITICAL - Ralph Loop Completion Promise", "  ✓ The statement MUST be completely and unequivocally TRUE", "  true naturally. Do not force it by lying."]) {
      expect(said).toContain(line);
      expect(vendored("scripts", "setup-ralph-loop.sh")).toContain(line);
    }
  });

  it("its stop hook feeds the task back, sees its promise in the agent's last message, and stops at its own maximum", async () => {
    process.env.GOAL_GUARDIAN_RALPH = RALPH;
    const root = await workspace();
    await ralphStart(root, "Add CSV export", { maxIterations: 3, sessionId: "c1" });
    const again = await ralphStop(root, { sessionId: "c1", lastMessage: "Still working on it." });
    // Ralph's script reads the task back from its state file as it wrote it, leading blank line included.
    expect(again).toMatchObject({ ran: true, outcome: "continue", prompt: "\nAdd CSV export", iteration: 2 });
    expect((again as { systemMessage: string }).systemMessage).toBe(`🔄 Ralph iteration 2 | To stop: output <promise>${RALPH_PROMISE}</promise> (ONLY when statement is TRUE - do not lie to exit!)`);
    // A stop from another chat is none of this loop's business: Ralph leaves it alone.
    expect(await ralphStop(root, { sessionId: "other", lastMessage: `<promise>${RALPH_PROMISE}</promise>` })).toEqual({ ran: true, outcome: "inactive" });
    expect(ralphIteration(root)).toBe(2);
    expect(await ralphStop(root, { sessionId: "c1", lastMessage: "More." })).toMatchObject({ outcome: "continue", iteration: 3 });
    expect(await ralphStop(root, { sessionId: "c1", lastMessage: "More." })).toMatchObject({ ran: true, outcome: "max" });
    expect(ralphActive(root)).toBe(false);
    await ralphStart(root, "Add CSV export", { maxIterations: 3, sessionId: "c1" });
    expect(await ralphStop(root, { sessionId: "c1", lastMessage: `All done.\n<promise>${RALPH_PROMISE}</promise>` })).toMatchObject({ ran: true, outcome: "promise" });
    expect(ralphActive(root)).toBe(false);
    expect(await ralphStop(root, { sessionId: "c1", lastMessage: "x" })).toEqual({ ran: true, outcome: "inactive" });
  });

  it("cancelling follows its cancel command: read the iteration, remove its state file", async () => {
    process.env.GOAL_GUARDIAN_RALPH = RALPH;
    const root = await workspace();
    expect(await ralphCancel(root)).toBeNull();
    await ralphStart(root, "Add CSV export", { maxIterations: 5 });
    await ralphStop(root, { sessionId: "c1", lastMessage: "x" });
    expect(await ralphCancel(root)).toBe(2);
    expect(ralphActive(root)).toBe(false);
    expect(vendored("commands", "cancel-ralph.md")).toContain("rm .claude/ralph-loop.local.md");
  });

  it("is skipped, never blocking, where the plugin isn't installed", async () => {
    process.env.GOAL_GUARDIAN_RALPH = "";
    const root = await workspace();
    expect(ralphUnavailable()).toBe("Ralph Loop isn't installed");
    expect(await ralphStart(root, "x", { maxIterations: 1 })).toMatchObject({ ran: false, reason: "Ralph Loop isn't installed" });
    expect(await ralphStop(root, { sessionId: "c1", lastMessage: "x" })).toMatchObject({ ran: false });
  });
});

describe("the agent's last message, as Cursor reports it", () => {
  it("is kept per chat from the afterAgentResponse hook, out of git", async () => {
    const root = await workspace();
    expect(await readAgentResponse(root, "c1")).toBeNull();
    await recordAgentResponse(root, "c1", "first");
    await recordAgentResponse(root, "c2", "other chat");
    await recordAgentResponse(root, "c1", `done <promise>${RALPH_PROMISE}</promise>`);
    expect((await readAgentResponse(root, "c1"))?.text).toBe(`done <promise>${RALPH_PROMISE}</promise>`);
    expect((await readAgentResponse(root, "c2"))?.text).toBe("other chat");
    expect(fs.readFileSync(path.join(getGuardianPaths(root).telemetryDir, ".gitignore"), "utf8")).toContain("responses.json");
  });
});

describe("three goal keepers side by side", () => {
  it("a send-back carries DeepSeek's round prompt, Codex's own continuation and Ralph's own answer", async () => {
    noReviewer();
    process.env.GOAL_GUARDIAN_RALPH = RALPH;
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    const msg = (await stop(root))!;
    expect(msg).toContain("<goal_round>\nObjective: \"Add CSV export\"\nRound: 1/");
    expect(msg).toContain("<goal_objective>\nAdd CSV export\n</goal_objective>\n\nCODEX SAYS: Continue working toward the active thread goal.");
    expect(msg).toContain(`🔄 Ralph iteration 2 | To stop: output <promise>${RALPH_PROMISE}</promise> (ONLY when statement is TRUE - do not lie to exit!)\n\nAdd CSV export\nDone when:\n- sc_1: the export test passes`);
    const order = ["<goal_round>", "CODEX SAYS", "🔄 Ralph iteration", "Guardian checks update_goal"].map((x) => msg.indexOf(x));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Codex's own accounting got the turn, with the split Cursor reported.
    expect(codex.log().find((r) => r.op === "turn")).toMatchObject({ usage: { input_tokens: 80, cached_input_tokens: 10, output_tokens: 30 } });
    expect(await kinds(root, "goal.partners")).toMatchObject([{ codex: { ran: true, continues: true }, ralph: { ran: true, outcome: "continue", iteration: 2 } }]);
  }, 30_000);

  it("the goal is complete only when the two tools accept and Ralph has seen its promise", async () => {
    noReviewer();
    process.env.GOAL_GUARDIAN_RALPH = RALPH;
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    expect((await submitGoalReport(root, report)).accepted).toBe(true);
    await recordAgentResponse(root, "c1", "All done, tests pass.");
    // The record backs the report, but the agent's last message carries no promise: not complete, and it's told.
    const back = (await stop(root))!;
    expect(back).toContain(`Ralph Loop hasn't seen its completion promise in your last message. If the goal is truly complete, end your message with <promise>${RALPH_PROMISE}</promise>.`);
    expect(await kinds(root, "goal.end")).toEqual([]);
    expect(await kinds(root, "goal.refused")).toMatchObject([{ change: "complete", by: "ralph" }]);
    expect(codex.log().some((r) => r.op === "tool")).toBe(false);
    // With the promise in its last message, all three agree.
    await recordAgentResponse(root, "c1", `All done, tests pass.\n<promise>${RALPH_PROMISE}</promise>`);
    expect(await stop(root, 1)).toBeNull();
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "proved" }]);
    expect(codex.log().filter((r) => r.op === "tool")).toMatchObject([{ name: "update_goal", arguments: { status: "complete" } }]);
    expect((await engineGoal(root))?.phase).toBe("complete");
    expect(ralphActive(root)).toBe(false);
  }, 30_000);

  it("when one accepts and another refuses, the change doesn't happen and the record says who refused", async () => {
    noReviewer();
    process.env.GOAL_GUARDIAN_RALPH = RALPH;
    const codex = await fakeCodex();
    codex.set({ refuse: { "update_goal:complete": "Codex says no: the goal isn't complete" } });
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    expect((await submitGoalReport(root, report)).accepted).toBe(true);
    await recordAgentResponse(root, "c1", `Done.\n<promise>${RALPH_PROMISE}</promise>`);
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

  it("Ralph seeing its promise doesn't complete a goal the record doesn't back: its loop starts again", async () => {
    noReviewer();
    process.env.GOAL_GUARDIAN_RALPH = RALPH;
    process.env.GOAL_GUARDIAN_CODEX_GOALS = "";
    const root = await workspace();
    await doneWork(root);
    await submitGoalReport(root, { ...report, proofs: [{ criterion: "sc_1", command: "make never-ran", quote: "12 passed" }] });
    await recordAgentResponse(root, "c1", `<promise>${RALPH_PROMISE}</promise>`);
    const back = (await stop(root))!;
    expect(back).toContain("You output Ralph Loop's completion promise, but the goal isn't proved.");
    expect(await kinds(root, "goal.refused")).toMatchObject([{ change: "complete", by: "guardian" }]);
    expect(await kinds(root, "goal.end")).toEqual([]);
    expect(ralphActive(root)).toBe(true);
  }, 30_000);

  it("if Codex's own scheduling starts no continuation because its goal is stopped, the run stops", async () => {
    noReviewer();
    process.env.GOAL_GUARDIAN_RALPH = "";
    const codex = await fakeCodex();
    process.env.GOAL_GUARDIAN_CODEX_GOALS = codex.file;
    const root = await workspace();
    await doneWork(root);
    codex.set({ continue: false, status: "paused" });
    expect(await stop(root)).toBeNull();
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "stopped", reason: "Codex's scheduling started no continuation: its goal is paused" }]);
    expect(await kinds(root, "goal.refused")).toMatchObject([{ change: "continue", by: "codex" }]);
  }, 30_000);

  it("Ralph's iterations running out ends the run, like Guardian's own cap", async () => {
    noReviewer();
    process.env.GOAL_GUARDIAN_RALPH = RALPH;
    process.env.GOAL_GUARDIAN_CODEX_GOALS = "";
    const root = await workspace();
    await doneWork(root);
    await stop(root);
    // Wind Ralph's own counter to its maximum, as its state file holds it.
    const state = path.join(ralphHome(root), ".claude", "ralph-loop.local.md");
    fs.writeFileSync(state, fs.readFileSync(state, "utf8").replace(/^iteration: .*$/m, `iteration: ${GOAL_MAX_ROUNDS + 1}`));
    const closing = (await stop(root, 1))!;
    expect(closing).toContain("Ralph Loop's iterations ran out.");
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "limit", reason: "Ralph Loop's iterations ran out" }]);
  }, 30_000);

  it("the user's message starts a Ralph loop and brings Ralph's own promise instruction; pausing cancels it", async () => {
    process.env.GOAL_GUARDIAN_RALPH = RALPH;
    process.env.GOAL_GUARDIAN_CODEX_GOALS = "";
    const root = await workspace();
    expect(await setEngineGoal(root, "Add CSV export", true)).toBe(true);
    const context = (await goalTurnContext(root))!;
    expect(context).toContain("Ralph Loop (Anthropic) is also running on this goal. Its own instruction:");
    expect(context).toContain(`  <promise>${RALPH_PROMISE}</promise>`);
    expect(context).toContain("  ✓ Do NOT output false statements to exit the loop");
    expect(ralphActive(root)).toBe(true);
    await controlGoal(root, "pause");
    expect(ralphActive(root)).toBe(false);
    expect(guardianRuleContent()).toContain(`<promise>${RALPH_PROMISE}</promise>`);
  }, 30_000);

  it("a user's goal change goes through Codex's GoalService, and the agent is shown Codex's own words for it", async () => {
    process.env.GOAL_GUARDIAN_RALPH = "";
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
    process.env.GOAL_GUARDIAN_RALPH = "";
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
