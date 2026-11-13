import { describe, it, expect } from "vitest";
import { defaultContract, goalHash, REVIEW_POLICY, objectionEntries, parseAdjudication, reviewLabels, buildPanelViewModel, type AuditRecord } from "../src/index.js";

const contract = { ...defaultContract(), goal: "Export records", successCriteria: [{ id: "sc_1", text: "exports records" }] };
const review = {
  ts: "2026-11-11T10:00:00Z", kind: "goal.review" as const, id: "r", goalHash: goalHash(contract), reportTs: "2026-11-11T09:59:00Z", ran: true, seconds: 1,
  fails: [{ id: "sc_1", evidence: "false claim" }], extra: [{ file: "other.js", what: "unrelated rename" }],
  evaluator: { ran: true, overall: 0.5, rubrics: 2, failed: [{ id: "sc_2", property: "another item", rationale: "actual failure" }], calls: 5, seconds: 1 },
  adjudication: { ran: true, seconds: 1, confirmed: [], unclear: [], dismissed: [{ id: "reviewer_item_1", property: "false claim", rationale: "false", evidence: "checked" }] },
};
const feedback = (index: number): AuditRecord => ({ ts: "2026-11-11T10:01:00Z", kind: "review.feedback", reviewId: "r", index, label: "right" });

describe("acceptance audit regressions", () => {
  it("dismissals preserve raw objection indexes through the panel and feedback learner", () => {
    expect(objectionEntries(review).map(e => [e.index,e.source])).toEqual([[1,"reviewer"],[2,"evaluator"]]);
    const vm=buildPanelViewModel({ setUp: true, contract, records: [], goalRecords: [review,feedback(2)], now: new Date() });
    expect(vm.reviews[0]).toMatchObject({ indexes: [1,2], feedback: [null,"right"] });
    expect(reviewLabels([review,feedback(2)]).size).toBe(0);
    expect(reviewLabels([review,feedback(0)]).size).toBe(0);
    expect(reviewLabels([review,feedback(1)]).get("r")).toEqual({label:"right",source:"user"});
  });
  it("a pass after all dismissals still allows the user to report missed work", () => {
    const passed = { ...review, extra: [], evaluator: { ...review.evaluator, failed: [] } };
    const end: AuditRecord = { ts: "2026-11-11T10:00:30Z",kind:"goal.end",goalHash:goalHash(contract),outcome:"proved" };
    const missed: AuditRecord = {ts:"2026-11-11T10:01:00Z",kind:"review.feedback",reviewId:"r",index:0,label:"missed"};
    const vm=buildPanelViewModel({setUp:true,contract,records:[],goalRecords:[passed,end],now:new Date()});
    expect(vm.goalRun?.passedReview).toBe("r");
    expect(reviewLabels([passed,end,missed]).get("r")).toEqual({label:"right",source:"missed"});
  });
  it("contradictory duplicate adjudications cannot dismiss a real failure", () => {
    const claim={id:"sc_1",property:"export",rationale:"throws"};
    const response=JSON.stringify({claims:[{id:"sc_1",verdict:"confirmed",evidence:"throws"},{id:"sc_1",verdict:"dismissed",evidence:"different input works"}]});
    expect(parseAdjudication(response,[claim])).toEqual({confirmed:[],dismissed:[],unclear:["sc_1"]});
  });
  it("sends back only the confirmed scope issue when a valid restriction and harmless formatting are mixed", () => {
    const mixed = { ...review, policy: REVIEW_POLICY, fails: [], extra: [{file:"README.md",what:"changed protected text"},{file:"index.d.ts",what:"harmless formatting"}], evaluator:{...review.evaluator,failed:[{id:"extra",property:"scope",rationale:"README and type formatting"}]}, adjudication:{ran:true,seconds:1,confirmed:[{id:"reviewer_extra_1",evidence:"README violates the exact-text restriction"},{id:"extra",evidence:"Only README violates the exact-text restriction"}],unclear:[],dismissed:[{id:"reviewer_extra_2",property:"types",rationale:"formatting",evidence:"no type/API change"}]}};
    const lines=objectionEntries(mixed).map(e=>e.line).join("\n");
    expect(lines).toContain("README"); expect(lines).not.toContain("index.d.ts"); expect(lines).not.toContain("type formatting");
  });
  it("an inconclusive scope opinion asks for verification, not code removal", () => {
    const uncertain={...review,policy:REVIEW_POLICY,fails:[],extra:[{file:"README.md",what:"maybe unnecessary"}],evaluator:{...review.evaluator,failed:[]},adjudication:{ran:false,seconds:0,confirmed:[],dismissed:[],unclear:["reviewer_extra_1"]}};
    expect(objectionEntries(uncertain)).toEqual([]);
  });

});
