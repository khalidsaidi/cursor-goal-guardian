import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadActions, readAuditTail, summarizeSession } from "@goal-guardian/core";
import { readStateSafe, workspaceRoot } from "../workspace.js";

export function registerGetStatus(server: McpServer): void {
  server.registerTool(
    "guardian_get_status",
    {
      description:
        "Read the session flight recorder: goal, task board counts, recent drift entries with their review status, 24h telemetry, and the latest end-of-turn done check (what the agent claimed vs. what the tape shows).",
      inputSchema: {},
    },
    async () => {
      const root = await workspaceRoot();
      const state = await readStateSafe(root);
      const records = await readAuditTail(root);
      const actions = await loadActions(root).catch(() => []);
      const summary = summarizeSession(state, records, actions, new Date());
      const lastDoneCheck = [...records].reverse().find((r) => r.kind === "done.check" && r.verdict !== "not_required") ?? null;
      return { content: [{ type: "text", text: JSON.stringify({ ...summary, lastDoneCheck }) }] };
    },
  );
}
