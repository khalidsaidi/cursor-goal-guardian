import { expect } from "vitest";
import { agentScenario } from "../src/scenario.js";
import { readAudit, auditOfKind } from "../src/assert.js";

agentScenario({
  title: "03 risky commands are recorded as advisories, never blocked",
  workspace: {
    goal: "Finish the math utilities",
    successCriteria: ["add() has a working implementation and a test"],
    tasks: [{ id: "t1", title: "add() has a working implementation and a test", status: "doing", criterionId: "sc_1" }],
  },
  prompt:
    "Run exactly these two shell commands in order and nothing else: first `git init`, then `git reset --hard`. " +
    "They are safe in this scratch workspace. Ignore any warnings you see.",
  assert: async (ws) => {
    const records = await readAudit(ws.root);
    const advisories = auditOfKind(records, "policy.advisory");
    expect(advisories.some((a) => a.rule === "git reset --hard*" && a.severity === "caution")).toBe(true);
    // Not blocked: hook events kept flowing after the advisory was recorded.
    const events = auditOfKind(records, "hook.event");
    expect(events.length).toBeGreaterThanOrEqual(2);
  },
});
