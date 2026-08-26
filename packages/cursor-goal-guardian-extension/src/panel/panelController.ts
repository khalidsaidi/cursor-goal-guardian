import * as vscode from "vscode";
import crypto from "node:crypto";
import {
  buildPanelViewModel,
  detectWorkspaceFormat,
  loadActions,
  readAuditTail,
  readStateReport,
  readStateSafe,
  type PanelViewModel,
} from "@goal-guardian/core";

export interface PanelDelegate {
  isSemanticConsented(): boolean;
  isSemanticAvailable(): boolean;
  isCommandCenterUsed(): boolean;
  isTourDismissed(): boolean;
  onCommand(command: string): Promise<void>;
  onStartTask(taskId: string): Promise<void>;
  onRescoreOne(driftId: string): Promise<void>;
}

export class PanelController implements vscode.WebviewViewProvider {
  static readonly viewType = "goalGuardian.goalPanel";

  private view: vscode.WebviewView | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private lastVmJson = "";
  private readonly updateEmitter = new vscode.EventEmitter<PanelViewModel>();
  readonly onDidUpdate = this.updateEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly root: string | null,
    private readonly delegate: PanelDelegate,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.shell(view.webview);
    this.context.subscriptions.push(
      view.webview.onDidReceiveMessage(async (message: { type: string; command?: string; taskId?: string; driftId?: string }) => {
        if (message.type === "ready") await this.refresh();
        else if (message.type === "command" && message.command) await this.delegate.onCommand(message.command);
        else if (message.type === "startTask" && message.taskId) await this.delegate.onStartTask(message.taskId);
        else if (message.type === "rescoreOne" && message.driftId) await this.delegate.onRescoreOne(message.driftId);
      }),
      view.onDidDispose(() => {
        this.view = null;
      }),
    );
  }

  /** Start reacting to workspace file changes; called only once guardian files exist. */
  startWatching(): void {
    if (!this.root || this.watcher) return;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, ".cursor/goal-guardian/**"),
    );
    const kick = (): void => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.refresh(), 300);
    };
    this.watcher.onDidChange(kick);
    this.watcher.onDidCreate(kick);
    this.watcher.onDidDelete(kick);
    this.context.subscriptions.push(this.watcher);
  }

  async refresh(): Promise<void> {
    const vm = await this.buildVm();
    const json = JSON.stringify(vm);
    if (json !== this.lastVmJson) {
      this.lastVmJson = json;
      this.view?.webview.postMessage({ type: "vm", vm });
      if (this.view) this.view.badge = vm.badge > 0 ? { value: vm.badge, tooltip: `${vm.badge} confirmed drift(s) in the last 24h` } : undefined;
      this.updateEmitter.fire(vm);
    } else if (this.view) {
      // A freshly-resolved webview needs the current model even if unchanged.
      this.view.webview.postMessage({ type: "vm", vm });
    }
  }

  private async buildVm(): Promise<PanelViewModel> {
    const empty: Parameters<typeof buildPanelViewModel>[0] = {
      setUp: false,
      state: await readStateSafe(this.root ?? "/nonexistent"),
      records: [],
      actions: [],
      now: new Date(),
      semanticConsented: this.delegate.isSemanticConsented(),
      semanticAvailable: this.delegate.isSemanticAvailable(),
      commandCenterUsed: this.delegate.isCommandCenterUsed(),
      tourDismissed: this.delegate.isTourDismissed(),
    };
    if (!this.root) return buildPanelViewModel(empty);
    const format = await detectWorkspaceFormat(this.root);
    if (format !== "v2") return buildPanelViewModel(empty);
    const report = await readStateReport(this.root);
    return buildPanelViewModel({
      ...empty,
      setUp: true,
      state: report.state,
      stateBroken: report.broken,
      records: await readAuditTail(this.root),
      actions: await loadActions(this.root).catch(() => []),
    });
  }

  private shell(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "panel.css"));
    const sections = ["welcome", "repair", "goal", "tour", "focus", "criteria", "constraints", "drift", "consent"]
      .map((id) => `<div id="${id}"></div>`)
      .join("\n");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}">
</head>
<body>
${sections}
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
