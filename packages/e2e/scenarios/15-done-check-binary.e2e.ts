import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldWorkspace, type E2EWorkspace } from "../src/scaffold.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST_TARGET = `${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const EXE = process.platform === "win32" ? ".exe" : "";
const BIN_HOOK = path.join(REPO, "dist-bin", HOST_TARGET, `goal-guardian-hook${EXE}`);
// The exact final messages and shell output from a live Cursor IDE turn pair:
// turn 1's block was sent back, turn 2's corrected block passed.
const LIVE = JSON.parse(
  fs.readFileSync(path.join(REPO, "packages", "core", "test", "fixtures", "donecheck", "live-ide-subtract.json"), "utf8"),
) as { shellRuns: Array<{ command: string; output: string }>; responses: string[] };

/**
 * The done check through the SHIPPED binary, replaying the event order Cursor
 * sends (verified live): afterShellExecution with output, afterAgentResponse
 * with the final text, then stop with status + loop_count. Runs on every CI
 * platform; the live IDE run itself happened over WSL.
 */
describe("15 [deterministic] done check through the shipped hook binary", () => {
  const made: E2EWorkspace[] = [];
  afterEach(async () => {
    await Promise.all(made.splice(0).map((w) => w.cleanup()));
  });

  function hook(ws: E2EWorkspace, payload: Record<string, unknown>): Record<string, unknown> {
    const res = spawnSync(BIN_HOOK, [], {
      input: JSON.stringify({ workspace_roots: [ws.root], conversation_id: "conv-live", ...payload }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout) as Record<string, unknown>;
  }

  it("enforce: a failing block is sent back naming its lines; the corrected one passes and stops the loop", async () => {
    const ws = await scaffoldWorkspace({
      successCriteria: ["subtract() exists next to add()"],
      config: { notify: "quiet", doneCheck: { mode: "enforce" } },
    });
    made.push(ws);
    fs.writeFileSync(path.join(ws.root, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n");

    const [first, ...rest] = LIVE.shellRuns;
    hook(ws, { hook_event_name: "beforeShellExecution", generation_id: "g1", command: first!.command });
    hook(ws, { hook_event_name: "afterShellExecution", generation_id: "g1", command: first!.command, output: first!.output });
    hook(ws, { hook_event_name: "afterAgentResponse", generation_id: "g1", text: LIVE.responses[0] });
    const turn1 = hook(ws, { hook_event_name: "stop", generation_id: "g1", status: "completed", loop_count: 0 });
    // Prose lines fail the spec as written; the command-quote bug from the live run must NOT reappear.
    expect(String(turn1.followup_message)).toMatch(/line 2: no command\+output/);
    expect(String(turn1.followup_message)).not.toMatch(/was not printed in this session/);

    for (const run of rest) {
      hook(ws, { hook_event_name: "beforeShellExecution", generation_id: "g2", command: run.command });
      hook(ws, { hook_event_name: "afterShellExecution", generation_id: "g2", command: run.command, output: run.output });
    }
    hook(ws, { hook_event_name: "afterAgentResponse", generation_id: "g2", text: LIVE.responses[1] });
    const turn2 = hook(ws, { hook_event_name: "stop", generation_id: "g2", status: "completed", loop_count: 1 });
    expect(turn2).toEqual({});

    const checks = fs
      .readFileSync(ws.paths.audit, "utf8")
      .split("\n")
      .filter((l) => l.includes('"done.check"'))
      .map((l) => JSON.parse(l) as { verdict: string; followupSent: boolean });
    expect(checks.map((c) => [c.verdict, c.followupSent])).toEqual([
      ["fail", true],
      ["pass", false],
    ]);
  });
});
