import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export { readContractSafe, readStateSafe, readConfigSafe } from "@goal-guardian/core";

let serverRef: McpServer | null = null;
let cachedRoot: string | null = null;

export function setServerForRoots(server: McpServer): void {
  serverRef = server;
}

function looksLikeWorkspace(p: string): boolean {
  try {
    return fs.existsSync(path.join(p, ".cursor"));
  } catch {
    return false;
  }
}

function isHomeish(p: string): boolean {
  const norm = path.resolve(p);
  const home = path.resolve(os.homedir());
  return norm === home || norm === path.join(home, ".cursor");
}

/**
 * Resolve the workspace this session serves. Priority:
 * 1. GOAL_GUARDIAN_WORKSPACE_ROOT (explicit per-workspace wiring)
 * 2. The MCP client's advertised roots (the protocol answer — this is what
 *    makes a single GLOBAL registration serve every repo, incl. Cursor's
 *    agent hub where workspace mcp.json isn't loaded)
 * 3. CURSOR_WORKSPACE_ROOT / WORKSPACE_FOLDER_PATHS (Windows lists use ';')
 * 4. cwd — but only when it actually looks like a workspace.
 *
 * The home directory is NEVER an acceptable answer: hosts that spawn global
 * servers with cwd=$HOME used to make the guardian silently write session
 * files into the user's home. Unresolvable now throws a message the agent
 * can read and relay instead.
 */
export async function workspaceRoot(): Promise<string> {
  if (process.env.GOAL_GUARDIAN_WORKSPACE_ROOT) return process.env.GOAL_GUARDIAN_WORKSPACE_ROOT;
  if (cachedRoot) return cachedRoot;

  if (serverRef) {
    try {
      const result = await serverRef.server.listRoots(undefined, { timeout: 3000 });
      const first = result.roots?.[0]?.uri;
      if (first?.startsWith("file://")) {
        cachedRoot = fileURLToPath(first);
        return cachedRoot;
      }
    } catch {
      // client doesn't support roots; fall through
    }
  }

  const candidates = [
    process.env.CURSOR_WORKSPACE_ROOT,
    ...(process.env.WORKSPACE_FOLDER_PATHS?.split(/[;,]/) ?? []),
  ].filter((c): c is string => Boolean(c && c.trim()));
  for (const candidate of candidates) {
    const c = candidate.trim();
    if (looksLikeWorkspace(c) && !isHomeish(c)) {
      cachedRoot = c;
      return c;
    }
  }

  const cwd = process.cwd();
  if (looksLikeWorkspace(cwd) && !isHomeish(cwd)) return cwd;

  throw new Error(
    "Goal Guardian could not determine which workspace this chat belongs to " +
      "(the client offered no workspace roots). Tell the user: open the project " +
      "folder in Cursor, or add the repository to this chat's context, then retry.",
  );
}
