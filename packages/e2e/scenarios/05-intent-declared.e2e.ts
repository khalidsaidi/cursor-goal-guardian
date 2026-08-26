import { expect } from "vitest";
import { agentScenario } from "../src/scenario.js";
import { readAudit, auditOfKind } from "../src/assert.js";

agentScenario({
  title: "05 declared intent lands on the tape before the work",
  workspace: {
    goal: "Finish the math utilities",
    successCriteria: ["math.ts has doc comments"],
    tasks: [{ id: "t1", title: "math.ts has doc comments", status: "doing", criterionId: "sc_1" }],
  },
  prompt:
    "Before touching any file, call the goal-guardian MCP tool guardian_declare_intent with a one-sentence summary of your plan " +
    "and taskId t1. Then add a JSDoc comment to the add() function in src/math.ts. Do nothing else.",
  assert: async (ws) => {
    const records = await readAudit(ws.root);
    const intents = auditOfKind(records, "intent.declared");
    expect(intents.length).toBeGreaterThanOrEqual(1);
    expect(intents[0]?.taskId).toBe("t1");
    expect(intents[0]?.summary.length).toBeGreaterThan(5);
    const edits = auditOfKind(records, "hook.event").filter((e) => e.event === "afterFileEdit");
    if (edits.length > 0 && intents[0]) {
      expect(Date.parse(intents[0].ts)).toBeLessThanOrEqual(Date.parse(edits[edits.length - 1]!.ts));
    }
  },
});
