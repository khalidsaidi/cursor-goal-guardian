import { describe, it, expect } from "vitest";
import {
  appendAudit,
  createCursorAgentJudge,
  loadVerdicts,
  readConfigSafe,
  readStateSafe,
  runRescore,
} from "@goal-guardian/core";
import { scaffoldWorkspace } from "../src/scaffold.js";
import { billableRunsEnabled } from "../src/agent.js";
import { auditOfKind, readAudit } from "../src/assert.js";

const maybe = billableRunsEnabled() ? describe : describe.skip;

maybe("08 [real judge] the cursor-agent judge separates real drift from false positives", () => {
  it("confirms the off-goal action and dismisses the in-service one", async () => {
    const ws = await scaffoldWorkspace({
      goal: "Ship the CSV export feature for the report table",
      successCriteria: ["Users can export the report table as CSV"],
      tasks: [{ id: "t1", title: "Users can export the report table as CSV", status: "doing", criterionId: "sc_1" }],
    });
    try {
      const seed = async (driftId: string, actionValue: string): Promise<void> =>
        appendAudit(ws.root, {
          ts: new Date().toISOString(),
          kind: "drift.lexical",
          driftId,
          episodeId: `ep_${driftId}`,
          actionType: "shell",
          actionValue,
          activeTaskId: "t1",
          activeTaskTitle: "Users can export the report table as CSV",
          taskTerms: ["export", "report", "csv"],
          actionTerms: actionValue.split(" ").slice(0, 3),
          confidence: "medium",
        });
      // Genuinely off-goal: UI theming has nothing to do with CSV export.
      await seed("drift_offgoal", "npm install tailwindcss && create dark-theme.css color palette");
      // Lexical false positive: formatting the very file the task is about.
      await seed("drift_inservice", "prettier --write src/export/csv-serializer.ts");

      const judge = createCursorAgentJudge({ cwd: ws.root, model: process.env.GG_JUDGE_MODEL });
      const availability = await judge.isAvailable();
      expect(availability.ok).toBe(true);

      const state = await readStateSafe(ws.root);
      const config = await readConfigSafe(ws.root);
      const result = await runRescore(ws.root, state, config, judge);
      expect(result.calledJudge).toBe(true);
      expect(result.recorded).toBe(2);

      const cache = await loadVerdicts(ws.root);
      expect(cache.entries.drift_offgoal?.verdict).toBe("confirmed");
      expect(cache.entries.drift_inservice?.verdict).toBe("dismissed");
      expect(auditOfKind(await readAudit(ws.root), "drift.verdict")).toHaveLength(2);

      // Cache honored: a second pass makes no further calls.
      const second = await runRescore(ws.root, state, config, judge);
      expect(second.calledJudge).toBe(false);
      await ws.cleanup();
    } catch (err) {
      await ws.cleanup(true);
      throw err;
    }
  }, 300_000);
});
