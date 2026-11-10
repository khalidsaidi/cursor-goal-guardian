#!/usr/bin/env node
/**
 * Goal Guardian MCP server (stdio). Four tools over the shared core: read the
 * goal and its status, set it, report on it. stdout is JSON-RPC only;
 * diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetContract } from "./tools/getContract.js";
import { registerGetStatus } from "./tools/getStatus.js";
import { registerUpdateGoal } from "./tools/updateGoal.js";
import { registerReportGoal } from "./tools/reportGoal.js";

import { setServerForRoots } from "./workspace.js";

const server = new McpServer({ name: "goal-guardian", version: "1.0.0" });
setServerForRoots(server);

registerGetContract(server);
registerGetStatus(server);
registerUpdateGoal(server);
registerReportGoal(server);

// No top-level await: the entry must bundle to CJS for Node SEA (the
// win32-arm64 executable), and CJS forbids TLA.
const transport = new StdioServerTransport();
void server.connect(transport).then(() => {
  console.error("[goal-guardian] MCP server running on stdio (v1.0.0)");
});
