/**
 * What a third independent audit found that an ordinary, honest agent or user can hit, as tests: verdicts read too
 * loosely, a goal never recorded when work went through commands, "the user's words" taken too easily, and a block
 * accepted on the first turn with nothing to say it was only the agent's word.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, buildPanelViewModel, defaultContract, getGuardianPaths, goalCommandIn, goalHash, nowIso, parseEvaluator, readAuditTail, readContractSafe, readGoalRecords,
  recordShellOutput, recordUserPrompt, runGoalStop, runUserGoalCommand, setEngineGoal, submitGoalReport, userAsked, writeContract, type AuditRecord,
} from "../src/index.js";

const made: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnv };
  for (const d of made.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});
const tick = () => new Promise((r) => setTimeout(r, 3));

async function folder(git: boolean): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gg-audit3-"));
  made.push(root);
  const p = getGuardianPaths(root);
  await fsp.mkdir(p.telemetryDir, { recursive: true });
  await fsp.writeFile(p.config, "{}");
  await fsp.writeFile(p.contract, JSON.stringify(defaultContract()));
  await fsp.writeFile(path.join(root, "a.js"), "one\n");
  if (git) {
    const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    sh("init", "-q");
    sh("add", "a.js");
    sh("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  }
  return root;
}
const ran = async (root: string, command: string): Promise<void> => {
  await recordShellOutput(root, { command, output: "12 passed\n", durationMs: 0 });
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: command, conversationId: "c1" });
};
const stop = (root: string, n = 0) => runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: n });
const kinds = async (root: string, kind: string) => (await readAuditTail(root, 3000)).filter((r) => r.kind === kind) as Array<Record<string, unknown>>;

describe("work done through commands still becomes the goal", () => {
  it("a change committed before the turn ended: the commit the project moved to shows it", async () => {
    const root = await folder(true);
    await recordUserPrompt(root, "Add the export", "c1", "agent");
    await tick();
    await fsp.writeFile(path.join(root, "a.js"), "two\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "work"], { cwd: root, stdio: "ignore" });
    await ran(root, "sed -i s/one/two/ a.js && git commit -qam work");
    // The tree is clean again, so nothing looks changed: only the commit moved.
    const sent = await stop(root);
    expect((await readContractSafe(root)).goal).toBe("Add the export");
    expect(await kinds(root, "goal.set")).toHaveLength(1);
    expect(sent).toContain("No report yet");
  });

  it("no command ran: a commit the user made themselves isn't the agent's work", async () => {
    const root = await folder(true);
    await recordUserPrompt(root, "what does a.js do?", "c1", "agent");
    await tick();
    await fsp.writeFile(path.join(root, "a.js"), "two\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "mine"], { cwd: root, stdio: "ignore" });
    expect(await stop(root)).toBeNull();
    expect((await readContractSafe(root)).goal).toBe("");
  });

  it("outside git, a command's change is seen against the folder as it was when the user's message arrived", async () => {
    const root = await folder(false);
    await recordUserPrompt(root, "Add the export", "c1", "agent");
    await tick();
    await fsp.writeFile(path.join(root, "b.js"), "new\n");
    await ran(root, "echo new > b.js");
    const sent = await stop(root);
    expect((await readContractSafe(root)).goal).toBe("Add the export");
    expect(sent).toContain("Changed, not accounted for: b.js");
  });

  it("outside git with nothing changed, nothing is recorded", async () => {
    const root = await folder(false);
    await recordUserPrompt(root, "list the files", "c1", "agent");
    await tick();
    await ran(root, "ls");
    expect(await stop(root)).toBeNull();
    expect((await readContractSafe(root)).goal).toBe("");
  });
});

describe("the user's words are the user's latest words, and not the goal quoted back", () => {
  const GOAL = "Add a subtract function\n- subtract(a, b) returns a - b\n- a test covers it";
  it("a piece of the goal itself, or words from an earlier message, don't count", () => {
    const earlier = "leave the docs alone for now please";
    const latest = "Add a subtract function. Done when:\n1. subtract(a, b) returns a - b\n2. a test covers it\nDo only item 1 for now, then stop.";
    expect(userAsked("Add a subtract", [earlier, latest], GOAL)).toBe(false);
    expect(userAsked("1. subtract(a, b) returns a - b", [earlier, latest], GOAL)).toBe(false);
    expect(userAsked("leave the docs alone for now", [earlier, latest], GOAL)).toBe(false);
    expect(userAsked("Do only item 1 for now, then stop.", [earlier, latest], GOAL)).toBe(true);
    // The whole message, limit and all, is the user asking.
    expect(userAsked(latest, [earlier, latest], GOAL)).toBe(true);
  });

  it("set_aside quoting the goal is refused, in the report and at the stop", async () => {
    const root = await folder(true);
    await writeContract(root, { ...defaultContract(), goal: "Add a subtract function", successCriteria: [{ id: "sc_1", text: "subtract(a, b) returns a - b" }] });
    await recordUserPrompt(root, "Add a subtract function. Done when:\n1. subtract(a, b) returns a - b", "c1", "agent");
    await tick();
    await fsp.writeFile(path.join(root, "a.js"), "two\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    const aside = await submitGoalReport(root, { status: "set_aside", proofs: [], changes: [], userWords: "Add a subtract" });
    expect(aside).toMatchObject({ accepted: false, message: expect.stringContaining("a piece of the goal itself") });
    expect(await stop(root)).not.toBeNull();
    expect((await kinds(root, "goal.end")).filter((e) => e.outcome === "set_aside")).toHaveLength(0);
  });

  it("their /goal command runs only when the user's message is the command, not when it merely contains the word", async () => {
    expect(goalCommandIn("/goal pause")).toBe("pause");
    expect(goalCommandIn("  /guardian-goal edit Ship it  ")).toBe("edit Ship it");
    expect(goalCommandIn("please don't pause until it's done")).toBeNull();
    expect(goalCommandIn("/goalie pause")).toBeNull();
    const root = await folder(true);
    await writeContract(root, { ...defaultContract(), goal: "Add the export", successCriteria: [] });
    await recordUserPrompt(root, "Add the export", "c1", "agent");
    expect(await setEngineGoal(root, "Add the export", true)).toBe(true);
    await tick();
    await recordUserPrompt(root, "keep going, and don't pause or clear anything until the export works", "c1", "agent");
    for (const word of ["pause", "clear"]) {
      expect(await runUserGoalCommand(root, word)).toMatchObject({ kind: "error", text: expect.stringContaining("has to be the command itself") });
    }
    expect((await kinds(root, "goal.control"))).toHaveLength(0);
    expect((await readContractSafe(root)).goal).toBe("Add the export");
    // The user really types the command: it runs, and the record says the user paused it.
    await recordUserPrompt(root, "/guardian-goal pause", "c1", "agent");
    expect(await runUserGoalCommand(root, "pause")).toMatchObject({ kind: "success" });
    expect(await kinds(root, "goal.control")).toMatchObject([{ operation: "pause", actor: "user" }]);
    // What runs is what the user typed, not what the agent passes.
    expect(await runUserGoalCommand(root, "clear")).toMatchObject({ kind: "error" });
  });
});

describe("a block accepted on the first turn says it was the agent's word", () => {
  it("the agent is told, the record says so, and the panel shows 'blocked (unverified)'", async () => {
    const root = await folder(true);
    await writeContract(root, { ...defaultContract(), goal: "Add the export", successCriteria: [{ id: "sc_1", text: "it works" }] });
    await recordUserPrompt(root, "Add the export", "c1", "agent");
    await tick();
    await fsp.writeFile(path.join(root, "a.js"), "two\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    const answer = await submitGoalReport(root, { status: "blocked", proofs: [], changes: [], reason: "needs the API key" });
    expect(answer.accepted).toBe(true);
    expect(answer.message).toContain("on the first turn, at your word alone");
    expect(await stop(root)).toBeNull();
    const ends = await kinds(root, "goal.end");
    expect(ends).toMatchObject([{ outcome: "blocked", by: "deepseek", atAgentsWord: true, reason: "needs the API key" }]);
    const contract = await readContractSafe(root);
    const vm = buildPanelViewModel({ setUp: true, contract, records: await readAuditTail(root, 3000), goalRecords: (await readGoalRecords(root)) as AuditRecord[], now: new Date() });
    expect(vm.status).toEqual({ lamp: "warn", word: "blocked (unverified)" });
    expect(goalHash(contract)).toBe(ends[0]!.goalHash);
  });

  it("a block accepted after their three goal rounds is not marked that way", async () => {
    const root = await folder(true);
    await writeContract(root, { ...defaultContract(), goal: "Add the export", successCriteria: [{ id: "sc_1", text: "it works" }] });
    await recordUserPrompt(root, "Add the export", "c1", "agent");
    await tick();
    for (let n = 0; n < 3; n += 1) {
      await fsp.writeFile(path.join(root, "a.js"), `state ${n}\n`);
      await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
      expect(await stop(root, n)).not.toBeNull();
      await tick();
    }
    const answer = await submitGoalReport(root, { status: "blocked", proofs: [], changes: [], reason: "needs the API key" });
    expect(answer.accepted).toBe(true);
    expect(answer.message).not.toContain("at your word alone");
    expect(await stop(root, 3)).toBeNull();
    const [end] = await kinds(root, "goal.end");
    expect(end).toMatchObject({ outcome: "blocked" });
    expect(end).not.toHaveProperty("atAgentsWord");
  });
});

describe("the evaluator's verdicts are read strictly too", () => {
  it("a rubric that came back without a score is unanswered, not met", () => {
    const out = parseEvaluator(JSON.stringify({ ran: true, overall: 1, rubrics: [{ id: "sc_1", property: "p", score: 1, rationale: "ok" }, { id: "sc_2", property: "q", score: null, rationale: "" }], calls: 5, seconds: 2 }), ["sc_1", "sc_2", "extra"]);
    expect(out).toMatchObject({ ran: true, failed: [], unanswered: ["sc_2", "extra"] });
  });

  it("a reviewer that answers for no item, or leaves one out, leaves the run unchecked, never proved", async () => {
    const root = await folder(true);
    await writeContract(root, { ...defaultContract(), goal: "Add the export", successCriteria: [{ id: "sc_1", text: "it works" }, { id: "sc_2", text: "a test passes" }] });
    await recordUserPrompt(root, "Add the export", "c1", "agent");
    await tick();
    await fsp.writeFile(path.join(root, "a.js"), "two\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    await tick();
    await ran(root, "make test");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gg-audit3-rev-"));
    made.push(dir);
    const reviewer = path.join(dir, "reviewer");
    await fsp.writeFile(reviewer, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify({ items: [{ id: "sc_1", verdict: "holds", evidence: "ok" }], extra: [] }) }) + "\\n");\n`);
    await fsp.chmod(reviewer, 0o755);
    process.env.GOAL_GUARDIAN_REVIEWER = reviewer;
    const report = { status: "complete" as const, proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }, { criterion: "sc_2", command: "make test", quote: "12 passed" }], changes: [{ file: "a.js", serves: "sc_1" }] };
    const answer = await submitGoalReport(root, report);
    expect(answer).toMatchObject({ accepted: true, outcome: "unchecked" });
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "unchecked", skipped: [expect.stringContaining("the reviewer gave no clear verdict on sc_2")] }]);
    expect(await kinds(root, "goal.review")).toMatchObject([{ ran: true, unanswered: ["sc_2"] }]);
  });
});
