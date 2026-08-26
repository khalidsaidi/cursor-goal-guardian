import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadActions, readAuditTail, summarizeSession } from "@goal-guardian/core";
import { readStateSafe, workspaceRoot } from "../workspace.js";

export function registerGetStatus(server: McpServer): void {
  server.registerTool(
    "guardian_get_status",
    {
      description:
        "Read the session flight recorder: goal, task board counts, recent drift entries with their review status, and 24h telemetry.",
      inputSchema: {},
    },
    async () => {
      const root = await workspaceRoot();
      const state = await readStateSafe(root);
      const records = await readAuditTail(root);
      const actions = await loadActions(root).catch(() => []);
      const summary = summarizeSession(state, records, actions, new Date());
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    },
  );
}
