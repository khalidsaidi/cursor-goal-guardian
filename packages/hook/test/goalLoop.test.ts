import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { auditOfKind, makeWorkspace, readAudit, type TestWorkspace } from "cursor-goal-guardian-testkit";

const DIST = path.join(process.cwd(), "dist", "cli.cjs");
const made: TestWorkspace[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((w) => w.cleanup()));
});
function run(root: string, payload: Record<string, unknown>): Record<string, unknown> {
  const res = spawnSync(process.execPath, [DIST], { input: JSON.stringify({ workspace_roots: [root], conversation_id: "c1", generation_id: "g1", ...payload }), encoding: "utf8", timeout: 30_000 });
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout) as Record<string, unknown>;
}
async function ws(): Promise<TestWorkspace> {
  const w = await makeWorkspace({ goal: "Fix the CSV parser", successCriteria: ["quoted commas parse"] });
  made.push(w);
  return w;
}
const stop = (loop_count = 0) => ({ hook_event_name: "stop", status: "completed", loop_count });

describe("the goal loop through the built hook", () => {
  it("an editing turn is sent back with the goal and the facts, in Cursor's shape", async () => {
    const w = await ws();
    run(w.root, { hook_event_name: "afterFileEdit", file_path: path.join(w.root, "src/csv.js") });
    const out = run(w.root, stop());
    expect(String(out.followup_message)).toMatch(/^Goal Guardian: round 1 of 20[\s\S]*Fix the CSV parser[\s\S]*not accounted for: src\/csv\.js/);
    expect(auditOfKind(await readAudit(w.root), "goal.round")).toHaveLength(1);
  });

  it("records what commands printed and what the user said, answering in each hook's own shape", async () => {
    const w = await ws();
    expect(run(w.root, { hook_event_name: "beforeSubmitPrompt", prompt: "fix the parser" })).toEqual({ continue: true });
    expect(run(w.root, { hook_event_name: "afterShellExecution", command: "make test", output: "12 passed", duration: 1500 })).toEqual({});
    const dir = path.join(w.root, ".cursor", "goal-guardian", "telemetry");
    expect(JSON.parse(await fs.readFile(path.join(dir, "prompts.json"), "utf8"))).toEqual(["fix the parser"]);
    expect(await fs.readFile(path.join(dir, "shell-output.jsonl"), "utf8")).toContain("12 passed");
  });

  it("sees a failed command through either hook Cursor uses, and only for shell tools", async () => {
    const w = await ws();
    const file = path.join(w.root, ".cursor", "goal-guardian", "telemetry", "shell-output.jsonl");
    const failures = async () => (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter((l) => l.includes('"failed":true')).length;
    const tool = { tool_name: "Shell", tool_input: { command: "make test", cwd: "" } };
    expect(run(w.root, { hook_event_name: "postToolUse", ...tool, tool_output: JSON.stringify({ output: "ok", exitCode: 0 }) })).toEqual({});
    expect(await failures()).toBe(0);
    run(w.root, { hook_event_name: "postToolUse", ...tool, tool_output: JSON.stringify({ output: "boom", exitCode: 1 }) });
    expect(await failures()).toBe(1);
    run(w.root, { hook_event_name: "postToolUseFailure", ...tool, error_message: "Command failed with exit code 2" });
    expect(await failures()).toBe(2);
    run(w.root, { hook_event_name: "postToolUseFailure", tool_name: "Read", tool_input: { command: "x" }, error_message: "no" });
    run(w.root, { hook_event_name: "postToolUse", ...tool, tool_output: "not json" });
    expect(await failures()).toBe(2);
  });

  it("a message in an agent mode carries the goal; Cmd+K and Guardian's own messages don't", async () => {
    const w = await ws();
    const send = (extra: Record<string, unknown>) => run(w.root, { hook_event_name: "beforeSubmitPrompt", prompt: "go", ...extra });
    expect(String(send({ composer_mode: "agent" }).additional_context)).toContain("Fix the CSV parser");
    expect(send({ composer_mode: "chat" })).toEqual({ continue: true });
    expect(send({})).toEqual({ continue: true });
    expect(send({ composer_mode: "agent", prompt: "Goal Guardian: round 2 of 20" })).toEqual({ continue: true });
  });

  it("finds a Windows workspace root sent as a URI path, and answers in plain ASCII", () => {
    const res = spawnSync(process.execPath, [DIST], { input: JSON.stringify({ hook_event_name: "stop", status: "completed", workspace_roots: ["/c:/nowhere/at/all"], conversation_id: "c" }), encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({});
  });

  it("reads a payload that starts with a byte-order mark, as PowerShell sends it on Windows", async () => {
    const w = await ws();
    const res = spawnSync(process.execPath, [DIST], { input: `\uFEFF${JSON.stringify({ workspace_roots: [w.root], conversation_id: "c1", hook_event_name: "beforeSubmitPrompt", prompt: "go" })}`, encoding: "utf8" });
    expect(JSON.parse(res.stdout)).toEqual({ continue: true });
    expect(auditOfKind(await readAudit(w.root), "user.message")).toHaveLength(1);
  });

  it("escapes non-ASCII goal text in what it prints", async () => {
    const w = await makeWorkspace({ goal: "Corrige le problème 日本", successCriteria: ["ok"] });
    made.push(w);
    run(w.root, { hook_event_name: "afterFileEdit", file_path: path.join(w.root, "a.js") });
    const res = spawnSync(process.execPath, [DIST], { input: JSON.stringify({ workspace_roots: [w.root], conversation_id: "c1", ...stop() }), encoding: "utf8" });
    expect(res.stdout).toMatch(/^[\x00-\x7f]*$/);
    expect(String((JSON.parse(res.stdout) as { followup_message: string }).followup_message)).toContain("problème 日本");
  });

  it("carries the turn's tokens from the stop hook", async () => {
    const w = await ws();
    run(w.root, { hook_event_name: "afterFileEdit", file_path: path.join(w.root, "a.js") });
    run(w.root, { ...stop(), input_tokens: 700, output_tokens: 300, cache_read_tokens: 9000 });
    expect(auditOfKind(await readAudit(w.root), "goal.round")[0]).toMatchObject({ tokens: 1000 });
  });

  it("with no workspace every hook still answers safely; a turn with no edits answers empty", async () => {
    for (const [event, shape] of [["stop", {}], ["afterShellExecution", {}], ["postToolUse", {}], ["postToolUseFailure", {}], ["beforeSubmitPrompt", { continue: true }]] as const) {
      const res = spawnSync(process.execPath, [DIST], { input: JSON.stringify({ hook_event_name: event }), encoding: "utf8", cwd: "/" });
      expect(JSON.parse(res.stdout)).toEqual(shape);
    }
    const w = await ws();
    expect(run(w.root, stop())).toEqual({});
  });
});
