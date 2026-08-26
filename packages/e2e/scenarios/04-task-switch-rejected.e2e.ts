import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scaffoldWorkspace, MCP_BIN } from "../src/scaffold.js";
import { readState } from "../src/assert.js";

describe("04 [deterministic] decision-gated task switching over the real MCP binary", () => {
  it("switching without a decision is rejected; with one it succeeds", async () => {
    const ws = await scaffoldWorkspace({
      goal: "Finish the math utilities",
      successCriteria: ["add() works", "subtract() works"],
      tasks: [
        { id: "t1", title: "add() works", status: "doing", criterionId: "sc_1" },
        { id: "t2", title: "subtract() works", status: "todo", criterionId: "sc_2" },
      ],
    });
    const client = new Client({ name: "e2e-04", version: "0.0.0" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: "node",
          args: [MCP_BIN],
          env: { ...process.env, GOAL_GUARDIAN_WORKSPACE_ROOT: ws.root } as Record<string, string>,
          stderr: "ignore",
        }),
      );

      const rejected = (await client.callTool({
        name: "guardian_record_progress",
        arguments: { action: "start_task", taskId: "t2" },
      })) as { isError?: boolean; content: Array<{ text: string }> };
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0]?.text).toMatch(/DECISION_REQUIRED/);
      expect((await readState(ws.root)).activeTaskId).toBe("t1");

      const accepted = (await client.callTool({
        name: "guardian_record_progress",
        arguments: {
          action: "start_task",
          taskId: "t2",
          decision: { text: "Switch to subtract()", rationale: "add() is blocked on review" },
        },
      })) as { isError?: boolean };
      expect(accepted.isError).not.toBe(true);
      const state = await readState(ws.root);
      expect(state.activeTaskId).toBe("t2");
      expect(state.decisions).toHaveLength(1);
    } finally {
      await client.close();
      await ws.cleanup();
    }
  }, 60_000);
});
