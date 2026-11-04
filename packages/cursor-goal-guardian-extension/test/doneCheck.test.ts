import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPanelViewModel,
  defaultState,
  DONE_CHECK_RULE_RELATIVE_PATH,
  getGuardianPaths,
  type AuditRecord,
} from "@goal-guardian/core";
import { doctorIntegration, syncDoneCheckRule, wireIntegration, runUninstall } from "../src/setup.js";
import { renderSections } from "../src/panel/render.js";
import { endsWithTurnEnded, findTranscriptDir, transcriptProjectSlug } from "../src/observer.js";

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

describe("done-check wiring", () => {
  it("wires afterShellExecution, afterAgentResponse and stop (with Cursor's loop_limit)", async () => {
    const root = await tmp("gg-dcw-");
    process.env.GOAL_GUARDIAN_TEST_HOME = root;
    await wireIntegration(root, ctx);
    const hooks = JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.afterShellExecution).toHaveLength(1);
    expect(hooks.hooks.afterAgentResponse).toHaveLength(1);
    // Timeout above the reviewer's own (≤280s); loop cap above maxFollowups + review rounds.
    expect(hooks.hooks.stop).toEqual([{ command: expect.stringMatching(/goal-guardian-hook/), loop_limit: 20, timeout: 300 }]);
  });

  it("doctor adds the new events to a workspace wired before they existed — and only to ours", async () => {
    const root = await tmp("gg-dcd-");
    process.env.GOAL_GUARDIAN_TEST_HOME = root;
    await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
    const old = { version: 1, hooks: { beforeShellExecution: [{ command: '"/ext/dir/bin/goal-guardian-hook"' }], stop: [{ command: "./mine.sh" }] } };
    await fs.writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify(old));
    await doctorIntegration(root, ctx);
    const hooks = JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.stop).toHaveLength(2);
    expect(hooks.hooks.stop[0]).toEqual({ command: "./mine.sh" });
    expect(hooks.hooks.afterAgentResponse).toHaveLength(1);

    const stranger = await tmp("gg-dcs-");
    await fs.mkdir(path.join(stranger, ".cursor"), { recursive: true });
    await fs.writeFile(path.join(stranger, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "./x.sh" }] } }));
    await doctorIntegration(stranger, ctx);
    const untouched = JSON.parse(await fs.readFile(path.join(stranger, ".cursor", "hooks.json"), "utf8"));
    expect(Object.keys(untouched.hooks)).toEqual(["stop"]);
  });

  it("doctor upgrades a Guardian stop entry from before the review (old cap, no timeout) — never a stranger's", async () => {
    const root = await tmp("gg-dcu2-");
    process.env.GOAL_GUARDIAN_TEST_HOME = root;
    await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
    const old = { version: 1, hooks: { stop: [{ command: "./mine.sh", loop_limit: 3 }, { command: '"/ext/dir/bin/goal-guardian-hook"', loop_limit: 10 }] } };
    await fs.writeFile(path.join(root, ".cursor", "hooks.json"), JSON.stringify(old));
    await doctorIntegration(root, ctx);
    const hooks = JSON.parse(await fs.readFile(path.join(root, ".cursor", "hooks.json"), "utf8"));
    expect(hooks.hooks.stop[0]).toEqual({ command: "./mine.sh", loop_limit: 3 });
    expect(hooks.hooks.stop[1]).toMatchObject({ loop_limit: 20, timeout: 300 });
  });

  it("the rule exists only while the mode asks for it", async () => {
    const root = await tmp("gg-dcr-");
    const p = getGuardianPaths(root);
    const rule = path.join(root, DONE_CHECK_RULE_RELATIVE_PATH);
    await fs.mkdir(p.dir, { recursive: true });

    await syncDoneCheckRule(root); // no config = default off
    await expect(fs.access(rule)).rejects.toThrow();

    await fs.writeFile(p.config, JSON.stringify({ doneCheck: { mode: "enforce" } }));
    await syncDoneCheckRule(root);
    expect(await fs.readFile(rule, "utf8")).toMatch(/sends you back/);

    await fs.writeFile(p.config, JSON.stringify({ doneCheck: { mode: "advisory" } }));
    await syncDoneCheckRule(root);
    expect(await fs.readFile(rule, "utf8")).toMatch(/shown to the user/);

    await fs.writeFile(p.config, JSON.stringify({ doneCheck: { mode: "off" } }));
    await syncDoneCheckRule(root);
    await expect(fs.access(rule)).rejects.toThrow();
  });

  it("uninstall removes the done-check rule too", async () => {
    const root = await tmp("gg-dcu-");
    process.env.GOAL_GUARDIAN_TEST_HOME = root;
    const p = getGuardianPaths(root);
    await fs.mkdir(p.dir, { recursive: true });
    await fs.writeFile(p.config, JSON.stringify({ doneCheck: { mode: "advisory" } }));
    await syncDoneCheckRule(root);
    await runUninstall(root);
    await expect(fs.access(path.join(root, DONE_CHECK_RULE_RELATIVE_PATH))).rejects.toThrow();
  });
});

describe("done-check panel section", () => {
  const NOW = new Date("2026-01-01T12:00:00.000Z");
  const rec = (verdict: "pass" | "fail" | "not_required", minAgo: number, lines: Array<{ key: string; status: "backed" | "contradicted" | "waived" | "stated" | "unsupported" | "missing"; note: string }>): AuditRecord => ({
    ts: new Date(NOW.getTime() - minAgo * 60_000).toISOString(),
    kind: "done.check",
    conversationId: "c1",
    verdict,
    required: verdict !== "not_required",
    lines,
    problems: [],
    turnActions: 2,
    followupSent: verdict === "fail",
  });
  const vm = (records: AuditRecord[]) =>
    buildPanelViewModel({ setUp: true, state: defaultState(), records, actions: [], now: NOW, semanticConsented: false, semanticAvailable: true });

  it("shows the latest owed check, line by line, with the contradiction spelled out and escaped", () => {
    const html = renderSections(
      vm([
        rec("pass", 30, [{ key: "1", status: "backed", note: "`pnpm test` ran" }]),
        rec("fail", 5, [
          { key: "1", status: "contradicted", note: '"<215> passed" is not in what the command printed' },
          { key: "7", status: "waived", note: "no numbers" },
        ]),
        rec("not_required", 1, []),
      ]),
    ).donecheck;
    expect(html).toMatch(/didn&#39;t hold up/);
    expect(html).toMatch(/Rule 1/);
    expect(html).toMatch(/contradicted/);
    expect(html).toContain("&lt;215&gt;");
    expect(html).toMatch(/Sent the agent back/);
  });

  it("renders `code` in notes as <code>, after escaping (no markup injection)", () => {
    const html = renderSections(vm([rec("fail", 1, [{ key: "1", status: "contradicted", note: "`<img src=x onerror=alert(1)>` never ran" }])])).donecheck;
    expect(html).toContain("<code>&lt;img src=x onerror=alert(1)&gt;</code>");
    expect(html).not.toContain("<img");
    const cut = renderSections(vm([rec("fail", 1, [{ key: "6", status: "gap", note: "does not import `subtract…" }])])).donecheck;
    expect(cut).toContain("does not import subtract…");
  });

  it("shows Guardian's own test re-run, with or without a done check, in plain words", () => {
    const rerun = (r: Partial<Extract<AuditRecord, { kind: "tests.rerun" }>>): AuditRecord => ({
      ts: NOW.toISOString(), kind: "tests.rerun", command: "npm test", exit: 0, broke: false, durationMs: 900, ...r,
    }) as AuditRecord;
    expect(renderSections(vm([rerun({})])).donecheck).toContain("Guardian re-ran <code>npm test</code> itself after the last change: it passes.");
    const broke = renderSections(vm([rec("pass", 2, []), rerun({ exit: 1, baselineExit: 0, broke: true, output: "ok 1\nFAIL <x> expected 2" })])).donecheck;
    expect(broke).toContain("it failed (exit 1) with the last turn's changes and passes without them. That turn broke it.");
    expect(broke).toContain("FAIL &lt;x&gt; expected 2");
    expect(broke).toContain("Every line holds up");
    expect(renderSections(vm([rerun({ exit: 1, baselineExit: 1 })])).donecheck).toContain("but it also failed before the last turn's changes.");
    expect(renderSections(vm([rerun({ exit: "timeout" })])).donecheck).toContain("timed out, so it says nothing either way.");
  });

  it("offers 'wrong flag?' on what Guardian flagged, and shows how its flags turned out", () => {
    const sent = rec("fail", 5, [{ key: "1", status: "contradicted", note: "x" }]);
    const html = renderSections(vm([sent])).donecheck;
    expect(html).toContain(`data-wrong="followup|${sent.ts}|"`);
    const marked: AuditRecord = { ts: NOW.toISOString(), kind: "flag.outcome", flag: "followup", ref: sent.ts, outcome: "marked_wrong", editsAfter: 0 };
    const fixed: AuditRecord = { ...marked, ts: NOW.toISOString(), ref: "other", outcome: "fixed" } as AuditRecord;
    const after = renderSections(vm([sent, marked, fixed, fixed])).donecheck;
    expect(after).not.toContain("data-wrong=");
    expect(after).toContain("marked wrong");
    expect(after).toContain("Guardian&#39;s flags this week: 2 fixed by the agent · 1 marked wrong by you.".replace("&#39;", "'"));
  });

  it("shows the goal run: phase, rounds, blocker, and the user's pause/resume/stop", () => {
    const snap = (over: Record<string, unknown>) => ({ ts: NOW.toISOString(), kind: "goal.change", operation: "create", actor: "user",
      goal: { id: "g1", revision: 1, objective: "x", phase: "active", maxRounds: 50, roundsStarted: 2, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over } }) as AuditRecord;
    const active = renderSections(vm([snap({ claimedComplete: true })])).goal;
    expect(active).toContain("In progress");
    expect(active).toContain("rounds 2 of 50");
    expect(active).toContain("Agent says done — Guardian is checking.");
    expect(active).toContain('data-cmd="pauseGoal"');
    const blocked = renderSections(vm([snap({ phase: "blocked", revision: 2, blockedReason: { code: "no-progress", message: "No progress <here>" } })])).goal;
    expect(blocked).toContain("Blocked");
    expect(blocked).toContain("In the way: No progress &lt;here&gt;");
    expect(blocked).toContain('data-cmd="resumeGoal"');
    const done = renderSections(vm([snap({ phase: "complete", certified: true, revision: 3 })])).goal;
    expect(done).toContain("Done — verified");
    expect(done).not.toContain("data-cmd=\"clearGoalRun\"");
  });

  it("renders nothing until a check has run", () => {
    expect(renderSections(vm([])).donecheck).toBe("");
  });
});

describe("transcript location (Windows observer)", () => {
  it("slugs workspace paths the way Cursor names project folders", () => {
    expect(transcriptProjectSlug("C:\\Temp\\fullwin")).toBe("C-Temp-fullwin");
    expect(transcriptProjectSlug("/tmp/gg-e2e-oOLzwf")).toBe("tmp-gg-e2e-oOLzwf");
  });

  it("finds the folder case-insensitively (the drive letter's case varies by Cursor build)", async () => {
    const home = await tmp("gg-home-");
    await fs.mkdir(path.join(home, ".cursor", "projects", "c-Temp-fullwin", "agent-transcripts"), { recursive: true });
    expect(findTranscriptDir(home, "C:\\Temp\\fullwin")).toBe(path.join(home, ".cursor", "projects", "c-Temp-fullwin", "agent-transcripts"));
    expect(findTranscriptDir(home, "C:\\Other")).toBeNull();
  });

  it("a turn is finished only when turn_ended is the last line", () => {
    expect(endsWithTurnEnded('{"role":"assistant"}\n{"type":"turn_ended","status":"success"}\n')).toBe(true);
    expect(endsWithTurnEnded('{"type":"turn_ended"}\n{"role":"user"}')).toBe(false);
    expect(endsWithTurnEnded("")).toBe(false);
  });
});

describe("observer transcript watcher (native Windows done check)", () => {
  it("arms even when Cursor creates the transcript folder after activation, then judges the finished turn", async () => {
    const { Observer } = await import("../src/observer.js");
    const home = await tmp("gg-obs-home-");
    const root = await tmp("gg-obs-root-");
    process.env.GOAL_GUARDIAN_TEST_HOME = home;
    const p = getGuardianPaths(root);
    await fs.mkdir(p.telemetryDir, { recursive: true });
    await fs.writeFile(p.config, JSON.stringify({ doneCheck: { mode: "advisory" } }));

    const obs = new Observer(root, 50);
    (obs as unknown as { startTranscriptWatcher(): void }).startTranscriptWatcher(); // folder absent: must retry
    await new Promise((r) => setTimeout(r, 120));

    const id = "11111111-2222-3333-4444-555555555555";
    const dir = path.join(home, ".cursor", "projects", root.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), "agent-transcripts", id);
    await fs.mkdir(dir, { recursive: true });
    await new Promise((r) => setTimeout(r, 200)); // retry fires, watch attaches
    await fs.writeFile(
      path.join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "add subtract" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "Added subtract." }] } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n") + "\n",
    );
    let rec: AuditRecord | undefined;
    for (let i = 0; i < 40 && !rec; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const raw = await fs.readFile(p.audit, "utf8").catch(() => "");
      rec = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditRecord).find((r) => r.kind === "done.check");
    }
    obs.dispose();
    expect(rec).toMatchObject({ kind: "done.check", conversationId: id, source: "observer" });
  });
});
