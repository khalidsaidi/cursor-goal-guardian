import { describe, it, expect } from "vitest";
import { buildCaseFile, editsSince, flagTrackRecord, lastSendBack, markedWrong, sendBackOutcomes, testsOutcome, type AuditRecord } from "../src/index.js";

const T = (m: number) => new Date(Date.UTC(2026, 10, 3, 12, m)).toISOString();
const check = (m: number, over: Partial<Extract<AuditRecord, { kind: "done.check" }>> = {}): Extract<AuditRecord, { kind: "done.check" }> => ({
  ts: T(m), kind: "done.check", conversationId: "c1", verdict: "fail", required: true,
  lines: [{ key: "1", status: "contradicted", note: "`npm test` never ran" }], problems: [], turnActions: 1, followupSent: true, ...over,
});
const edit = (m: number, file: string, conversationId = "c1"): AuditRecord => ({ ts: T(m), kind: "action.observed", actionType: "edit", actionValue: file, conversationId });

describe("flag outcomes (no model)", () => {
  it("a code-check send-back: fixed with edits, corrected without, ignored when still failing", () => {
    const prev = check(0);
    const next = { ts: T(5), conversationId: "c1" };
    expect(sendBackOutcomes(prev, { ...next, verdict: "pass" }, 2)[0]).toMatchObject({ flag: "followup", outcome: "fixed", ref: T(0), editsAfter: 2, text: "1: `npm test` never ran" });
    expect(sendBackOutcomes(prev, { ...next, verdict: "pass" }, 0)[0]).toMatchObject({ outcome: "corrected" });
    expect(sendBackOutcomes(prev, { ...next, verdict: "fail" }, 3)[0]).toMatchObject({ outcome: "ignored" });
    expect(sendBackOutcomes(prev, { ...next, verdict: "blocked" }, 0)[0]).toMatchObject({ outcome: "corrected" });
  });

  it("counts distinct files edited after the flag, in this conversation, not Guardian's own", () => {
    const recs = [edit(1, "a.js"), edit(6, "a.js"), edit(7, "a.js"), edit(8, "b.js"), edit(9, ".cursor/goal-guardian/x"), edit(9, "c.js", "other")];
    expect(editsSince(recs, { conversationId: "c1" }, T(5))).toBe(2);
  });

  it("finds the send-back being answered only if the latest check sent one", () => {
    expect(lastSendBack([check(0), check(3, { followupSent: false })], { conversationId: "c1" })).toBeNull();
    expect(lastSendBack([check(0, { followupSent: false }), check(3)], { conversationId: "c1" })!.ts).toBe(T(3));
  });

  it("broken tests that pass again are tests_green, once", () => {
    const broke: AuditRecord = { ts: T(0), kind: "tests.rerun", conversationId: "c1", command: "mvn test", exit: 1, baselineExit: 0, broke: true, durationMs: 9 };
    const pass = { ts: T(9), kind: "tests.rerun" as const, conversationId: "c1", command: "mvn test", exit: 0 as const, broke: false, durationMs: 9 };
    const recs = [broke, edit(4, "A.java")];
    expect(testsOutcome(recs, { conversationId: "c1" }, pass)).toMatchObject({ flag: "tests_broke", ref: T(0), outcome: "tests_green", editsAfter: 1, text: "mvn test (exit 1)" });
    const done = [...recs, testsOutcome(recs, { conversationId: "c1" }, pass)!];
    expect(testsOutcome(done, { conversationId: "c1" }, { ...pass, ts: T(20) })).toBeNull();
    expect(testsOutcome(recs, { conversationId: "c1" }, { ...pass, exit: 1 })).toBeNull();
  });

  it("the user's wrong-flag mark, and the track record", () => {
    const m = markedWrong({ flag: "drift", ref: "d1", ts: T(3) });
    expect(m).toMatchObject({ kind: "flag.outcome", outcome: "marked_wrong", ref: "d1" });
    const recs: AuditRecord[] = [m, { ...m, ts: T(4), outcome: "fixed" }, { ...m, ts: T(5), outcome: "fixed" }];
    expect(flagTrackRecord(recs, Date.parse(T(0)))).toMatchObject({ fixed: 2, marked_wrong: 1, ignored: 0 });
  });
});

describe("the case file", () => {
  it("joins every flag with its outcome; the user's mark wins; drift uses realignment", () => {
    const sent = check(0);
    const second = check(10);
    const broke: AuditRecord = { ts: T(20), kind: "tests.rerun", conversationId: "c1", command: "pytest", exit: 1, baselineExit: 0, broke: true, durationMs: 9 };
    const recs: AuditRecord[] = [
      sent,
      { ts: T(5), kind: "flag.outcome", conversationId: "c1", flag: "followup", ref: T(0), outcome: "fixed", editsAfter: 1 },
      second,
      { ts: T(12), kind: "flag.outcome", flag: "followup", ref: T(10), outcome: "corrected", editsAfter: 0 },
      markedWrong({ flag: "followup", ref: T(10), ts: T(13) }),
      broke,
    ];
    const drift = [
      { driftId: "d1", ts: T(30), actionValue: "docs/x.md", activeTaskTitle: "parser", status: "confirmed", realigned: true },
      { driftId: "d2", ts: T(31), actionValue: "y", activeTaskTitle: "parser", status: "dismissed", realigned: false },
    ];
    expect(buildCaseFile(recs, drift)).toMatchObject([
      { flag: "followup", outcome: "fixed", text: "1: `npm test` never ran" },
      { flag: "followup", outcome: "marked_wrong" },
      { flag: "tests_broke", outcome: "open", text: "pytest (exit 1)" },
      { flag: "drift", ref: "d1", outcome: "realigned", judged: "confirmed" },
    ]);
  });
});
