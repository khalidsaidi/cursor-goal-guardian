import { describe, it, expect } from "vitest";
import { appendAudit, buildPanelViewModel, dispatch, nowIso } from "@goal-guardian/core";
import { scaffoldWorkspace } from "../src/scaffold.js";
import { readActions, readAudit, readState } from "../src/assert.js";

describe("10 [deterministic] disk artifacts flow into the panel view model", () => {
  it("drift, verdicts, and actions produced on disk render into the feed and badge", async () => {
    const ws = await scaffoldWorkspace({
      goal: "Finish the math utilities",
      successCriteria: ["add() works", "subtract() works"],
      tasks: [
        { id: "t1", title: "add() works", status: "doing", criterionId: "sc_1" },
        { id: "t2", title: "subtract() works", status: "todo", criterionId: "sc_2" },
      ],
    });
    try {
      await appendAudit(ws.root, {
        ts: nowIso(),
        kind: "drift.lexical",
        driftId: "d1",
        episodeId: "ep1",
        actionType: "shell",
        actionValue: "docker build -t theme .",
        activeTaskId: "t1",
        activeTaskTitle: "add() works",
        taskTerms: ["add"],
        actionTerms: ["docker", "theme"],
        confidence: "medium",
      });
      await appendAudit(ws.root, {
        ts: nowIso(),
        kind: "drift.verdict",
        driftId: "d1",
        verdict: "confirmed",
        judge: "cursor-agent",
        confidence: 0.9,
        rationale: "theming is unrelated",
      });
      await dispatch(ws.root, { type: "COMPLETE_TASK", actor: "human", payload: { taskId: "t1" } });

      const vm = buildPanelViewModel({
        setUp: true,
        state: await readState(ws.root),
        records: await readAudit(ws.root),
        actions: await readActions(ws.root),
        now: new Date(),
        semanticConsented: true,
        semanticAvailable: true,
      });

      expect(vm.setUp).toBe(true);
      const entry = vm.driftFeed.find((e) => e.driftId === "d1");
      expect(entry).toMatchObject({ status: "confirmed", realigned: true });
      expect(vm.badge).toBe(0); // realigned confirmed drift doesn't badge
      expect(vm.successCriteria.find((c) => c.id === "sc_1")?.done).toBe(true);
      expect(vm.board.done.map((t) => t.id)).toContain("t1");
      await ws.cleanup();
    } catch (err) {
      await ws.cleanup(true);
      throw err;
    }
  }, 60_000);
});
