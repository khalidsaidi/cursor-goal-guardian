import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { blockGoal, claimGoalComplete, GoalError, pauseGoal, readGoal } from "@goal-guardian/core";
import { workspaceRoot } from "../workspace.js";

/** Rounds a goal must have run before the agent may call it blocked: one hard moment is not a blocker. */
export const BLOCKED_AFTER_ROUNDS = 3;

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function registerGoalStatus(server: McpServer): void {
  server.registerTool(
    "guardian_get_goal",
    {
      description:
        "Read the current goal: its objective (the goal and its 'done when' list), phase (active, paused, blocked, complete, budget_limited), rounds used of its budget, any blocker, and the revision to pass to guardian_set_goal_status.",
      inputSchema: {},
    },
    async () => text({ goal: await readGoal(await workspaceRoot()) }),
  );

  server.registerTool(
    "guardian_set_goal_status",
    {
      description:
        "Record the goal's state. complete: your evidence covers every 'done when' item — Guardian then verifies it against the session itself; your word alone does not complete it. blocked: only when the same obstacle outside your reach (the user, a credential, an outside service) has held for several rounds — hard, slow or uncertain work is not blocked. paused: only when the user asked you to stop.",
      inputSchema: {
        revision: z.number().int().positive().describe("The revision guardian_get_goal returned."),
        status: z.enum(["complete", "blocked", "paused"]),
        reason: z.string().optional().describe("Required for blocked: the concrete obstacle and what you tried."),
        user_asked: z.boolean().optional().describe("Required true for paused: the user asked you to stop."),
      },
    },
    async ({ revision, status, reason, user_asked }) => {
      const root = await workspaceRoot();
      try {
        const goal = await readGoal(root);
        if (!goal) return text({ error: "no goal is set" });
        if (status === "paused") {
          if (user_asked !== true) return text({ error: "paused is only for when the user asked you to stop; otherwise keep working" });
          return text({ goal: await pauseGoal(root, revision, "agent") });
        }
        if (status === "blocked") {
          if (!reason || reason.trim().length < 8) return text({ error: "blocked needs a reason: the concrete obstacle and what you tried" });
          if (goal.roundsStarted < BLOCKED_AFTER_ROUNDS) {
            return text({ error: `too early to call this blocked (round ${goal.roundsStarted} of at least ${BLOCKED_AFTER_ROUNDS}). Try the ways around it first; if the same obstacle holds for ${BLOCKED_AFTER_ROUNDS} rounds, record it then.` });
          }
          return text({ goal: await blockGoal(root, revision, { code: "agent-reported", message: reason.trim().slice(0, 300) }, "agent") });
        }
        const claimed = await claimGoalComplete(root, revision, "agent");
        return text({ goal: claimed, note: "Recorded as your claim. Guardian verifies it against the session at the end of this turn; until then the goal stays active." });
      } catch (err) {
        if (err instanceof GoalError) return text({ error: err.message, code: err.code });
        throw err;
      }
    },
  );
}
