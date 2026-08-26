import crypto from "node:crypto";
import type { GuardianState } from "../schema/state.js";

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `"${k}":${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeHash(state: GuardianState): string {
  const copy: GuardianState = { ...state, meta: { ...state.meta, hash: "" } };
  return crypto.createHash("sha256").update(stableStringify(copy)).digest("hex");
}

/** True when state.json content no longer matches its recorded hash (manual edit). */
export function isManuallyEdited(state: GuardianState): boolean {
  return state.meta.hash !== "" && state.meta.hash !== computeHash(state);
}
