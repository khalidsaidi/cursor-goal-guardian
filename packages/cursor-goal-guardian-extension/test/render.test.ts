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
  state.goal = "Ship CSV export";
  state.successCriteria = criteriaFromTexts(["serializer works"]);
  state.constraints = ["no new deps"];
  state.tasks = [
    { id: "t1", title: "serializer works", status: "doing", criterionId: "sc_1" },
    { id: "t2", title: "filters", status: "todo" },
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
  activeTaskTitle: "serializer works",
  taskTerms: ["serializer"],
  actionTerms: ["docker"],
  confidence: "low",
});

describe("panel section renderers", () => {
  it("welcome state renders only the welcome section", () => {
    const sections = renderSections(buildPanelViewModel(inputs({ setUp: false })));
    expect(sections.welcome).toContain("Set up this workspace");
    expect(sections.welcome).toContain('data-cmd="setup"');
    for (const id of SECTION_IDS.filter((s) => s !== "welcome")) {
      expect(sections[id]).toBe("");
    }
  });

  it("set-up state renders hero/board and no welcome", () => {
    const sections = renderSections(buildPanelViewModel(inputs()));
    expect(sections.welcome).toBe("");
    expect(sections.hero).toContain("Ship CSV export");
    expect(sections.hero).toContain("🟢 On track");
    expect(sections.board).toContain("serializer works");
    expect(sections.board).toContain('data-cmd="completeActiveTask"');
    expect(sections.board).toContain('data-cmd="startNextTask"');
    expect(sections.criteria).toContain("⬜");
    expect(sections.constraints).toContain("no new deps");
    expect(sections.drift).toContain("The tape is clean");
    expect(sections.consent).toBe("");
  });

  it("drift entries escape HTML and expose per-item review buttons; consent card appears with pending drift", () => {
    const sections = renderSections(buildPanelViewModel(inputs({ records: [drift("d1", 30)] })));
    expect(sections.drift).toContain("docker build &lt;img&gt; &amp; &quot;quote&quot;");
    expect(sections.drift).not.toContain("<img>");
    expect(sections.drift).toContain('data-rescore="d1"');
    expect(sections.consent).toContain("Enable AI review");
  });

  it("consented + unavailable renders the offline note instead of the ask", () => {
    const sections = renderSections(
      buildPanelViewModel(inputs({ records: [drift("d1", 30)], semanticConsented: true, semanticAvailable: false })),
    );
    expect(sections.consent).toContain("offline");
    expect(sections.consent).not.toContain("Enable AI review");
  });

  it("dismissed drifts are tucked behind a details toggle", () => {
    const records: AuditRecord[] = [
      drift("d1", 30),
      { ts: at(10), kind: "drift.verdict", driftId: "d1", verdict: "dismissed", judge: "cursor-agent", confidence: 0.8, rationale: "fine" },
    ];
    const sections = renderSections(buildPanelViewModel(inputs({ records })));
    expect(sections.drift).toContain("<details>");
    expect(sections.drift).toContain("1 dismissed by review");
  });

  it("escapeHtml covers the critical entities", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  });
});
