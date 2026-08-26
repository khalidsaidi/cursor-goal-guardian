import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeWorkspace, type TestWorkspace } from "cursor-goal-guardian-testkit";
import { ensureBuilt, runHook, shellEvent } from "./helpers.js";

beforeAll(ensureBuilt, 30000);

let w: TestWorkspace;
beforeAll(async () => {
  w = await makeWorkspace({ tasks: [{ id: "t1", title: "Task", status: "doing" }] });
});
afterAll(async () => {
  await w?.cleanup();
});

// The hook sits in the hot path of every shell/read/edit event. Budget is
// overridable for slow CI runners; locally the bundle runs well under it.
// Windows pays a real process-spawn tax (~100ms+ on CI runners); the budget
// is per-platform so the test measures our code, not the OS's exec cost.
const BUDGET_MS = Number(process.env.GG_HOOK_LATENCY_MS ?? (process.platform === "win32" ? 450 : 150));

describe("latency", () => {
  it(`p95 of sequential invocations stays under ${BUDGET_MS}ms`, () => {
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      runHook(w.root, shellEvent("git status"));
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1]!;
    // eslint-disable-next-line no-console
    console.log(`hook latency: p50=${samples[14]?.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
    expect(p95).toBeLessThan(BUDGET_MS);
  }, 60000);
});
