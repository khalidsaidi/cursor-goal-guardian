#!/usr/bin/env node
/**
 * Goal Guardian MCP server (stdio). Four advisory tools over the shared core —
 * a flight-recorder interface, not a gatekeeper. stdout is JSON-RPC only;
 * diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetContract } from "./tools/getContract.js";
import { registerDeclareIntent } from "./tools/declareIntent.js";
import { registerCheckAction } from "./tools/checkAction.js";
import { registerGetStatus } from "./tools/getStatus.js";
import { registerRecordProgress } from "./tools/recordProgress.js";
import { registerUpdateGoal } from "./tools/updateGoal.js";

import { setServerForRoots } from "./workspace.js";

const server = new McpServer({ name: "goal-guardian", version: "1.0.0" });
setServerForRoots(server);

registerGetContract(server);
registerDeclareIntent(server);
registerCheckAction(server);
registerGetStatus(server);
registerRecordProgress(server);
registerUpdateGoal(server);

// No top-level await: the entry must bundle to CJS for Node SEA (the
// win32-arm64 executable), and CJS forbids TLA.
const transport = new StdioServerTransport();
void server.connect(transport).then(() => {
  console.error("[goal-guardian] MCP server running on stdio (v1.0.0)");
});
