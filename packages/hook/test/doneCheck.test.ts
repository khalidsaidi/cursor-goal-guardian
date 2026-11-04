import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { makeWorkspace, readAudit, auditOfKind, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { ensureBuilt } from "./helpers.js";

beforeAll(ensureBuilt, 30000);

const DIST = path.join(process.cwd(), "dist", "cli.cjs");

/** Raw run: stop/afterAgentResponse answer in their own shapes, not the permission shape. */
async function eventually<T>(get: () => Promise<T | undefined>, ms = 10_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v !== undefined || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function run(root: string, payload: Record<string, unknown>, env?: Record<string, string>): { status: number | null; out: Record<string, unknown> } {
  const res = spawnSync(process.execPath, [DIST], {
    input: JSON.stringify({ ...payload, workspace_roots: [root] }),
    encoding: "utf8",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (res.error) throw res.error;
  return { status: res.status, out: JSON.parse(res.stdout) as Record<string, unknown> };
}

const workspaces: TestWorkspace[] = [];
async function ws(mode: "off" | "advisory" | "enforce", doneCheck: Record<string, unknown> = {}): Promise<TestWorkspace> {
  const w = await makeWorkspace({
    goal: "Fix the CSV parser",
    successCriteria: ["parser handles quoted commas"],
    tasks: [{ id: "t1", title: "Fix the CSV parser quoting", status: "doing" }],
    config: { notify: "quiet", doneCheck: { mode, ...doneCheck } },
  });
  workspaces.push(w);
  return w;
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.cleanup()));
});

const C = { conversation_id: "conv-1", generation_id: "gen-1" };

function shell(root: string, command: string, output: string): void {
  run(root, { ...C, hook_event_name: "beforeShellExecution", command });
  run(root, { ...C, hook_event_name: "afterShellExecution", command, output, duration: 900 });
}

const HONEST = [
  "Fixed quoting in the parser.",
  "",
  "## Done check",
  '1. `pnpm test` → "12 passed"',
  "2. does not apply: one small change, nothing superseded",
  "3. does not apply: no heuristic decides what counts here",
  "4. does not apply: scope is the single parser function",
  '5. `pnpm test` reproduces it, "12 passed"',
  "6. does not apply: nothing left unfinished",
  "7. does not apply: no numbers reported",
  'sc_1. `pnpm test` → "12 passed"',
].join("\n");

describe("done check through the built hook", () => {
  it("enforce: a fabricated result sends the agent back, naming the line", async () => {
    const w = await ws("enforce");
    shell(w.root, "pnpm test", "Tests  11 passed | 1 failed");
    run(w.root, { ...C, hook_event_name: "afterAgentResponse", text: HONEST });
    const { status, out } = run(w.root, { ...C, hook_event_name: "stop", status: "completed", loop_count: 0 });
    expect(status).toBe(0);
    expect(String(out.followup_message)).toMatch(/line 1: "12 passed" was not printed in this session/);
    const [rec] = auditOfKind(await readAudit(w.root), "done.check");
    expect(rec).toMatchObject({ verdict: "fail", conversationId: "conv-1", followupSent: true });
  });

  it("enforce: an honest block passes and sends nothing", async () => {
    const w = await ws("enforce");
    shell(w.root, "pnpm test", "Test Files 2 passed\n Tests  12 passed (12)");
    run(w.root, { ...C, hook_event_name: "afterAgentResponse", text: HONEST });
    const { out } = run(w.root, { ...C, hook_event_name: "stop", status: "completed", loop_count: 0 });
    expect(out).toEqual({});
    expect(auditOfKind(await readAudit(w.root), "done.check")[0]).toMatchObject({ verdict: "pass", followupSent: false });
  });

  it("advisory: records the failure but never sends a follow-up", async () => {
    const w = await ws("advisory");
    shell(w.root, "pnpm test", "12 passed");
    run(w.root, { ...C, hook_event_name: "afterAgentResponse", text: "Done, all good." });
    const { out } = run(w.root, { ...C, hook_event_name: "stop", status: "completed", loop_count: 0 });
    expect(out).toEqual({});
    // Nothing can be sent back, so the check finishes in a detached process: Cursor is not kept waiting.
    expect(await eventually(async () => auditOfKind(await readAudit(w.root), "done.check")[0])).toMatchObject({ verdict: "absent", required: true });
  });

  it("advisory: the stop hook answers before a slow test re-run finishes", async () => {
    const w = await ws("advisory");
    await fs.writeFile(path.join(w.root, "package.json"), JSON.stringify({ scripts: { test: "node -e \"setTimeout(() => {}, 3000)\"" } }));
    execFileSync("git", ["init", "-q"], { cwd: w.root });
    execFileSync("git", ["-c", "user.email=x@x", "-c", "user.name=x", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: w.root });
    run(w.root, { ...C, hook_event_name: "afterFileEdit", file_path: path.join(w.root, "a.js") });
    // Guardian re-runs the test command the agent itself ran.
    shell(w.root, "npm test", "1 passed");
    const t0 = Date.now();
    run(w.root, { ...C, hook_event_name: "stop", status: "completed", loop_count: 0 });
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(await eventually(async () => auditOfKind(await readAudit(w.root), "tests.rerun")[0], 15_000)).toMatchObject({ command: "npm test", exit: 0 });
  });

  it("off: no block checked, nothing sent; shell output kept only while the test re-run is on", async () => {
    const on = await ws("off");
    shell(on.root, "pnpm test", "12 passed");
    expect(run(on.root, { ...C, hook_event_name: "stop", status: "completed", loop_count: 0 }).out).toEqual({});
    expect(auditOfKind(await readAudit(on.root), "done.check")).toHaveLength(0);
    await fs.access(path.join(on.root, ".cursor/goal-guardian/telemetry/shell-output.jsonl"));
  });

  it("off with the test re-run off: nothing stored, nothing checked, nothing sent", async () => {
    const w = await ws("off", { tests: { enabled: false } });
    shell(w.root, "pnpm test", "12 passed");
    run(w.root, { ...C, hook_event_name: "afterAgentResponse", text: "Done." });
    const { out } = run(w.root, { ...C, hook_event_name: "stop", status: "completed", loop_count: 0 });
    expect(out).toEqual({});
    expect(auditOfKind(await readAudit(w.root), "done.check")).toHaveLength(0);
    await expect(fs.access(path.join(w.root, ".cursor/goal-guardian/telemetry/shell-output.jsonl"))).rejects.toThrow();
  });

  it("falls back to transcript_path when afterAgentResponse never arrived", async () => {
    const w = await ws("enforce");
    shell(w.root, "pnpm test", "12 passed");
    const transcript = path.join(w.root, "t.jsonl");
    await fs.writeFile(
      transcript,
      [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "fix it" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: HONEST }] } }),
      ].join("\n"),
    );
    const { out } = run(w.root, { ...C, generation_id: "gen-2", hook_event_name: "stop", status: "completed", loop_count: 0, transcript_path: transcript });
    expect(out).toEqual({});
    expect(auditOfKind(await readAudit(w.root), "done.check")[0]).toMatchObject({ verdict: "pass" });
  });

  it("respects the follow-up cap and aborted turns", async () => {
    const w = await ws("enforce");
    shell(w.root, "pnpm test", "12 passed");
    run(w.root, { ...C, hook_event_name: "afterAgentResponse", text: "Done." });
    for (const loop of [0, 1, 2]) {
      expect(run(w.root, { ...C, hook_event_name: "stop", status: "completed", loop_count: loop }).out.followup_message).toMatch(/Done check/);
    }
    expect(run(w.root, { ...C, hook_event_name: "stop", status: "completed", loop_count: 3 }).out).toEqual({});
    shell(w.root, "pnpm test", "12 passed");
    expect(run(w.root, { ...C, hook_event_name: "stop", status: "aborted", loop_count: 0 }).out).toEqual({});
  });

  it("malformed or unresolvable stop payloads still exit 0 with an empty object", () => {
    const res = spawnSync(process.execPath, [DIST], { input: JSON.stringify({ hook_event_name: "stop" }), encoding: "utf8", cwd: "/" });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({});
  });
});

