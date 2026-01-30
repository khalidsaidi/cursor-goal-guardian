import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-hook-"));
  await fs.mkdir(path.join(dir, ".cursor", "goal-guardian"), { recursive: true });
  const contract = {
    goal: "Stay on task",
    success_criteria: ["SC1 goal met", "SC2 tests added"],
    constraints: ["No scope creep"],
  };
  await fs.writeFile(
    path.join(dir, ".cursor", "goal-guardian", "contract.json"),
    JSON.stringify(contract, null, 2),
    "utf8",
  );
  return dir;
}

function runHook(workspaceRoot: string, payload: Record<string, unknown>) {
  const cliPath = path.join(process.cwd(), "src", "cli.ts");
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const input = JSON.stringify({
    ...payload,
    workspace_roots: [workspaceRoot],
  });

  const res = spawnSync(tsxBin, [cliPath], {
    input,
    encoding: "utf8",
    env: { ...process.env },
  });

  if (res.error) throw res.error;
  if (!res.stdout) {
    throw new Error(`No stdout from hook. stderr: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

describe("goal-guardian hook CLI", () => {
  it("hard-blocks catastrophic shell commands", async () => {
    const root = await makeTempWorkspace();
    const res = runHook(root, { hook_event_name: "beforeShellExecution", command: "rm -rf /" });
    expect(res.permission).toBe("deny");
    expect(String(res.userMessage)).toMatch(/BLOCKED/i);
  });

  it("warns (allows) for risky commands and increments warning count", async () => {
    const root = await makeTempWorkspace();
    const res1 = runHook(root, { hook_event_name: "beforeShellExecution", command: "git reset --hard" });
    expect(res1.permission).toBe("allow");
    expect(String(res1.userMessage)).toMatch(/Warning/i);

    const violationsPath = path.join(root, ".ai", "goal-guardian", "violations.json");
    const afterFirst = JSON.parse(await fs.readFile(violationsPath, "utf8"));
    expect(afterFirst.warningCounts["git reset --hard*"]).toBe(1);

    runHook(root, { hook_event_name: "beforeShellExecution", command: "git reset --hard" });
    const afterSecond = JSON.parse(await fs.readFile(violationsPath, "utf8"));
    expect(afterSecond.warningCounts["git reset --hard*"]).toBe(2);
  });

  it("recommends permits for non-whitelisted commands", async () => {
    const root = await makeTempWorkspace();
    const res = runHook(root, { hook_event_name: "beforeShellExecution", command: "pnpm test" });
    expect(res.permission).toBe("allow");
    expect(String(res.userMessage)).toMatch(/Permit recommended/i);
  });

  it("blocks sensitive file reads", async () => {
    const root = await makeTempWorkspace();
    const res = runHook(root, { hook_event_name: "beforeReadFile", file_path: ".env" });
    expect(res.permission).toBe("deny");
  });
});
