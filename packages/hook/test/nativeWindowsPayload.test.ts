import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeWorkspace, readAudit, auditOfKind, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { ensureBuilt } from "./helpers.js";

beforeAll(ensureBuilt, 30000);

const DIST = path.resolve(__dirname, "..", "dist", "cli.cjs");
const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.cleanup()));
});

/**
 * Native-Windows Cursor sends hook payloads with NO workspace_roots and a cwd
 * outside the workspace — only file_path locates the work (captured live from
 * the Hooks execution log, 2026-08-26). The hook must resolve the workspace by
 * ascending from file_path, and must refuse to guess when nothing resolves.
 */
function runRaw(cwd: string, payload: Record<string, unknown>): { status: number | null; response: Record<string, unknown> } {
  const res = spawnSync(process.execPath, [DIST], { input: JSON.stringify(payload), encoding: "utf8", cwd });
  return { status: res.status, response: JSON.parse(res.stdout) as Record<string, unknown> };
}

describe("native-windows payload shape (no workspace_roots, foreign cwd)", () => {
  it("afterFileEdit resolves the workspace from file_path and writes the tape", async () => {
    const w = await makeWorkspace({ goal: "Expense tracker app", tasks: [{ id: "t1", title: "Build the expense form", status: "doing" }] });
    workspaces.push(w);
    const hostileCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-elsewhere-"));
    const { status, response } = runRaw(hostileCwd, {
      hook_event_name: "afterFileEdit",
      file_path: path.join(w.root, "src", "form.ts"),
      conversation_id: "c1",
      generation_id: "g1",
    });
    expect(status).toBe(0);
    expect(response.permission).toBe("allow");
    const observed = auditOfKind(await readAudit(w.root), "action.observed");
    expect(observed.length).toBeGreaterThan(0);
    await fs.rm(hostileCwd, { recursive: true, force: true });
  });

  it("nothing resolvable -> bare allow, no crash, no tape written anywhere", async () => {
    const hostileCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-nowhere-"));
    const { status, response } = runRaw(hostileCwd, {
      hook_event_name: "beforeMCPExecution",
      mcp_server_name: "some-server",
      tool_name: "some_tool",
    });
    expect(status).toBe(0);
    expect(response.permission).toBe("allow");
    expect(response.userMessage).toBeUndefined();
    await expect(fs.access(path.join(hostileCwd, ".cursor"))).rejects.toThrow();
    await fs.rm(hostileCwd, { recursive: true, force: true });
  });
});
