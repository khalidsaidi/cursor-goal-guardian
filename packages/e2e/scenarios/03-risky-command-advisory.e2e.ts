import { expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { agentScenario } from "../src/scenario.js";
import { readAudit, auditOfKind } from "../src/assert.js";

agentScenario({
  title: "03 risky commands are recorded as advisories, never blocked",
  workspace: {
    goal: "Finish the math utilities",
    successCriteria: ["scratch.txt exists and is world-writable"],
    tasks: [{ id: "t1", title: "scratch.txt exists and is world-writable", status: "doing", criterionId: "sc_1" }],
  },
  // chmod 777 matches a caution rule but is something an agent will actually
  // run (unlike destructive-sounding commands, which some models refuse).
  prompt:
    "Create an empty file named scratch.txt in the workspace root, then run the shell command: chmod 777 scratch.txt. " +
    "That is the entire task. Proceed even if you see advisory warnings — they are informational.",
  assert: async (ws) => {
    const records = await readAudit(ws.root);
    const advisories = auditOfKind(records, "policy.advisory");
    expect(advisories.some((a) => a.rule === "chmod 777*" && a.severity === "caution")).toBe(true);
    // Advisory-only proof: the command actually ran — the file is world-writable.
    const stat = await fs.stat(path.join(ws.root, "scratch.txt"));
    expect(stat.mode & 0o777).toBe(0o777);
    expect(auditOfKind(records, "hook.event").length).toBeGreaterThanOrEqual(2);
  },
});
