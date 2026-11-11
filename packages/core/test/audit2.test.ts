/**
 * What a second independent audit found wrong at 39fb9e8, as tests: a proof naming a file that isn't there, a goal
 * file rewritten behind the user's back, stops that said nothing, and inputs Guardian made up for the goal keepers.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  absentPathsIn, appendAudit, defaultContract, getGuardianPaths, goalStopFailed, nowIso, readAuditTail, readContractSafe, recordShellOutput, recordUserPrompt,
  runGoalStop, submitGoalReport, writeContract, GOAL_RESTORED,
} from "../src/index.js";

const made: string[] = [];
const savedEnv = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnv };
  for (const d of made.splice(0)) await fsp.rm(d, { recursive: true, force: true });
});
const tick = () => new Promise((r) => setTimeout(r, 3));

const GOAL = { goal: "Add CSV export", successCriteria: [{ id: "sc_1", text: "the export works" }, { id: "sc_2", text: "a test covers it and passes" }] };

/** A git project whose goal the user set (written the way Guardian writes it on their authority). */
async function repo(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gg-audit2-"));
  made.push(root);
  const p = getGuardianPaths(root);
  await fsp.mkdir(p.telemetryDir, { recursive: true });
  await fsp.writeFile(p.config, "{}");
  await writeContract(root, { ...defaultContract(), ...GOAL });
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  sh("init", "-q");
  await fsp.writeFile(path.join(root, "a.js"), "one\n");
  sh("add", "a.js");
  sh("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
  return root;
}
const TEST_CMD = "node test/export.test.js";
async function work(root: string, withTestFile = true): Promise<void> {
  await recordUserPrompt(root, "add the export", "c1", "agent");
  await tick();
  await fsp.writeFile(path.join(root, "a.js"), "exports.csv = () => 'a,b';\n");
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
  if (withTestFile) {
    await fsp.mkdir(path.join(root, "test"), { recursive: true });
    await fsp.writeFile(path.join(root, "test", "export.test.js"), "console.log('1 pass');\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "test/export.test.js", conversationId: "c1" });
  }
  await tick();
  await recordShellOutput(root, { command: TEST_CMD, output: "1 pass\n", durationMs: 0 });
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: TEST_CMD, conversationId: "c1" });
}
const report = (withTestFile = true) => ({
  status: "complete" as const,
  proofs: [{ criterion: "sc_1", file: "a.js", contains: "exports.csv" }, { criterion: "sc_2", command: TEST_CMD, quote: "1 pass" }],
  changes: [{ file: "a.js", serves: "sc_1" }, ...(withTestFile ? [{ file: "test/export.test.js", serves: "sc_2" }] : [])],
});
const stop = (root: string, n = 0) => runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: n });
const kinds = async (root: string, kind: string) => (await readAuditTail(root, 3000)).filter((r) => r.kind === kind) as Array<Record<string, unknown>>;

describe("a proof that names a file the project doesn't have", () => {
  it("is refused by Guardian's own check, whatever the command printed and whatever a judge would say", async () => {
    const root = await repo();
    await work(root, false);
    const answer = await submitGoalReport(root, report(false));
    expect(answer.accepted).toBe(false);
    expect(answer.unproved).toEqual([expect.stringContaining("`node test/export.test.js` names test/export.test.js, which isn't in the project")]);
    expect(await kinds(root, "goal.review")).toHaveLength(0);
    expect(await kinds(root, "goal.end")).toHaveLength(0);
    // With the file really there the same report is accepted.
    await fsp.mkdir(path.join(root, "test"), { recursive: true });
    await fsp.writeFile(path.join(root, "test", "export.test.js"), "console.log('1 pass');\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "test/export.test.js", conversationId: "c1" });
    await tick();
    await recordShellOutput(root, { command: TEST_CMD, output: "1 pass\n", durationMs: 0 });
    expect(await submitGoalReport(root, report(true))).toMatchObject({ accepted: true, outcome: "proved" });
  });

  it("only real path arguments count, in any language: not quoted code, options, redirects, or files in a subfolder", async () => {
    const root = await repo();
    await fsp.mkdir(path.join(root, "pkg", "spec"), { recursive: true });
    await fsp.writeFile(path.join(root, "pkg", "spec", "t.rb"), "");
    expect(absentPathsIn(root, "node -e \"console.log(require('./a.js').csv())\"")).toEqual([]);
    expect(absentPathsIn(root, "make test --jobs=4 > out.log 2>&1")).toEqual([]);
    expect(absentPathsIn(root, "cd pkg && ruby spec/t.rb")).toEqual([]);
    expect(absentPathsIn(root, "pytest tests/test_export.py -k csv")).toEqual(["tests/test_export.py"]);
    expect(absentPathsIn(root, "go test ./missing/... ; cargo test")).toEqual([]);
    expect(absentPathsIn(root, "node a.js && node gone.js")).toEqual(["gone.js"]);
  });
});

describe("the goal is the user's", () => {
  it("a contract file rewritten by a command to drop an item is put back, said to the agent, and never counted", async () => {
    const root = await repo();
    await work(root);
    const file = getGuardianPaths(root).contract;
    // What the audit did: a shell command rewrites Guardian's goal file, dropping the test item.
    await fsp.writeFile(file, JSON.stringify({ ...defaultContract(), goal: GOAL.goal, successCriteria: [GOAL.successCriteria[0]] }));
    const answer = await submitGoalReport(root, { status: "complete", proofs: [{ criterion: "sc_1", file: "a.js", contains: "exports.csv" }], changes: [{ file: "a.js", serves: "sc_1" }, { file: "test/export.test.js", serves: "sc_1" }] });
    expect(answer.accepted).toBe(false);
    expect(answer.message).toContain(GOAL_RESTORED);
    expect(answer.message).toContain("sc_2: a test covers it and passes");
    expect((await readContractSafe(root)).successCriteria).toEqual(GOAL.successCriteria);
    expect(await kinds(root, "goal.restored")).toMatchObject([{ found: expect.stringContaining("the export works") }]);
    expect(await kinds(root, "goal.end")).toHaveLength(0);
    // The same at a stop: put back, and said in the send-back.
    await fsp.writeFile(file, JSON.stringify({ ...defaultContract(), goal: "Something smaller", successCriteria: [] }));
    const round = (await stop(root))!;
    expect(round).toContain(GOAL_RESTORED);
    expect(round).toContain("- sc_2: a test covers it and passes");
    expect((await readContractSafe(root)).goal).toBe(GOAL.goal);
    expect(await kinds(root, "goal.restored")).toHaveLength(2);
  });

  it("a change made on the user's authority stands", async () => {
    const root = await repo();
    await work(root);
    await writeContract(root, { ...defaultContract(), goal: "Add CSV and JSON export", successCriteria: GOAL.successCriteria });
    await stop(root);
    expect((await readContractSafe(root)).goal).toBe("Add CSV and JSON export");
    expect(await kinds(root, "goal.restored")).toHaveLength(0);
  });
});

describe("nothing stops in silence", () => {
  it("a goal log another process holds is waited for, and then the run ends unverified and the agent is told", async () => {
    const root = await repo();
    await work(root);
    const lock = path.join(getGuardianPaths(root).telemetryDir, "engine.lock");
    await fsp.mkdir(lock);
    const fresh = setInterval(() => void fsp.utimes(lock, new Date(), new Date()).catch(() => undefined), 500);
    try {
      const said = (await stop(root))!;
      expect(said).toContain("DeepSeek's goal code didn't run: the goal is being changed by another process");
      expect(said).toContain("can't keep this goal going or record it as proved");
    } finally {
      clearInterval(fresh);
      await fsp.rm(lock, { recursive: true, force: true });
    }
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "unverified", by: "deepseek" }]);
  }, 40_000);

  it("a stop handler that fails is recorded as unverified and said once", async () => {
    const root = await repo();
    await work(root);
    const said = (await goalStopFailed(root, "c1", new Error("disk went away")))!;
    expect(said).toContain("Guardian's stop handler failed: disk went away, so this goal was neither kept going nor verified.");
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "unverified", by: "guardian", reason: "Guardian's stop handler failed: disk went away" }]);
    expect(await goalStopFailed(root, "c1", new Error("again"))).toBeNull();
    expect(await goalStopFailed(root, undefined, new Error("no chat"))).toBeNull();
  });
});

describe("nothing is made up for the goal keepers", () => {
  it("DeepSeek's session gets the user's own message, not a stand-in for it", async () => {
    const root = await repo();
    await recordUserPrompt(root, "add the export, with a test", "c1", "agent");
    const said = (await kinds(root, "goal.engine")).map((r) => r.event as { type: string; data?: { source?: { kind: string }; content?: Array<{ text?: string }> } }).filter((e) => e.type === "user/message");
    expect(said).toHaveLength(1);
    expect(said[0]!.data!.source).toEqual({ kind: "user" });
    expect(said[0]!.data!.content![0]!.text).toBe("add the export, with a test");
  });

  it("Codex's goal is not re-created on the way to asking it: an emptied store ends the run unverified until the user speaks again", async () => {
    const root = await repo();
    await work(root);
    await fsp.rm(path.join(getGuardianPaths(root).dir, "codex"), { recursive: true, force: true });
    const answer = await submitGoalReport(root, report());
    expect(answer).toMatchObject({ accepted: false, outcome: "unverified", refusedBy: "codex" });
    expect(answer.message).toContain("Codex's goal store holds no goal while DeepSeek's log has an open one");
    expect(await kinds(root, "goal.end")).toMatchObject([{ outcome: "unverified", by: "codex" }]);
    // The user's next message is what puts the goal back into Codex's store.
    await recordUserPrompt(root, "carry on and finish it", "c1", "agent");
    await tick();
    await recordShellOutput(root, { command: TEST_CMD, output: "1 pass\n", durationMs: 0 });
    expect(await submitGoalReport(root, report())).toMatchObject({ accepted: true });
  });

  it("each round's record says who let it start, and that arming the goal in this process was Guardian's doing", async () => {
    const root = await repo();
    await work(root);
    expect(await stop(root)).toContain("<goal_round>");
    const [round] = await kinds(root, "goal.round");
    expect(round).toMatchObject({ armedByGuardian: true, decidedBy: { guardian: expect.stringContaining("its gates passed"), deepseek: "its round driver admitted round 1 of 256", codex: "its scheduling submitted a continuation turn" } });
  });
});
