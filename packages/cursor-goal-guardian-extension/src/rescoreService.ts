import * as vscode from "vscode";
import {
  createCursorAgentJudge,
  readConfigSafe,
  readStateSafe,
  runRescore,
  type DriftJudge,
} from "@goal-guardian/core";

const CONSENT_KEY = "goalGuardian.semanticConsent";

/**
 * Background semantic drift review. Hard rules: never runs without one-time
 * user consent (billed cursor-agent calls), debounced behind editor activity,
 * capped per session, and backs off after repeated failures.
 */
export class RescoreService {
  private debounceTimer: NodeJS.Timeout | null = null;
  private running = false;
  private callsThisSession = 0;
  private consecutiveFailures = 0;
  private availability: boolean | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly root: string | null,
    private readonly judge: DriftJudge = createCursorAgentJudge(),
    private readonly onDidRescore: () => void = () => {},
  ) {}

  isConsented(): boolean {
    return this.context.workspaceState.get<boolean>(CONSENT_KEY, false);
  }

  isAvailable(): boolean {
    return this.availability !== false && this.consecutiveFailures < 3;
  }

  async grantConsent(): Promise<void> {
    await this.context.workspaceState.update(CONSENT_KEY, true);
    this.schedule();
  }

  /** Watch the audit log; each burst of drift activity schedules one debounced pass. */
  start(): void {
    if (!this.root) return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, ".cursor/goal-guardian/telemetry/audit.jsonl"),
    );
    watcher.onDidChange(() => this.schedule());
    watcher.onDidCreate(() => this.schedule());
    this.context.subscriptions.push(watcher);
    this.schedule();
  }

  private schedule(): void {
    if (!this.isConsented()) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.runOnce(), 30_000);
  }

  /** One pass now — the manual command path. Asks once if blanket consent is absent. */
  async rescoreNow(): Promise<void> {
    if (!this.root) return;
    if (!this.isConsented()) {
      const choice = await vscode.window.showInformationMessage(
        "Review flagged drift with AI? This uses your Cursor account (a few small calls). Enabling keeps reviewing in the background for this workspace.",
        "Enable AI review",
        "Just this once",
      );
      if (choice === undefined) return;
      if (choice === "Enable AI review") await this.context.workspaceState.update(CONSENT_KEY, true);
    }
    await this.runOnce(true);
  }

  private async runOnce(manual = false): Promise<void> {
    if (!this.root || this.running) return;
    if (!manual && !this.isConsented()) return;
    if (this.consecutiveFailures >= 3 && !manual) return;

    const config = await readConfigSafe(this.root);
    if (this.callsThisSession >= config.drift.semantic.sessionCallCap) return;

    if (this.availability === null) {
      const availability = await this.judge.isAvailable();
      this.availability = availability.ok;
      if (!availability.ok) return;
    }
    if (this.availability === false && !manual) return;

    this.running = true;
    try {
      const state = await readStateSafe(this.root);
      const result = await runRescore(this.root, state, config, this.judge);
      if (result.calledJudge) {
        this.callsThisSession += 1;
        this.consecutiveFailures = result.recorded > 0 ? 0 : this.consecutiveFailures + (result.judged > 0 ? 1 : 0);
      }
      if (result.recorded > 0) this.onDidRescore();
    } catch {
      this.consecutiveFailures += 1;
    } finally {
      this.running = false;
    }
  }
}
