import { describe, it, expect } from "vitest";
import {
  buildPanelViewModel,
  defaultContract,
  criteriaFromTexts,
  goalHash,
  type AuditRecord,
  type PanelInputs,
} from "../src/index.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60 * 1000).toISOString();

function baseInputs(overrides: Partial<PanelInputs> = {}): PanelInputs {
  return {
    setUp: true,
    contract: {
      ...defaultContract(),
      goal: "Ship CSV export",
      successCriteria: criteriaFromTexts(["serializer works", "filters respected"]),
      constraints: ["no new deps"],
    },
    records: [],
    now: NOW,
    ...overrides,
  };
}

describe("panel view model", () => {
  it("not-set-up renders the welcome state with nothing leaking through", () => {
    const vm = buildPanelViewModel(baseInputs({ setUp: false }));
    expect(vm.setUp).toBe(false);
    expect(vm.successCriteria).toEqual([]);
    expect(vm.status).toEqual({ lamp: "idle", word: "no goal" });
  });

  it("lists the contract's items, unticked before any run", () => {
    const vm = buildPanelViewModel(baseInputs());
    expect(vm.goal).toBe("Ship CSV export");
    expect(vm.constraints).toEqual(["no new deps"]);
    expect(vm.successCriteria).toEqual([
      { id: "sc_1", text: "serializer works", done: false },
      { id: "sc_2", text: "filters respected", done: false },
    ]);
    expect(vm.status).toEqual({ lamp: "on", word: "active" });
  });

  it("ticks only what a proved run on this goal backed", () => {
    const inputs = baseInputs();
    const proved = (goalHashValue: string): AuditRecord => ({
      ts: at(5), kind: "goal.end", conversationId: "c", goalHash: goalHashValue, outcome: "proved",
      proved: [{ criterion: "sc_1", command: "npm test", quote: "1 passing" }],
    });
    const ticks = (goalRecords: AuditRecord[]) => buildPanelViewModel({ ...inputs, goalRecords }).successCriteria.map((c) => c.done);
    expect(ticks([proved(goalHash(inputs.contract))])).toEqual([true, false]);
    expect(ticks([{ ...proved(goalHash(inputs.contract)), verifiedItems: inputs.contract.successCriteria.map((c) => c.id) } as AuditRecord])).toEqual([true, true]);
    // A proved run on an earlier goal, or the user closing the goal, ticks nothing.
    expect(ticks([proved("another-goal")])).toEqual([false, false]);
    expect(ticks([{ ts: at(5), kind: "goal.control", goalHash: goalHash(inputs.contract), operation: "complete", actor: "user" }])).toEqual([false, false]);
  });

  it("the status follows the goal, and flags in old logs change nothing", () => {
    const end = (outcome: "proved" | "blocked" | "stalled" | "limit"): AuditRecord => ({ ts: at(5), kind: "goal.end", conversationId: "c", goalHash: "h", outcome });
    const word = (goalRecords: AuditRecord[]) => buildPanelViewModel(baseInputs({ goalRecords })).status;
    expect(word([end("blocked")])).toEqual({ lamp: "warn", word: "blocked" });
    // Proved on the record with the review still objecting to that state is not a clean "proved".
    const disputed = baseInputs();
    disputed.goalRecords = [{ ts: at(5), kind: "goal.end", conversationId: "c", goalHash: goalHash(disputed.contract), outcome: "proved", reviewer: ["Reviewer: sc_1 isn't done: a placeholder test"] }];
    expect(buildPanelViewModel(disputed).status).toEqual({ lamp: "warn", word: "needs attention" });
    expect(word([end("stalled")])).toEqual({ lamp: "warn", word: "stalled" });
    expect(word([{ ts: at(5), kind: "goal.end", conversationId: "c", goalHash: "h", outcome: "budget_limited", reason: "1100 of 1000 tokens used" }])).toEqual({ lamp: "warn", word: "budget reached" });
    expect(word([end("limit")])).toEqual({ lamp: "warn", word: "stalled" });
    const inputs = baseInputs();
    inputs.contract.goal = "";
    expect(buildPanelViewModel(inputs).status).toEqual({ lamp: "idle", word: "no goal" });
    const legacy: AuditRecord = {
      ts: at(5), kind: "drift.lexical", driftId: "d1", episodeId: "e1", actionType: "shell", actionValue: "docker build .",
      activeTaskId: "t1", activeTaskTitle: "serializer works", taskTerms: ["serializer"], actionTerms: ["docker"], confidence: "medium",
    };
    expect(buildPanelViewModel(baseInputs({ records: [legacy] })).status).toEqual({ lamp: "on", word: "active" });
  });
});

describe("get-started tour", () => {
  const stepById = (vm: ReturnType<typeof buildPanelViewModel>) =>
    Object.fromEntries(vm.tour.steps.map((s) => [s.id, s.done]));

  it("every step completes from evidence on the tape, not clicks", () => {
    const records: AuditRecord[] = [
      { ts: at(30), kind: "action.observed", actionType: "mcp", actionValue: "goal-guardian/get_goal" },
    ];
    const vm = buildPanelViewModel(baseInputs({ records, commandCenterUsed: true }));
    expect(stepById(vm)).toEqual({ connect: true, ask: true, steer: true, center: true });
    expect(vm.tour.doneCount).toBe(4);
    // All done -> the section retires itself.
    expect(vm.tour.visible).toBe(false);
  });

  it("a fresh connected workspace shows 1 of 4 with the momentum step done", () => {
    const inputs = baseInputs();
    inputs.contract = defaultContract();
    const vm = buildPanelViewModel(inputs);
    expect(stepById(vm)).toEqual({ connect: true, ask: false, steer: false, center: false });
    expect(vm.tour).toMatchObject({ doneCount: 1, total: 4, visible: true });
  });

  it("asking completes via goal or via any tape record; /guardian completes only on a guardian status/contract call", () => {
    const inputs = baseInputs();
    inputs.contract = defaultContract();
    inputs.records = [
      { ts: at(10), kind: "action.observed", actionType: "mcp", actionValue: "browser/take_screenshot" },
    ];
    const vm = buildPanelViewModel(inputs);
    expect(stepById(vm).ask).toBe(true);
    expect(stepById(vm).steer).toBe(false);
  });

  it("reporting on the goal does NOT tick the steer step; only reading it with get_goal does", () => {
    const inputs = baseInputs();
    inputs.records = [
      { ts: at(10), kind: "action.observed", actionType: "mcp", actionValue: "goal-guardian/update_goal" },
    ];
    expect(stepById(buildPanelViewModel(inputs)).steer).toBe(false);
    inputs.records.push({ ts: at(5), kind: "action.observed", actionType: "mcp", actionValue: "goal-guardian/get_goal" });
    expect(stepById(buildPanelViewModel(inputs)).steer).toBe(true);
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
