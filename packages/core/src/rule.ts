import path from "node:path";

/**
 * The session-start anchor. The hook can only reach the agent after it acts;
 * this always-applied Cursor rule anchors every session to the contract BEFORE
 * any work happens — and makes the user's own first request the way the goal
 * gets declared. Chat is the interface; the guardian is the record.
 */
export const GUARDIAN_RULE_RELATIVE_PATH = path.join(".cursor", "rules", "goal-guardian.mdc");

export function guardianRuleContent(): string {
  return [
    "---",
    "description: Goal Guardian session protocol — keeps agent work anchored to the declared goal",
    "alwaysApply: true",
    "---",
    "",
    "This workspace uses Goal Guardian. It never blocks you.",
    "The user steers through chat; Guardian keeps the record. Follow this protocol:",
    "",
    "1. At the start of a session, call the `goal-guardian` MCP tool `guardian_get_contract`.",
    "2. **The user's request is the goal.** Guardian records it word for word when you first change",
    "   something; you don't write it and never reword it. Only if the request lists no 'done when' items,",
    "   add 2–4 with `guardian_update_goal` (add_criteria). Never interrogate the user about goals.",
    "3. **A limit in one message ends with that message.** \"Just item 1 for now\" means do that and stop",
    "   this time. It never binds a later message.",
    "4. If the user asks to continue or finish, that means the whole goal: work through everything left.",
    "   If they ask for something separate from the goal, do only that and leave the goal alone.",
    "   An empty record doesn't mean there's no work: look in past chats and recent commits before asking.",
    "5. Do what the goal asks and nothing more. Keep it whole: don't settle for a smaller version.",
    "6. If something stands in the way of one item, such as a broken tool, try another way to check it and",
    "   keep going on the rest. Tell the user about it when you close. Ask only when nothing is left to do.",
    "7. Assume it isn't done until each 'done when' item is proved by what the project does now. Then call",
    "   `guardian_report_goal` with your proof. Guardian checks it against its own record and sends you back",
    "   with what doesn't hold. When the record agrees, an independent reviewer checks the project and",
    "   may send objections back: fix what holds up, and answer what doesn't with evidence.",
    "   Never remove finished work to make it fit the record: if they disagree,",
    "   tell the user and ask.",
    "8. When the user changes direction ('actually, let's...'), call `guardian_update_goal` with their",
    "   words in `user_words`: those words become the goal. Only the user changes the goal.",
    "9. When the user asks about progress or 'where were we', answer from `guardian_get_status` and",
    "   `guardian_get_contract`, not memory. Stay within any boundaries the user set in the contract.",
    "",
  ].join("\n");
}

/** Project skills: guardian actions surfaced natively in the chat input's `/` menu. */
export const GUARDIAN_SKILLS: Array<{ relativeDir: string; content: string }> = [
  {
    relativeDir: path.join(".cursor", "skills", "guardian"),
    content: [
      "---",
      "name: guardian",
      "description: See the session goal and progress — and steer from chat.",
      "disable-model-invocation: true",
      "---",
      "# Guardian",
      "",
      "Accept `/guardian [question]`.",
      "",
      "1. Call the `goal-guardian` MCP tools `guardian_get_status` and `guardian_get_contract`.",
      "2. With no question: present a short, readable briefing — the goal, its 'done when' items,",
      "   what's proved and what's left. Plain prose, no JSON, no field names.",
      "3. With a question ('what's left?'): answer it from those tools and the project itself.",
      "4. End by offering the useful next moves: keep working on the goal, or update it with",
      "   `guardian_update_goal`.",
      "",
    ].join("\n"),
  },
  {
    relativeDir: path.join(".cursor", "skills", "guardian-goal"),
    content: [
      "---",
      "name: guardian-goal",
      "description: Declare or change the goal Guardian tracks for this session.",
      "disable-model-invocation: true",
      "---",
      "# Guardian goal",
      "",
      "Accept `/guardian-goal <goal>`.",
      "",
      "- Empty: show the current goal and 'done when' list from `guardian_get_contract`,",
      "  then `Usage: /guardian-goal <goal>`.",
      "- With a goal: call `guardian_update_goal` with the user's words in `user_words`. If they listed",
      "  no 'done when' items, propose 2–4 and add the ones they confirm (add_criteria). Confirm the",
      "  record in one line and continue with the work.",
      "",
    ].join("\n"),
  },
];
