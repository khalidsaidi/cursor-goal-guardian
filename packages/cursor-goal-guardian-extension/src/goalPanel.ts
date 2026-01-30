import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  loadState,
  loadActions,
  reduceAction,
  getStatePaths,
  defaultState,
  type AgentState,
  type AgentAction,
} from "./stateStore.js";

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

type SnapshotDoc = {
  lastActionIndex: number;
  state: AgentState;
};

type StateDiff = {
  action: AgentAction;
  before: AgentState;
  after: AgentState;
};

type DiffRow = {
  label: string;
  before: string;
  after: string;
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
        case "dispatchAction":
          vscode.commands.executeCommand("goalGuardian.dispatchAction");
          break;
        case "openState":
          vscode.commands.executeCommand("goalGuardian.openState");
          break;
        case "openActions":
          vscode.commands.executeCommand("goalGuardian.openActions");
          break;
        case "openReducer":
          vscode.commands.executeCommand("goalGuardian.openReducer");
          break;
        case "openRules":
          vscode.commands.executeCommand("goalGuardian.openRules");
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
    const state = await this._loadState(workspaceRoot);
    const lastReduxAction = await this._loadLastReduxAction(workspaceRoot);
    const recentReduxActions = await this._loadRecentReduxActions(workspaceRoot, 12);
    const timelineActions = await this._loadRecentReduxActions(workspaceRoot, 30);
    const stateDiff = await this._loadStateDiff(workspaceRoot);
    const mcpStatus = await this._loadMcpStatus(workspaceRoot);

    this._view.webview.html = this._getHtml(
      this._view.webview,
      contract,
      permits,
      violations,
      lastAction,
      state,
      lastReduxAction,
      recentReduxActions,
      timelineActions,
      stateDiff,
      mcpStatus
    );
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

  private async _loadState(workspaceRoot: string): Promise<AgentState | null> {
    try {
      const state = await loadState(workspaceRoot);
      return state;
    } catch {
      return null;
    }
  }

  private async _loadMcpStatus(workspaceRoot: string): Promise<{ mcpConfigured: boolean; hooksUseMcp: boolean }> {
    const hooksPath = path.join(workspaceRoot, ".cursor", "hooks.json");
    const mcpPath = path.join(workspaceRoot, ".cursor", "mcp.json");
    let mcpConfigured = false;
    let hooksUseMcp = false;

    try {
      const raw = await fs.readFile(mcpPath, "utf8");
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      mcpConfigured = Boolean(parsed?.mcpServers && (parsed.mcpServers as any)["goal-guardian"]);
    } catch {
      mcpConfigured = false;
    }

    try {
      const raw = await fs.readFile(hooksPath, "utf8");
      const parsed = JSON.parse(raw) as { hooks?: Record<string, Array<{ command?: string }>> };
      const hooks = parsed.hooks ?? {};
      const commands = Object.values(hooks)
        .flat()
        .map((h) => h?.command ?? "");
      hooksUseMcp = commands.some((cmd) => cmd.includes("goal-guardian-hook") && cmd.includes("--mcp"));
    } catch {
      hooksUseMcp = false;
    }

    return { mcpConfigured, hooksUseMcp };
  }

  private async _loadLastReduxAction(workspaceRoot: string): Promise<AgentAction | null> {
    try {
      const actions = await loadActions(workspaceRoot);
      return actions.length > 0 ? actions[actions.length - 1]! : null;
    } catch {
      return null;
    }
  }

  private async _loadRecentReduxActions(workspaceRoot: string, limit: number): Promise<AgentAction[]> {
    try {
      const actions = await loadActions(workspaceRoot);
      return actions.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  private async _loadStateDiff(workspaceRoot: string): Promise<StateDiff | null> {
    try {
      const actions = await loadActions(workspaceRoot);
      if (actions.length === 0) return null;

      const paths = getStatePaths(workspaceRoot);
      let baseState: AgentState | null = null;
      let startIndex = 0;

      try {
        const raw = await fs.readFile(paths.snapshot, "utf8");
        const snapshot = JSON.parse(raw) as SnapshotDoc;
        if (snapshot && snapshot.state && Number.isFinite(snapshot.lastActionIndex)) {
          baseState = snapshot.state;
          startIndex = snapshot.lastActionIndex + 1;
        }
      } catch {
        // no snapshot
      }

      if (!baseState) {
        baseState = await this._seedStateFromContract(workspaceRoot);
      }

      let current = baseState;
      let before: AgentState | null = null;
      let action = actions[actions.length - 1]!;

      for (let i = startIndex; i < actions.length; i++) {
        const next = await reduceAction(workspaceRoot, current, actions[i]!);
        if (i === actions.length - 1) {
          before = current;
          action = actions[i]!;
          current = next;
          break;
        }
        current = next;
      }

      if (!before) return null;
      return { action, before, after: current };
    } catch {
      return null;
    }
  }

  private async _seedStateFromContract(workspaceRoot: string): Promise<AgentState> {
    try {
      const contractPath = path.join(workspaceRoot, ".cursor", "goal-guardian", "contract.json");
      const raw = await fs.readFile(contractPath, "utf8");
      const contract = JSON.parse(raw) as { goal?: string; success_criteria?: string[]; constraints?: string[] };
      const base = defaultState();
      base.goal = contract.goal ?? "";
      base.definition_of_done = contract.success_criteria ?? [];
      base.constraints = contract.constraints ?? [];
      base._meta.lastUpdated = new Date().toISOString();
      base._meta.hash = "";
      return base;
    } catch {
      return defaultState();
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
    webview: vscode.Webview,
    contract: GoalContract | null,
    permits: Permit[],
    violations: ViolationTracker | null,
    lastAction: AuditEntry | null,
    state: AgentState | null,
    lastReduxAction: AgentAction | null,
    recentReduxActions: AgentAction[],
    timelineActions: AgentAction[],
    stateDiff: StateDiff | null,
    mcpStatus: { mcpConfigured: boolean; hooksUseMcp: boolean }
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

    const effectiveGoal = contract?.goal?.trim().length ? contract.goal : state?.goal ?? "";
    const hasEffectiveGoal = effectiveGoal.trim().length > 0;
    const constraints = state?.constraints?.length ? state.constraints : contract?.constraints ?? [];
    const definitionOfDone = state?.definition_of_done?.length
      ? state.definition_of_done
      : contract?.success_criteria ?? [];

    const tasks = state?.tasks ?? [];
    const todoTasks = tasks.filter((t) => t.status === "todo");
    const doingTasks = tasks.filter((t) => t.status === "doing");
    const doneTasks = tasks.filter((t) => t.status === "done");
    const activeTask = state?.active_task ? tasks.find((t) => t.id === state.active_task) : null;

    const stateLastUpdated = state?._meta?.lastUpdated ?? "";
    const stateAge = this._formatAgo(stateLastUpdated);

    const toolkitUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "vscode-webview-ui-toolkit.js")
    );
    const nonce = this._getNonce();

    const renderTaskColumn = (title: string, items: typeof tasks) => `
      <div class="task-col">
        <div class="task-col-header">
          <span>${title}</span>
          <vscode-badge>${items.length}</vscode-badge>
        </div>
        ${items.length === 0 ? `<div class="empty">No tasks</div>` : ""}
        ${items
          .map(
            (t) => `
            <div class="task-item">
              <div class="task-title">${this._escapeHtml(t.title)}</div>
              <div class="task-id">${this._escapeHtml(t.id)}</div>
            </div>
          `
          )
          .join("")}
      </div>
    `;

    const renderTags = (items: string[], fallback: string) => {
      if (!items.length) return `<div class="empty">${fallback}</div>`;
      return items
        .map((item) => `<span class="chip">${this._escapeHtml(item)}</span>`)
        .join("");
    };

    const renderTimelineList = (items: AgentAction[]) => {
      if (!items.length) return `<div class="empty">No actions yet</div>`;
      return items
        .map((a) => {
          const ts = this._escapeHtml(a.ts);
          const type = this._escapeHtml(a.type);
          return `
            <div class="timeline-item">
              <div class="timeline-dot"></div>
              <div class="timeline-body">
                <div class="timeline-title">${type}</div>
                <div class="timeline-meta">${ts}</div>
              </div>
            </div>
          `;
        })
        .join("");
    };

    const renderTimelineGraph = (items: AgentAction[]) => {
      if (!items.length) return `<div class="empty">No timeline data</div>`;
      const maxPoints = 30;
      const list = items.slice(0, maxPoints).slice().reverse(); // oldest -> newest
      const width = 900;
      const height = 140;
      const padding = 32;
      const times = list.map((a) => Date.parse(a.ts));
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const span = Math.max(maxTime - minTime, 1);
      const points = list.map((a, idx) => {
        const t = Date.parse(a.ts);
        const x = padding + ((t - minTime) / span) * (width - padding * 2);
        const y = padding + (idx % 4) * 18;
        return { x, y, action: a };
      });

      const colorFor = (type: string) => {
        switch (type) {
          case "SET_GOAL": return "#38bdf8";
          case "ADD_TASKS": return "#22d3ee";
          case "START_TASK": return "#34d399";
          case "COMPLETE_TASK": return "#a3e635";
          case "OPEN_QUESTION": return "#fbbf24";
          case "CLOSE_QUESTION": return "#f59e0b";
          case "ADD_DECISION": return "#f472b6";
          case "PIN_CONTEXT": return "#c084fc";
          case "UNPIN_CONTEXT": return "#94a3b8";
          default: return "#38bdf8";
        }
      };

      const path = points
        .map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
        .join(" ");

      const dots = points
        .map((p) => `
          <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="${colorFor(p.action.type)}">
            <title>${this._escapeHtml(p.action.type)} • ${this._escapeHtml(p.action.ts)}</title>
          </circle>
        `)
        .join("");

      return `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="timeline-graph">
          <defs>
            <linearGradient id="ggLine" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#38bdf8" />
              <stop offset="100%" stop-color="#22d3ee" />
            </linearGradient>
          </defs>
          <path d="${path}" fill="none" stroke="url(#ggLine)" stroke-width="2" opacity="0.9"/>
          ${dots}
          <line x1="${padding}" y1="${height - 24}" x2="${width - padding}" y2="${height - 24}" stroke="rgba(148,163,184,0.3)" />
        </svg>
      `;
    };

    const renderDiffRows = (diff: StateDiff | null) => {
      if (!diff) return `<div class="empty">No diff available yet</div>`;
      const rows = this._buildDiffRows(diff.before, diff.after);
      if (!rows.length) return `<div class="empty">No meaningful changes detected</div>`;
      return rows
        .map(
          (row) => `
            <div class="diff-row">
              <div class="diff-label">${this._escapeHtml(row.label)}</div>
              <div class="diff-values">
                <span class="diff-before">${this._escapeHtml(row.before)}</span>
                <span class="diff-arrow">→</span>
                <span class="diff-after">${this._escapeHtml(row.after)}</span>
              </div>
            </div>
          `
        )
        .join("");
    };

    const renderPermits = () => {
      if (permits.length === 0) return `<div class="empty">No active permits</div>`;
      return permits
        .map(
          (p) => `
            <div class="permit-card">
              <div class="permit-header">
                <span class="permit-token">${p.token.substring(0, 16)}...</span>
                <span class="permit-expires">${this._formatTime(p.expires_at)}</span>
              </div>
              <div class="permit-patterns">
                ${p.allow.shell.length > 0 ? `Shell: ${p.allow.shell.length}` : ""}
                ${p.allow.mcp.length > 0 ? ` | MCP: ${p.allow.mcp.length}` : ""}
                ${p.allow.read.length > 0 ? ` | Read: ${p.allow.read.length}` : ""}
                ${p.allow.write.length > 0 ? ` | Write: ${p.allow.write.length}` : ""}
              </div>
            </div>
          `
        )
        .join("");
    };

    const renderWarnings = () => {
      if (warningEntries.length === 0) return `<div class="empty">No warnings</div>`;
      return warningEntries
        .map(
          ([pattern, count]) => `
            <div class="warning-row">
              <div class="warning-pattern" title="${this._escapeHtml(pattern)}">${this._escapeHtml(pattern)}</div>
              <vscode-badge>${count}/3</vscode-badge>
            </div>
          `
        )
        .join("");
    };

    const renderCriteria = () => {
      if (!contract?.success_criteria?.length) return `<div class="empty">No success criteria yet</div>`;
      return contract.success_criteria
        .map(
          (c, i) => `
            <div class="criteria-row">
              <span class="criteria-id">SC${i + 1}</span>
              <span>${this._escapeHtml(c)}</span>
            </div>
          `
        )
        .join("");
    };

    const bannerSubtitle = hasEffectiveGoal ? "Anti‑drift state engine" : "Define a goal to begin";
    const mcpLabel = mcpStatus.mcpConfigured && mcpStatus.hooksUseMcp ? "MCP‑controlled" : "MCP not wired";

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';" />
        <script nonce="${nonce}" type="module" src="${toolkitUri}"></script>
        <style>
          :root {
            --gg-accent: #5cc8ff;
            --gg-accent-strong: #8be7f6;
            --gg-card: var(--vscode-editorWidget-background);
            --gg-border: rgba(148, 163, 184, 0.18);
            --gg-muted: var(--vscode-descriptionForeground);
          }

          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            margin: 0;
            padding: 16px;
            color: var(--vscode-foreground);
            background:
              linear-gradient(180deg, rgba(92, 200, 255, 0.06), rgba(92, 200, 255, 0) 45%),
              var(--vscode-editor-background);
          }

          .hero {
            display: grid;
            grid-template-columns: auto 1fr auto;
            gap: 12px;
            align-items: center;
            padding: 16px 18px;
            border-radius: 16px;
            border: 1px solid var(--gg-border);
            background: rgba(15, 23, 42, 0.2);
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
            margin-bottom: 16px;
          }

          .hero-icon {
            width: 40px;
            height: 40px;
            display: grid;
            place-items: center;
            border-radius: 12px;
            background: rgba(92, 200, 255, 0.12);
            border: 1px solid rgba(92, 200, 255, 0.25);
          }

          .hero-title {
            font-size: 19px;
            font-weight: 600;
          }

          .hero-subtitle {
            color: var(--gg-muted);
            font-size: 12px;
          }

          .status-badges {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            justify-content: flex-end;
          }

          .grid {
            display: grid;
            gap: 14px;
          }

          .card {
            background: var(--gg-card);
            border-radius: 16px;
            border: 1px solid var(--gg-border);
            padding: 16px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
          }

          .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            font-weight: 600;
          }

          .card-title {
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .pill {
            font-size: 11px;
            color: var(--gg-muted);
          }

          .goal-text {
            font-size: 14px;
            line-height: 1.5;
            padding: 12px;
            border-radius: 12px;
            background: rgba(92, 200, 255, 0.08);
            border: 1px solid rgba(92, 200, 255, 0.18);
            margin-bottom: 12px;
          }

          .chip-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }

          .chip {
            padding: 4px 10px;
            border-radius: 999px;
            background: rgba(148, 163, 184, 0.12);
            border: 1px solid rgba(148, 163, 184, 0.18);
            font-size: 11px;
          }

          .empty {
            color: var(--gg-muted);
            font-size: 12px;
          }

          .state-grid {
            display: grid;
            gap: 10px;
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .state-item {
            background: rgba(15, 23, 42, 0.08);
            border-radius: 12px;
            padding: 10px;
            border: 1px solid rgba(148, 163, 184, 0.16);
          }

          .state-item .label {
            font-size: 10px;
            color: var(--gg-muted);
            margin-bottom: 4px;
          }

          .state-item .value {
            font-weight: 600;
            font-size: 12px;
          }

          .tasks-board {
            display: grid;
            gap: 10px;
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }

          .task-col {
            background: rgba(15, 23, 42, 0.12);
            border-radius: 14px;
            padding: 10px;
            border: 1px solid rgba(148, 163, 184, 0.16);
          }

          .task-col-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
            font-size: 12px;
            font-weight: 600;
          }

          .task-item {
            padding: 8px 10px;
            border-radius: 12px;
            background: rgba(30, 41, 59, 0.2);
            border: 1px solid rgba(148, 163, 184, 0.14);
            margin-bottom: 8px;
          }

          .task-title {
            font-size: 12px;
            font-weight: 600;
          }

          .task-id {
            font-size: 10px;
            color: var(--gg-muted);
          }

          .timeline {
            display: grid;
            gap: 10px;
          }

          .timeline-card {
            display: grid;
            gap: 12px;
          }

          .timeline-grid {
            display: grid;
            gap: 12px;
            grid-template-columns: minmax(0, 1fr);
            align-items: start;
          }

          .diff-section {
            padding: 10px 12px;
            border-radius: 12px;
            background: rgba(15, 23, 42, 0.08);
            border: 1px solid rgba(148, 163, 184, 0.14);
          }

          .timeline-item {
            display: flex;
            gap: 10px;
            align-items: flex-start;
          }

          .timeline-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--gg-accent);
            margin-top: 6px;
            box-shadow: 0 0 0 6px rgba(92, 200, 255, 0.12);
          }

          .timeline-title {
            font-size: 12px;
            font-weight: 600;
          }

          .timeline-meta {
            font-size: 10px;
            color: var(--gg-muted);
          }

          .timeline-graph {
            width: 100%;
            height: 140px;
            margin-bottom: 10px;
            border-radius: 14px;
            background: rgba(15, 23, 42, 0.08);
            border: 1px solid rgba(148, 163, 184, 0.14);
          }

          @media (min-width: 980px) {
            .timeline-grid {
              grid-template-columns: minmax(0, 1.3fr) minmax(0, 0.9fr);
            }
          }

          .criteria-row,
          .warning-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            border-bottom: 1px solid rgba(148, 163, 184, 0.12);
            font-size: 12px;
          }

          .criteria-id {
            font-weight: 700;
            color: var(--gg-accent);
            margin-right: 8px;
          }

          .warning-pattern {
            font-family: monospace;
            max-width: 220px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .diff-row {
            padding: 6px 0;
            border-bottom: 1px solid rgba(148, 163, 184, 0.12);
            font-size: 12px;
          }

          .diff-label {
            font-weight: 600;
            margin-bottom: 4px;
          }

          .diff-values {
            display: flex;
            align-items: center;
            gap: 6px;
            color: var(--gg-muted);
            flex-wrap: wrap;
          }

          .diff-before {
            padding: 2px 6px;
            border-radius: 6px;
            background: rgba(148, 163, 184, 0.12);
          }

          .diff-after {
            padding: 2px 6px;
            border-radius: 6px;
            background: rgba(92, 200, 255, 0.16);
            color: var(--vscode-foreground);
          }

          .diff-arrow {
            color: var(--gg-accent);
          }

          .permit-card {
            background: rgba(15, 23, 42, 0.12);
            border-radius: 14px;
            padding: 10px;
            border: 1px solid rgba(148, 163, 184, 0.16);
            margin-bottom: 10px;
          }

          .permit-header {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: var(--gg-muted);
          }

          .permit-token {
            font-family: monospace;
            color: var(--gg-accent);
          }

          .permit-expires {
            color: var(--vscode-charts-yellow);
          }

          .permit-patterns {
            margin-top: 4px;
            font-size: 11px;
          }

          .action-bar {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 18px;
          }

          .action-bar vscode-button {
            flex: 1 1 auto;
          }

          .nav-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 8px;
          }

          @media (max-width: 520px) {
            .hero {
              grid-template-columns: 1fr;
            }
            .status-badges {
              justify-content: flex-start;
            }
            .state-grid {
              grid-template-columns: 1fr;
            }
            .tasks-board {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <section class="hero">
          <div class="hero-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2l7 3v6c0 5-3.5 9-7 11-3.5-2-7-6-7-11V5l7-3z" fill="url(#ggGrad)"/>
              <path d="M7 12l3 3 6-6" stroke="#0f172a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <defs>
                <linearGradient id="ggGrad" x1="0" y1="0" x2="24" y2="24">
                  <stop offset="0%" stop-color="#38bdf8"/>
                  <stop offset="100%" stop-color="#22d3ee"/>
                </linearGradient>
              </defs>
            </svg>
          </div>
          <div>
            <div class="hero-title">Goal Guardian</div>
            <div class="hero-subtitle">${bannerSubtitle}</div>
          </div>
          <div class="status-badges">
            <vscode-badge>${hasEffectiveGoal ? "Goal Set" : "No Goal"}</vscode-badge>
            <vscode-badge>${mcpLabel}</vscode-badge>
            ${permits.length > 0 ? `<vscode-badge>${permits.length} Permit(s)</vscode-badge>` : ""}
            ${totalWarnings > 0 ? `<vscode-badge>${totalWarnings} Warning(s)</vscode-badge>` : ""}
          </div>
        </section>

        <div class="grid">
          <section class="card">
            <div class="card-header">
              <div class="card-title">🎯 Goal & Constraints</div>
              <span class="pill">State updated ${stateAge}</span>
            </div>
            ${
              hasEffectiveGoal
                ? `<div class="goal-text">${this._escapeHtml(effectiveGoal)}</div>`
                : `<div class="goal-text">Set a goal to anchor the agent’s state.</div>`
            }
            <div class="card-title">Definition of Done</div>
            <div class="chip-row">${renderTags(definitionOfDone, "No definition of done yet.")}</div>
            <vscode-divider></vscode-divider>
            <div class="card-title">Constraints</div>
            <div class="chip-row">${renderTags(constraints, "No constraints set.")}</div>
          </section>

          <section class="card">
            <div class="card-header">
              <div class="card-title">🧠 State Snapshot</div>
              <span class="pill">${lastReduxAction ? this._escapeHtml(lastReduxAction.type) : "No actions yet"}</span>
            </div>
            <div class="state-grid">
              <div class="state-item">
                <div class="label">Active Task</div>
                <div class="value">${activeTask ? this._escapeHtml(activeTask.title) : "None"}</div>
              </div>
              <div class="state-item">
                <div class="label">Tasks</div>
                <div class="value">${tasks.length} total · ${doneTasks.length} done</div>
              </div>
              <div class="state-item">
                <div class="label">Open Questions</div>
                <div class="value">${state?.open_questions.filter((q) => q.status === "open").length ?? 0}</div>
              </div>
              <div class="state-item">
                <div class="label">Decisions</div>
                <div class="value">${state?.decisions.length ?? 0}</div>
              </div>
            </div>
            <div class="nav-row">
              <vscode-button appearance="secondary" onclick="openState()">Open state.json</vscode-button>
              <vscode-button appearance="secondary" onclick="openActions()">Open actions.jsonl</vscode-button>
              <vscode-button appearance="secondary" onclick="openRules()">Open rules.json</vscode-button>
              <vscode-button appearance="secondary" onclick="openReducer()">Open reducer.js</vscode-button>
            </div>
          </section>

          <section class="card">
            <div class="card-header">
              <div class="card-title">🧩 Tasks Board</div>
              <span class="pill">Active: ${activeTask ? this._escapeHtml(activeTask.id) : "None"}</span>
            </div>
            <div class="tasks-board">
              ${renderTaskColumn("To Do", todoTasks)}
              ${renderTaskColumn("Doing", doingTasks)}
              ${renderTaskColumn("Done", doneTasks)}
            </div>
          </section>

          <section class="card">
            <div class="card-header">
              <div class="card-title">🧭 Action Timeline</div>
              <span class="pill">${recentReduxActions.length} recent</span>
            </div>
            <div class="timeline-card">
              ${renderTimelineGraph(timelineActions)}
              <div class="timeline-grid">
                <div class="timeline">${renderTimelineList(recentReduxActions)}</div>
                <div class="diff-section">
                  <div class="card-title">Latest Diff</div>
                  ${renderDiffRows(stateDiff)}
                </div>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-header">
              <div class="card-title">✅ Success Criteria</div>
              <span class="pill">${contract?.success_criteria?.length ?? 0} items</span>
            </div>
            ${renderCriteria()}
          </section>

          <section class="card">
            <div class="card-header">
              <div class="card-title">⚠️ Drift Warnings</div>
              <span class="pill">${totalWarnings} active</span>
            </div>
            ${renderWarnings()}
          </section>

          <section class="card">
            <div class="card-header">
              <div class="card-title">🔒 Active Permits</div>
              <span class="pill">${permits.length} active</span>
            </div>
            ${renderPermits()}
          </section>
        </div>

        <div class="action-bar">
          <vscode-button appearance="primary" onclick="openContract()">Edit Contract</vscode-button>
          <vscode-button appearance="secondary" onclick="dispatchAction()">Dispatch Action</vscode-button>
          ${lastAction ? `<vscode-button appearance="secondary" onclick="autoPermit()">Auto-Permit Last Action</vscode-button>` : ""}
          <vscode-button appearance="secondary" onclick="refresh()">Refresh</vscode-button>
        </div>

        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          function openContract() { vscode.postMessage({ command: 'openContract' }); }
          function autoPermit() { vscode.postMessage({ command: 'autoPermit' }); }
          function dispatchAction() { vscode.postMessage({ command: 'dispatchAction' }); }
          function refresh() { vscode.postMessage({ command: 'refresh' }); }
          function openState() { vscode.postMessage({ command: 'openState' }); }
          function openActions() { vscode.postMessage({ command: 'openActions' }); }
          function openReducer() { vscode.postMessage({ command: 'openReducer' }); }
          function openRules() { vscode.postMessage({ command: 'openRules' }); }
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

  private _getNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let value = "";
    for (let i = 0; i < 16; i++) {
      value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
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

  private _formatAgo(isoString?: string | null): string {
    if (!isoString) return "Unknown";
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return "Unknown";
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;
    return `${hours}h ${mins}m ago`;
  }

  private _buildDiffRows(before: AgentState, after: AgentState): DiffRow[] {
    const rows: DiffRow[] = [];

    const pushIfChanged = (label: string, a: string, b: string) => {
      if (a !== b) rows.push({ label, before: a, after: b });
    };

    pushIfChanged("Goal", before.goal ?? "", after.goal ?? "");
    pushIfChanged(
      "Definition of Done",
      (before.definition_of_done ?? []).join(", "),
      (after.definition_of_done ?? []).join(", ")
    );
    pushIfChanged(
      "Constraints",
      (before.constraints ?? []).join(", "),
      (after.constraints ?? []).join(", ")
    );
    pushIfChanged("Active Task", before.active_task ?? "None", after.active_task ?? "None");

    const beforeDone = before.tasks.filter((t) => t.status === "done").length;
    const afterDone = after.tasks.filter((t) => t.status === "done").length;
    pushIfChanged("Tasks Done", String(beforeDone), String(afterDone));

    const beforeOpen = before.open_questions.filter((q) => q.status === "open").length;
    const afterOpen = after.open_questions.filter((q) => q.status === "open").length;
    pushIfChanged("Open Questions", String(beforeOpen), String(afterOpen));

    const beforeDec = before.decisions.length;
    const afterDec = after.decisions.length;
    pushIfChanged("Decisions", String(beforeDec), String(afterDec));

    const beforePins = before.pinned_context.length;
    const afterPins = after.pinned_context.length;
    pushIfChanged("Pinned Context", String(beforePins), String(afterPins));

    const statusChanges = this._diffTaskStatuses(before, after);
    for (const change of statusChanges.slice(0, 4)) {
      rows.push({
        label: `Task ${change.title}`,
        before: change.before,
        after: change.after,
      });
    }

    return rows;
  }

  private _diffTaskStatuses(before: AgentState, after: AgentState): Array<{ id: string; title: string; before: string; after: string }> {
    const rows: Array<{ id: string; title: string; before: string; after: string }> = [];
    const map = new Map<string, { title: string; status: string }>();
    for (const t of before.tasks) map.set(t.id, { title: t.title, status: t.status });
    for (const t of after.tasks) {
      const prev = map.get(t.id);
      if (prev && prev.status !== t.status) {
        rows.push({ id: t.id, title: t.title, before: prev.status, after: t.status });
      }
    }
    return rows;
  }
}
