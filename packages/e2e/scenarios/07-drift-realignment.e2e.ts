import { expect } from "vitest";
import { appendAudit, pairDriftTelemetry } from "@goal-guardian/core";
import { agentScenario } from "../src/scenario.js";
import { readActions, readAudit } from "../src/assert.js";

agentScenario({
  title: "07 a seeded drift pairs with the realignment the agent produces",
  workspace: {
    goal: "Finish the math utilities",
    successCriteria: ["add() has a working implementation and a test"],
    tasks: [{ id: "t1", title: "add() has a working implementation and a test", status: "doing", criterionId: "sc_1" }],
  },
  prime: async (ws) => {
    await appendAudit(ws.root, {
      ts: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      kind: "drift.lexical",
      driftId: "drift_seeded",
      episodeId: "ep_seeded",
      actionType: "shell",
      actionValue: "docker build -t dark-theme .",
      activeTaskId: "t1",
      activeTaskTitle: "add() has a working implementation and a test",
      taskTerms: ["math"],
      actionTerms: ["docker", "dark", "theme"],
      confidence: "medium",
    });
  },
  prompt:
    "The add() function in src/math.ts is done. Call guardian_record_progress with action complete_task and taskId t1. Do nothing else.",
  assert: async (ws) => {
    const telemetry = pairDriftTelemetry(await readAudit(ws.root), await readActions(ws.root), { now: new Date() });
    const seeded = telemetry.entries.find((e) => e.driftId === "drift_seeded");
    expect(seeded).toBeDefined();
    expect(seeded?.realigned).toBe(true);
    expect(seeded?.realignment?.type).toBe("COMPLETE_TASK");
    expect(telemetry.realign24h).toBeGreaterThanOrEqual(1);
    expect(telemetry.health).not.toBe("drifting");
  },
});
