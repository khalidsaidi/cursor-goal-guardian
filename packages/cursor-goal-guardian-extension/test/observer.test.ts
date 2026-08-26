import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import type { AuditRecord } from "@goal-guardian/core";
import { hooksRecentlyAlive, isIgnoredRelPath, shouldObserve } from "../src/observer.js";
import { offerMcpEnableGuidance } from "../src/setup.js";
import { recorded, responses, env } from "./mocks/vscode.js";

afterEach(() => {
  recorded.reset();
  env.remoteName = "wsl";
});

// The observer exists for exactly one gap: native Windows desktop, where
// Cursor's hook runtime is sandboxed away from the workspace. Everywhere else
// the hooks are the richer channel and the observer must stay off.
describe("observer activation gate", () => {
  it("activates only on native win32 desktop", () => {
    expect(shouldObserve("win32", undefined)).toBe(true);
    expect(shouldObserve("win32", "wsl")).toBe(false);
    expect(shouldObserve("linux", undefined)).toBe(false);
    expect(shouldObserve("darwin", undefined)).toBe(false);
  });
});

describe("observer path filter", () => {
  it("keeps real workspace files", () => {
    expect(isIgnoredRelPath("src/app.ts")).toBe(false);
    expect(isIgnoredRelPath(path.join("src", "deep", "file.ts"))).toBe(false);
    expect(isIgnoredRelPath(".cursor/rules/goal-guardian.mdc")).toBe(false);
  });

  it("drops derived artifacts, VCS internals, out-of-root paths, and its own telemetry", () => {
    expect(isIgnoredRelPath(path.join(".git", "index"))).toBe(true);
    expect(isIgnoredRelPath(path.join("node_modules", "x", "y.js"))).toBe(true);
    expect(isIgnoredRelPath(path.join("dist", "main.js"))).toBe(true);
    expect(isIgnoredRelPath(path.join(".cursor", "goal-guardian", "telemetry", "audit.jsonl"))).toBe(true);
    expect(isIgnoredRelPath(path.join("..", "elsewhere", "f.ts"))).toBe(true);
    expect(isIgnoredRelPath("")).toBe(true);
  });
});

describe("hook liveness gate", () => {
  const now = Date.parse("2026-01-01T10:10:00.000Z");
  const hookEvent = (ts: string, source?: "observer"): AuditRecord => ({
    ts,
    kind: "hook.event",
    event: "beforeShellExecution",
    ...(source ? { source } : {}),
  });

  it("recent hook-runtime records mean hooks own recording", () => {
    expect(hooksRecentlyAlive([hookEvent("2026-01-01T10:08:00.000Z")], now)).toBe(true);
  });

  it("stale records or silence mean the observer records", () => {
    expect(hooksRecentlyAlive([hookEvent("2026-01-01T09:00:00.000Z")], now)).toBe(false);
    expect(hooksRecentlyAlive([], now)).toBe(false);
  });

  it("the observer's own echo never counts as hook liveness", () => {
    expect(hooksRecentlyAlive([hookEvent("2026-01-01T10:09:00.000Z", "observer")], now)).toBe(false);
  });
});

// Cursor's one-time per-project MCP enable: the user gets a button straight to
// Cursor's MCP settings screen, not a paragraph of directions to memorize.
describe("MCP enable guidance", () => {
  it("desktop: shows one message with a button that opens Cursor's MCP settings", async () => {
    env.remoteName = undefined as unknown as string;
    responses.information = "Open MCP Settings";
    offerMcpEnableGuidance();
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorded.windowMessages.filter((m) => m.kind === "information")).toHaveLength(1);
    expect(recorded.executed).toContain("workbench.action.openMCPSettings");
  });

  it("desktop: dismissing the message executes nothing", async () => {
    env.remoteName = undefined as unknown as string;
    responses.information = undefined;
    offerMcpEnableGuidance();
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorded.executed).toHaveLength(0);
  });

  it("remote hosts: stays silent (no toggle there)", () => {
    env.remoteName = "wsl";
    offerMcpEnableGuidance();
    expect(recorded.windowMessages).toHaveLength(0);
  });
});
