import { describe, it, expect } from "vitest";
import {
  reduce,
  replay,
  defaultState,
  computeHash,
  StateError,
  type GuardianAction,
  type GuardianState,
} from "../src/index.js";

/**
 * Property-style check without a PBT dependency: a seeded PRNG generates
 * random (mostly legal, sometimes illegal) action sequences; after every
 * accepted action the core invariants must hold, and full replay must
 * reproduce the incremental state.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomAction(rnd: () => number, state: GuardianState, n: number): GuardianAction {
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const taskIds = state.tasks.map((t) => t.id);
  const decisionIds = state.decisions.map((d) => d.id);
  const kinds = ["ADD_TASKS", "START_TASK", "COMPLETE_TASK", "ADD_DECISION", "PIN_CONTEXT", "UNPIN_CONTEXT", "OPEN_QUESTION"] as const;
  const type = pick([...kinds]);
  const payloads: Record<(typeof kinds)[number], () => Record<string, unknown>> = {
    ADD_TASKS: () => ({ tasks: [{ id: `t${n}`, title: `task ${n}` }] }),
    START_TASK: () => ({
      taskId: taskIds.length ? pick(taskIds) : "missing",
      ...(rnd() > 0.5 && decisionIds.length ? { decisionId: pick(decisionIds) } : {}),
    }),
    COMPLETE_TASK: () => ({ taskId: taskIds.length ? pick(taskIds) : "missing", ...(rnd() > 0.7 ? { allowSkip: true } : {}) }),
    ADD_DECISION: () => ({ id: `d${n}`, text: `decision ${n}`, rationale: "because" }),
    PIN_CONTEXT: () => ({ path: `src/f${Math.floor(rnd() * 5)}.ts` }),
    UNPIN_CONTEXT: () => ({ path: `src/f${Math.floor(rnd() * 5)}.ts` }),
    OPEN_QUESTION: () => ({ id: `q${n}`, text: `question ${n}` }),
  };
  return {
    id: `act_${n}`,
    ts: new Date(1735689600000 + n * 1000).toISOString(),
    actor: "agent",
    type,
    payload: payloads[type](),
  };
}

function checkInvariants(state: GuardianState): void {
  const doing = state.tasks.filter((t) => t.status === "doing");
  expect(doing.length).toBeLessThanOrEqual(1);
  if (state.activeTaskId) {
    expect(doing.map((t) => t.id)).toContain(state.activeTaskId);
  } else {
    expect(doing).toHaveLength(0);
  }
  expect(new Set(state.queue).size).toBe(state.queue.length);
  for (const id of state.queue) {
    expect(state.tasks.find((t) => t.id === id)?.status).not.toBe("done");
  }
  expect(new Set(state.pinnedContext).size).toBe(state.pinnedContext.length);
  expect(state.meta.hash).toBe(computeHash(state));
}

describe("invariants hold over random action sequences", () => {
  for (const seed of [1, 7, 42, 1337]) {
    it(`seed ${seed}: 200 random actions`, () => {
      const rnd = mulberry32(seed);
      let state = defaultState();
      state.meta.hash = computeHash(state);
      const accepted: GuardianAction[] = [];
      let rejected = 0;

      for (let n = 1; n <= 200; n++) {
        const action = randomAction(rnd, state, n);
        try {
          state = reduce(state, action);
          accepted.push(action);
        } catch (err) {
          expect(err).toBeInstanceOf(StateError);
          rejected += 1;
        }
        checkInvariants(state);
        expect(state.meta.actionCount).toBe(accepted.length);
      }

      expect(accepted.length).toBeGreaterThan(50);
      expect(rejected).toBeGreaterThan(0);
      expect(replay(accepted)).toEqual(state);
    });
  }
});
