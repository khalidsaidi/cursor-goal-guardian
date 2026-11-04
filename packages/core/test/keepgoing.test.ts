import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAudit, criteriaFromTexts, defaultContract, getGuardianPaths, nowIso, openWork, readGoal, recordShellOutput, runDoneCheck, type DoneCheckResult } from "../src/index.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

function block(sc1: string): string {
  return [
    "Did part of it.",
    "",
    "## Done check",
    '1. `npm test` → "ok 1 passed"',
    "2. does not apply: single small change, nothing superseded",
    "3. does not apply: no heuristic decides inclusion in this change",
    "4. does not apply: one file, nothing outside the task touched",
    '5. `npm test` reproduces it in one command, output "ok 1 passed"',
    "6. does not apply: the open item is declared on its own line below",
    "7. does not apply: no numbers reported in this change",
    `sc_1. ${sc1}`,
  ].join("\n");
}

async function setUp(doneCheck: Record<string, unknown> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-keep-"));
  made.push(root);
  const p = getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  await fs.writeFile(p.config, JSON.stringify({ doneCheck: { mode: "enforce", tests: { enabled: false }, ...doneCheck } }));
  await fs.writeFile(p.contract, JSON.stringify({ ...defaultContract(), goal: "Add export", successCriteria: criteriaFromTexts(["CSV export works"]), constraints: [] }));
  await appendAudit(root, { ts: nowIso(), kind: "hook.event", event: "beforeShellExecution", conversationId: "c1" });
  await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: "npm test", conversationId: "c1" });
  await recordShellOutput(root, { conversationId: "c1", command: "npm test", output: "ok 1 passed" });
  return root;
}

async function audit(root: string, kind: string): Promise<Array<Record<string, unknown>>> {
  const t = await fs.readFile(getGuardianPaths(root).audit, "utf8");
  return t.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === kind);
}

const GAP_ME = "gap: export button not wired yet · closes with: wire it and test it · held by: me";
const GAP_USER = "gap: needs the production API key · closes with: the user adds the key · held by: the user";

const BLOCKED = ["Tried it.", "", "## Blocked", "- What: the export needs a schema I could not find", "- Unblock: find or write the schema", "- Who: me, the agent"].join("\n");

describe("keep going toward the goal", () => {
  it("only open 'done when' items the agent itself holds count", () => {
    const r = (holder: string, key = "sc_1"): DoneCheckResult => ({ verdict: "pass", required: true, problems: [], lines: [{ key, status: "gap", note: `export button not wired — held by ${holder}` }] });
    expect(openWork(r("me"))).toEqual(["sc_1: export button not wired"]);
    expect(openWork(r("the agent"))).toHaveLength(1);
    expect(openWork(r("the user"))).toEqual([]);
    expect(openWork(r("me", "6"))).toEqual([]);
    expect(openWork({ ...r("me"), verdict: "fail" })).toEqual([]);
  });

  it("an honest block that leaves the goal open sends the agent back; closing it records 'fixed'", async () => {
    const root = await setUp();
    const first = await runDoneCheck(root, { message: block(GAP_ME), conversationId: "c1", stop: { status: "completed", loopCount: 0 } });
    expect(first!.result.verdict).toBe("pass");
    expect(first!.followup).toMatch(/goal round 1\/50: the goal is not done yet[\s\S]*sc_1: export button not wired yet[\s\S]*Never settle quietly for a smaller/);
    expect((await audit(root, "done.check"))[0]).toMatchObject({ continued: true, open: ["sc_1: export button not wired yet"] });
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: "src/export.js", conversationId: "c1" });
    const second = await runDoneCheck(root, { message: block('`npm test` → "ok 1 passed" covers the export button'), conversationId: "c1", stop: { status: "completed", loopCount: 1 } });
    expect(second!.followup).toBeNull();
    expect(await audit(root, "flag.outcome")).toMatchObject([{ flag: "keep_going", outcome: "fixed", editsAfter: 1 }]);
  });

  it("someone else's gap is a fine place to stop; the cap stops an endless loop", async () => {
    const root = await setUp();
    expect((await runDoneCheck(root, { message: block(GAP_USER), conversationId: "c1", stop: { status: "completed", loopCount: 0 } }))!.followup).toBeNull();
    const capped = await setUp({ continueRounds: 2 });
    const sent: string[] = [];
    for (let loop = 0; loop < 4; loop += 1) {
      const out = await runDoneCheck(capped, { message: block(GAP_ME), conversationId: "c1", stop: { status: "completed", loopCount: loop } });
      sent.push(out!.followup?.match(/goal round \d+\/\d+|keep-going limit reached|Guardian is stopping work on this goal/)?.[0] ?? "none");
    }
    // Two keep-goings, then (the agent answered both without doing anything) one grounded wrap-up, then quiet.
    // Two rounds answered with no work: Guardian stops the goal as blocked (no progress) and asks for a last message.
    expect(sent).toEqual(["goal round 1/50", "goal round 2/50", "Guardian is stopping work on this goal", "none"]);
    expect((await audit(capped, "flag.outcome")).map((o) => [o.flag, o.outcome])).toEqual([["keep_going", "ignored"], ["keep_going", "ignored"]]);
    const off = await setUp({ continueRounds: 0 });
    expect((await runDoneCheck(off, { message: block(GAP_ME), conversationId: "c1", stop: { status: "completed", loopCount: 0 } }))!.followup).toBeNull();
  });

  it("a first 'blocked' the agent could get past is challenged once; the same claim again is accepted", async () => {
    const root = await setUp();
    const first = await runDoneCheck(root, { message: BLOCKED, conversationId: "c1", stop: { status: "completed", loopCount: 0 } });
    expect(first!.result.verdict).toBe("blocked");
    expect(first!.followup).toMatch(/before you stop as blocked — is it really out of your reach\?/);
    await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "shell", actionValue: "find . -name '*.schema.json'", conversationId: "c1" });
    const again = await runDoneCheck(root, { message: BLOCKED, conversationId: "c1", stop: { status: "completed", loopCount: 1 } });
    expect(again!.followup).toBeNull();
    const other = await setUp();
    const theirs = BLOCKED.replace("- Who: me, the agent", "- Who: the user");
    expect((await runDoneCheck(other, { message: theirs, conversationId: "c1", stop: { status: "completed", loopCount: 0 } }))!.followup).toBeNull();
  });

  it("work done between keep-goings resets the stall count", async () => {
    const root = await setUp({ continueRounds: 3 });
    const sent: string[] = [];
    for (let loop = 0; loop < 3; loop += 1) {
      if (loop > 0) await appendAudit(root, { ts: nowIso(), kind: "action.observed", actionType: "edit", actionValue: `src/step${loop}.js`, conversationId: "c1" });
      const out = await runDoneCheck(root, { message: block(GAP_ME), conversationId: "c1", stop: { status: "completed", loopCount: loop } });
      sent.push(out!.followup?.match(/goal round \d+\/\d+|limit reached|stopping work/)?.[0] ?? "none");
    }
    expect(sent).toEqual(["goal round 1/50", "goal round 2/50", "goal round 3/50"]);
  });
});

