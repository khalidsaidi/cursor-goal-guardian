import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";

type GoalContract = {
  goal: string;
  success_criteria: string[];
  constraints: string[];
};

type Permit = {
  token: string;
  step_id: string;
  issued_at: string;
  expires_at: string;
  allow: {
    shell: string[];
    mcp: string[];
    read: string[];
    write: string[];
  };
};

type ViolationTracker = {
  warningCounts: Record<string, number>;
  lastReset: string;
};

type AuditEntry = {
  ts?: string;
  event?: string;
  actionType?: "shell" | "mcp" | "read" | "write";
  actionValue?: string;
  suggestedAllow?: string;
};

export class GoalPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "goalGuardian.goalPanel";

  private _view?: vscode.WebviewView;
  private _refreshInterval?: NodeJS.Timeout;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    this._updateContent();

    // Auto-refresh every 5 seconds
    this._refreshInterval = setInterval(() => {
      this._updateContent();
    }, 5000);

    webviewView.onDidDispose(() => {
      if (this._refreshInterval) {
        clearInterval(this._refreshInterval);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "openContract":
          vscode.commands.executeCommand("goalGuardian.openContract");
          break;
        case "refresh":
          this._updateContent();
          break;
        case "requestPermit":
          vscode.commands.executeCommand("goalGuardian.requestPermit");
          break;
        case "autoPermit":
          vscode.commands.executeCommand("goalGuardian.autoPermitLastAction");
          break;
      }
    });
  }

  public refresh() {
    this._updateContent();
  }

  private async _updateContent() {
    if (!this._view) return;

    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      this._view.webview.html = this._getNoWorkspaceHtml();
      return;
    }

    const contract = await this._loadContract(workspaceRoot);
    const permits = await this._loadPermits(workspaceRoot);
    const violations = await this._loadViolations(workspaceRoot);
    const lastAction = await this._loadLastAction(workspaceRoot);

    this._view.webview.html = this._getHtml(contract, permits, violations, lastAction);
  }

  private _getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0]?.uri.fsPath ?? null;
  }

  private async _loadContract(workspaceRoot: string): Promise<GoalContract | null> {
    const contractPath = path.join(workspaceRoot, ".cursor", "goal-guardian", "contract.json");
    try {
      const raw = await fs.readFile(contractPath, "utf8");
      return JSON.parse(raw) as GoalContract;
    } catch {
      return null;
    }
  }

  private async _loadPermits(workspaceRoot: string): Promise<Permit[]> {
    const permitsPath = path.join(workspaceRoot, ".ai", "goal-guardian", "permits.json");
    try {
      const raw = await fs.readFile(permitsPath, "utf8");
      const doc = JSON.parse(raw) as { permits: Permit[] };
      const now = Date.now();
      return (doc.permits ?? []).filter((p) => Date.parse(p.expires_at) > now);
    } catch {
      return [];
    }
  }

  private async _loadViolations(workspaceRoot: string): Promise<ViolationTracker | null> {
    const violationsPath = path.join(workspaceRoot, ".ai", "goal-guardian", "violations.json");
    try {
      const raw = await fs.readFile(violationsPath, "utf8");
      return JSON.parse(raw) as ViolationTracker;
    } catch {
      return null;
    }
  }

  private async _loadLastAction(workspaceRoot: string): Promise<AuditEntry | null> {
    const auditPath = path.join(workspaceRoot, ".ai", "goal-guardian", "audit.log");
    try {
      const raw = await fs.readFile(auditPath, "utf8");
      const lines = raw.trim().split("\n").reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as AuditEntry;
        if (entry.actionType && entry.actionValue) {
          return entry;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private _getNoWorkspaceHtml(): string {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); }
          .message { color: var(--vscode-descriptionForeground); }
        </style>
      </head>
      <body>
        <p class="message">Open a workspace folder to use Goal Guardian.</p>
      </body>
      </html>
    `;
  }

  private _getHtml(
    contract: GoalContract | null,
    permits: Permit[],
    violations: ViolationTracker | null,
    lastAction: AuditEntry | null
  ): string {
    const hasGoal = contract?.goal && contract.goal.trim().length > 0;
    const totalWarnings = violations
      ? Object.values(violations.warningCounts).reduce((sum, c) => sum + c, 0)
      : 0;

    const warningEntries = violations
      ? Object.entries(violations.warningCounts)
          .filter(([_, count]) => count > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
      : [];

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 8px;
            color: var(--vscode-foreground);
          }
          .section {
            margin-bottom: 16px;
          }
          .section-title {
            font-weight: bold;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .section-title .icon {
            font-size: 14px;
          }
          .goal-text {
            background: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
            padding: 8px;
            margin: 4px 0;
            font-style: italic;
          }
          .no-goal {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
          }
          .criteria-list {
            list-style: none;
            padding: 0;
            margin: 4px 0;
          }
          .criteria-item {
            display: flex;
            gap: 8px;
            padding: 4px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
          }
          .criteria-id {
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
            min-width: 32px;
          }
          .permit-card {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px;
            margin: 4px 0;
          }
          .permit-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 4px;
          }
          .permit-token {
            font-family: monospace;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
          }
          .permit-expires {
            font-size: 11px;
            color: var(--vscode-charts-yellow);
          }
          .permit-patterns {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
          }
          .warning-list {
            list-style: none;
            padding: 0;
            margin: 4px 0;
          }
          .warning-item {
            display: flex;
            justify-content: space-between;
            padding: 4px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
          }
          .warning-pattern {
            font-family: monospace;
            color: var(--vscode-charts-orange);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 180px;
          }
          .warning-count {
            font-weight: bold;
            color: var(--vscode-charts-red);
          }
          .btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 12px;
            cursor: pointer;
            border-radius: 2px;
            font-size: 12px;
          }
          .btn:hover {
            background: var(--vscode-button-hoverBackground);
          }
          .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
          }
          .actions {
            display: flex;
            gap: 8px;
            margin-top: 8px;
          }
          .badge {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: bold;
          }
          .badge-success {
            background: var(--vscode-testing-iconPassed);
            color: white;
          }
          .badge-warning {
            background: var(--vscode-charts-orange);
            color: white;
          }
          .badge-info {
            background: var(--vscode-textLink-foreground);
            color: white;
          }
          .status-bar {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
          }
        </style>
      </head>
      <body>
        <div class="status-bar">
          ${hasGoal ? '<span class="badge badge-success">Goal Set</span>' : '<span class="badge badge-warning">No Goal</span>'}
          ${permits.length > 0 ? `<span class="badge badge-info">${permits.length} Permit(s)</span>` : ""}
          ${totalWarnings > 0 ? `<span class="badge badge-warning">${totalWarnings} Warning(s)</span>` : ""}
        </div>

        <div class="section">
          <div class="section-title">
            <span class="icon">&#127919;</span>
            Current Goal
          </div>
          ${
            hasGoal
              ? `<div class="goal-text">${this._escapeHtml(contract!.goal)}</div>`
              : '<div class="no-goal">No goal set. Click "Edit Contract" to define a goal.</div>'
          }
        </div>

        ${
          contract?.success_criteria && contract.success_criteria.length > 0
            ? `
        <div class="section">
          <div class="section-title">
            <span class="icon">&#9989;</span>
            Success Criteria
          </div>
          <ul class="criteria-list">
            ${contract.success_criteria
              .map(
                (c, i) => `
              <li class="criteria-item">
                <span class="criteria-id">SC${i + 1}</span>
                <span>${this._escapeHtml(c)}</span>
              </li>
            `
              )
              .join("")}
          </ul>
        </div>
        `
            : ""
        }

        ${
          permits.length > 0
            ? `
        <div class="section">
          <div class="section-title">
            <span class="icon">&#128274;</span>
            Active Permits
          </div>
          ${permits
            .map(
              (p) => `
            <div class="permit-card">
              <div class="permit-header">
                <span class="permit-token">${p.token.substring(0, 16)}...</span>
                <span class="permit-expires">Expires: ${this._formatTime(p.expires_at)}</span>
              </div>
              <div class="permit-patterns">
                ${p.allow.shell.length > 0 ? `Shell: ${p.allow.shell.length} patterns` : ""}
                ${p.allow.mcp.length > 0 ? ` | MCP: ${p.allow.mcp.length} patterns` : ""}
                ${p.allow.read.length > 0 ? ` | Read: ${p.allow.read.length} patterns` : ""}
                ${p.allow.write.length > 0 ? ` | Write: ${p.allow.write.length} patterns` : ""}
              </div>
            </div>
          `
            )
            .join("")}
        </div>
        `
            : ""
        }

        ${
          warningEntries.length > 0
            ? `
        <div class="section">
          <div class="section-title">
            <span class="icon">&#9888;</span>
            Recent Warnings
          </div>
          <ul class="warning-list">
            ${warningEntries
              .map(
                ([pattern, count]) => `
              <li class="warning-item">
                <span class="warning-pattern" title="${this._escapeHtml(pattern)}">${this._escapeHtml(pattern)}</span>
                <span class="warning-count">${count}/3</span>
              </li>
            `
              )
              .join("")}
          </ul>
        </div>
        `
            : ""
        }

        <div class="actions">
          <button class="btn" onclick="openContract()">Edit Contract</button>
          ${
            lastAction
              ? `<button class="btn btn-secondary" onclick="autoPermit()">Auto‑Permit Last Action</button>`
              : ""
          }
          <button class="btn btn-secondary" onclick="refresh()">Refresh</button>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          function openContract() {
            vscode.postMessage({ command: 'openContract' });
          }
          function autoPermit() {
            vscode.postMessage({ command: 'autoPermit' });
          }
          function refresh() {
            vscode.postMessage({ command: 'refresh' });
          }
        </script>
      </body>
      </html>
    `;
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  private _formatTime(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / 60000);

    if (diffMins < 0) return "Expired";
    if (diffMins < 60) return `${diffMins}m`;
    return `${Math.round(diffMins / 60)}h ${diffMins % 60}m`;
  }
}
