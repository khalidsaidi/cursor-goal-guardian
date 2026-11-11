import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { agentScenario } from "../src/scenario.js";
import { readAudit, auditOfKind } from "../src/assert.js";

agentScenario({
  title: "01 on-goal work lands on the tape",
  workspace: {
    goal: "Finish the math utilities",
    successCriteria: ["add() has a working implementation and a test"],
  },
  prompt:
    "This workspace has a goal-guardian MCP server. First call its get_goal tool. " +
    "Then create src/math.test.ts with a simple test for the add() function in src/math.ts (plain assertions are fine, do not install anything). Do not do anything else.",
  assert: async (ws) => {
    expect(fs.existsSync(path.join(ws.root, "src", "math.test.ts"))).toBe(true);
    const records = await readAudit(ws.root);
    expect(auditOfKind(records, "hook.event").length).toBeGreaterThanOrEqual(1);
    expect(auditOfKind(records, "action.observed").some((r) => r.actionValue.endsWith("/get_goal"))).toBe(true);
  },
});
