#!/usr/bin/env node
/**
 * Goal Guardian MCP server (stdio). Three tools over the shared core: Codex's
 * get_goal and update_goal by their own names and descriptions, and Guardian's
 * own guardian_change_goal for when the user redirects the goal. stdout is JSON-RPC only;
 * diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetGoal } from "./tools/getGoal.js";
import { registerUpdateGoal } from "./tools/updateGoal.js";
import { registerChangeGoal } from "./tools/changeGoal.js";

import { setServerForRoots } from "./workspace.js";

const server = new McpServer({ name: "goal-guardian", version: "1.0.0" });
setServerForRoots(server);

registerGetGoal(server);
registerUpdateGoal(server);
registerChangeGoal(server);

// No top-level await: the entry must bundle to CJS for Node SEA (the
// win32-arm64 executable), and CJS forbids TLA.
const transport = new StdioServerTransport();
void server.connect(transport).then(() => {
  console.error("[goal-guardian] MCP server running on stdio (v1.0.0)");
});
