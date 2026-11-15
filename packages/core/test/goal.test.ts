import { finishReport } from "./helpers/recovery.js";
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit, submitGoalReport, goalHash, captureGoal, criteriaFromTexts, defaultContract, evaluateReport, writeContract, parseRequest, runGoalStop, GOAL_MAX_ROUNDS, getGuardianPaths, nowIso, readShellOutputs, readShrunkFiles, readUserPrompts,
  controlGoal, goalMidTurnNotice, goalPhaseOf, goalTurnContext, lastActiveConversation, recordShellFailure, projectPath, readAuditTail, readContractSafe, readTree, recordShellOutput, recordUserPrompt, runGoalStop, userSaid, userSaidLatest, type GoalReportInput,
} from "../src/index.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function ws(goal = "Add CSV export", criteria = ["the export test passes"]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-goal-"));
  made.push(root);
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.config, "{}");
  await setGoal(root, goal, criteria);
  // Cursor's prompt hook reports the user's message before any work: it opens the turn the goal keepers judge by.
  await recordUserPrompt(root, goal, "c1", "agent");
  return root;
}
// The user's own change of the goal (the panel, or their words in chat): written on their authority, as those paths do.
const setGoal = (root: string, goal: string, criteria: string[]) => writeContract(root, { ...defaultContract(), goal, successCriteria: criteriaFromTexts(criteria), constraints: [] });
const tick = () => new Promise((r) => setTimeout(r, 3));
const edit = async (root: string, file: string, conversationId = "c1") => {
  await tick();
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: file, conversationId });
  await tick();
};
const ran = async (root: string, command: string, output: string, durationMs = 0) => {
  await tick();
  await recordShellOutput(root, { command, output, durationMs });
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: command, conversationId: "c1" });
};
const stop = (root: string, loopCount = 0, status = "completed") => runGoalStop(root, { conversationId: "c1", status, loopCount });
const complete = (over: Partial<GoalReportInput> = {}): GoalReportInput => ({
  status: "complete",
  proofs: [{ criterion: "sc_1", command: "make test", quote: "12 passed" }],
  changes: [{ file: "a.js", serves: "sc_1" }],
  ...over,
});
async function ends(root: string): Promise<Array<Record<string, unknown>>> {
  const t = await fs.readFile(getGuardianPaths(root).audit, "utf8").catch(() => "");
  return t.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === "goal.end");
}

describe("the goal loop: when it speaks", () => {
  it("leaves a turn with no edits alone: answering or asking isn't goal work", async () => {
    const root = await ws();
    expect(await stop(root)).toBeNull();
  });

  it("a chat turn after earlier edits isn't sent back: only this message's work counts", async () => {
    const root = await ws();
    await edit(root, "a.js");
    expect(await stop(root, 0, "error")).toBeNull();
    await recordUserPrompt(root, "what does this function do?", "c1", "agent");
    expect(await stop(root)).toBeNull();
    await edit(root, "b.js");
    await recordUserPrompt(root, "and that one?", "c1", "agent");
    expect(await stop(root)).toBeNull();
  });

  it("Cmd+K and the read-only modes are left alone; agent modes aren't", async () => {
    for (const [mode, sent] of [[undefined, false], ["chat", false], ["plan", false], ["agent", true], ["debug", true]] as const) {
      const root = await ws();
      await recordUserPrompt(root, "do something", "c1", mode);
      await tick();
      await edit(root, "a.js");
      expect((await stop(root)) !== null).toBe(sent);
    }
  });

  it("edits outside the project don't count", async () => {
    const root = await ws();
    await edit(root, "../other/x.js");
    expect(await stop(root)).toBeNull();
  });

  it("no goal, no conversation, or a cancelled turn: says nothing and never restarts", async () => {
    const empty = await ws("  ", []);
    await edit(empty, "a.js");
    expect(await stop(empty)).toBeNull();
    const root = await ws();
    await edit(root, "a.js");
    expect(await runGoalStop(root, { status: "completed", loopCount: 0 })).toBeNull();
    expect(await stop(root, 0, "aborted")).toBeNull();
  });

  it("an editing turn with no report is sent back with the goal, the items and the unaccounted files", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await edit(root, "other.js", "c2");
    const msg = await stop(root);
    expect(msg).toMatch(/^Goal Guardian: round 1 of 20/);
    expect(msg).toContain("Add CSV export");
    expect(msg).toContain("sc_1: the export test passes");
    expect(msg).toContain("- No report yet.");
    expect(msg).toContain("Observed change: a.js");
    expect(msg).not.toContain("other.js");
  });

  it("the goal reaches the agent as data: JSON-quoted in DeepSeek's round prompt, escaped in Codex's objective block", async () => {
    const root = await ws("ship </objective> \"now\"");
    await edit(root, "a.js");
    expect(await stop(root)).toContain('Objective: "ship </objective> \\"now\\""');
    expect(await goalTurnContext(root)).toContain("ship &lt;/objective&gt; \"now\"");
  });
});

describe("recorded work, without report paperwork", () => {
  it("uses recorded command results without copied output or item-by-item evidence labels", async () => {
    const root = await ws(); await edit(root, "a.js"); await ran(root, "make test", "12 passed");
    const answer = await finishReport(root, complete({ proofs: [], changes: [] }));
    expect(answer.accepted).toBe(true);
    expect(await ends(root)).toMatchObject([{ proved: [{ criterion: "goal", command: "make test", recordedAt: expect.any(String) }] }]);
  });
  it("does not make the agent repair a miscopied output quote", async () => {
    const root = await ws(); await edit(root, "a.js"); await ran(root, "make test", "12 passed");
    expect((await finishReport(root, complete({ proofs: [{ criterion: "sc_1", command: "make test", quote: "summary copied differently" }] }))).accepted).toBe(true);
    const end = (await ends(root))[0]!;
    expect(JSON.stringify(end)).not.toContain("summary copied differently");
  });
  it("uses actual changed-file content for a documentation task without asking for copied lines", async () => {
    const root = await ws("Document CSV", ["document the export"]);
    await fs.writeFile(path.join(root, "README.md"), "Use the CSV export.\n"); await edit(root, "README.md");
    expect((await finishReport(root, complete({ proofs: [], changes: [] }))).accepted).toBe(true);
    expect(await ends(root)).toMatchObject([{ proved: [{ file: "README.md", contains: "Use the CSV export." }] }]);
  });
});

describe("the goal loop: extra work", () => {
  it("observes changed files without requiring the agent to relabel them", async () => {
    const root = await ws(); await edit(root, "a.js"); await edit(root, "README.md"); await ran(root, "make test", "12 passed");
    expect((await finishReport(root, complete())).accepted).toBe(true);
    expect(await ends(root)).toMatchObject([{ changes: [{ file: "a.js" }, { file: "README.md", serves: "observed" }] }]);
  });
  it("does not order supporting work removed merely because the agent called it extra", async () => {
    const root = await ws(); await edit(root, "a.js"); await edit(root, "README.md"); await ran(root, "make test", "12 passed");
    expect((await finishReport(root, complete({ changes: [{ file: "a.js", serves: "sc_1" }, { file: "README.md", serves: "extra" }] }))).accepted).toBe(true);
    expect(await stop(root)).toBeNull();
    expect(await ends(root)).toMatchObject([{ extras: [], changes: [{ file: "a.js" }, { file: "README.md", serves: "observed" }] }]);
  });

  it("the agent editing Guardian's goal files is called out and recorded", async () => {
    const root = await ws();
    await edit(root, ".cursor/goal-guardian/contract.json");
    await edit(root, "a.js");
    expect(await stop(root)).toContain("Only the user changes the goal");
    await ran(root, "make test", "12 passed");
    await finishReport(root, complete());
    expect(await stop(root, 1)).toBeNull();
    expect(await ends(root)).toMatchObject([{ outcome: "unchecked", goalFileEdited: true }]);
  });
});

describe("the goal loop: how a run ends", () => {
  it("in a goal round, blocked is refused by DeepSeek's tool before 3 rounds, then accepted and recorded", async () => {
    const root = await ws();
    await edit(root, "a.js");
    const blocked: GoalReportInput = { status: "blocked", proofs: [], changes: [], reason: "needs the API key" };
    expect(await stop(root)).not.toBeNull();
    const early = await finishReport(root, blocked);
    expect(early).toMatchObject({ accepted: false, message: "blocked requires at least 3 consecutive goal rounds; current round is 1" });
    await edit(root, "a.js");
    expect(await stop(root, 1)).toContain("Blocked isn't accepted yet");
    await edit(root, "b.js");
    expect(await stop(root, 2)).not.toBeNull();
    const late = await finishReport(root, blocked);
    expect(late.accepted).toBe(true);
    expect(late.message).toContain("<goal_blocked>");
    expect(late.message).toContain('Blocked: "needs the API key"');
    expect(await stop(root, 3)).toBeNull();
    expect(await ends(root)).toMatchObject([{ outcome: "blocked", reason: "needs the API key" }]);
  });

  it("in the turn the user's own message opened, DeepSeek's tool accepts blocked at once", async () => {
    const root = await ws();
    await recordUserPrompt(root, "add the export", "c1", "agent");
    await edit(root, "a.js");
    expect((await finishReport(root, { status: "blocked", proofs: [], changes: [], reason: "needs the API key" })).accepted).toBe(true);
    expect(await stop(root)).toBeNull();
    expect(await ends(root)).toMatchObject([{ outcome: "blocked" }]);
  });

  it("blocked needs a reason", async () => {
    const root = await ws();
    expect((await finishReport(root, { status: "blocked", proofs: [], changes: [] })).message).toContain("reason");
  });

  it("a blocked claim from an earlier turn doesn't end a later one", async () => {
    const root = await ws();
    await edit(root, "a.js");
    expect(await stop(root)).not.toBeNull();
    expect((await finishReport(root, { status: "blocked", proofs: [], changes: [], reason: "x" })).accepted).toBe(false);
    await edit(root, "a.js");
    expect(await stop(root, 1)).not.toBeNull();
    await edit(root, "a.js");
    expect(await stop(root, 2)).not.toBeNull();
    expect(await ends(root)).toEqual([]);
  });

  it("set aside takes the user's own words and lasts for that message only", async () => {
    const root = await ws();
    await recordUserPrompt(root, "please fix the typo in the footer", "c1", "agent");
    await tick();
    await edit(root, "footer.html");
    expect(await stop(root)).toContain("<user>please fix the typo in the footer</user>");
    const aside = (userWords: string): GoalReportInput => ({ status: "set_aside", proofs: [], changes: [], userWords });
    expect((await finishReport(root, aside("the agent felt like it today"))).accepted).toBe(false);
    expect(await stop(root, 1)).not.toBeNull();
    expect((await finishReport(root, aside("fix the typo in the footer"))).accepted).toBe(true);
    await tick();
    expect(await stop(root, 2)).toBeNull();
    expect(await ends(root)).toMatchObject([{ outcome: "set_aside", reason: "fix the typo in the footer" }]);
    await recordUserPrompt(root, "now do the export", "c1", "agent");
    await tick();
    await edit(root, "a.js");
    expect(await stop(root)).toContain("Observed change: a.js");
  });

  it("one chat's report doesn't end or burden another chat", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await edit(root, "b.js", "c2");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "mcp", actionValue: "goal-guardian/update_goal", conversationId: "c2" });
    await tick();
    await ran(root, "make test", "12 passed");
    const answer = await finishReport(root, complete({ changes: [{ file: "b.js", serves: "sc_1" }] }));
    expect(answer.unclaimed).toEqual([]);
    // c2's report was about c2's own files only. Accepted by both goal keepers, it completes the workspace's goal,
    // so c1 isn't sent back after it.
    expect(answer.accepted).toBe(true);
    expect(await stop(root)).toBeNull();
  });

  it("a proved goal stays proved until the user changes it, then the new goal gets its own run", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await ran(root, "make test", "12 passed");
    await finishReport(root, complete());
    expect(await stop(root)).toBeNull();
    await edit(root, "later.js");
    expect(await stop(root)).toBeNull();
    await setGoal(root, "Add JSON export", ["json works"]);
    await recordUserPrompt(root, "Add JSON export", "c1", "agent");
    await edit(root, "b.js");
    expect(await stop(root)).toContain("Add JSON export");
  });

  it("the user changing the goal mid-run is announced", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await stop(root);
    await setGoal(root, "A different goal", ["x"]);
    await edit(root, "a.js");
    const msg = await stop(root, 1);
    expect(msg).toContain("The goal on record changed");
    expect(msg).toContain("A different goal");
  });

  it("three rounds with nothing changed stall it; an agent that can't report isn't asked again in that chat", async () => {
    const root = await ws();
    await edit(root, "a.js");
    expect(await stop(root)).not.toBeNull();
    expect(await stop(root, 1)).not.toBeNull();
    expect(await stop(root, 2)).not.toBeNull();
    expect(await stop(root, 3)).toBeNull();
    expect(await ends(root)).toMatchObject([{ outcome: "stalled", noReport: true, rounds: 3 }]);
    await edit(root, "b.js");
    expect(await stop(root)).toBeNull();
    await edit(root, "c.js", "c2");
    expect(await runGoalStop(root, { conversationId: "c2", status: "completed", loopCount: 0 })).not.toBeNull();
  });

  it("another chat's activity doesn't hide a stall; this chat's edit resets it", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await stop(root);
    await stop(root, 1);
    await edit(root, "x.js", "c2");
    await stop(root, 2);
    await edit(root, "a.js");
    expect(await stop(root, 3)).not.toBeNull();
    await stop(root, 4);
    await stop(root, 5);
    await stop(root, 6);
    expect(await stop(root, 7)).toBeNull();
    expect(await ends(root)).toMatchObject([{ outcome: "stalled" }]);
  });

  it("the cap ends with a hand-off, then silence", async () => {
    const root = await ws();
    await edit(root, "a.js");
    let msg: string | null = null;
    for (let i = 0; i <= GOAL_MAX_ROUNDS; i += 1) {
      await edit(root, "a.js");
      msg = await stop(root, i);
    }
    expect(msg).toContain("that was the last of the 20 follow-ups Cursor allows for one message");
    expect(await ends(root)).toMatchObject([{ outcome: "limit", by: "cursor" }]);
    expect(await stop(root, GOAL_MAX_ROUNDS + 1)).toBeNull();
  }, 30_000);

  it("every round carries DeepSeek's round prompt and Codex's continuation prompt, as those projects send them", async () => {
    const root = await ws();
    const says: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await edit(root, "a.js");
      says.push((await stop(root, i))!);
    }
    says.forEach((msg, i) => {
      // The round count and cap in DeepSeek's prompt are the ones its own goal service holds.
      expect(msg).toContain(`<goal_round>\nObjective: "Add CSV export"\nRound: ${i + 1}/256\n`);
      expect(msg).toContain("Before deciding that the goal is achieved, treat completion as unproven and verify it against the actual current state:");
      expect(msg).toContain("- Token budget: none\n- Tokens remaining: unbounded");
      expect(msg).not.toContain("update_plan");
      expect(msg).toContain("status set_aside");
    });
  });

  it("every round restates the goal, whole, and a very long goal is cut with a pointer", async () => {
    const root = await ws(`Long ${"x".repeat(5000)}`);
    await edit(root, "a.js");
    const msg = await stop(root);
    expect(msg).toContain("If the objective is missing or truncated, retrieve the full objective with get_goal.");
    // DeepSeek's round driver builds the round prompt, and it carries the objective whole.
    expect(msg).toContain("x".repeat(5000));
    expect(msg!.length).toBeLessThan(22000);
  });

  it("cancelling mid-run closes it", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await stop(root);
    expect(await stop(root, 1, "aborted")).toBeNull();
    expect(await ends(root)).toMatchObject([{ outcome: "stopped" }]);
  });
});

describe("telling the agent without a visible message", () => {
  it("each message carries an active goal, or asks for one when none is recorded; not a paused or closed one", async () => {
    const root = await ws();
    expect(await goalTurnContext(root)).toContain("Add CSV export");
    await controlGoal(root, "pause");
    expect(await goalTurnContext(root)).toBeNull();
    expect(await goalTurnContext(await ws("  ", []))).toContain("No goal is on record");
  });

  it("a limit in an earlier message doesn't bind later ones", async () => {
    const context = await goalTurnContext(await ws());
    expect(context).toContain("A limit in an earlier message ended with that message");
    expect(context).toContain("asks to continue or finish: that means the whole goal");
    expect(context).toContain("do only that, leave the rest of the goal alone, and call update_goal with status set_aside");
  });

  it("a running agent hears a pause or a new goal once, per chat, and nothing else", async () => {
    const root = await ws();
    expect(await goalMidTurnNotice(root, "c1")).toBeNull();
    expect(await goalMidTurnNotice(root, "c1")).toBeNull();
    await controlGoal(root, "pause");
    expect(await goalMidTurnNotice(root, "c1")).toContain("This goal is paused");
    expect(await goalMidTurnNotice(root, "c1")).toBeNull();
    await controlGoal(root, "resume");
    expect(await goalMidTurnNotice(root, "c1")).toBeNull();
    await setGoal(root, "A different goal", ["x"]);
    expect(await goalMidTurnNotice(root, "c1")).toContain("A different goal");
    expect(await goalMidTurnNotice(root, "c1")).toBeNull();
    expect(await goalMidTurnNotice(root, undefined)).toBeNull();
  });

  it("the chat that declares the first goal isn't told the user changed it", async () => {
    const root = await ws("  ", []);
    expect(await goalMidTurnNotice(root, "c1")).toBeNull();
    await setGoal(root, "A brand new goal", ["x"]);
    expect(await goalMidTurnNotice(root, "c1")).toBeNull();
  });

  it("finds the chat at work, so a pause can stop it", async () => {
    const root = await ws();
    expect(lastActiveConversation(await readAuditTail(root))).toBeNull();
    await edit(root, "a.js", "c7");
    expect(lastActiveConversation(await readAuditTail(root))).toBe("c7");
  });
});

describe("what a run spent", () => {
  it("adds up the tokens Cursor reports across rounds", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0, tokens: 1000 });
    await ran(root, "make test", "12 passed");
    await finishReport(root, complete());
    await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 1, tokens: 500 });
    // The run ends at the report both goal keepers accept, with what its rounds had spent by then.
    expect(await ends(root)).toMatchObject([{ outcome: "unchecked", rounds: 1, tokens: 1000 }]);
  });
});

describe("the goal is the user's", () => {
  it("while paused the agent isn't sent back and its reports are refused; only resuming restarts it", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await controlGoal(root, "pause");
    expect(await stop(root)).toBeNull();
    expect((await finishReport(root, complete())).message).toContain("Only the user resumes it");
    await controlGoal(root, "resume");
    expect(await stop(root)).toContain("Add CSV export");
  });

  it("nothing the agent says can pause or resume the goal", async () => {
    const root = await ws();
    await controlGoal(root, "pause");
    await recordUserPrompt(root, "please resume the goal", "c1", "agent");
    expect((await finishReport(root, complete())).accepted).toBe(false);
    expect(goalPhaseOf(await readAuditTail(root), await readContractSafe(root))).toBe("paused");
  });

  it("the user can close a goal that can't be proved; changing the goal reopens", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await controlGoal(root, "done");
    expect(await stop(root)).toBeNull();
    expect((await finishReport(root, complete())).message).toContain("already closed");
    await setGoal(root, "Another goal", ["x"]);
    expect(goalPhaseOf(await readAuditTail(root), await readContractSafe(root))).toBe("active");
    await recordUserPrompt(root, "Another goal", "c1", "agent");
    await edit(root, "b.js");
    expect(await stop(root)).toContain("Another goal");
  });

  it("a report on a goal the user has since changed doesn't count", async () => {
    const root = await ws();
    await edit(root, "a.js");
    await appendAudit(root, { ts: nowIso(), kind: "goal.report", goalHash: goalHash(await readContractSafe(root)), ...complete() });
    await setGoal(root, "A different goal", ["the export test passes"]);
    expect(await stop(root)).toContain("- No report yet.");
    expect(await ends(root)).toEqual([]);
  });

  it("no goal: a report is refused, not recorded", async () => {
    const root = await ws("  ", []);
    expect((await finishReport(root, complete())).message).toBe("No goal is set.");
  });
});

describe("the goal loop: what commands change, in a git repository", () => {
  const sh = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  async function repo(): Promise<string> {
    const root = await ws();
    sh(root, "init", "-q");
    await fs.writeFile(path.join(root, "a.js"), "one\n");
    sh(root, "add", "a.js");
    sh(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base");
    return root;
  }

  it("provides the current file content when a command changed the project after an earlier test", async () => {
    const root = await repo(); await recordUserPrompt(root, "add the export", "c1", "agent");
    await fs.writeFile(path.join(root, "a.js"), "two\n"); await ran(root, "make test", "12 passed");
    await fs.writeFile(path.join(root, "a.js"), "sed changed this\n");
    await finishReport(root, complete());
    expect(await ends(root)).toMatchObject([{ proved: expect.arrayContaining([{ criterion: "goal", file: "a.js", contains: "sed changed this" }]) }]);
  });

  it("a file made by a command must be accounted for; what was already changed before the run needn't be", async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, "users-own-work.js"), "theirs\n");
    await recordUserPrompt(root, "add the export", "c1", "agent");
    await tick();
    await fs.writeFile(path.join(root, "generated.js"), "by a script\n");
    await ran(root, "node generate.js", "made it");
    expect(await stop(root)).toContain("Observed change: generated.js");
    expect(await stop(root, 1)).not.toContain("users-own-work.js");
  });

  it("a file the person saved isn't the agent's change when the agent ran nothing", async () => {
    const root = await repo();
    await recordUserPrompt(root, "what does this do?", "c1", "agent");
    await tick();
    await fs.writeFile(path.join(root, "typed-by-person.js"), "mine\n");
    expect(await stop(root)).toBeNull();
  });

  it("a file edited and then put back needs no accounting", async () => {
    const root = await ws();
    sh(root, "init", "-q");
    sh(root, "config", "user.email", "x@x");
    sh(root, "config", "user.name", "x");
    await fs.writeFile(path.join(root, "kept.txt"), "before\n");
    await fs.writeFile(path.join(root, "reverted.txt"), "before\n");
    sh(root, "add", "kept.txt", "reverted.txt");
    sh(root, "commit", "-qm", "base");
    await recordUserPrompt(root, "go", "c1", "agent");
    await tick();
    await fs.writeFile(path.join(root, "kept.txt"), "after\n");
    await edit(root, "kept.txt");
    await fs.writeFile(path.join(root, "reverted.txt"), "after\n");
    await edit(root, "reverted.txt");
    await fs.writeFile(path.join(root, "reverted.txt"), "before\n");
    const answer = await finishReport(root, { status: "complete", proofs: [], changes: [] });
    expect(answer.accepted).toBe(true);
    expect(await ends(root)).toMatchObject([{ changes: [{ file: "kept.txt" }] }]);
  });

  it("line counts identify changes but do not order formatting undone", async () => {
    const root = await ws();
    sh(root, "init", "-q");
    sh(root, "config", "user.email", "x@x");
    sh(root, "config", "user.name", "x");
    await fs.writeFile(path.join(root, "suite.txt"), `${"check\n".repeat(100)}`);
    await fs.writeFile(path.join(root, "small.txt"), `${"line\n".repeat(10)}`);
    await fs.writeFile(path.join(root, "gone.txt"), `${"line\n".repeat(40)}`);
    sh(root, "add", "suite.txt", "small.txt", "gone.txt");
    sh(root, "commit", "-qm", "base");
    expect(readShrunkFiles(root)).toEqual([]);

    // Ordinary edits, a small file emptied, and more lines than before all stay quiet.
    await fs.writeFile(path.join(root, "small.txt"), "");
    await fs.writeFile(path.join(root, "suite.txt"), `${"check\n".repeat(70)}`);
    expect(readShrunkFiles(root)).toEqual([]);

    await fs.writeFile(path.join(root, "suite.txt"), `${"check\n".repeat(5)}`);
    await fs.rm(path.join(root, "gone.txt"));
    expect(readShrunkFiles(root)).toEqual([
      { file: "gone.txt", lost: 40, had: 40 },
      { file: "suite.txt", lost: 95, had: 100 },
    ]);

    const shrunk = [{ file: "suite.txt", lost: 95, had: 100 }];
    const seen = { outputs: [], lastEditTs: null, editedFiles: [], shrunk };
    const contract = { successCriteria: [] };
    const proofs = [{ criterion: "goal", file: "suite.txt", contains: "check" }];
    const refused = await evaluateReport(root, contract, { proofs, changes: [] }, seen);
    expect(refused.unproved).toEqual([]);
    const declared = await evaluateReport(root, contract, { proofs, changes: [], removed: ["./suite.txt"] }, seen);
    expect(declared.unproved).toEqual([]);
  });

  it("outside git there is no tree to read, and nothing breaks", async () => {
    const root = await ws();
    expect(readTree(root)).toBeNull();
  });
});

describe("the user's words", () => {
  it("keeps the latest messages, skips Guardian's own, and keeps them out of git", async () => {
    const root = await ws();
    expect(await readUserPrompts(root)).toEqual(["Add CSV export"]);
    for (const m of ["one", "two", "Goal Guardian: round 1", "three", "four"]) await recordUserPrompt(root, m, "c1", "agent");
    expect(await readUserPrompts(root)).toEqual(["two", "three", "four"]);
    const ignore = await fs.readFile(path.join(getGuardianPaths(root).telemetryDir, ".gitignore"), "utf8");
    expect(ignore).toContain("prompts.json");
    expect(ignore).toContain("shell-output.jsonl");
  });

  it("matches a real quote, ignoring case and spacing; refuses anything else", () => {
    expect(userSaid("Drop  the CSV part", ["please drop the csv part today"])).toBe(true);
    expect(userSaid("ship JSON instead", ["please drop the csv part"])).toBe(false);
    expect(userSaid("the", ["the goal is smaller now"])).toBe(false);
    expect(userSaid("yes", ["yes"])).toBe(true);
    expect(userSaid("corrige ça dans le pied", ["corrige Ã§a dans le pied de page"])).toBe(true);
    expect(userSaid("", ["x"])).toBe(false);
    expect(userSaid(undefined, ["x"])).toBe(false);
    // Setting or changing the goal goes by the latest message only.
    expect(userSaidLatest("drop the csv part", ["please drop the csv part today", "what does this do?"])).toBe(false);
    expect(userSaidLatest("drop the csv part", ["what does this do?", "please drop the csv part today"])).toBe(true);
    expect(userSaidLatest("drop the csv part", [])).toBe(false);
  });
});

describe("the goal is the user's own words", () => {
  const empty = () => ws("  ", []);

  it("a list supplies checklist items without dropping any of the request", () => {
    const parsed = parseRequest("Add two helpers. Done when:\n1. The first works\n2. The second works\n3. Tests pass\n\nDo only item 1 for now, then stop.");
    expect(parsed.goal).toBe("Add two helpers. Done when:\n1. The first works\n2. The second works\n3. Tests pass\n\nDo only item 1 for now, then stop.");
    expect(parsed.items).toEqual(["The first works", "The second works", "Tests pass"]);
    expect(parseRequest("Fix it:\n- one\n  more of one\n- two").items).toEqual(["one more of one", "two"]);
    expect(parseRequest("Add it. Done when: 1. It runs 2. It has tests. Only the first today.").items).toEqual(["It runs", "It has tests."]);
  });

  it("preserves restrictions and examples after multiline and inline lists", () => {
    for (const request of [
      "Add tag helpers:\n- trim tags\n- deduplicate tags\n\nDo not change the existing README.\nExample: [' A ', 'a'] becomes ['a'].",
      "Add it. Done when: 1. It runs 2. It has tests. Do not change the existing README.",
      "Build it:\n- one works\n- two works\n\n```js\nconst example = 1;\n```\nKeep the public API unchanged.",
    ]) expect(parseRequest(request).goal).toBe(request);
  });

  it("no list means the whole message, and one marker, versions or code aren't a list", () => {
    expect(parseRequest("Fix the login bug")).toEqual({ goal: "Fix the login bug", items: [] });
    expect(parseRequest("Do this:\n- only thing").items).toEqual([]);
    expect(parseRequest("Upgrade from 1.2 to 2.3 today").items).toEqual([]);
    expect(parseRequest("Run this:\n```\n- a\n- b\n```").items).toEqual([]);
    expect(parseRequest("- one\n- two").goal).toBe("- one\n- two");
  });

  it("the first change records the latest message, once; an agent can't get in first", async () => {
    const root = await empty();
    expect(await captureGoal(root, "c1")).toBe(false);
    await recordUserPrompt(root, "Build it. Done when:\n- a works\n- b works", "c1", "agent");
    expect(await captureGoal(root, "c1")).toBe(true);
    const saved = await readContractSafe(root);
    expect(saved.goal).toBe("Build it. Done when:\n- a works\n- b works");
    expect(saved.successCriteria.map((c) => c.text)).toEqual(["a works", "b works"]);
    await recordUserPrompt(root, "something else entirely", "c1", "agent");
    expect(await captureGoal(root, "c1")).toBe(false);
    expect((await readContractSafe(root)).goal).toBe("Build it. Done when:\n- a works\n- b works");
  });

  it("honors a first-part-only request even though that instruction is retained in the goal", async () => {
    const root = await empty();
    const limit = "Do only item 1 for now, then stop.";
    const request = `Build it.\nDone when:\n- a works\n- b works\n\n${limit}`;
    await recordUserPrompt(root, request, "c1", "agent");
    await captureGoal(root, "c1");
    await fs.writeFile(path.join(root, "a.js"), "first requested part\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    expect(await submitGoalReport(root, { status: "set_aside", proofs: [], changes: [], userWords: limit })).toMatchObject({ accepted: true });
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toBeNull();
    expect((await readContractSafe(root)).goal).toBe(request);
    await tick();
    await recordUserPrompt(root, "Continue the original goal and finish the remaining work.", "c1", "agent");
    await fs.writeFile(path.join(root, "a.js"), "second requested part\n");
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "c1" });
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).not.toBeNull();
  });

  it("the agent hears the recorded goal once, in the chat that set it", async () => {
    const root = await empty();
    await recordUserPrompt(root, "Build it", "c1", "agent");
    await captureGoal(root, "c1");
    expect(await goalMidTurnNotice(root, "c2")).toBeNull();
    expect(await goalMidTurnNotice(root, "c1")).toContain("word for word");
    expect(await goalMidTurnNotice(root, "c1")).toBeNull();
  });

  it("at the stop, work with no goal records one and carries on; a question records nothing", async () => {
    const root = await empty();
    await recordUserPrompt(root, "what does this do?", "c1", "agent");
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toBeNull();
    expect((await readContractSafe(root)).goal.trim()).toBe("");
    await tick();
    await recordUserPrompt(root, "Build it", "c1", "agent");
    await tick();
    await edit(root, "a.txt");
    expect(await runGoalStop(root, { conversationId: "c1", status: "completed", loopCount: 0 })).toContain("Build it");
    expect((await readContractSafe(root)).goal).toBe("Build it");
  });

  it("the next request after a closed goal becomes the next goal; an open goal stays", async () => {
    const root = await ws("  ", []);
    await recordUserPrompt(root, "First job", "c1", "agent");
    await captureGoal(root, "c1");
    await tick();
    await recordUserPrompt(root, "Second job", "c1", "agent");
    expect(await captureGoal(root, "c1")).toBe(false);
    await controlGoal(root, "done");
    expect(await captureGoal(root, "c1")).toBe(false); // nothing asked since it closed
    await tick();
    await recordUserPrompt(root, "Third job", "c1", "agent");
    expect(await captureGoal(root, "c1")).toBe(true);
    expect((await readContractSafe(root)).goal).toBe("Third job");
    expect(goalPhaseOf(await readAuditTail(root, 1000), await readContractSafe(root))).toBe("active");
  });
});
