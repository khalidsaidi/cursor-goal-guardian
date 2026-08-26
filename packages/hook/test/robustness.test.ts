import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeWorkspace, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { ensureBuilt, runHook, shellEvent } from "./helpers.js";

beforeAll(ensureBuilt, 30000);

const DIST = path.join(process.cwd(), "dist", "cli.cjs");
const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.cleanup()));
});

function rawRun(input: string): { status: number | null; stdout: string; stderr?: string } {
  const res = spawnSync(process.execPath, [DIST], { input, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe("robustness: the hook never breaks the editor", () => {
  it("empty stdin -> allow, exit 0", () => {
    const { status, stdout } = rawRun("");
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ continue: true, permission: "allow" });
  });

  it("garbage stdin -> allow, exit 0", () => {
    const { status, stdout } = rawRun("{not json at all");
    expect(status).toBe(0);
    expect(JSON.parse(stdout).permission).toBe("allow");
  });

  it("bare workspace with no guardian files -> allow, exit 0", async () => {
    const w = await makeWorkspace({ bare: true });
    workspaces.push(w);
    const { status, response } = runHook(w.root, shellEvent("cargo build"));
    expect(status).toBe(0);
    expect(response.permission).toBe("allow");
  });

  it("corrupt state.json and config.json -> allow, exit 0", async () => {
    const w = await makeWorkspace();
    workspaces.push(w);
    await fs.writeFile(w.paths.state, "{truncated", "utf8");
    await fs.writeFile(w.paths.config, "also broken", "utf8");
    const { status, response } = runHook(w.root, shellEvent("rm -rf /"));
    expect(status).toBe(0);
    expect(response.permission).toBe("allow");
  });

  it("unwritable telemetry dir -> allow, exit 0", async () => {
    const w = await makeWorkspace();
    workspaces.push(w);
    await fs.chmod(w.paths.telemetryDir, 0o555);
    try {
      const { status, response } = runHook(w.root, shellEvent("git reset --hard"));
      expect(status).toBe(0);
      expect(response.permission).toBe("allow");
    } finally {
      await fs.chmod(w.paths.telemetryDir, 0o755);
    }
  });

  it("missing payload fields -> allow, exit 0", async () => {
    const w = await makeWorkspace();
    workspaces.push(w);
    const { status, response } = runHook(w.root, { hook_event_name: "beforeShellExecution" });
    expect(status).toBe(0);
    expect(response.permission).toBe("allow");
  });
});
