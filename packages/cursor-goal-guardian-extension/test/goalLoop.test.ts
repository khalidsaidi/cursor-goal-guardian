import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import * as core from "@goal-guardian/core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPanelViewModel, defaultContract, goalHash, reviewLabels, type AuditRecord } from "@goal-guardian/core";
import { doctorIntegration, runUninstall, wireIntegration } from "../src/setup.js";
import { renderSections } from "../src/panel/render.js";
import { applyGoalCommand, applyReviewCommand, WORK_PROMPT } from "../src/goalControls.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  delete process.env.GOAL_GUARDIAN_TEST_HOME;
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const ctx = { extensionPath: "/ext/dir" } as never;
const readHooks = async (root: string) => JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8")) as { hooks: Record<string, Array<{ command: string; loop_limit?: number }>> };

describe("goal loop wiring", () => {
  it("a missed-work correction starts Cursor on the reopened goal, while old feedback does not", async () => {
    const root = await tmp("gg-feedback-");
    const feedback = vi.spyOn(core, "recordReviewFeedback").mockResolvedValue(undefined);
    const resume = vi.spyOn(core, "resumeMissedGoal").mockResolvedValue(true);
    const learning = vi.spyOn(core, "autoImprove").mockResolvedValue(null);
    const start = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    try {
      await applyReviewCommand(root, "review.missed:current", async () => {}, "/extension");
      expect(feedback).toHaveBeenCalledWith(root, "current", 0, "missed");
      expect(resume).toHaveBeenCalledWith(root, "current");
      expect(start).toHaveBeenCalledWith("composer.createNew", expect.objectContaining({ autoSubmit: true, partialState: expect.objectContaining({ text: WORK_PROMPT }) }));
      start.mockClear();
      resume.mockResolvedValue(false);
      await applyReviewCommand(root, "review.missed:older", async () => {}, "/extension");
      expect(start).not.toHaveBeenCalled();
    } finally {
      feedback.mockRestore(); resume.mockRestore(); learning.mockRestore(); start.mockRestore();
    }
  });

  it("setup wires stop with the rounds cap; the doctor adds it to older workspaces, never to a stranger's", async () => {
    process.env.GOAL_GUARDIAN_TEST_HOME = await tmp("gg-home-");
    const root = await tmp("gg-wire-");
    await wireIntegration(root, ctx);
    expect((await readHooks(root)).hooks.stop).toEqual([{ command: expect.stringMatching(/goal-guardian-hook/), loop_limit: 21 }]);

    const older = await readHooks(root);
    delete (older.hooks as Record<string, unknown>).stop;
    older.hooks.stop = [{ command: "my-own-hook" }];
    await fs.writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify(older));
    await doctorIntegration(root, ctx);
    const after = (await readHooks(root)).hooks.stop!;
    expect(after[0]).toEqual({ command: "my-own-hook" });
    expect(after[1]).toMatchObject({ loop_limit: 21 });

    const stranger = await tmp("gg-stranger-");
    await fs.mkdir(path.join(stranger, ".cursor"));
    await fs.writeFile(path.join(stranger, ".cursor", "hooks.json"), JSON.stringify({ hooks: { afterFileEdit: [{ command: "theirs" }] } }));
    await doctorIntegration(stranger, ctx);
    expect((await readHooks(stranger)).hooks.stop).toBeUndefined();
  });

  it("setup wires what the loop needs; the doctor restores it; uninstall keeps a stranger's hook", async () => {
    process.env.GOAL_GUARDIAN_TEST_HOME = await tmp("gg-home-");
    const root = await tmp("gg-wire-");
    await wireIntegration(root, ctx);
    const wired = await readHooks(root);
    for (const event of ["beforeSubmitPrompt", "afterShellExecution"]) expect(wired.hooks[event]).toHaveLength(1);
    delete wired.hooks.beforeSubmitPrompt;
    await fs.writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify(wired));
    await doctorIntegration(root, ctx);
    const h = await readHooks(root);
    expect(h.hooks.beforeSubmitPrompt).toHaveLength(1);
    h.hooks.stop!.push({ command: "my-own-hook" });
    await fs.writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify(h));
    await runUninstall(root);
    expect((await readHooks(root)).hooks.stop).toEqual([{ command: "my-own-hook" }]);
  });
});

describe("goal loop panel lines", () => {
  const NOW = new Date("2026-01-01T12:00:00.000Z");
  const at = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const vm = (records: AuditRecord[]) => buildPanelViewModel({ setUp: true, contract: { ...defaultContract(), goal: "x" }, records, now: NOW });
  const base = { conversationId: "c1", goalHash: "h" };

  it("shows nothing before any run, and the round while one is going", () => {
    expect(renderSections(vm([])).goal).not.toContain("Goal: agent");
    const goal = renderSections(vm([{ ts: at(3), kind: "goal.round", ...base, round: 2, idle: false, unproved: ["sc_1 (x): no proof given"], unclaimed: [], extras: [] }])).goal;
    expect(goal).toContain("Goal: agent sent back (round 2)");
    expect(goal).toContain("sc_1 (x): no proof given");
  });

  it("a proved goal shows its receipts, what each changed file was for, and any extra left for the user", () => {
    const goal = renderSections(vm([{ ts: at(1), kind: "goal.end", ...base, outcome: "proved", proved: [{ criterion: "sc_1", command: "mvn verify", quote: "BUILD SUCCESS" }, { criterion: "sc_2", file: "doc.md", contains: "--csv" }], extras: ["README.md"], changes: [{ file: "src/export.ts", serves: "sc_1" }, { file: "test/export.test.ts", serves: "sc_1" }, { file: "doc.md", serves: "sc_2" }, { file: "README.md", serves: "extra" }], reviewer: ["Reviewer: sc_2 isn't done: the flag is documented but never parsed"], goalFileEdited: true }])).goal;
    expect(goal).toMatch(/Goal proved on Guardian(&#39;|&#x27;|')s record/);
    expect(goal).toMatch(/sc_1: ran mvn verify, printed (&quot;|")BUILD SUCCESS/);
    expect(goal).toMatch(/sc_2: doc\.md contains (&quot;|")--csv/);
    expect(goal).toContain("Changed for sc_1: src/export.ts, test/export.test.ts");
    expect(goal).toContain("Changed for sc_2: doc.md");
    expect(goal).toContain("Not for any done-when item, your call: README.md");
    expect(goal).toMatch(/Reviewer(&#39;|&#x27;|')s opinion: sc_2 isn(&#39;|&#x27;|')t done: the flag is documented but never parsed/);
    expect(goal).toContain("edited Guardian");
  });

  it("offers the user's controls by phase, with what the run cost", () => {
    const round: AuditRecord = { ts: at(5), kind: "goal.round", ...base, round: 1, idle: false, unproved: ["no proof given"], unclaimed: [], extras: [] };
    expect(renderSections(vm([round])).goal).toContain('data-cmd="goal.pause"');
    expect(renderSections(vm([round])).goal).toContain('data-cmd="goal.done"');
    const goal = "x";
    const hash = goalHash({ goal, successCriteria: [] });
    const paused = renderSections(vm([round, { ts: at(4), kind: "goal.control", goalHash: hash, operation: "pause", actor: "user" }])).goal;
    expect(paused).toContain('data-cmd="goal.resume"');
    expect(paused).not.toContain('data-cmd="goal.pause"');
    expect(paused).not.toContain("agent sent back");
    const closed = renderSections(vm([round, { ts: at(4), kind: "goal.control", goalHash: hash, operation: "done", actor: "user" }])).goal;
    expect(closed).toContain("Goal marked done by you.");
    expect(closed).not.toContain("agent sent back");
    expect(closed).not.toContain("no proof given");
    const proved = renderSections(vm([{ ts: at(1), kind: "goal.end", conversationId: "c1", goalHash: hash, outcome: "proved", rounds: 3, seconds: 240 }])).goal;
    expect(proved).toContain("(3 rounds, 4 min)");
    expect(renderSections(vm([{ ts: at(1), kind: "goal.end", conversationId: "c1", goalHash: hash, outcome: "limit", rounds: 2, tokens: 41500 }])).goal).toContain("(2 rounds, 42K tokens)");
    expect(proved).not.toContain('data-cmd="goal.');
  });

  it("before any run offers to start; after a run that ended unproved, to carry on; an untrusted workspace says why nothing runs", () => {
    expect(renderSections(vm([])).goal).toContain('data-cmd="goal.work"');
    const ended = renderSections(vm([{ ts: at(1), kind: "goal.end", ...base, goalHash: "other", outcome: "limit" }])).goal;
    expect(ended).toContain('data-cmd="goal.work"');
    const untrusted = buildPanelViewModel({ setUp: true, contract: { ...defaultContract(), goal: "x" }, records: [], now: NOW, workspaceTrusted: false });
    expect(renderSections(untrusted).goal).toContain("trusted workspace");
  });

  it("every other ending says plainly that it isn't proved, and escapes what the agent wrote", () => {
    const end = (outcome: "blocked" | "limit", extra: Record<string, unknown>) => renderSections(vm([{ ts: at(1), kind: "goal.end", ...base, outcome, ...extra } as AuditRecord])).goal;
    expect(end("blocked", { reason: "needs <key>" })).toContain("needs &lt;key&gt;");
    expect(end("limit", { unproved: ["sc_1: nope"] })).toContain("Goal not proved: the rounds ran out");
  });
});

describe("goal buttons", () => {
  async function workspace(): Promise<string> {
    const root = await tmp("gg-controls-");
    const dir = path.join(root, ".cursor", "goal-guardian");
    await fs.mkdir(path.join(dir, "telemetry"), { recursive: true });
    await fs.writeFile(path.join(dir, "contract.json"), JSON.stringify({ schemaVersion: 2, goal: "Ship it", successCriteria: [], constraints: [] }));
    await fs.writeFile(path.join(dir, "telemetry", "audit.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), kind: "action.observed", actionType: "edit", actionValue: "a.js", conversationId: "chat-7" })}\n`);
    return root;
  }

  it("pause records it and stops the chat at work; resume starts the agent, sent at once", async () => {
    const run = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const root = await workspace();
    await applyGoalCommand(root, "goal.pause");
    expect(run).toHaveBeenCalledWith("composer.cancelChat", "chat-7");
    await applyGoalCommand(root, "goal.resume");
    expect(run).toHaveBeenCalledWith("composer.createNew", { partialState: { text: WORK_PROMPT, richText: WORK_PROMPT, unifiedMode: "agent" }, autoSubmit: true, openInNewTab: true });
    const tape = await fs.readFile(path.join(root, ".cursor", "goal-guardian", "telemetry", "audit.jsonl"), "utf8");
    expect(tape).toContain('"operation":"pause"');
    expect(tape).toContain('"operation":"resume"');
    run.mockRestore();
  });

  it("if Cursor's start command has gone away, fills in a chat instead", async () => {
    const run = vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (id: string) => {
      if (id === "composer.createNew") throw new Error("command not found");
      return undefined;
    });
    const root = await workspace();
    await applyGoalCommand(root, "goal.work");
    expect(run).toHaveBeenCalledWith("workbench.action.chat.open", { query: WORK_PROMPT });
    run.mockRestore();
  });

  it("a Cursor command that has gone away doesn't undo the pause", async () => {
    const run = vi.spyOn(vscode.commands, "executeCommand").mockRejectedValue(new Error("command not found"));
    const root = await workspace();
    await expect(applyGoalCommand(root, "goal.pause")).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(root, ".cursor", "goal-guardian", "telemetry", "audit.jsonl"), "utf8")).toContain('"operation":"pause"');
    run.mockRestore();
  });
});

describe("the reviewer on the panel, and improving it", () => {
  const NOW = new Date("2026-01-01T12:00:00.000Z");
  const at = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const base = { goalHash: "h", reportTs: at(9), seconds: 3, ran: true };
  const objected = (id: string, m: number): AuditRecord => ({ ts: at(m), kind: "goal.review", ...base, id, caseSaved: true, fails: [{ id: "sc_1", evidence: "a comment, not code" }], extra: [{ file: "util.js", what: "renamed helpers" }] });
  const vm = (records: AuditRecord[], improvedReviewer = false) =>
    buildPanelViewModel({ setUp: true, contract: { ...defaultContract(), goal: "x" }, records, goalRecords: records, now: NOW, improvedReviewer });

  it("each objection can be called right or wrong, and the user's answer shows instead of the buttons", () => {
    const records = [objected("rev_a", 5), { ts: at(4), kind: "review.feedback", reviewId: "rev_a", index: 1, label: "wrong" } as AuditRecord];
    const goal = renderSections(vm(records)).goal;
    expect(goal).toContain("sc_1 isn&#39;t done: a comment, not code");
    expect(goal).toContain('data-cmd="review.right:rev_a:0"');
    expect(goal).toContain('data-cmd="review.wrong:rev_a:0"');
    expect(goal).not.toContain('data-cmd="review.wrong:rev_a:1"');
    expect(goal).toContain("you said: reviewer was wrong");
  });

  it("improves by itself, with no button: it says what it is doing and what it costs, then what it did, with an Undo", () => {
    const records: AuditRecord[] = [];
    for (let i = 0; i < 8; i += 1) {
      records.push(objected(`rev_${i}`, 60 - i));
      records.push({ ts: at(50 - i), kind: "review.feedback", reviewId: `rev_${i}`, index: 0, label: i < 3 ? "right" : "wrong" } as AuditRecord);
      if (i >= 3) records.push({ ts: at(50 - i), kind: "review.feedback", reviewId: `rev_${i}`, index: 1, label: "wrong" } as AuditRecord);
    }
    const waiting = renderSections(vm(records)).goal;
    expect(waiting).not.toContain("review.improve");
    expect(waiting).toContain("8 reviews have a verdict");
    records.push({ ts: at(5), kind: "improve.start", id: "improve_1", auto: true, reviews: 22, searchCallsMax: 174 } as AuditRecord);
    const running = renderSections(vm(records)).goal;
    expect(running).toContain("Guardian is improving its reviewer with RRSI from your verdicts.");
    expect(running).toContain("About 22 reviews and up to 174 more calls to your Cursor model.");
    records.push({ ts: at(2), kind: "improve.run", id: "improve_1", kept: true, reason: "4 right against 2 now on 4 cases it never saw", train: 5, heldOut: 4, old: { correct: 2, catches: 1 }, new: { correct: 4, catches: 1 }, lostCatches: 0, seconds: 300, calls: 9, hypotheses: ["extras the user wanted"], diff: "+ QUIET" } as AuditRecord);
    const kept = renderSections(vm(records)).goal;
    expect(kept).toContain("Guardian improved its reviewer from your verdicts: 4 right against 2 now");
    expect(kept).toContain("+ QUIET");
    records.push({ ts: at(1), kind: "improve.apply", runId: "improve_1", auto: true } as AuditRecord);
    const applied = renderSections(vm(records, true)).goal;
    expect(applied).toContain("It is in use now.");
    expect(applied).not.toContain("review.apply:");
    expect(applied).toContain('data-cmd="review.undo"');
  });

  it("a run the review passed can be called not done: that review is then a miss to learn from", () => {
    const passed: AuditRecord = { ts: at(6), kind: "goal.review", ...base, id: "rev_p", caseSaved: true, fails: [], extra: [] };
    const ended: AuditRecord = { ts: at(5), kind: "goal.end", conversationId: "c", goalHash: "h", outcome: "proved", proved: [] };
    expect(renderSections(vm([passed, ended])).goal).toContain('data-cmd="review.missed:rev_p"');
    const said = [passed, ended, { ts: at(4), kind: "review.feedback", reviewId: "rev_p", index: 0, label: "missed" } as AuditRecord];
    const goal = renderSections(vm(said)).goal;
    expect(goal).not.toContain("review.missed:");
    expect(goal).toContain("you said: this wasn't done");
    expect(reviewLabels(said).get("rev_p")).toEqual({ label: "right", source: "missed" });
  });

  it("says plainly when a goal is complete but unchecked, disputed, or unverified", () => {
    const end = (outcome: "unchecked" | "disputed" | "unverified", rest: Record<string, unknown> = {}): AuditRecord => ({ ts: at(5), kind: "goal.end", conversationId: "c", goalHash: "h", outcome, ...rest }) as AuditRecord;
    const unchecked = renderSections(vm([end("unchecked", { skipped: ["the reviewer didn't run: cursor-agent isn't installed"] })])).goal;
    expect(unchecked).toContain("Goal complete but unchecked, not proved");
    expect(unchecked).toContain("Not independently checked: the reviewer didn&#39;t run: cursor-agent isn&#39;t installed");
    expect(renderSections(vm([end("disputed", { reviewer: ["Reviewer: sc_1 isn't done: a placeholder"] })])).goal).toContain("Goal disputed, not proved: the review still objects");
    expect(vm([end("disputed")]).status).toEqual({ lamp: "warn", word: "disputed" });
    expect(vm([end("unverified", { reason: "Codex's goal program isn't installed" })]).status).toEqual({ lamp: "warn", word: "unverified" });
    expect(renderSections(vm([end("unverified", { reason: "Codex's goal program isn't installed" })])).goal).toContain("a goal keeper&#39;s code didn&#39;t run");
  });
});
