import fs from "node:fs";
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

/**
 * Resolve the workspace this session serves. Priority:
 * 1. GOAL_GUARDIAN_WORKSPACE_ROOT (explicit per-workspace wiring)
 * 2. The MCP client's advertised roots (the protocol answer — this is what
 *    makes a single GLOBAL registration serve every repo, incl. Cursor's
 *    agent hub where workspace mcp.json isn't loaded)
 * 3. CURSOR_WORKSPACE_ROOT / WORKSPACE_FOLDER_PATHS
 * 4. cwd
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

  const envRoot = process.env.CURSOR_WORKSPACE_ROOT || process.env.WORKSPACE_FOLDER_PATHS?.split(",")[0];
  if (envRoot && looksLikeWorkspace(envRoot)) {
    cachedRoot = envRoot;
    return envRoot;
  }
  return process.cwd();
}
