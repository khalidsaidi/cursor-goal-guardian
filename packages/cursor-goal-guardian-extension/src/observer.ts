import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import { readAuditTail, runPipeline, type AuditRecord, type DriftActionType, type HookEventName } from "@goal-guardian/core";

/**
 * In-process recorder for platforms where Cursor's hook runtime cannot reach
 * the workspace (native Windows runs hooks in a sandbox that mis-attributes
 * the workspace and blocks its filesystem). The professional pattern — the
 * one OpenAI's extension uses for everything — is to observe from your own
 * extension process instead of depending on the host's hook plumbing. This
 * observer runs the exact same core pipeline the hook binary runs, so the
 * tape, drift scoring, episodes, and advisories are identical; only the
 * in-conversation nudge is undeliverable from here (the panel and status bar
 * carry the findings instead).
 */

const EDIT_DEBOUNCE_MS = 1_500;
const HOOK_LIVENESS_WINDOW_MS = 5 * 60_000;
const LIVENESS_CACHE_MS = 30_000;
const IGNORED_SEGMENTS = new Set([".git", "node_modules", "dist", "out", "build", "coverage", ".next", ".cache"]);

/** Native Windows desktop only — everywhere else Cursor's hooks work and are the richer channel. */
export function shouldObserve(platform: NodeJS.Platform, remoteName: string | undefined): boolean {
  return platform === "win32" && remoteName === undefined;
}

/** Skip derived artifacts, VCS internals, and the guardian's own telemetry writes. */
export function isIgnoredRelPath(rel: string): boolean {
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return true;
  const posix = rel.split(path.sep).join("/");
  if (posix.startsWith(".cursor/goal-guardian/")) return true;
  return posix.split("/").some((segment) => IGNORED_SEGMENTS.has(segment));
}

/** True when Cursor's own hook runtime has taped recently — then it owns recording. */
export function hooksRecentlyAlive(records: AuditRecord[], nowMs: number): boolean {
  return records.some(
    (r) => r.kind === "hook.event" && r.source === undefined && nowMs - Date.parse(r.ts) < HOOK_LIVENESS_WINDOW_MS,
  );
}

interface ShellExecutionStartEvent {
  execution?: { commandLine?: { value?: string } };
}

export class Observer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private livenessCheckedAt = 0;
  private livenessResult = false;
  private started = false;

  constructor(private readonly root: string | null) {}

  start(): void {
    if (this.started || !this.root) return;
    if (!shouldObserve(process.platform, vscode.env.remoteName)) return;
    if (!fs.existsSync(path.join(this.root, ".cursor", "goal-guardian"))) return;
    this.started = true;

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, "**/*"));
    this.disposables.push(watcher);
    const onFile = (uri: vscode.Uri): void => this.queueEdit(uri.fsPath);
    this.disposables.push(watcher.onDidChange(onFile), watcher.onDidCreate(onFile));

    // Terminal commands, when the editor exposes shell integration events.
    const win = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (listener: (e: ShellExecutionStartEvent) => void) => vscode.Disposable;
    };
    if (typeof win.onDidStartTerminalShellExecution === "function") {
      this.disposables.push(
        win.onDidStartTerminalShellExecution((e) => {
          const command = e.execution?.commandLine?.value ?? "";
          if (command.trim()) void this.record("beforeShellExecution", "shell", command);
        }),
      );
    }
  }

  private queueEdit(file: string): void {
    if (!this.root) return;
    const rel = path.relative(this.root, file);
    if (isIgnoredRelPath(rel)) return;
    const posix = rel.split(path.sep).join("/");
    const pending = this.timers.get(posix);
    if (pending) clearTimeout(pending);
    this.timers.set(
      posix,
      setTimeout(() => {
        this.timers.delete(posix);
        void this.record("afterFileEdit", "edit", posix);
      }, EDIT_DEBOUNCE_MS),
    );
  }

  private async record(event: HookEventName, actionType: DriftActionType, actionValue: string): Promise<void> {
    if (!this.root) return;
    try {
      if (await this.hooksAlive()) return;
      // Same pipeline as the hook binary; the returned message is dropped —
      // the panel and status bar surface findings on this platform.
      await runPipeline(this.root, event, actionType, actionValue, { source: "observer" });
    } catch {
      // The recorder must never disturb the editor.
    }
  }

  private async hooksAlive(): Promise<boolean> {
    const now = Date.now();
    if (now - this.livenessCheckedAt < LIVENESS_CACHE_MS) return this.livenessResult;
    this.livenessCheckedAt = now;
    try {
      this.livenessResult = hooksRecentlyAlive(await readAuditTail(this.root ?? ""), now);
    } catch {
      this.livenessResult = false;
    }
    return this.livenessResult;
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
