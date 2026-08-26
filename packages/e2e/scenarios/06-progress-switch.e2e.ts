import { expect } from "vitest";
import { agentScenario } from "../src/scenario.js";
import { readActions, readState } from "../src/assert.js";

agentScenario({
  title: "06 agent records a complete-then-start transition through guardian tools",
  workspace: {
    goal: "Finish the math utilities",
    successCriteria: ["add() works", "subtract() exists"],
    tasks: [
      { id: "t1", title: "add() works", status: "doing", criterionId: "sc_1" },
      { id: "t2", title: "subtract() exists", status: "todo", criterionId: "sc_2" },
    ],
  },
  prompt:
    "add() in src/math.ts already works, so: 1) call guardian_record_progress with action complete_task, taskId t1; " +
    "2) call guardian_record_progress with action start_task, taskId t2; 3) add a subtract(a, b) function to src/math.ts. Nothing else.",
  assert: async (ws) => {
    const state = await readState(ws.root);
    expect(state.tasks.find((t) => t.id === "t1")?.status).toBe("done");
    expect(state.tasks.find((t) => t.id === "t2")?.status).toBe("doing");
    expect(state.activeTaskId).toBe("t2");
    const types = (await readActions(ws.root)).map((a) => a.type);
    expect(types).toContain("COMPLETE_TASK");
    expect(types).toContain("START_TASK");
  },
});
