import { spawn } from "node:child_process";

export interface AgentRunOptions {
  workspace: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
}

export interface AgentRunResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/** Skip billable scenarios only in CI without an explicit opt-in; locally they run freely. */
export function billableRunsEnabled(): boolean {
  if (process.env.CI && process.env.GG_E2E_CONFIRM !== "1") return false;
  return true;
}

/** Drive a real headless Cursor agent inside the scaffolded workspace. */
export async function runCursorAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const model = options.model ?? process.env.GG_E2E_MODEL;
  // --force is required for headless MCP tool CALLS (--approve-mcps only
  // approves servers); safe here, agents run in throwaway temp workspaces.
  const args = ["-p", options.prompt, "--output-format", "json", "--trust", "--approve-mcps", "--force", "--workspace", options.workspace];
  if (model) args.push("--model", model);

  return new Promise((resolve) => {
    const child = spawn("cursor-agent", args, { cwd: options.workspace, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, timedOut });
    });
  });
}
