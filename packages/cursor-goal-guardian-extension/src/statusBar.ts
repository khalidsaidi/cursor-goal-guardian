import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { loadState } from "./stateStore.js";

type GoalContract = {
  goal: string;
  success_criteria: string[];
  constraints: string[];
};

export class StatusBarManager {
  private _statusBarItem: vscode.StatusBarItem;
  private _refreshInterval?: NodeJS.Timeout;
  private _disposed = false;

  constructor() {
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this._statusBarItem.command = "goalGuardian.showPanel";
    this._statusBarItem.show();

    this._update();

    // Auto-refresh every 10 seconds
    this._refreshInterval = setInterval(() => {
      if (!this._disposed) {
        this._update();
      }
    }, 10000);
  }

  public refresh() {
    this._update();
  }

  public dispose() {
    this._disposed = true;
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
    }
    this._statusBarItem.dispose();
  }

  private async _update() {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      this._statusBarItem.text = "$(shield) Goal Guardian";
      this._statusBarItem.tooltip = "Open a workspace to use Goal Guardian";
      return;
    }

    const contract = await this._loadContract(workspaceRoot);
    const state = await loadState(workspaceRoot).catch(() => null);

    const hasGoal = contract?.goal && contract.goal.trim().length > 0;

    // Build status bar text
    let text = "";
    let tooltip = "";

    if (!hasGoal) {
      text = "$(shield) No Goal";
      tooltip = "No goal set. Click to open Goal Guardian panel in Explorer.";
    } else {
      text = "$(shield-check) Goal Active";
      tooltip = `Goal: ${contract!.goal}`;
    }

    if (state?.active_task) {
      text += ` $(list-selection) ${state.active_task}`;
      tooltip += `\nActive task: ${state.active_task}`;
    }

    this._statusBarItem.text = text;
    this._statusBarItem.tooltip = `${tooltip}\nClick to open Goal Guardian panel (Explorer sidebar).`;

    if (!hasGoal) {
      this._statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
    } else {
      this._statusBarItem.backgroundColor = undefined;
    }
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

}
