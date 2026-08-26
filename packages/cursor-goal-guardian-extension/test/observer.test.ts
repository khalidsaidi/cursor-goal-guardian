import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import type { AuditRecord } from "@goal-guardian/core";
import {
  hooksRecentlyAlive,
  isDuplicateShell,
  isIgnoredRelPath,
  isReportableProcess,
  processWatchScript,
  shouldObserve,
  unwrapShellCommand,
} from "../src/observer.js";
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

// OS-level shell observation: nothing an agent tool-runner launches escapes
// process creation, but editor plumbing and our own binaries stay off the tape.
describe("process watcher filter", () => {
  it("keeps real commands", () => {
    expect(isReportableProcess("node.exe", "node --test src/math.test.ts")).toBe(true);
    expect(isReportableProcess("powershell.exe", "powershell -Command winget install X")).toBe(true);
  });

  it("drops plumbing, our binaries, empty command lines, and the watcher itself", () => {
    expect(isReportableProcess("conhost.exe", "\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4")).toBe(false);
    expect(isReportableProcess("Cursor.exe", "Cursor.exe --type=utility")).toBe(false);
    expect(isReportableProcess("goal-guardian-hook.exe", "goal-guardian-hook.exe")).toBe(false);
    expect(isReportableProcess("node.exe", "")).toBe(false);
    expect(isReportableProcess("powershell.exe", "powershell -Command # gg-process-watch ...")).toBe(false);
  });

  it("drops the editor's own machinery seen live: hook-runtime wrapper, tsserver, typings installer", () => {
    expect(
      isReportableProcess(
        "powershell.exe",
        "powershell.exe -NoProfile -c \"Get-Content 'C:\\Users\\k\\AppData\\Local\\Temp\\cursor-hook-payload-1.json' | & 'goal-guardian-hook.exe'\"",
      ),
    ).toBe(false);
    expect(
      isReportableProcess(
        "node.exe",
        "c:\\Users\\k\\AppData\\Local\\Programs\\cursor\\resources\\app\\resources\\helpers\\node.exe tsserver.js",
      ),
    ).toBe(false);
    expect(
      isReportableProcess("node.exe", "node.exe c:/Users/k/AppData/Local/Programs/cursor/resources/app/extensions/node_modules/typescript/lib/typingsInstaller.js"),
    ).toBe(false);
    // A user's own node stays reportable.
    expect(isReportableProcess("node.exe", "node --test src/math.test.ts")).toBe(true);
  });

  it("the watch script carries its own sentinel so it can filter itself", () => {
    expect(processWatchScript()).toContain("gg-process-watch");
  });
});

describe("shell dedup across channels", () => {
  const now = 1_000_000;
  it("the same execution seen by both channels tapes once, whichever lands first", () => {
    const recent = [{ value: "npm test", ts: now - 5_000 }];
    expect(isDuplicateShell(recent, "npm test", now)).toBe(true);
    // WMI sees the full spawned command line wrapping the typed command —
    // still the same execution, in either arrival order.
    expect(isDuplicateShell(recent, 'powershell.exe -Command "npm test"', now)).toBe(true);
    expect(isDuplicateShell([{ value: 'powershell.exe -Command "npm test"', ts: now - 5_000 }], "npm test", now)).toBe(true);
  });

  it("old sightings expire; new commands always tape", () => {
    expect(isDuplicateShell([{ value: "npm test", ts: now - 120_000 }], "npm test", now)).toBe(false);
    expect(isDuplicateShell([{ value: "npm test", ts: now - 5_000 }], "git status", now)).toBe(false);
  });

  it("escaping differences between channels cannot defeat the dedup", () => {
    const typed = 'Get-Command node, npm -ErrorAction SilentlyContinue | Format-Table Name';
    const wmi = 'Get-Command node, npm -ErrorAction SilentlyContinue \\| Format-Table \\"Name\\"';
    expect(isDuplicateShell([{ value: typed, ts: now - 3_000 }], wmi, now)).toBe(true);
  });
});

describe("wrapper unwrapping", () => {
  it("powershell -c and -Command payloads become the taped command", () => {
    expect(unwrapShellCommand('powershell.exe -NoProfile -c "node --test src/math.test.ts"')).toBe(
      "node --test src/math.test.ts",
    );
    expect(unwrapShellCommand('powershell.exe -Command "npm -v"')).toBe("npm -v");
    expect(unwrapShellCommand('cmd.exe /c npm install')).toBe("npm install");
  });

  it("unwrapped payloads get the infrastructure filter again", () => {
    const wrapper =
      'powershell.exe -NoProfile -c "Get-Content \'C:\\Temp\\cursor-hook-payload-1.json\' | & \'goal-guardian-hook.exe\'"';
    expect(isReportableProcess("powershell.exe", unwrapShellCommand(wrapper))).toBe(false);
  });

  it("plain commands pass through untouched", () => {
    expect(unwrapShellCommand("node --test src/math.test.ts")).toBe("node --test src/math.test.ts");
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
