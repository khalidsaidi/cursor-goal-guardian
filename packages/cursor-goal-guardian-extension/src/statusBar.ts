import * as vscode from "vscode";
import type { PanelViewModel } from "@goal-guardian/core";

/**
 * Calm chrome: hidden until the workspace is set up; never an error background
 * (a missing goal is not an error). Warning tint only for confirmed drift.
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    // Click -> the command center (one-keystroke actions), not a sidebar jump.
    this.item.command = "goalGuardian.commandCenter";
    context.subscriptions.push(this.item);
  }

  update(vm: PanelViewModel): void {
    const enabled = vscode.workspace.getConfiguration("goalGuardian").get<boolean>("statusBar.enabled", true);
    if (!vm.setUp || !enabled) {
      this.item.hide();
      return;
    }
    const task = vm.activeTask ? vm.activeTask.title : "no active task";
    this.item.text = vm.badge > 0 ? `$(target) ${task} · ${vm.badge}⚠` : `$(target) ${task}`;
    this.item.backgroundColor =
      vm.badge > 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    const semantic = vm.semantic.consented
      ? vm.semantic.available
        ? "AI review on"
        : "AI review offline"
      : "AI review off";
    this.item.tooltip = `Goal Guardian — ${vm.health}\nunreviewed: ${vm.semantic.pendingCount} · confirmed 24h: ${vm.counts24h.driftConfirmed} · dismissed: ${vm.counts24h.driftDismissed}\n${semantic}`;
    this.item.show();
  }
}
