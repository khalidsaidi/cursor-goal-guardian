import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  dispatch,
  rebuild,
  replay,
  loadState,
  loadActions,
  loadSnapshot,
  ensureStateFiles,
  computeHash,
  getGuardianPaths,
  criteriaFromTexts,
  SNAPSHOT_INTERVAL,
  type Clock,
} from "../src/index.js";

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-store-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

let tick = 0;
const clock: Clock = { now: () => new Date(1735689600000 + ++tick * 1000) };

async function seed(root: string) {
  await dispatch(root, { type: "SET_GOAL", payload: { goal: "Ship CSV export", successCriteria: criteriaFromTexts(["works"]), constraints: [] } }, clock);
  await dispatch(root, { type: "ADD_TASKS", payload: { tasks: [{ id: "t1", title: "serializer" }, { id: "t2", title: "filters" }] } }, clock);
  await dispatch(root, { type: "START_TASK", payload: { taskId: "t1" } }, clock);
}

describe("store dispatch and replay", () => {
  it("replay(actions) reproduces the dispatched state exactly", async () => {
    const root = await makeRoot();
    await seed(root);
    const state = await loadState(root);
    const actions = await loadActions(root);
    expect(replay(actions)).toEqual(state);
  });

  it("rebuild restores a hand-edited state.json from the log", async () => {
    const root = await makeRoot();
    await seed(root);
    const p = getGuardianPaths(root);
    const state = await loadState(root);
    const tampered = { ...state, goal: "HACKED" };
    await fs.writeFile(p.state, JSON.stringify(tampered, null, 2), "utf8");

    await expect(dispatch(root, { type: "PIN_CONTEXT", payload: { path: "a.ts" } }, clock)).rejects.toThrowError(
      expect.objectContaining({ code: "MANUAL_EDIT" }),
    );

    const rebuilt = await rebuild(root);
    expect(rebuilt.goal).toBe("Ship CSV export");
    expect(rebuilt).toEqual(replay(await loadActions(root)));

    const after = await dispatch(root, { type: "PIN_CONTEXT", payload: { path: "a.ts" } }, clock);
    expect(after.pinnedContext).toEqual(["a.ts"]);
  });

  it("keeps contract.json as a projection of state", async () => {
    const root = await makeRoot();
    await seed(root);
    const p = getGuardianPaths(root);
    const contract = JSON.parse(await fs.readFile(p.contract, "utf8"));
    expect(contract).toEqual({
      schemaVersion: 2,
      goal: "Ship CSV export",
      successCriteria: criteriaFromTexts(["works"]),
      constraints: [],
    });
  });

  it("writes a snapshot exactly on the interval grid; snapshot+tail === full replay", async () => {
    const root = await makeRoot();
    await seed(root);
    for (let i = 0; i < SNAPSHOT_INTERVAL; i++) {
      await dispatch(root, { type: "PIN_CONTEXT", payload: { path: `f${i}.ts` } }, clock);
    }
    const snapshot = await loadSnapshot(root);
    expect(snapshot).not.toBeNull();
    expect((snapshot!.lastActionIndex + 1) % SNAPSHOT_INTERVAL).toBe(0);

    const actions = await loadActions(root);
    let fromSnapshot = snapshot!.state;
    const { reduce } = await import("../src/index.js");
    for (const action of actions.slice(snapshot!.lastActionIndex + 1)) {
      fromSnapshot = reduce(fromSnapshot, action);
    }
    expect(fromSnapshot).toEqual(replay(actions));
  });

  it("materializes missing ids at dispatch time so the log is self-sufficient", async () => {
    const root = await makeRoot();
    await seed(root);
    await dispatch(root, { type: "OPEN_QUESTION", payload: { text: "hidden columns?" } }, clock);
    await dispatch(root, { type: "ADD_DECISION", payload: { text: "x", rationale: "y" } }, clock);
    const actions = await loadActions(root);
    const q = actions.find((a) => a.type === "OPEN_QUESTION");
    const d = actions.find((a) => a.type === "ADD_DECISION");
    expect(q?.payload.id).toMatch(/^q_/);
    expect(d?.payload.id).toMatch(/^dec_/);
    expect(replay(actions)).toEqual(await loadState(root));
  });

  it("a failed reduce leaves no partial writes behind", async () => {
    const root = await makeRoot();
    await seed(root);
    const before = await loadActions(root);
    await expect(dispatch(root, { type: "START_TASK", payload: { taskId: "ghost" } }, clock)).rejects.toThrow();
    expect(await loadActions(root)).toEqual(before);
    expect((await loadState(root)).meta.actionCount).toBe(before.length);
  });

  it("corrupt action log lines raise a typed error with the line number", async () => {
    const root = await makeRoot();
    await seed(root);
    const p = getGuardianPaths(root);
    await fs.appendFile(p.actions, "not-json\n", "utf8");
    await expect(loadActions(root)).rejects.toThrowError(
      expect.objectContaining({ code: "CORRUPT_ACTION_LOG", message: expect.stringContaining("line 4") }),
    );
  });

  it("ensureStateFiles is idempotent and produces a hash-valid initial state", async () => {
    const root = await makeRoot();
    await ensureStateFiles(root, clock);
    const first = await loadState(root);
    expect(first.meta.hash).toBe(computeHash(first));
    await ensureStateFiles(root, clock);
    expect(await loadState(root)).toEqual(first);
  });
});
