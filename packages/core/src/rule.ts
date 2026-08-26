import path from "node:path";

/**
 * The session-start anchor. The hook can only reach the agent AFTER it drifts;
 * this always-applied Cursor rule anchors every session to the contract BEFORE
 * any work happens, and turns the MCP tool surface from available into used.
 */
export const GUARDIAN_RULE_RELATIVE_PATH = path.join(".cursor", "rules", "goal-guardian.mdc");

export function guardianRuleContent(): string {
  return [
    "---",
    "description: Goal Guardian session protocol — keeps agent work anchored to the declared goal",
    "alwaysApply: true",
    "---",
    "",
    "This workspace uses Goal Guardian (advisory only — it never blocks you).",
    "Follow this protocol:",
    "",
    "1. At the start of a session, call the `goal-guardian` MCP tool `guardian_get_contract`",
    "   to load the goal, success criteria, constraints, and the active task.",
    "2. Before starting multi-file or multi-step work, call `guardian_declare_intent`",
    "   with a one-line summary (and the taskId it serves).",
    "3. When you finish a task, call `guardian_record_progress` with action `complete_task`.",
    "   To work on a different task, call it with action `start_task` — switching away from",
    "   an active task requires a `decision` (text + rationale); that is intentional.",
    "4. If a Goal Guardian message notes your work looks off-goal, pause and give the user",
    "   the choice in chat: continue this direction (record it via guardian_declare_intent",
    "   or a decision) or return to the active task. Never proceed silently past a nudge.",
    "5. Stay within the declared constraints. If the user's request conflicts with the",
    "   contract, say so and suggest updating the contract instead of silently diverging.",
    "6. The user steers through chat. When they ask about progress, drift, the goal, or",
    "   'where were we', answer from guardian_get_status and guardian_get_contract — the",
    "   session tape — not from memory.",
    "7. When the user changes direction in chat ('actually, let's...'), reflect it on the",
    "   record: switch tasks with guardian_record_progress (with a decision) so the pivot",
    "   is documented instead of silent.",
    "",
  ].join("\n");
}
