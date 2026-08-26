import { expect } from "vitest";
import { agentScenario } from "../src/scenario.js";
import { readActions, readAudit, auditOfKind } from "../src/assert.js";

/**
 * The anchoring loop's real test: the prompt says NOTHING about Goal Guardian
 * or MCP tools. If the agent still loads the contract and records progress,
 * the .cursor/rules/goal-guardian.mdc anchor is doing its job — the tool
 * surface went from available to used.
 */
agentScenario({
  title: "12 an uninstructed agent cooperates purely from the workspace rule",
  workspace: {
    goal: "Finish the math utilities",
    successCriteria: ["math.ts exports a subtract(a, b) function"],
    tasks: [{ id: "t1", title: "math.ts exports a subtract(a, b) function", status: "doing", criterionId: "sc_1" }],
  },
  prompt: "Add a subtract(a, b) function to src/math.ts. That's the whole request.",
  assert: async (ws) => {
    const records = await readAudit(ws.root);
    const observedMcp = auditOfKind(records, "action.observed")
      .filter((r) => r.actionType === "mcp")
      .map((r) => r.actionValue);
    // Rule step 1: the agent primed itself on the contract without being told to.
    expect(observedMcp.some((v) => v.includes("guardian_get_contract"))).toBe(true);
    // Rule step 3: it recorded completion on the tape.
    const actions = await readActions(ws.root);
    expect(actions.some((a) => a.type === "COMPLETE_TASK" && a.payload.taskId === "t1")).toBe(true);
  },
});
