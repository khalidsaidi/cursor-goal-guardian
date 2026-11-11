import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { guardContract, criteriaFromTexts, ensureGuardianFiles, parseRequest, readUserPrompts, setEngineGoal, setGoalBudget, userSaidLatest, writeContract } from "@goal-guardian/core";
import { readContractSafe, workspaceRoot } from "../workspace.js";

/** Guardian's own tool: neither original lets the user redirect an open goal from chat. */
export function registerChangeGoal(server: McpServer): void {
  server.registerTool(
    "guardian_change_goal",
    {
      description:
        "Change the goal when the user changes it, add 'done when' items when the goal has none at all, or set the goal's token budget when the user explicitly asks for one. Guardian records the user's first request by itself, so don't call this to declare it.",
      inputSchema: {
        user_words: z.string().optional().describe("The user's new goal, quoted exactly from their latest message. These words become the goal; only the user changes it."),
        add_criteria: z
          .array(z.string().min(1))
          .optional()
          .describe("Only when the goal has no 'done when' items at all: the items to add. Refused when the goal already has any, whoever wrote them."),
        token_budget: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe("Only when the user explicitly asks for a token budget, or to raise or remove one (null removes it): pass their request in user_words. The budget and the usage counted against it are kept by Codex's goal store."),
      },
    },
    async ({ user_words, add_criteria, token_budget }) => {
      const root = await workspaceRoot();
      // The goal is the user's: a goal file changed by anything else is put back before it is read or built on.
      await guardContract(root).catch(() => false);
      try {
        if (token_budget !== undefined) {
          // Codex sets a budget only on an explicit request: Guardian asks to see the request, as for any change.
          const said = await readUserPrompts(root);
          if (said && !userSaidLatest(user_words, said)) {
            return { isError: true, content: [{ type: "text" as const, text: "Budget not changed: only the user sets the token budget. Pass their request in user_words, quoted exactly from their latest message." }] };
          }
          const answer = await setGoalBudget(root, token_budget);
          const text = answer.ran ? JSON.stringify({ goal: answer.goal }) : `Budget not changed: ${answer.reason ?? "Codex's goal store didn't answer"}.`;
          return { ...(answer.ran ? {} : { isError: true }), content: [{ type: "text" as const, text }] };
        }
        const current = await readContractSafe(root);
        const changesGoal = user_words !== undefined && parseRequest(user_words).goal !== current.goal.trim();
        // Where Cursor reports the user's messages, the goal only changes on the user's own words.
        const prompts = changesGoal ? await readUserPrompts(root) : null;
        if (prompts && !userSaidLatest(user_words, prompts)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Not changed: only the user changes the goal. Pass their request in user_words, quoted exactly from their latest message. If they didn't ask for this, keep working toward the goal as written, or ask them." }],
          };
        }
        const next = changesGoal ? parseRequest(user_words!) : null;
        const kept = next ? criteriaFromTexts(next.items) : current.successCriteria;
        // The one case where the agent, not the user, writes "done when" items: a goal that has none at all.
        if (add_criteria?.length && kept.length > 0) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Not added: this goal already has 'done when' items, and only the user changes them. add_criteria is only for a goal that has none." }],
          };
        }
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
