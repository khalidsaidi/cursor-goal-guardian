import { describe, it, expect } from "vitest";
import {
  buildPanelViewModel,
  defaultContract,
  criteriaFromTexts,
  goalHash,
  type PanelInputs,
  type AuditRecord,
} from "@goal-guardian/core";
import { renderSections, escapeHtml, SECTION_IDS } from "../src/panel/render.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60 * 1000).toISOString();

function inputs(overrides: Partial<PanelInputs> = {}): PanelInputs {
  return {
    setUp: true,
    contract: {
      ...defaultContract(),
      goal: "Ship the checkout flow",
      successCriteria: criteriaFromTexts(["Payment form works", "Order email sends"]),
      constraints: ["No new dependencies"],
    },
    records: [],
    now: NOW,
    ...overrides,
  };
}

describe("panel sections", () => {
  it("not connected: only the welcome card with the in-place connect form renders", () => {
    const sections = renderSections(buildPanelViewModel(inputs({ setUp: false })));
    expect(sections.welcome).toContain("standing by");
    // The whole setup is a real form in the panel: goal input, list builders
    // (no delimiters anywhere), gitignore choice, one submit.
    expect(sections.welcome).toContain('id="su-goal"');
    expect(sections.welcome).toContain('data-su-list="su-crit-list"');
    expect(sections.welcome).toContain('data-su-list="su-con-list"');
    expect(sections.welcome).toContain('id="su-git"');
    expect(sections.welcome).toContain("data-setup-submit");
    for (const id of SECTION_IDS.filter((s) => s !== "welcome")) {
      expect(sections[id]).toBe("");
    }
  });

  it("the goal is the title, editable; the instrument reads the goal's state", () => {
    const sections = renderSections(buildPanelViewModel(inputs()));
    expect(sections.welcome).toBe("");
    expect(sections.goal).toContain("Ship the checkout flow");
    expect(sections.goal).toContain('data-cmd="editGoal"');
    expect(sections.goal).toContain('class="lamp on"');
    expect(sections.goal).toContain(">active<");
    for (const gone of ["drift", "focus", "repair"]) expect(SECTION_IDS).not.toContain(gone);
  });

  it("an empty goal invites the chat-first path", () => {
    const inp = inputs();
    inp.contract.goal = "";
    const sections = renderSections(buildPanelViewModel(inp));
    expect(sections.goal).toContain("Ask your agent for something");
  });

  it("plain-language lists: Done when checklist and Boundaries", () => {
    const inp = inputs();
    inp.goalRecords = [{ ts: at(1), kind: "goal.end", conversationId: "c", goalHash: goalHash(inp.contract), outcome: "proved", proved: [{ criterion: "sc_1", command: "npm test", quote: "1 passing" }] }];
    const sections = renderSections(buildPanelViewModel(inp));
    expect(sections.criteria).toContain("Done when");
    expect(sections.criteria).toMatch(/class="done"/);
    expect(sections.constraints).toContain("Boundaries");
    expect(sections.constraints).toContain("No new dependencies");
  });

  it("keeps service failures out of the primary task view and technical receipts closed", () => {
    const inp=inputs();
    inp.goalRecords=[{ts:at(1),kind:"goal.end",goalHash:goalHash(inp.contract),outcome:"unchecked",skipped:["reviewer failed <details>"],proved:[{criterion:"sc_1",command:"npm test",quote:"passed"}]}];
    const sections=renderSections(buildPanelViewModel(inp));
    expect(sections.goal).not.toContain("CGG couldn");
    expect(sections.goal).not.toContain("review unfinished");
    expect(sections.goal).not.toContain('class="lamp warn"');
    expect(sections.goal).toContain('<details class="run-details"><summary>Check details</summary>');
    expect(sections.goal).not.toMatch(/<details[^>]*open/);
    expect(sections.goal).not.toContain("Verification incomplete");
    expect(sections.goal).not.toContain("retry");
    expect(sections.goal).toContain("reviewer failed &lt;details&gt;");
    expect(sections.goal.indexOf('<details class="run-details">')).toBeLessThan(sections.goal.indexOf("reviewer failed"));
    inp.goalRecords[0]={ts:at(1),kind:"goal.end",goalHash:goalHash(inp.contract),outcome:"proved"};
    expect(renderSections(buildPanelViewModel(inp)).goal).not.toContain('class="review-notice"');
  });

  it("escapeHtml covers the critical entities", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  });

  it("get-started tour renders progress, action links for open steps, and a dismiss control", () => {
    const sections = renderSections(buildPanelViewModel(inputs()));
    expect(sections.tour).toContain("Get started · 2 of 4");
    expect(sections.tour).toContain('data-cmd="commandCenter"');
    expect(sections.tour).toContain('data-cmd="dismissTour"');
    expect(sections.tour).toContain("Type /guardian in the chat");
  });

  it("tour disappears when dismissed and when every step is done", () => {
    expect(renderSections(buildPanelViewModel(inputs({ tourDismissed: true }))).tour).toBe("");
    const records: AuditRecord[] = [
      { ts: at(30), kind: "action.observed", actionType: "mcp", actionValue: "goal-guardian/get_goal" },
    ];
    expect(renderSections(buildPanelViewModel(inputs({ records, commandCenterUsed: true }))).tour).toBe("");
  });
});
