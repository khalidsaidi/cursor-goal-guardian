/**
 * Goal Guardian Cursor hook (stdio JSON in/out). Contract: this process NEVER
 * blocks and NEVER breaks the editor — every path, including crashes and
 * malformed input, ends in permission:"allow" and exit code 0.
 */
import path from "node:path";
import { advisoryAllow, type HookResponse } from "./respond.js";
import { runPipeline } from "./pipeline.js";

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

function workspaceRoot(payload: Record<string, unknown>): string {
  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === "string" && roots[0]) return roots[0];
  return process.cwd();
}

function relativePath(root: string, value: string): string {
  const asPosix = (p: string): string => p.split(path.sep).join("/");
  if (!value) return "";
  if (path.isAbsolute(value)) return asPosix(path.relative(root, value));
  return asPosix(value).replace(/^\.\//, "");
}

async function handle(payload: Record<string, unknown>): Promise<HookResponse> {
  const root = workspaceRoot(payload);
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
