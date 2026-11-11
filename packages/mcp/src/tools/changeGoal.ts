import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { criteriaFromTexts, ensureGuardianFiles, parseRequest, readUserPrompts, setEngineGoal, userSaid, writeContract } from "@goal-guardian/core";
import { readContractSafe, workspaceRoot } from "../workspace.js";

/** Guardian's own tool: neither original lets the user redirect an open goal from chat. */
export function registerChangeGoal(server: McpServer): void {
  server.registerTool(
    "guardian_change_goal",
    {
      description:
        "Change the goal when the user changes it, or add 'done when' items when the user listed none. Guardian records the user's first request by itself, word for word, so don't call this to declare it.",
      inputSchema: {
        user_words: z.string().optional().describe("The user's new goal, quoted exactly from their message. These words become the goal; only the user changes it."),
        add_criteria: z
          .array(z.string().min(1))
          .optional()
          .describe("Only if the user listed no 'done when' items: new ones to add. Existing items can't be changed or removed."),
      },
    },
    async ({ user_words, add_criteria }) => {
      const root = await workspaceRoot();
      try {
        const current = await readContractSafe(root);
        const changesGoal = user_words !== undefined && parseRequest(user_words).goal !== current.goal.trim();
        // Where Cursor reports the user's messages, the goal only changes on the user's own words.
        const prompts = changesGoal ? await readUserPrompts(root) : null;
        if (prompts && !userSaid(user_words, prompts)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Not changed: only the user changes the goal. Pass their request in user_words, quoted exactly from their message. If they didn't ask for this, keep working toward the goal as written, or ask them." }],
          };
        }
        const next = changesGoal ? parseRequest(user_words!) : null;
        const kept = next ? criteriaFromTexts(next.items) : current.successCriteria;
        const added = (add_criteria ?? []).map((text, i) => ({ id: `sc_${kept.length + i + 1}`, text }));
        await ensureGuardianFiles(root);
        // DeepSeek's goal service takes the new words first (an edit, or a new goal after a completed one).
        if (next && !(await setEngineGoal(root, next.goal, false))) {
          return { isError: true, content: [{ type: "text" as const, text: "Not changed: the goal can't be changed from where it stands." }] };
        }
        const contract = await writeContract(root, { ...current, ...(next ? { goal: next.goal } : {}), successCriteria: [...kept, ...added] });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ goal: contract.goal, criteria: contract.successCriteria, constraints: contract.constraints }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    },
  );
}
