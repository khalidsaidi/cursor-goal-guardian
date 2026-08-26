import { expect } from "vitest";
import { agentScenario } from "../src/scenario.js";
import { readActions, readState, readAudit, auditOfKind } from "../src/assert.js";

agentScenario({
  title: "01 on-goal work completes the active task on the tape, with zero drift",
  workspace: {
    goal: "Finish the math utilities",
    successCriteria: ["add() has a working implementation and a test"],
    tasks: [{ id: "t1", title: "add() has a working implementation and a test", status: "doing", criterionId: "sc_1" }],
  },
  prompt:
    "This workspace has a goal-guardian MCP server. First call guardian_declare_intent with a one-line summary. " +
    "Then create src/math.test.ts with a simple test for the add() function in src/math.ts (plain assertions are fine, do not install anything). " +
    "When the test file exists, call guardian_record_progress with action complete_task and taskId t1. Do not do anything else.",
  assert: async (ws) => {
    const actions = await readActions(ws.root);
    expect(actions.some((a) => a.type === "COMPLETE_TASK" && a.payload.taskId === "t1")).toBe(true);
    const state = await readState(ws.root);
    expect(state.tasks.find((t) => t.id === "t1")?.status).toBe("done");

    const records = await readAudit(ws.root);
    expect(auditOfKind(records, "intent.declared").length).toBeGreaterThanOrEqual(1);
    expect(auditOfKind(records, "hook.event").length).toBeGreaterThanOrEqual(1);
    expect(auditOfKind(records, "drift.lexical")).toHaveLength(0);
  },
});
