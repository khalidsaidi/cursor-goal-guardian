import { spawnSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIST = path.join(process.cwd(), "dist", "cli.cjs");

export function ensureBuilt(): void {
  if (!fs.existsSync(DIST)) {
    execSync("node build.mjs", { cwd: process.cwd(), stdio: "ignore" });
  }
}

export interface HookRun {
  status: number | null;
  response: { continue: boolean; permission: string; userMessage?: string; agentMessage?: string };
}

/** Spawn the real built bundle — the artifact users run — never the TS source. */
export function runHook(workspaceRoot: string, payload: Record<string, unknown>): HookRun {
  const res = spawnSync(process.execPath, [DIST], {
    input: JSON.stringify({ ...payload, workspace_roots: [workspaceRoot] }),
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  if (!res.stdout) throw new Error(`No stdout from hook. stderr: ${res.stderr}`);
  return { status: res.status, response: JSON.parse(res.stdout) };
}

export function shellEvent(command: string): Record<string, unknown> {
  return { hook_event_name: "beforeShellExecution", command };
}

export function readEvent(filePath: string): Record<string, unknown> {
  return { hook_event_name: "beforeReadFile", file_path: filePath };
}
