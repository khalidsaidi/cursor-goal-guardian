import { describe, it, expect } from "vitest";
import {
  buildPanelViewModel,
  defaultState,
  criteriaFromTexts,
  type PanelInputs,
  type AuditRecord,
} from "@goal-guardian/core";
import { renderSections, escapeHtml, SECTION_IDS } from "../src/panel/render.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60 * 1000).toISOString();

function inputs(overrides: Partial<PanelInputs> = {}): PanelInputs {
  const state = defaultState();
  state.goal = "Ship the checkout flow";
  state.successCriteria = criteriaFromTexts(["Payment form works", "Order email sends"]);
  state.constraints = ["No new dependencies"];
  state.tasks = [
    { id: "t1", title: "Payment form works", status: "doing", criterionId: "sc_1" },
    { id: "t2", title: "Order email sends", status: "todo", criterionId: "sc_2" },
  ];
  state.activeTaskId = "t1";
  return { setUp: true, state, records: [], actions: [], now: NOW, semanticConsented: false, semanticAvailable: true, ...overrides };
}

const drift = (id: string, minAgo: number): AuditRecord => ({
  ts: at(minAgo),
  kind: "drift.lexical",
  driftId: id,
  episodeId: `ep_${id}`,
  actionType: "shell",
  actionValue: `docker build <img> & "quote"`,
  activeTaskId: "t1",
  activeTaskTitle: "Payment form works",
  taskTerms: ["payment"],
  actionTerms: ["docker"],
  confidence: "low",
});

describe("panel sections", () => {
  it("not connected: only the welcome invitation renders", () => {
    const sections = renderSections(buildPanelViewModel(inputs({ setUp: false })));
    expect(sections.welcome).toContain("Connect Guardian to this workspace");
    expect(sections.welcome).toContain('data-cmd="setup"');
    expect(sections.welcome).toContain("standing by");
    for (const id of SECTION_IDS.filter((s) => s !== "welcome")) {
      expect(sections[id]).toBe("");
    }
  });

  it("the goal is the title, editable; the instrument reads on course", () => {
    const sections = renderSections(buildPanelViewModel(inputs()));
    expect(sections.welcome).toBe("");
    expect(sections.goal).toContain("Ship the checkout flow");
    expect(sections.goal).toContain('data-cmd="editGoal"');
    expect(sections.goal).toContain("on course");
    expect(sections.goal).toContain("Nothing off-goal in the last 24 hours.");
  });

  it("an empty goal invites the chat-first path", () => {
    const inp = inputs();
    inp.state.goal = "";
    const sections = renderSections(buildPanelViewModel(inp));
    expect(sections.goal).toContain("Ask your agent for something");
  });

  it("focus shows Now with Mark done, Up next with Start, and a finished count", () => {
    const inp = inputs();
    inp.state.tasks.push({ id: "t3", title: "Old spike", status: "done" });
    const sections = renderSections(buildPanelViewModel(inp));
    expect(sections.focus).toContain("Payment form works");
    expect(sections.focus).toContain("Mark done");
    expect(sections.focus).toContain("Up next");
    expect(sections.focus).toContain('data-task="t2"');
    expect(sections.focus).toContain("1 finished");
  });

  it("plain-language lists: Done when checklist and Boundaries", () => {
    const inp = inputs();
    inp.state.tasks[0]!.status = "done";
    inp.state.activeTaskId = null;
    const sections = renderSections(buildPanelViewModel(inp));
    expect(sections.criteria).toContain("Done when");
    expect(sections.criteria).toMatch(/class="done"/);
    expect(sections.constraints).toContain("Boundaries");
    expect(sections.constraints).toContain("No new dependencies");
  });

  it("the track: detours render as off-axis nodes with chips; HTML is escaped", () => {
    const sections = renderSections(buildPanelViewModel(inputs({ records: [drift("d1", 30)] })));
    expect(sections.drift).toContain('class="track"');
    expect(sections.drift).toContain("unreviewed");
    expect(sections.drift).toContain('data-rescore="d1"');
    expect(sections.drift).toContain("docker build &lt;img&gt;");
    expect(sections.drift).not.toContain("<img>");
    expect(sections.goal).toContain("off course");
    expect(sections.consent).toContain("Turn on AI review");
  });

  it("a realigned detour reads 'came back'; dismissed ones become cleared false alarms", () => {
    const records: AuditRecord[] = [
      drift("d1", 30),
      { ts: at(25), kind: "drift.verdict", driftId: "d1", verdict: "dismissed", judge: "cursor-agent", confidence: 0.8, rationale: "fine" },
      drift("d2", 20),
    ];
    const actions = [{ id: "a1", ts: at(18), actor: "agent" as const, type: "ADD_DECISION" as const, payload: {} }];
    const sections = renderSections(buildPanelViewModel(inputs({ records, actions })));
    expect(sections.drift).toContain("came back");
    expect(sections.drift).toContain("1 false alarm cleared by review");
  });

  it("consented + offline shows the calm offline note", () => {
    const sections = renderSections(
      buildPanelViewModel(inputs({ records: [drift("d1", 30)], semanticConsented: true, semanticAvailable: false })),
    );
    expect(sections.consent).toContain("offline");
    expect(sections.consent).not.toContain("Turn on AI review");
  });

  it("escapeHtml covers the critical entities", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  });
});
