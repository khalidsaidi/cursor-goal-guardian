import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { evaluateLexicalDrift, evaluatePolicy } from "@goal-guardian/core";
import { readConfigSafe, readStateSafe, workspaceRoot } from "../workspace.js";

export function registerCheckAction(server: McpServer): void {
  server.registerTool(
    "guardian_check_action",
    {
      description:
        "Advisory self-check for an action you are considering: returns its policy severity (ok / caution / alert) and whether it looks off-scope for the active task. Nothing is blocked either way; this is a mirror, not a gate.",
      inputSchema: {
        action_type: z.enum(["shell", "mcp", "read"]).describe("The kind of action."),
        action_value: z
          .string()
          .min(1)
          .describe("The command string, 'server/tool' for MCP, or relative file path for reads."),
      },
    },
    async ({ action_type, action_value }) => {
      const root = await workspaceRoot();
      const config = await readConfigSafe(root);
      const state = await readStateSafe(root);
      const advisory = evaluatePolicy(action_type, action_value, config);
      const drift = evaluateLexicalDrift(state, config, action_type, action_value);
      const result = {
        severity: advisory.severity,
        rule: advisory.rule || null,
        reason: advisory.reason || null,
        lexicalDrift: drift
          ? {
              activeTaskTitle: drift.activeTaskTitle,
              confidence: drift.confidence,
              taskTerms: drift.taskTerms,
              actionTerms: drift.actionTerms,
            }
          : null,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
