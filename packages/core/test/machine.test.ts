import { describe, it, expect } from "vitest";
import {
  reduce,
  defaultState,
  computeHash,
  criteriaFromTexts,
  StateError,
  type GuardianAction,
  type GuardianState,
} from "../src/index.js";

let counter = 0;
function act(type: GuardianAction["type"], payload: Record<string, unknown> = {}): GuardianAction {
  counter += 1;
  return {
    id: `act_${counter}`,
    ts: `2026-01-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
    actor: "agent",
    type,
    payload,
  };
}

function seeded(): GuardianState {
  let s = defaultState();
  s.meta.hash = computeHash(s);
  s = reduce(s, act("SET_GOAL", { goal: "Ship CSV export", successCriteria: criteriaFromTexts(["works"]), constraints: ["no deps"] }));
  s = reduce(s, act("ADD_TASKS", { tasks: [
    { id: "t1", title: "serializer", criterionId: "sc_1" },
    { id: "t2", title: "filters" },
  ] }));
  return s;
}

describe("reducer transitions", () => {
  it("SET_GOAL updates only provided fields", () => {
    let s = seeded();
    s = reduce(s, act("SET_GOAL", { goal: "New goal" }));
    expect(s.goal).toBe("New goal");
    expect(s.successCriteria).toEqual(criteriaFromTexts(["works"]));
    expect(s.constraints).toEqual(["no deps"]);
  });

  it("ADD_TASKS appends todo tasks, queues them, dedupes ids", () => {
    let s = seeded();
    expect(s.tasks.map((t) => t.status)).toEqual(["todo", "todo"]);
    expect(s.queue).toEqual(["t1", "t2"]);
    s = reduce(s, act("ADD_TASKS", { tasks: [{ id: "t1", title: "dupe" }] }));
    expect(s.tasks).toHaveLength(2);
    expect(s.tasks[0]?.title).toBe("serializer");
  });

  it("START_TASK activates and marks doing; carries criterionId through", () => {
    const s = reduce(seeded(), act("START_TASK", { taskId: "t1" }));
    expect(s.activeTaskId).toBe("t1");
    expect(s.tasks[0]?.status).toBe("doing");
    expect(s.tasks[0]?.criterionId).toBe("sc_1");
  });

  it("START_TASK on unknown task throws TASK_NOT_FOUND", () => {
    expect(() => reduce(seeded(), act("START_TASK", { taskId: "nope" }))).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_FOUND" }),
    );
  });

  it("COMPLETE_TASK finishes the active task and clears activeTaskId", () => {
    let s = reduce(seeded(), act("START_TASK", { taskId: "t1" }));
    s = reduce(s, act("COMPLETE_TASK", { taskId: "t1" }));
    expect(s.tasks[0]?.status).toBe("done");
    expect(s.activeTaskId).toBeNull();
    expect(s.queue).toEqual(["t2"]);
  });

  it("OPEN/CLOSE_QUESTION uses ids and timestamps from the action", () => {
    let s = reduce(seeded(), act("OPEN_QUESTION", { id: "q1", text: "hidden columns?" }));
    expect(s.openQuestions[0]).toMatchObject({ id: "q1", status: "open" });
    expect(s.openQuestions[0]?.ts).toBe(s.meta.lastUpdated);
    s = reduce(s, act("CLOSE_QUESTION", { id: "q1" }));
    expect(s.openQuestions[0]?.status).toBe("closed");
    expect(() => reduce(s, act("CLOSE_QUESTION", { id: "q2" }))).toThrowError(
      expect.objectContaining({ code: "QUESTION_NOT_FOUND" }),
    );
  });

  it("ADD_DECISION and PIN/UNPIN_CONTEXT", () => {
    let s = reduce(seeded(), act("ADD_DECISION", { id: "d1", text: "hand-rolled", rationale: "no deps" }));
    expect(s.decisions[0]?.id).toBe("d1");
    s = reduce(s, act("PIN_CONTEXT", { path: "src/export/csv.ts" }));
    s = reduce(s, act("PIN_CONTEXT", { path: "src/export/csv.ts" }));
    expect(s.pinnedContext).toEqual(["src/export/csv.ts"]);
    s = reduce(s, act("UNPIN_CONTEXT", { path: "src/export/csv.ts" }));
    expect(s.pinnedContext).toEqual([]);
  });

  it("MIGRATE_IMPORT adopts a full state and recomputes meta", () => {
    const imported = defaultState();
    imported.goal = "migrated goal";
    imported.tasks = [{ id: "m1", title: "migrated", status: "doing" }];
    imported.activeTaskId = "m1";
    const { meta: _meta, ...sansMeta } = imported;
    let base = defaultState();
    base.meta.hash = computeHash(base);
    const s = reduce(base, act("MIGRATE_IMPORT", { state: sansMeta }));
    expect(s.goal).toBe("migrated goal");
    expect(s.activeTaskId).toBe("m1");
    expect(s.meta.actionCount).toBe(1);
    expect(s.meta.hash).toBe(computeHash(s));
  });

  it("rejects malformed payloads with INVALID_PAYLOAD", () => {
    expect(() => reduce(seeded(), act("START_TASK", {}))).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" }),
    );
    expect(() => reduce(seeded(), act("ADD_TASKS", { tasks: [{ title: "no id" }] }))).toThrowError(
      expect.objectContaining({ code: "INVALID_PAYLOAD" }),
    );
  });

  it("stamps meta on every reduce", () => {
    const s = seeded();
    const before = s.meta.actionCount;
    const nextAction = act("PIN_CONTEXT", { path: "a.ts" });
    const next = reduce(s, nextAction);
    expect(next.meta.actionCount).toBe(before + 1);
    expect(next.meta.lastActionId).toBe(nextAction.id);
    expect(next.meta.lastUpdated).toBe(nextAction.ts);
    expect(next.meta.hash).toBe(computeHash(next));
  });
});

describe("invariants", () => {
  it("singleActiveTask + requireDecisionForTaskSwitch: switching without a decision throws", () => {
    const s = reduce(seeded(), act("START_TASK", { taskId: "t1" }));
    expect(() => reduce(s, act("START_TASK", { taskId: "t2" }))).toThrowError(
      expect.objectContaining({ code: "DECISION_REQUIRED" }),
    );
  });

  it("switching with a cited decision demotes the previous task to todo", () => {
    let s = reduce(seeded(), act("START_TASK", { taskId: "t1" }));
    s = reduce(s, act("ADD_DECISION", { id: "d1", text: "switch", rationale: "blocked" }));
    s = reduce(s, act("START_TASK", { taskId: "t2", decisionId: "d1" }));
    expect(s.activeTaskId).toBe("t2");
    expect(s.tasks.find((t) => t.id === "t1")?.status).toBe("todo");
    expect(s.tasks.filter((t) => t.status === "doing")).toHaveLength(1);
  });

  it("a decisionId that does not exist does not authorize a switch", () => {
    const s = reduce(seeded(), act("START_TASK", { taskId: "t1" }));
    expect(() => reduce(s, act("START_TASK", { taskId: "t2", decisionId: "ghost" }))).toThrowError(
      expect.objectContaining({ code: "DECISION_REQUIRED" }),
    );
  });

  it("re-starting the already-active task needs no decision", () => {
    const s = reduce(seeded(), act("START_TASK", { taskId: "t1" }));
    const again = reduce(s, act("START_TASK", { taskId: "t1" }));
    expect(again.activeTaskId).toBe("t1");
  });

  it("disallowTodoToDone: completing an unstarted task throws unless allowSkip", () => {
    expect(() => reduce(seeded(), act("COMPLETE_TASK", { taskId: "t2" }))).toThrowError(
      expect.objectContaining({ code: "TODO_TO_DONE" }),
    );
    const s = reduce(seeded(), act("COMPLETE_TASK", { taskId: "t2", allowSkip: true }));
    expect(s.tasks.find((t) => t.id === "t2")?.status).toBe("done");
  });
});
