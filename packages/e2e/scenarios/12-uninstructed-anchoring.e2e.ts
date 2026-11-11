import { expect } from "vitest";
import { agentScenario } from "../src/scenario.js";
import { readAudit, auditOfKind } from "../src/assert.js";

/**
 * The anchoring loop's real test: the prompt says NOTHING about Goal Guardian
 * or MCP tools. If the agent still loads the contract,
 * the .cursor/rules/goal-guardian.mdc anchor is doing its job — the tool
 * surface went from available to used.
 */
agentScenario({
  title: "12 an uninstructed agent cooperates purely from the workspace rule",
  workspace: {
    goal: "Finish the math utilities",
    successCriteria: ["math.ts exports a subtract(a, b) function"],
  },
  prompt: "Add a subtract(a, b) function to src/math.ts. That's the whole request.",
  assert: async (ws) => {
    const records = await readAudit(ws.root);
    const observedMcp = auditOfKind(records, "action.observed")
      .filter((r) => r.actionType === "mcp")
      .map((r) => r.actionValue);
    // Rule step 6: the agent reported on the goal with update_goal without being told to.
    expect(observedMcp.some((v) => v.endsWith("/update_goal"))).toBe(true);
  },
});
