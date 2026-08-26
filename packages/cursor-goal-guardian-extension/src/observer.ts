import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
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
const LEASE_HEARTBEAT_MS = 10_000;
const LEASE_STALE_MS = 30_000;
const LEASE_RETRY_MS = 20_000;
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

/** Editor plumbing and our own binaries never belong on the tape. */
const INFRASTRUCTURE_IMAGES = new Set([
  "conhost.exe",
  "cursor.exe",
  "crashpad_handler.exe",
  "winpty-agent.exe",
  "goal-guardian-hook.exe",
  "goal-guardian-mcp.exe",
]);

/** Substrings that mark a command line as the editor's own machinery, not the
 * user's or agent's work: our binaries and watcher, Cursor's hook-runtime
 * wrapper (it pipes a temp payload file into the hook), and anything run out
 * of the editor's install tree (tsserver, typings installer, helpers). */
const INFRASTRUCTURE_CMD_MARKERS = [
  "goal-guardian-hook",
  "goal-guardian-mcp",
  "gg-process-watch",
  "cursor-hook-payload",
  "\\resources\\app\\",
  "/resources/app/",
  "appdata\\local\\programs\\cursor\\",
  // Tool-runner temp-script wrappers are opaque; their child processes carry
  // the real commands and are taped in their own right.
  "-noninteractive -file c:\\users\\",
];

/** Filter for OS-level process events: keep real commands, drop plumbing. */
export function isReportableProcess(name: string, cmd: string): boolean {
  if (!cmd.trim()) return false;
  if (INFRASTRUCTURE_IMAGES.has(name.toLowerCase())) return false;
  const lower = cmd.toLowerCase();
  return !INFRASTRUCTURE_CMD_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * A shell wrapper's inner command is the story; the wrapper is noise. Pulls
 * the payload out of `powershell ... -c "<cmd>"` / `-Command "<cmd>"` (and
 * cmd.exe /c) so the tape reads like work, not plumbing.
 */
export function unwrapShellCommand(cmd: string): string {
  const ps = /(?:-c(?:ommand)?)\s+"([\s\S]+)"\s*$/i.exec(cmd);
  if (ps?.[1]) return ps[1].replace(/\\"/g, '"').trim();
  const cmdExe = /cmd(?:\.exe)?"?\s+\/[cs]\s+(.+)$/i.exec(cmd);
  if (cmdExe?.[1]) return cmdExe[1].trim();
  return cmd;
}

/** Escaping and quoting differ between channels; compare the letters only. */
function shellFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Two channels can see the same command (terminal shell integration, which is
 * richer but bypassable, and OS process creation, which nothing bypasses).
 * A command whose normalized text contains — or is contained by — something
 * taped in the last minute is the same execution, not a new one.
 */
export function isDuplicateShell(recent: Array<{ value: string; ts: number }>, value: string, nowMs: number): boolean {
  const norm = shellFingerprint(value);
  if (!norm) return true;
  return recent.some((r) => {
    if (nowMs - r.ts >= 60_000) return false;
    const seen = shellFingerprint(r.value);
    return seen.includes(norm) || norm.includes(seen);
  });
}

/**
 * PowerShell one-liner sentinel: gg-process-watch. Subscribes to Windows'
 * own process-creation events (WMI), walks each new process's ancestry, and
 * prints one JSON line per process born inside the editor's process tree.
 * Push-based — no polling loop on our side, nothing an agent tool-runner can
 * bypass, scoped strictly to the editor's own descendants.
 */
export function processWatchScript(): string {
  return [
    "# gg-process-watch",
    "$ErrorActionPreference='SilentlyContinue'",
    "$ext=[int]$env:GG_EXT_PID",
    "$root=$ext",
    "for($i=0;$i -lt 6;$i++){",
    "  $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$root\"",
    "  if(-not $p){break}",
    "  $par=Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\"",
    "  if($par -and $par.Name -match 'Cursor'){$root=$par.ProcessId}else{break}",
    "}",
    "Register-CimIndicationEvent -Query \"SELECT * FROM __InstanceCreationEvent WITHIN 2 WHERE TargetInstance ISA 'Win32_Process'\" -SourceIdentifier gg | Out-Null",
    "while($true){",
    "  $e=Wait-Event -SourceIdentifier gg",
    "  if(-not $e){continue}",
    "  Remove-Event -EventIdentifier $e.EventIdentifier",
    "  $t=$e.SourceEventArgs.NewEvent.TargetInstance",
    "  $pp=$t.ParentProcessId;$hit=$false",
    "  for($d=0;$d -lt 8 -and $pp;$d++){",
    "    if($pp -eq $root){$hit=$true;break}",
    "    $q=Get-CimInstance Win32_Process -Filter \"ProcessId=$pp\"",
    "    if(-not $q){break}",
    "    $pp=$q.ParentProcessId",
    "  }",
    "  if($hit){@{name=$t.Name;cmd=[string]$t.CommandLine} | ConvertTo-Json -Compress}",
    "}",
  ].join("\n");
}

interface ShellExecutionStartEvent {
  execution?: { commandLine?: { value?: string } };
}

export class Observer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recentShell: Array<{ value: string; ts: number }> = [];
  private watcherProc: ChildProcess | null = null;
  private livenessCheckedAt = 0;
  private livenessResult = false;
  private started = false;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly root: string | null) {}

  private leasePath(): string {
    return path.join(this.root ?? "", ".cursor", "goal-guardian", "telemetry", "observer.lock");
  }

  /** True when this instance holds (or just took) the single-recorder lease. */
  private acquireLease(): boolean {
    const lease = this.leasePath();
    try {
      const stat = fs.statSync(lease);
      const holder = fs.readFileSync(lease, "utf8").trim();
      if (holder === String(process.pid)) return true;
      if (Date.now() - stat.mtimeMs < LEASE_STALE_MS) return false; // live holder elsewhere
      fs.rmSync(lease, { force: true }); // stale holder — clear the seat
    } catch {
      /* no lease yet */
    }
    try {
      fs.mkdirSync(path.dirname(lease), { recursive: true });
      // Exclusive create is the election: both extension hosts start at the
      // same instant after a reload, and check-then-write is a race.
      fs.writeFileSync(lease, String(process.pid), { flag: "wx" });
    } catch {
      return false; // another host won the seat first
    }
    try {
      return fs.readFileSync(lease, "utf8").trim() === String(process.pid);
    } catch {
      return false;
    }
  }

  private touchLease(): void {
    try {
      const now = new Date();
      fs.utimesSync(this.leasePath(), now, now);
    } catch {
      /* workspace removed — dispose will clean up */
    }
  }

  start(): void {
    if (!this.root) return;
    if (!shouldObserve(process.platform, vscode.env.remoteName)) return;
    if (!fs.existsSync(path.join(this.root, ".cursor", "goal-guardian"))) return;

    // Cursor runs more than one extension host per workspace (the Agents
    // Window has its own), so more than one Observer can exist. Exactly one
    // may record — elected by a heartbeat lease; the others retry and take
    // over when the holder's window closes.
    if (!this.acquireLease()) {
      this.leaseTimer ??= setInterval(() => this.start(), LEASE_RETRY_MS);
      return;
    }
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    if (this.started) return;
    this.started = true;
    this.heartbeatTimer = setInterval(() => this.touchLease(), LEASE_HEARTBEAT_MS);

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, "**/*"));
    this.disposables.push(watcher);
    const onFile = (uri: vscode.Uri): void => this.queueEdit(uri.fsPath);
    this.disposables.push(watcher.onDidChange(onFile), watcher.onDidCreate(onFile));

    // Terminal commands, when the editor exposes shell integration events
    // (richer: the exact typed command line, before execution).
    const win = vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (listener: (e: ShellExecutionStartEvent) => void) => vscode.Disposable;
    };
    if (typeof win.onDidStartTerminalShellExecution === "function") {
      this.disposables.push(
        win.onDidStartTerminalShellExecution((e) => {
          const command = e.execution?.commandLine?.value ?? "";
          if (command.trim()) this.recordShell(command);
        }),
      );
    }

    // OS-level backstop: agent tool-runners can bypass integrated terminals,
    // but nothing launches a process without the OS seeing it.
    this.startProcessWatcher();
  }

  private startProcessWatcher(): void {
    try {
      this.watcherProc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", processWatchScript()], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GG_EXT_PID: String(process.pid) },
      });
      const out = this.watcherProc.stdout;
      if (!out) return;
      readline.createInterface({ input: out }).on("line", (line) => {
        try {
          const p = JSON.parse(line) as { name?: string; cmd?: string };
          const name = p.name ?? "";
          const cmd = (p.cmd ?? "").trim();
          if (!isReportableProcess(name, cmd)) return;
          // The wrapper's payload is the story; filter it again once bare.
          const inner = unwrapShellCommand(cmd);
          if (isReportableProcess(name, inner)) this.recordShell(inner);
        } catch {
          /* non-JSON chatter from the shell — ignore */
        }
      });
      this.watcherProc.on("error", () => {
        this.watcherProc = null;
      });
    } catch {
      // The recorder must never disturb the editor; the terminal channel
      // still stands.
    }
  }

  /** Both shell channels funnel here; one execution is taped exactly once. */
  private recordShell(command: string): void {
    const now = Date.now();
    while (this.recentShell.length > 0 && now - this.recentShell[0]!.ts > 60_000) this.recentShell.shift();
    if (isDuplicateShell(this.recentShell, command, now)) return;
    this.recentShell.push({ value: command.trim(), ts: now });
    if (this.recentShell.length > 16) this.recentShell.shift();
    void this.record("beforeShellExecution", "shell", command);
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
    this.watcherProc?.kill();
    this.watcherProc = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      if (this.started && fs.readFileSync(this.leasePath(), "utf8").trim() === String(process.pid)) {
        fs.rmSync(this.leasePath(), { force: true });
      }
    } catch {
      /* nothing to release */
    }
  }
}
