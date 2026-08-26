import { describe, it, expect } from "vitest";
import { stableStringify, computeHash, isManuallyEdited, defaultState } from "../src/index.js";

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, null, "x"] } })).toBe(
      stableStringify({ a: { c: [3, null, "x"], d: 2 }, b: 1 }),
    );
  });

  it("distinguishes arrays from objects and preserves primitives", () => {
    expect(stableStringify([1, "a", true])).toBe('[1,"a",true]');
    expect(stableStringify({ k: undefined })).toBe("{\"k\":undefined}");
  });
});

describe("computeHash / isManuallyEdited", () => {
  it("hash excludes the stored hash itself and is stable", () => {
    const s = defaultState();
    s.meta.hash = computeHash(s);
    const rehash = computeHash(s);
    expect(rehash).toBe(s.meta.hash);
  });

  it("detects field tampering", () => {
    const s = defaultState();
    s.meta.hash = computeHash(s);
    expect(isManuallyEdited(s)).toBe(false);
    const tampered = { ...s, goal: "edited by hand" };
    expect(isManuallyEdited(tampered)).toBe(true);
  });

  it("treats an empty stored hash as not-edited (bootstrap state)", () => {
    const s = defaultState();
    expect(isManuallyEdited(s)).toBe(false);
  });
});
