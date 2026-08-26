/**
 * Goal Guardian Cursor hook (stdio JSON in/out). Contract: this process NEVER
 * blocks and NEVER breaks the editor — every path, including crashes and
 * malformed input, ends in permission:"allow" and exit code 0.
 */
import fs from "node:fs";
import path from "node:path";
import { advisoryAllow, runPipeline, type HookResponse } from "@goal-guardian/core";

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function eventName(payload: Record<string, unknown>): string {
  for (const key of ["hook_event_name", "hookEventName", "event", "name"]) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** True when this directory is a Guardian workspace. */
function isGuardianWorkspace(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".cursor", "goal-guardian"));
  } catch {
    return false;
  }
}

/**
 * Resolve the workspace this event belongs to. Native-Windows Cursor sends
 * hook payloads with NO workspace_roots and a cwd outside the workspace —
 * only file_path identifies where the work is happening. Ladder:
 * 1. workspace_roots (WSL/remote sends it)
 * 2. ascend from file_path until a Guardian workspace appears
 * 3. cwd, if it is a Guardian workspace
 * Unresolvable returns "" and the caller answers a bare allow — never a
 * guessed directory, never a tape written into the wrong place.
 */
function workspaceRoot(payload: Record<string, unknown>): string {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];

  const filePath = typeof payload.file_path === "string" ? payload.file_path : "";
  if (filePath && path.isAbsolute(filePath)) {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 32; i += 1) {
      if (isGuardianWorkspace(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const cwd = process.cwd();
  if (isGuardianWorkspace(cwd)) return cwd;
  return "";
}

function relativePath(root: string, value: string): string {
  const asPosix = (p: string): string => p.split(path.sep).join("/");
  if (!value) return "";
  if (path.isAbsolute(value)) return asPosix(path.relative(root, value));
  return asPosix(value).replace(/^\.\//, "");
}

async function handle(payload: Record<string, unknown>): Promise<HookResponse> {
  const root = workspaceRoot(payload);
  if (!root) return advisoryAllow();
  const event = eventName(payload);

  switch (event) {
    case "beforeShellExecution":
      return runPipeline(root, "beforeShellExecution", "shell", String(payload.command ?? ""), ids(payload));
    case "beforeMCPExecution": {
      // Cursor sends the server as mcp_server_name; older builds used server.
      const serverName = String(payload.mcp_server_name ?? payload.server ?? "");
      const value = `${serverName}/${String(payload.tool_name ?? "")}`;
      return runPipeline(root, "beforeMCPExecution", "mcp", value, ids(payload));
    }
    case "beforeReadFile":
    case "beforeTabFileRead":
      return runPipeline(root, "beforeReadFile", "read", relativePath(root, String(payload.file_path ?? "")), ids(payload));
    case "afterFileEdit":
    case "afterTabFileEdit":
      return runPipeline(root, "afterFileEdit", "edit", relativePath(root, String(payload.file_path ?? "")), ids(payload));
    default:
      return advisoryAllow();
  }
}

function ids(payload: Record<string, unknown>): { conversationId?: string; generationId?: string } {
  const conversationId = typeof payload.conversation_id === "string" ? payload.conversation_id : undefined;
  const generationId = typeof payload.generation_id === "string" ? payload.generation_id : undefined;
  return { ...(conversationId ? { conversationId } : {}), ...(generationId ? { generationId } : {}) };
}

async function main(): Promise<void> {
  let response: HookResponse = advisoryAllow();
  try {
    const raw = await readAllStdin();
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (payload && typeof payload === "object") {
      response = await handle(payload);
    }
  } catch {
    response = advisoryAllow();
  }
  process.stdout.write(JSON.stringify(response));
}

main()
  .catch(() => {
    process.stdout.write(JSON.stringify(advisoryAllow()));
  })
  .finally(() => {
    process.exit(0);
  });
