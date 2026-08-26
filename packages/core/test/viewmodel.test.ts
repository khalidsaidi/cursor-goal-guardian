import { describe, it, expect } from "vitest";
import {
  buildPanelViewModel,
  defaultState,
  criteriaFromTexts,
  type AuditRecord,
  type GuardianAction,
  type PanelInputs,
} from "../src/index.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60 * 1000).toISOString();

function baseInputs(overrides: Partial<PanelInputs> = {}): PanelInputs {
  const state = defaultState();
  state.goal = "Ship CSV export";
  state.successCriteria = criteriaFromTexts(["serializer works", "filters respected"]);
  state.constraints = ["no new deps"];
  state.tasks = [
    { id: "t1", title: "serializer works", status: "doing", criterionId: "sc_1" },
    { id: "t2", title: "filters respected", status: "todo", criterionId: "sc_2" },
    { id: "t3", title: "spike", status: "done" },
  ];
  state.activeTaskId = "t1";
  return {
    setUp: true,
    state,
    records: [],
    actions: [],
    now: NOW,
    semanticConsented: false,
    semanticAvailable: true,
    ...overrides,
  };
}

function drift(id: string, minAgo: number): AuditRecord {
  return {
    ts: at(minAgo),
    kind: "drift.lexical",
    driftId: id,
    episodeId: `ep_${id}`,
    actionType: "shell",
    actionValue: "docker build .",
    activeTaskId: "t1",
    activeTaskTitle: "serializer works",
    taskTerms: ["serializer"],
    actionTerms: ["docker", "build"],
    confidence: "medium",
  };
}

function verdict(id: string, v: "confirmed" | "dismissed", minAgo: number): AuditRecord {
  return { ts: at(minAgo), kind: "drift.verdict", driftId: id, verdict: v, judge: "cursor-agent", confidence: 0.9, rationale: "r" };
}

describe("panel view model", () => {
  it("not-set-up renders the welcome state with nothing leaking through", () => {
    const vm = buildPanelViewModel(baseInputs({ setUp: false }));
    expect(vm.setUp).toBe(false);
    expect(vm.board).toEqual({ todo: [], doing: [], done: [] });
    expect(vm.badge).toBe(0);
    expect(vm.driftFeed).toEqual([]);
  });

  it("projects the task board with the active flag and criterion completion", () => {
    const vm = buildPanelViewModel(baseInputs());
    expect(vm.activeTask).toEqual({ id: "t1", title: "serializer works" });
    expect(vm.board.doing[0]).toMatchObject({ id: "t1", active: true, criterionId: "sc_1" });
    expect(vm.board.todo[0]?.id).toBe("t2");
    expect(vm.successCriteria).toEqual([
      { id: "sc_1", text: "serializer works", done: false },
      { id: "sc_2", text: "filters respected", done: false },
    ]);
    expect(vm.health).toBe("stable");
  });

  it("marks criteria done when their linked task is done", () => {
    const inputs = baseInputs();
    inputs.state.tasks[0]!.status = "done";
    inputs.state.activeTaskId = null;
    const vm = buildPanelViewModel(inputs);
    expect(vm.successCriteria[0]?.done).toBe(true);
  });

  it("drift feed carries review status and realignment; badge counts confirmed unrealigned drifts", () => {
    const actions: GuardianAction[] = [
      { id: "a1", ts: at(55), actor: "agent", type: "ADD_DECISION", payload: {} },
    ];
    const vm = buildPanelViewModel(
      baseInputs({
        records: [drift("d1", 60), drift("d2", 30), drift("d3", 20), verdict("d2", "confirmed", 10), verdict("d3", "dismissed", 10)],
        actions,
      }),
    );
    const byId = Object.fromEntries(vm.driftFeed.map((e) => [e.driftId, e]));
    expect(byId.d1).toMatchObject({ status: "pending", realigned: true, label: "Possible drift (unreviewed) — realigned" });
    expect(byId.d2).toMatchObject({ status: "confirmed", realigned: false, label: "Drift confirmed" });
    expect(byId.d3?.status).toBe("dismissed");
    expect(vm.badge).toBe(1);
    expect(vm.semantic.pendingCount).toBe(1);
  });

  it("passes consent and availability through for the consent card", () => {
    const vm = buildPanelViewModel(baseInputs({ semanticConsented: true, semanticAvailable: false }));
    expect(vm.semantic).toMatchObject({ consented: true, available: false });
  });

  it("surfaces the newest session review and suggests updating a stale contract", () => {
    const records: AuditRecord[] = [
      { ts: at(60), kind: "session.review", verdict: "on_course", confidence: 0.9, rationale: "early", judge: "cursor-agent", sampledActions: 12, flaggedActions: [] },
      { ts: at(10), kind: "session.review", verdict: "off_course", confidence: 0.8, rationale: "all theming work", judge: "cursor-agent", sampledActions: 15, flaggedActions: ["[shell] docker build"] },
    ];
    const vm = buildPanelViewModel(baseInputs({ records }));
    expect(vm.sessionReview).toMatchObject({ verdict: "off_course", confidence: 0.8, flaggedActions: ["[shell] docker build"] });
    expect(vm.suggestion).toMatch(/update the contract or record a decision/);
  });

  it("no suggestion when the session reads on course", () => {
    const records: AuditRecord[] = [
      { ts: at(10), kind: "session.review", verdict: "on_course", confidence: 0.95, rationale: "focused", judge: "cursor-agent", sampledActions: 10, flaggedActions: [] },
    ];
    const vm = buildPanelViewModel(baseInputs({ records }));
    expect(vm.sessionReview?.verdict).toBe("on_course");
    expect(vm.suggestion).toBeNull();
  });
});

describe("get-started tour", () => {
  const stepById = (vm: ReturnType<typeof buildPanelViewModel>) =>
    Object.fromEntries(vm.tour.steps.map((s) => [s.id, s.done]));

  it("every step completes from evidence on the tape, not clicks", () => {
    const records: AuditRecord[] = [
      { ts: at(30), kind: "action.observed", actionType: "mcp", actionValue: "goal-guardian/guardian_get_status" },
      { ts: at(20), kind: "drift.verdict", driftId: "d1", verdict: "dismissed", judge: "cursor-agent", confidence: 0.9, rationale: "r" },
    ];
    const vm = buildPanelViewModel(baseInputs({ records, commandCenterUsed: true }));
    expect(stepById(vm)).toEqual({ connect: true, ask: true, tick: true, steer: true, review: true, center: true });
    expect(vm.tour.doneCount).toBe(6);
    // All done -> the section retires itself.
    expect(vm.tour.visible).toBe(false);
  });

  it("a fresh connected workspace shows 1 of 6 with the momentum step done", () => {
    const inputs = baseInputs();
    inputs.state = defaultState();
    const vm = buildPanelViewModel(inputs);
    expect(stepById(vm)).toEqual({ connect: true, ask: false, tick: false, steer: false, review: false, center: false });
    expect(vm.tour).toMatchObject({ doneCount: 1, total: 6, visible: true });
  });

  it("asking completes via goal or via any tape record; /guardian completes only on a guardian status/contract call", () => {
    const inputs = baseInputs();
    inputs.state = defaultState();
    inputs.records = [
      { ts: at(10), kind: "action.observed", actionType: "mcp", actionValue: "browser/take_screenshot" },
    ];
    const vm = buildPanelViewModel(inputs);
    expect(stepById(vm).ask).toBe(true);
    expect(stepById(vm).steer).toBe(false);
  });

  it("consent alone completes the review step", () => {
    const vm = buildPanelViewModel(baseInputs({ semanticConsented: true }));
    expect(stepById(vm).review).toBe(true);
  });

  it("dismissed hides the tour without touching step state", () => {
    const vm = buildPanelViewModel(baseInputs({ tourDismissed: true }));
    expect(vm.tour.visible).toBe(false);
    expect(vm.tour.doneCount).toBeGreaterThan(0);
  });

  it("not-set-up keeps the tour invisible (the welcome screen is step 1)", () => {
    const vm = buildPanelViewModel(baseInputs({ setUp: false }));
    expect(vm.tour.visible).toBe(false);
  });
});
