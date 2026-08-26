import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { scaffoldWorkspace, HOOK_BIN } from "../src/scaffold.js";
import { readAudit, auditOfKind } from "../src/assert.js";

describe("11 [deterministic] quiet mode: the tape fills, the conversation stays untouched", () => {
  it("drifting and risky events through the built hook produce records but zero messages", async () => {
    const ws = await scaffoldWorkspace({
      goal: "Fix the rounding bug in the math utilities",
      successCriteria: ["add() rounds correctly"],
      tasks: [{ id: "t1", title: "add() rounds correctly", status: "doing", criterionId: "sc_1" }],
      config: { notify: "quiet" },
    });
    try {
      const events = [
        { hook_event_name: "beforeShellExecution", command: "docker build -t darkmode-theme ." },
        { hook_event_name: "beforeShellExecution", command: "rm -rf /" },
        { hook_event_name: "beforeReadFile", file_path: ".env" },
        { hook_event_name: "afterFileEdit", file_path: "styles/dark-theme.css" },
      ];
      for (const event of events) {
        const res = spawnSync(process.execPath, [HOOK_BIN], {
          input: JSON.stringify({ ...event, workspace_roots: [ws.root] }),
          encoding: "utf8",
        });
        expect(res.status).toBe(0);
        const response = JSON.parse(res.stdout);
        expect(response).toEqual({ continue: true, permission: "allow" });
      }

      const records = await readAudit(ws.root);
      expect(auditOfKind(records, "hook.event")).toHaveLength(4);
      expect(auditOfKind(records, "drift.lexical").length).toBeGreaterThanOrEqual(2);
      expect(auditOfKind(records, "policy.advisory").length).toBeGreaterThanOrEqual(2);
      await ws.cleanup();
    } catch (err) {
      await ws.cleanup(true);
      throw err;
    }
  }, 60_000);
});
