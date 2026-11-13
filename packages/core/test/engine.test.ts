import { finishReport } from "./helpers/recovery.js";
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldGoal } from "@deepseek-ai/dsh-goal";
import {
  EngineRefused, appendAudit, controlGoal, criteriaFromTexts, defaultContract, engineApply, engineRun, engineGoalPolicy, DEEPSEEK_GOAL_POLICY, guardianRuleContent, runGoalTool, runGoalCommand, engineEvents, engineView, getGuardianPaths, goalPhaseOf, goalTurnContext, legacyGoalPhase,
  nowIso, readAuditTail, readContractSafe, readGoalRecords, recordShellOutput, recordUserPrompt, runGoalStop, captureGoal, goalHash,
} from "../src/index.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const tick = () => new Promise((r) => setTimeout(r, 3));

async function ws(goal = "Add CSV export", criteria = ["the export test passes"]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-engine-"));
  made.push(root);
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.config, "{}");
  await fs.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal, successCriteria: criteriaFromTexts(criteria), constraints: [] }));
  // Cursor's prompt hook reports the user's message before any work: the turn their tools and driver judge by.
  await recordUserPrompt(root, goal, "c1", "agent");
  return root;
}
const view = async (root: string) => engineView(await readGoalRecords(root));
const phase = async (root: string) => goalPhaseOf(await readGoalRecords(root), await readContractSafe(root));
const edit = async (root: string, file = "a.js") => {
  await tick();
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: file, conversationId: "c1" });
  await tick();
};
const stop = (root: string, loopCount = 0) => runGoalStop(root, { conversationId: "c1", status: "completed", loopCount });

describe("DeepSeek's goal service keeps the goal's state", () => {
  it("makes every change, and its own fold reads them back: create, round, pause, resume, block, complete", async () => {
    const root = await ws();
    expect(await view(root)).toBeUndefined();
    expect(await engineApply(root, "Add CSV export", "none", { type: "sync" })).toMatchObject({ objective: "Add CSV export", phase: "active", revision: 1, roundsStarted: 0, maxGoalRounds: 256 });
    expect((await engineApply(root, "Add CSV export", "none", { type: "round" }))!.roundsStarted).toBe(1);
    expect((await engineApply(root, "Add CSV export", "none", { type: "round" }))!.roundsStarted).toBe(2);
    expect((await engineApply(root, "Add CSV export", "none", { type: "pause" }))!.phase).toBe("paused");
    expect(await phase(root)).toBe("paused");
    expect((await engineApply(root, "Add CSV export", "none", { type: "resume" }))!.phase).toBe("active");
    expect(await engineApply(root, "Add CSV export", "none", { type: "block", code: "model-reported", message: "no network" })).toMatchObject({ phase: "blocked", blockedReason: { code: "model-reported", message: "no network" } });
    // Their blocked goal is still open to Guardian: the run that blocked says so, and the goal isn't closed.
    expect(await phase(root)).toBe("active");
    expect((await engineApply(root, "Add CSV export", "none", { type: "complete" }))!.phase).toBe("complete");
    expect(await phase(root)).toBe("complete");

    // What is saved is their session log, and their fold over it is what Guardian reads.
    const events = engineEvents(await readGoalRecords(root));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["goal/change", "turn/start", "user/message", "turn/end", "command/run"]));
    const folded = foldGoal(events as never);
    expect(await view(root)).toEqual({ ...folded.goal, roundsStarted: folded.roundsStarted });
    expect(folded).toMatchObject({ goal: { phase: "complete" }, roundsStarted: 2 });
    // The rounds are the ones their round driver queued: attributed to the goal, its revision and the round number.
    const rounds = events.filter((e) => e.type === "user/message").map((e) => (e.data as { source: Record<string, unknown> }).source).filter((src) => src.kind === "goal");
    expect(rounds).toMatchObject([{ kind: "goal", round: 1 }, { kind: "goal", round: 2 }]);
    // Their goal operations, in order, as their own code wrote them. Each round re-arms the goal with their resume.
    const ops = events.filter((e) => e.type === "goal/change").map((e) => (e.data as { operation: string }).operation);
    expect(ops).toEqual(["create", "resume", "resume", "pause", "resume", "block", "complete"]);
  });

  it("refuses what their service refuses, with their error, and saves nothing", async () => {
    const root = await ws();
    await engineApply(root, "Add CSV export", "none", { type: "block", code: "model-reported", message: "stuck" });
    const before = (await readAuditTail(root, 1000)).length;
    const err = await engineApply(root, "Add CSV export", "none", { type: "pause" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRefused);
    // The user's pause is their /goal command, and the refusal is the command's own answer.
    expect((err as EngineRefused).code).toBe("GOAL_COMMAND_REFUSED");
    expect((err as EngineRefused).message).toBe("The goal command is not valid for the current state. Run /goal to view available commands.");
    await expect(engineApply(root, "Add CSV export", "none", { type: "block", code: "Not Kebab", message: "x" })).rejects.toMatchObject({ code: "GOAL_INVALID_TRANSITION" });
    expect((await readAuditTail(root, 1000)).length).toBe(before);
    // Their driver starts no round for a blocked goal.
    expect((await engineRun(root, "Add CSV export", "none", { type: "round" })).prompt).toBeUndefined();
    expect((await view(root))!.phase).toBe("blocked");
  });

  it("the objective follows the contract by their own operations: edit while open, a new goal after a completed one, clear", async () => {
    const root = await ws();
    const first = (await engineApply(root, "Add CSV export", "none", { type: "sync" }))!;
    const edited = (await engineApply(root, "Add JSON export", "none", { type: "sync" }))!;
    expect(edited).toMatchObject({ id: first.id, objective: "Add JSON export", revision: 2, phase: "active" });
    await engineApply(root, "Add JSON export", "none", { type: "complete" });
    const next = (await engineApply(root, "Something new", "none", { type: "sync" }))!;
    expect(next).toMatchObject({ objective: "Something new", revision: 1, phase: "active" });
    expect(next.id).not.toBe(first.id);
    // The same words again after completion stay complete unless a new goal is asked for.
    await engineApply(root, "Something new", "none", { type: "complete" });
    expect((await engineApply(root, "Something new", "none", { type: "sync" }))!.phase).toBe("complete");
    expect((await engineApply(root, "Something new", "none", { type: "create" }))!.phase).toBe("active");
    expect(await engineApply(root, "", "none", { type: "sync" })).toBeNull();
    expect(await view(root)).toBeNull();
  });

  it("the round cap is theirs: their default is 256, and a goal out of rounds is blocked with their round-limit code", async () => {
    const root = await ws();
    expect((await engineApply(root, "Add CSV export", "none", { type: "sync" }))!.maxGoalRounds).toBe(256);
    const capped = await ws();
    // Their create_goal takes the cap; two rounds are allowed.
    expect((await engineRun(capped, undefined, "none", { type: "tool", name: "create_goal", args: { objective: "Add CSV export", max_goal_rounds: 2 } })).tool).toMatchObject({ isError: false });
    expect((await engineRun(capped, undefined, "none", { type: "round" })).prompt).toContain("Round: 1/2");
    expect((await engineRun(capped, undefined, "none", { type: "round" })).prompt).toContain("Round: 2/2");
    const out = await engineRun(capped, undefined, "none", { type: "round" });
    expect(out.prompt).toBeUndefined();
    expect(out.goal).toMatchObject({ phase: "blocked", roundsStarted: 2, blockedReason: { code: "round-limit", message: "Goal reached its configured limit of 2 rounds." } });
    // Their own rule: a goal out of rounds can't be resumed until its cap is raised.
    await expect(engineRun(capped, undefined, "none", { type: "resume" })).rejects.toBeInstanceOf(EngineRefused);
  }, 60_000);

  it("replays from audit.jsonl in a fresh process", async () => {
    const root = await ws();
    await engineApply(root, "Add CSV export", "none", { type: "round" });
    await engineApply(root, "Add CSV export", "none", { type: "pause" });
    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = `
      import { engineApply, engineView, readGoalRecords } from ${JSON.stringify(path.join(here, "..", "src", "index.ts"))};
      const before = engineView(await readGoalRecords(process.argv[2]));
      const after = await engineApply(process.argv[2], "Add CSV export", "none", { type: "resume" });
      console.log(JSON.stringify({ before, after }));`;
    const file = path.join(root, "replay.mts");
    await fs.writeFile(file, script);
    const out = execFileSync(path.join(here, "..", "..", "..", "node_modules", ".bin", "tsx"), [file, root], { encoding: "utf8" });
    const { before, after } = JSON.parse(out.trim().split("\n").pop()!) as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(before).toMatchObject({ phase: "paused", revision: 2, roundsStarted: 1 });
    expect(after).toMatchObject({ phase: "active", revision: 3, roundsStarted: 1 });
    expect(await view(root)).toMatchObject({ phase: "active", revision: 3, roundsStarted: 1 });
  }, 60_000);

  it("a log their replay rejects is started over rather than trusted", async () => {
    const root = await ws();
    await engineApply(root, "Add CSV export", "none", { type: "sync" });
    await appendAudit(root, { ts: nowIso(), kind: "goal.engine", event: { type: "goal/change", seq: 99, time: 1, data: { kind: "goal/change", version: 1, operation: "pause", goal: { id: "x", revision: 7, objective: "y", phase: "paused", maxGoalRounds: 1 }, roundsStarted: 0, createdAt: 1, updatedAt: 1 } } });
    expect(await view(root)).toBeUndefined();
    expect(await engineApply(root, "Add CSV export", "none", { type: "sync" })).toMatchObject({ phase: "active", revision: 1 });
    expect((await readGoalRecords(root)).some((r) => r.kind === "goal.engine" && r.reset)).toBe(true);
    expect(await view(root)).toMatchObject({ phase: "active", revision: 1 });
  });
});

describe("a workspace from before the engine", () => {
  it("is read the old way until its first change, which seeds their service from the old phase", async () => {
    const root = await ws();
    const contract = await readContractSafe(root);
    await appendAudit(root, { ts: nowIso(), kind: "goal.control", goalHash: goalHash(contract), operation: "pause", actor: "user" });
    const records = await readGoalRecords(root);
    expect(engineView(records)).toBeUndefined();
    expect(legacyGoalPhase(records, contract)).toBe("paused");
    expect(goalPhaseOf(records, contract)).toBe("paused");
    await controlGoal(root, "resume");
    expect(await view(root)).toMatchObject({ phase: "active", revision: 3 });
    const ops = engineEvents(await readGoalRecords(root)).filter((e) => e.type === "goal/change").map((e) => (e.data as { operation: string }).operation);
    expect(ops).toEqual(["create", "pause", "resume"]);

    const done = await ws("Old goal");
    const c2 = await readContractSafe(done);
    await appendAudit(done, { ts: nowIso(), kind: "goal.end", conversationId: "c0", goalHash: goalHash(c2), outcome: "proved" });
    expect(await phase(done)).toBe("complete");
    await controlGoal(done, "done");
    expect(await view(done)).toMatchObject({ phase: "complete", objective: "Old goal" });
  });
});

describe("Guardian's flows go through the service", () => {
  it("a captured request is created there; each send-back is a round there; a proved goal is completed there", async () => {
    const root = await ws("", []);
    await recordUserPrompt(root, "Add CSV export\n- the export test passes\n- the readme says so", "c1", "agent");
    expect(await captureGoal(root, "c1")).toBe(true);
    expect(await view(root)).toMatchObject({ objective: "Add CSV export\n- the export test passes\n- the readme says so", phase: "active", roundsStarted: 0 });
    await edit(root);
    expect(await stop(root)).toContain("Round: 1/256");
    await edit(root);
    expect(await stop(root, 1)).toContain("Round: 2/256");
    expect((await view(root))!.roundsStarted).toBe(2);
    await tick();
    await recordShellOutput(root, { command: "make test", output: "12 passed", durationMs: 0 });
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
    const answer = await finishReport(root, { status: "complete", proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }, { criterion: "sc_2", command: "make test", quote: "12 passed" }], changes: [{ file: "a.js", serves: "sc_1" }] });
    delete process.env.GOAL_GUARDIAN_REVIEWER;
    expect(answer.accepted).toBe(true);
    // Their update_goal tool completed it in that same report, in the goal round their driver had admitted.
    expect(await view(root)).toMatchObject({ phase: "complete", roundsStarted: 2 });
    expect(await stop(root, 2)).toBeNull();
    expect(await phase(root)).toBe("complete");
  });

  it("the panel's controls and the agent's quoted pause are their pause, resume and complete; a refused one leaves no record", async () => {
    const root = await ws();
    await controlGoal(root, "pause");
    expect((await view(root))!.phase).toBe("paused");
    await controlGoal(root, "pause"); // their service: cannot pause from paused
    expect((await readGoalRecords(root)).filter((r) => r.kind === "goal.control")).toHaveLength(1);
    await edit(root);
    expect(await stop(root)).toBeNull();
    await controlGoal(root, "resume");
    expect(await phase(root)).toBe("active");
    await recordUserPrompt(root, "please pause this goal for now", "c1", "agent");
    expect((await finishReport(root, { status: "paused", proofs: [], changes: [], userWords: "pause this goal for now" })).accepted).toBe(true);
    expect((await view(root))!.phase).toBe("paused");
    await controlGoal(root, "done");
    expect((await view(root))!.phase).toBe("complete");
  });

  it("a blocked goal is their blocked phase, and the user's next message in agent mode resumes it", async () => {
    const root = await ws();
    await recordUserPrompt(root, "go", "c1", "agent");
    const blocked = { status: "blocked" as const, proofs: [], changes: [], reason: "the registry is down" };
    // Their tool accepts a model's "blocked" from the third goal round on.
    for (let n = 0; n < 3; n += 1) {
      await edit(root, `f${n}.js`);
      expect(await stop(root, n)).not.toBeNull();
    }
    await edit(root);
    expect((await finishReport(root, blocked)).accepted).toBe(true);
    expect(await stop(root, 3)).toBeNull();
    expect(await view(root)).toMatchObject({ phase: "blocked", blockedReason: { code: "model-reported", message: "the registry is down" } });
    expect((await readGoalRecords(root)).filter((r) => r.kind === "goal.end")).toMatchObject([{ outcome: "blocked" }]);
    // The next message from the user is the human-authorized edge.
    expect(await goalTurnContext(root)).toContain("open goal");
    expect((await view(root))!.phase).toBe("active");
  });
});

describe("the rest of DeepSeek's goal feature runs as their own code", () => {
  const tool = (root: string, name: "get_goal" | "create_goal" | "update_goal", args: Record<string, unknown> = {}) => engineRun(root, undefined, "none", { type: "tool", name, args }).then((r) => r.tool!);

  it("their tools run through their pipeline: create in the user's turn, read back as their JSON", async () => {
    const root = await ws();
    await engineRun(root, undefined, "none", { type: "user-message", text: "please do the export" });
    const created = await tool(root, "create_goal", { objective: "Add CSV export" });
    expect(created.isError).toBe(false);
    expect(JSON.parse(created.text)).toMatchObject({ goal: { objective: "Add CSV export", phase: "active", revision: 1, roundsStarted: 0, maxGoalRounds: 256 }, activation: "armed" });
    expect(JSON.parse((await tool(root, "get_goal")).text)).toMatchObject({ goal: { objective: "Add CSV export" } });
  });

  it("their authority decides: in a goal round the model can't pause, and can't report blocked before 3 rounds", async () => {
    const root = await ws();
    await engineRun(root, undefined, "none", { type: "user-message", text: "please do the export" });
    await tool(root, "create_goal", { objective: "Add CSV export" });
    expect((await engineRun(root, undefined, "none", { type: "round" })).prompt).toContain("<goal_round>");
    const goal = (await view(root))!;
    const ref = { goal_id: goal.id, revision: goal.revision };
    const pause = await tool(root, "update_goal", { ...ref, action: "pause" });
    expect(pause).toMatchObject({ isError: true, text: expect.stringContaining("this goal operation requires a direct human turn on a top-level agent") });
    const early = await tool(root, "update_goal", { ...ref, action: "blocked", blocked_reason: "no network" });
    expect(early).toMatchObject({ isError: true, text: expect.stringContaining("blocked requires at least 3 consecutive goal rounds; current round is 1") });
    expect((await view(root))!.phase).toBe("active");
    // Completing in the goal round is allowed, and their tool defers its wrap-up instruction.
    const done = await tool(root, "update_goal", { ...ref, action: "complete" });
    expect(done.isError).toBe(false);
    expect(done.contexts[0]).toContain("<goal_complete>");
    expect(done.contexts[0]).toContain("The goal is marked complete and this autonomous run is ending.");
  });

  it("in a turn the user's message opened, their tool lets the model pause", async () => {
    const root = await ws();
    await engineRun(root, undefined, "none", { type: "user-message", text: "please do the export" });
    await tool(root, "create_goal", { objective: "Add CSV export" });
    await engineRun(root, undefined, "none", { type: "user-message", text: "please do the export" });
    const goal = (await view(root))!;
    expect((await tool(root, "update_goal", { goal_id: goal.id, revision: goal.revision, action: "pause" })).isError).toBe(false);
    expect((await view(root))!.phase).toBe("paused");
    // Their rule: the model can't resume a paused goal; the user does.
    const paused = (await view(root))!;
    expect(await tool(root, "update_goal", { goal_id: paused.id, revision: paused.revision, action: "resume" })).toMatchObject({ isError: true, text: expect.stringContaining("the model cannot resume a paused goal; the user must resume it") });
  });

  it("their round driver builds the round prompt and admits the round; its text is the prompt function's own", async () => {
    const root = await ws();
    await engineApply(root, "Add CSV export", "none", { type: "sync" });
    const { prompt, goal } = await engineRun(root, "Add CSV export", "none", { type: "round" });
    expect(prompt!.startsWith('<goal_round>\nObjective: "Add CSV export"\nRound: 1/256\n\nContinue working toward the objective in this same session.')).toBe(true);
    expect(goal).toMatchObject({ phase: "active", roundsStarted: 1 });
    // Nothing for a paused goal: their driver only drives an active, armed one.
    await engineApply(root, "Add CSV export", "none", { type: "pause" });
    expect((await engineRun(root, "Add CSV export", "none", { type: "round" })).prompt).toBeUndefined();
  });

  it("their /goal command answers in its own words", async () => {
    const root = await ws();
    expect(await runGoalCommand(root, "")).toMatchObject({ kind: "success", text: "No goal is currently set.\nUsage: /goal [<objective>|clear|edit <objective>|pause|resume]" });
    expect((await runGoalCommand(root, "Add CSV export")).text).toContain("Goal created\nStatus: active\nObjective: Add CSV export\nRounds: 0/256");
    expect((await runGoalCommand(root, "pause")).text).toContain("Goal paused\nStatus: paused");
    expect((await runGoalCommand(root, "resume")).text).toContain("Goal resumed\nStatus: active");
    expect((await runGoalCommand(root, "edit Add JSON export")).text).toContain("Goal updated\nStatus: active\nObjective: Add JSON export");
    expect(await runGoalCommand(root, "clear")).toMatchObject({ kind: "success", text: "Goal cleared.", goal: null });
  });

  it("their system-prompt goal policy is what their runtime assembles", async () => {
    const policy = await engineGoalPolicy();
    expect(policy.startsWith("create_goal may infer goal intent from a direct human request in any language.")).toBe(true);
    expect(policy).toContain("at least 3 consecutive goal rounds");
    // The workspace rule carries the same text, word for word.
    expect(DEEPSEEK_GOAL_POLICY).toBe(policy);
    expect(guardianRuleContent()).toContain(policy);
  });

  it("runGoalTool fills in the current goal's id and revision for a call in Codex's shape", async () => {
    const root = await ws();
    await engineApply(root, "Add CSV export", "none", { type: "sync" });
    const out = await runGoalTool(root, "update_goal", { action: "complete" });
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text)).toMatchObject({ goal: { phase: "complete" } });
  });
});
