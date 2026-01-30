import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  ensureStateStoreFiles,
  dispatchAction,
  loadActions,
  loadState,
  rebuildState,
  getStatePaths,
} from "../src/stateStore.js";

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-state-"));
  await fs.mkdir(path.join(dir, ".cursor", "goal-guardian"), { recursive: true });
  return dir;
}

async function writeContract(workspaceRoot: string, goal = "Test goal"): Promise<void> {
  const contractPath = path.join(workspaceRoot, ".cursor", "goal-guardian", "contract.json");
  const payload = {
    goal,
    success_criteria: ["Criterion 1", "Criterion 2"],
    constraints: ["No scope creep"],
  };
  await fs.writeFile(contractPath, JSON.stringify(payload, null, 2), "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("state store", () => {
  it("creates store files and seeds from contract", async () => {
    const root = await makeTempWorkspace();
    await writeContract(root, "Seeded goal");
    await ensureStateStoreFiles(root);
    const state = await loadState(root);
    const paths = getStatePaths(root);

    expect(state.goal).toBe("Seeded goal");
    expect(await fileExists(paths.state)).toBe(true);
    expect(await fileExists(paths.actions)).toBe(true);
    expect(await fileExists(paths.rules)).toBe(true);
    expect(await fileExists(paths.reducer)).toBe(true);
  });

  it("dispatchAction updates state and actions log", async () => {
    const root = await makeTempWorkspace();
    await ensureStateStoreFiles(root);

    await dispatchAction(root, {
      type: "SET_GOAL",
      payload: { goal: "Dispatch goal", definition_of_done: ["Done"], constraints: [] },
    });

    const state = await loadState(root);
    const actions = await loadActions(root);
    expect(state.goal).toBe("Dispatch goal");
    expect(actions.length).toBe(1);
  });

  it("enforces decision requirement for task switching", async () => {
    const root = await makeTempWorkspace();
    await ensureStateStoreFiles(root);

    await dispatchAction(root, {
      type: "ADD_TASKS",
      payload: { tasks: [{ id: "t1", title: "Task 1" }, { id: "t2", title: "Task 2" }] },
    });
    await dispatchAction(root, { type: "START_TASK", payload: { taskId: "t1" } });

    let threw = false;
    try {
      await dispatchAction(root, { type: "START_TASK", payload: { taskId: "t2" } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("allows task switching with a recorded decision", async () => {
    const root = await makeTempWorkspace();
    await ensureStateStoreFiles(root);

    await dispatchAction(root, {
      type: "ADD_TASKS",
      payload: { tasks: [{ id: "t1", title: "Task 1" }, { id: "t2", title: "Task 2" }] },
    });
    await dispatchAction(root, { type: "START_TASK", payload: { taskId: "t1" } });
    await dispatchAction(root, { type: "ADD_DECISION", payload: { text: "Switch task", rationale: "Higher priority" } });

    const state = await loadState(root);
    const decisionId = state.decisions[0]?.id;

    await dispatchAction(root, { type: "START_TASK", payload: { taskId: "t2", decision_id: decisionId } });
    const updated = await loadState(root);
    expect(updated.active_task).toBe("t2");
  });

  it("detects manual edits in strict mode", async () => {
    const root = await makeTempWorkspace();
    await ensureStateStoreFiles(root);
    const paths = getStatePaths(root);
    const state = await loadState(root);

    // Tamper with state but keep old hash to trigger strict check
    const tampered = { ...state, goal: "Manual edit" };
    await fs.writeFile(paths.state, JSON.stringify(tampered, null, 2), "utf8");

    let threw = false;
    try {
      await dispatchAction(root, { type: "OPEN_QUESTION", payload: { text: "Is strict mode on?" } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("creates snapshots and can rebuild from action log", async () => {
    const root = await makeTempWorkspace();
    await ensureStateStoreFiles(root);
    const paths = getStatePaths(root);

    const rules = {
      preferredReducer: "json",
      strictMode: true,
      snapshotInterval: 2,
      syncContractFromState: true,
      invariants: {
        singleActiveTask: true,
        requireDecisionForTaskSwitch: true,
        disallowTodoToDone: true,
      },
    };
    await fs.writeFile(paths.rules, JSON.stringify(rules, null, 2), "utf8");

    await dispatchAction(root, {
      type: "SET_GOAL",
      payload: { goal: "Snapshot goal", definition_of_done: [], constraints: [] },
    });
    await dispatchAction(root, { type: "OPEN_QUESTION", payload: { text: "Does snapshot exist?" } });

    expect(await fileExists(paths.snapshot)).toBe(true);

    await fs.unlink(paths.state);
    const rebuilt = await rebuildState(root);
    expect(rebuilt.goal).toBe("Snapshot goal");
    expect(rebuilt._meta.actionCount).toBe(2);
  });

  it("uses JS reducer when preferred", async () => {
    const root = await makeTempWorkspace();
    await ensureStateStoreFiles(root);
    const paths = getStatePaths(root);

    const rules = {
      preferredReducer: "js",
      strictMode: false,
      snapshotInterval: 0,
      syncContractFromState: false,
      invariants: {
        singleActiveTask: true,
        requireDecisionForTaskSwitch: true,
        disallowTodoToDone: true,
      },
    };
    await fs.writeFile(paths.rules, JSON.stringify(rules, null, 2), "utf8");

    const reducerSource = `
      export function reducer(state, action) {
        if (action.type === "SET_GOAL") {
          return {
            ...state,
            goal: String(action.payload.goal ?? "") + " (js)",
          };
        }
        return state;
      }
    `;
    await fs.writeFile(paths.reducer, reducerSource, "utf8");

    await dispatchAction(root, { type: "SET_GOAL", payload: { goal: "Reducer" } });
    const state = await loadState(root);
    expect(state.goal).toBe("Reducer (js)");
  });
});
