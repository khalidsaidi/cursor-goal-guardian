import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldGoal } from "@deepseek-ai/dsh-goal";
import {
  EngineRefused, appendAudit, controlGoal, criteriaFromTexts, defaultContract, engineApply, engineEvents, engineView, getGuardianPaths, goalPhaseOf, goalTurnContext, legacyGoalPhase,
  nowIso, readAuditTail, readContractSafe, readGoalRecords, recordShellOutput, recordUserPrompt, runGoalStop, submitGoalReport, captureGoal, goalHash,
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
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(["goal/change", "session/end-seed", "turn/start", "user/message", "turn/end"]));
    const folded = foldGoal(events as never);
    expect(await view(root)).toEqual({ ...folded.goal, roundsStarted: folded.roundsStarted });
    expect(folded).toMatchObject({ goal: { phase: "complete", revision: 5 }, roundsStarted: 2 });
    // The rounds are attributed to the goal the way their round driver attributes them.
    const rounds = events.filter((e) => e.type === "user/message").map((e) => (e.data as { source: Record<string, unknown> }).source);
    expect(rounds).toMatchObject([{ kind: "goal", revision: 1, round: 1 }, { kind: "goal", revision: 1, round: 2 }]);
  });

  it("refuses what their service refuses, with their error, and saves nothing", async () => {
    const root = await ws();
    await engineApply(root, "Add CSV export", "none", { type: "block", code: "model-reported", message: "stuck" });
    const before = (await readAuditTail(root, 1000)).length;
    const err = await engineApply(root, "Add CSV export", "none", { type: "pause" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineRefused);
    expect((err as EngineRefused).code).toBe("GOAL_INVALID_TRANSITION");
    expect((err as EngineRefused).message).toMatch(/^cannot pause goal "goal-[0-9a-f-]+" from phase "blocked"; expected active$/);
    await expect(engineApply(root, "Add CSV export", "none", { type: "round" })).rejects.toMatchObject({ code: "GOAL_INVALID_TRANSITION" });
    await expect(engineApply(root, "Add CSV export", "none", { type: "block", code: "Not Kebab", message: "x" })).rejects.toMatchObject({ code: "GOAL_INVALID_TRANSITION" });
    expect((await readAuditTail(root, 1000)).length).toBe(before);
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

  it("the round cap is theirs: their fold counts rounds and the service's default of 256 holds", async () => {
    const root = await ws();
    let goal = (await engineApply(root, "Add CSV export", "none", { type: "sync" }))!;
    expect(goal.maxGoalRounds).toBe(256);
    for (let i = 0; i < 256; i += 1) goal = (await engineApply(root, "Add CSV export", "none", { type: "round" }))!;
    expect(goal.roundsStarted).toBe(256);
    await expect(engineApply(root, "Add CSV export", "none", { type: "round" })).rejects.toMatchObject({ code: "round-limit" });
    // Their own rule: a goal out of rounds can't be resumed until its cap is raised.
    await engineApply(root, "Add CSV export", "none", { type: "block", code: "round-limit", message: "out of rounds" });
    await expect(engineApply(root, "Add CSV export", "none", { type: "resume" })).rejects.toMatchObject({ code: "GOAL_INVALID_TRANSITION", message: expect.stringContaining("exhausted 256 goal rounds") });
  }, 120_000);

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
    expect(await view(root)).toMatchObject({ objective: "Add CSV export", phase: "active", roundsStarted: 0 });
    await edit(root);
    expect(await stop(root)).toContain("Round: 1/256");
    await edit(root);
    expect(await stop(root, 1)).toContain("Round: 2/256");
    expect((await view(root))!.roundsStarted).toBe(2);
    await tick();
    await recordShellOutput(root, { command: "make test", output: "12 passed", durationMs: 0 });
    process.env.GOAL_GUARDIAN_REVIEWER = "/nonexistent/reviewer";
    const answer = await submitGoalReport(root, { status: "complete", proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }, { criterion: "sc_2", command: "make test", quote: "12 passed" }], changes: [{ file: "a.js", serves: "sc_1" }] });
    delete process.env.GOAL_GUARDIAN_REVIEWER;
    expect(answer.accepted).toBe(true);
    // Accepted, but the goal is completed where the run ends, with its receipts.
    expect((await view(root))!.phase).toBe("active");
    expect(await stop(root, 2)).toBeNull();
    expect(await view(root)).toMatchObject({ phase: "complete", roundsStarted: 2 });
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
    expect((await submitGoalReport(root, { status: "paused", proofs: [], changes: [], userWords: "pause this goal for now" })).accepted).toBe(true);
    expect((await view(root))!.phase).toBe("paused");
    await controlGoal(root, "done");
    expect((await view(root))!.phase).toBe("complete");
  });

  it("a blocked goal is their blocked phase, and the user's next message in agent mode resumes it", async () => {
    const root = await ws();
    await recordUserPrompt(root, "go", "c1", "agent");
    const blocked = { status: "blocked" as const, proofs: [], changes: [], reason: "the registry is down" };
    for (let n = 0; n < 2; n += 1) {
      await edit(root);
      expect(await stop(root, n)).not.toBeNull();
    }
    await edit(root);
    expect((await submitGoalReport(root, blocked)).accepted).toBe(true);
    expect(await stop(root, 2)).toBeNull();
    expect(await view(root)).toMatchObject({ phase: "blocked", blockedReason: { code: "model-reported", message: "the registry is down" } });
    expect((await readGoalRecords(root)).filter((r) => r.kind === "goal.end")).toMatchObject([{ outcome: "blocked" }]);
    // The next message from the user is the human-authorized edge.
    expect(await goalTurnContext(root)).toContain("open goal");
    expect((await view(root))!.phase).toBe("active");
  });
});
