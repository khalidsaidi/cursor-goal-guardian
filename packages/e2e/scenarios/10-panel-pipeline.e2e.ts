import { describe, it, expect } from "vitest";
import { appendAudit, buildPanelViewModel, goalHash, nowIso, readContractSafe } from "@goal-guardian/core";
import { scaffoldWorkspace } from "../src/scaffold.js";
import { readAudit } from "../src/assert.js";

describe("10 [deterministic] disk artifacts flow into the panel view model", () => {
  it("a proved run on disk ticks only the items it backed", async () => {
    const ws = await scaffoldWorkspace({
      goal: "Finish the math utilities",
      successCriteria: ["add() works", "subtract() works"],
    });
    try {
      const contract = await readContractSafe(ws.root);
      await appendAudit(ws.root, {
        ts: nowIso(),
        kind: "goal.end",
        conversationId: "c1",
        goalHash: goalHash(contract),
        outcome: "proved",
        proved: [{ criterion: "sc_1", command: "npm test", quote: "1 passing" }],
      });

      const vm = buildPanelViewModel({ setUp: true, contract, records: await readAudit(ws.root), now: new Date() });

      expect(vm.setUp).toBe(true);
      expect(vm.status).toEqual({ lamp: "on", word: "complete" });
      expect(vm.successCriteria.map((c) => c.done)).toEqual([true, false]);
      await ws.cleanup();
    } catch (err) {
      await ws.cleanup(true);
      throw err;
    }
  }, 60_000);
});
