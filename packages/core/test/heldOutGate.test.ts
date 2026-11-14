import { describe, it, expect } from "vitest";
import { compareHeldOutVerdicts, compareFeedbackResults, type LabelledCase, type ReviewLabel } from "../src/goal/improve.js";

const labels = new Map<string, ReviewLabel>([["gap-a", "right"], ["gap-b", "right"], ["good", "wrong"]]);
const verdicts = (...values: unknown[]) => new Map([...labels.keys()].map((id, i) => [id, values[i]]));

describe("held-out prompt acceptance", () => {
  it("rejects trading away an existing catch even when total catches stay equal and accuracy rises", () => {
    const result = compareHeldOutVerdicts(labels, verdicts(true, false, true), verdicts(false, true, false));
    expect(result).toMatchObject({ kept: false, lostCatches: 1, old: { correct: 1, catches: 1 }, new: { correct: 2, catches: 1 } });
    expect(result.reason).toContain("missed 1 gap");
  });

  it("keeps a genuine improvement on the same complete set without losing any existing catch", () => {
    expect(compareHeldOutVerdicts(labels, verdicts(true, false, true), verdicts(true, true, false)))
      .toMatchObject({ kept: true, lostCatches: 0, old: { correct: 1, catches: 1 }, new: { correct: 3, catches: 2 } });
  });

  it("cannot turn missing baseline replays into an apparent candidate improvement", () => {
    expect(compareHeldOutVerdicts(labels, new Map([["good", true]]), verdicts(true, true, false)))
      .toMatchObject({ kept: false, reason: expect.stringContaining("coverage is incomplete") });
  });

  it("rejects equally sized but different subsets instead of calling them comparable", () => {
    expect(compareHeldOutVerdicts(labels, new Map([["gap-a", true], ["good", true]]), new Map([["gap-b", true], ["good", false]])))
      .toMatchObject({ kept: false, reason: expect.stringContaining("coverage is incomplete") });
  });

  it("requires a boolean verdict for every expected case on both sides", () => {
    for (const invalid of [null, undefined, "false", "true", 0, 1, {}, []]) {
      expect(compareHeldOutVerdicts(labels, verdicts(true, true, false), verdicts(true, invalid, false)), `candidate value ${JSON.stringify(invalid)}`)
        .toMatchObject({ kept: false, reason: expect.stringContaining("coverage is incomplete") });
      expect(compareHeldOutVerdicts(labels, verdicts(true, invalid, false), verdicts(true, true, false)), `current value ${JSON.stringify(invalid)}`)
        .toMatchObject({ kept: false, reason: expect.stringContaining("coverage is incomplete") });
    }
  });

  it("does not count unrelated output files toward accuracy or replay coverage", () => {
    const after = verdicts(true, false, true);
    after.set("not-a-held-out-case", false);
    expect(compareHeldOutVerdicts(labels, verdicts(true, false, true), after))
      .toMatchObject({ kept: false, old: { correct: 1, catches: 1 }, new: { correct: 1, catches: 1 } });
  });

  it("rejects no improvement or an empty comparison", () => {
    expect(compareHeldOutVerdicts(labels, verdicts(true, true, false), verdicts(true, true, false))).toMatchObject({ kept: false });
    expect(compareHeldOutVerdicts(new Map(), new Map(), new Map())).toMatchObject({ kept: false, reason: "no held-out cases to compare" });
  });
});

// The production comparison uses concrete issue identities, rather than whole-case flag booleans.
describe("specific feedback qualification",()=>{
 const cases=[{reviewCase:{id:"a"},targets:[{key:"useful",finding:"missing API",label:"right"},{key:"nit",finding:"style complaint",label:"wrong"}]}] as LabelledCase[];
 it("cannot hide a lost useful issue behind another flag",()=>{
  const before=new Map([["a/useful",true],["a/nit",true]]);
  const after=new Map([["a/useful",false],["a/nit",false],["a/unrelated",true]]);
  expect(compareFeedbackResults(cases,before,after)).toMatchObject({kept:false,lostCatches:1});
 });
 it("accepts removing a rejected complaint while the real defect remains",()=>{
  expect(compareFeedbackResults(cases,new Map([["a/useful",true],["a/nit",true]]),new Map([["a/useful",true],["a/nit",false]]))).toMatchObject({kept:true,lostCatches:0});
 });
 it("requires an unambiguous same-issue match",()=>{
  expect(compareFeedbackResults(cases,new Map([["a/useful",true],["a/nit",true]]),new Map<string,unknown>([["a/useful",null],["a/nit",false]]))).toMatchObject({kept:false,reason:expect.stringContaining("incomplete")});
 });
});
