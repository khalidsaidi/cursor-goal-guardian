#!/usr/bin/env node
/**
 * Goal Guardian MCP server (stdio). The goal tools are DeepSeek Harness's own
 * (get_goal, create_goal, update_goal, run through its tool pipeline) under
 * Codex's names and descriptions too, its /goal command as goal_command, and
 * Guardian's own guardian_change_goal. stdout is JSON-RPC only; diagnostics go
 * to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetGoal } from "./tools/getGoal.js";
import { registerUpdateGoal } from "./tools/updateGoal.js";
import { registerChangeGoal } from "./tools/changeGoal.js";
import { registerCreateGoal } from "./tools/createGoal.js";
import { registerGoalCommand } from "./tools/goalCommand.js";
import { theirTool } from "./tools/theirs.js";
import { engineToolDefinitions } from "@goal-guardian/core";

import { setServerForRoots } from "./workspace.js";

const server = new McpServer({ name: "goal-guardian", version: "1.0.0" });
setServerForRoots(server);

// DeepSeek's tools describe themselves: their names, descriptions and parameters are read from their own runtime
// before the tools are registered. No top-level await: the entry must also bundle to CJS.
void engineToolDefinitions()
  .then((theirs) => {
    registerGetGoal(server, theirTool(theirs, "get_goal"));
    registerCreateGoal(server, theirTool(theirs, "create_goal"));
    registerUpdateGoal(server, theirTool(theirs, "update_goal"));
    registerGoalCommand(server);
    registerChangeGoal(server);
    return server.connect(new StdioServerTransport());
  })
  .then(() => {
    console.error("[goal-guardian] MCP server running on stdio (v1.0.0)");
  });
