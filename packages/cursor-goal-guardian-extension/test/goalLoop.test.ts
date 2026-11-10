import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPanelViewModel, defaultContract, goalHash, type AuditRecord } from "@goal-guardian/core";
import { doctorIntegration, runUninstall, wireIntegration } from "../src/setup.js";
import { renderSections } from "../src/panel/render.js";
import { applyGoalCommand, WORK_PROMPT } from "../src/goalControls.js";

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
    const goal = renderSections(vm([{ ts: at(1), kind: "goal.end", ...base, outcome: "proved", proved: [{ criterion: "sc_1", command: "mvn verify", quote: "BUILD SUCCESS" }, { criterion: "sc_2", file: "doc.md", contains: "--csv" }], extras: ["README.md"], changes: [{ file: "src/export.ts", serves: "sc_1" }, { file: "test/export.test.ts", serves: "sc_1" }, { file: "doc.md", serves: "sc_2" }, { file: "README.md", serves: "extra" }], goalFileEdited: true }])).goal;
    expect(goal).toMatch(/Goal proved on Guardian(&#39;|&#x27;|')s record/);
    expect(goal).toMatch(/sc_1: ran mvn verify, printed (&quot;|")BUILD SUCCESS/);
    expect(goal).toMatch(/sc_2: doc\.md contains (&quot;|")--csv/);
    expect(goal).toContain("Changed for sc_1: src/export.ts, test/export.test.ts");
    expect(goal).toContain("Changed for sc_2: doc.md");
    expect(goal).toContain("Not for any done-when item, your call: README.md");
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
