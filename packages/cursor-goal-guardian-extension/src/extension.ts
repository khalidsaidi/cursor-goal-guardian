import * as vscode from "vscode";
import {
  detectWorkspaceFormat,
  getGuardianPaths,
  migrateV1toV2,
  readContractSafe,
  writeContract,
} from "@goal-guardian/core";
import { applyGoalCommand, applyReviewCommand } from "./goalControls.js";
import { PanelController } from "./panel/panelController.js";
import { StatusBar } from "./statusBar.js";
import { applySetup, connectWorkspace, doctorIntegration, offerMcpEnableGuidance, runUninstall } from "./setup.js";
import { openCommandCenter } from "./commandCenter.js";

/**
 * Activation contract: in a workspace without guardian files this registers
 * commands and views and does NOTHING else — no file writes, no status bar,
 * no notifications. Services start only after setup, or for existing guardian
 * workspaces (where v1 files auto-migrate with backups and one passive notice).
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  const controller = new PanelController(context, root, {
    isCommandCenterUsed: () => context.workspaceState.get<boolean>("goalGuardian.tour.commandCenterUsed", false),
    isTourDismissed: () => context.workspaceState.get<boolean>("goalGuardian.tour.dismissed", false),
    onCommand: async (command) => {
      if (command === "goal.pause" || command === "goal.resume" || command === "goal.done" || command === "goal.work") {
        if (root) await applyGoalCommand(root, command);
      } else if (root && command.startsWith("review.")) await applyReviewCommand(root, command, () => controller.refresh(), context.extensionPath);
      else if (command === "dismissTour") await context.workspaceState.update("goalGuardian.tour.dismissed", true);
      else if (command === "editGoal") {
        if (!root) return;
        const contract = await readContractSafe(root);
        const goal = await vscode.window.showInputBox({ title: "Goal", value: contract.goal, prompt: "One unambiguous sentence." });
        if (goal !== undefined) await writeContract(root, { ...contract, goal });
      } else await vscode.commands.executeCommand(`goalGuardian.${command}`);
      await controller.refresh();
    },
    onConnectSubmit: async (form) => {
      if (!root) return;
      try {
        await applySetup(root, context, form);
        startServices();
      } catch (err) {
        void vscode.window.showWarningMessage(`Goal Guardian: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
  const statusBar = new StatusBar(context);
  controller.onDidUpdate((vm) => statusBar.update(vm));

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(PanelController.viewType, controller));

  const startServices = (): void => {
    controller.startWatching();
    void controller.refresh();
  };

  const requireRoot = (): string | null => {
    if (!root) void vscode.window.showWarningMessage("Goal Guardian: open a folder first.");
    return root;
  };

  const openGuardianFile = (key: "contract" | "config" | "audit"): (() => Promise<void>) => {
    return async () => {
      const r = requireRoot();
      if (!r) return;
      const p = getGuardianPaths(r);
      const file = key === "audit" ? p.audit : p[key];
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    };
  };

  const commands: Record<string, () => Promise<void>> = {
    "goalGuardian.setup": async () => {
      if (!requireRoot()) return;
      // The connect form lives in the panel — one setup experience everywhere.
      await vscode.commands.executeCommand("goalGuardian.goalPanel.focus");
    },
    "goalGuardian.showPanel": async () => {
      await vscode.commands.executeCommand("goalGuardian.goalPanel.focus");
    },
    "goalGuardian.refresh": async () => controller.refresh(),
    "goalGuardian.openContract": openGuardianFile("contract"),
    "goalGuardian.openConfig": openGuardianFile("config"),
    "goalGuardian.openAuditLog": openGuardianFile("audit"),
    "goalGuardian.commandCenter": async () => {
      const r = requireRoot();
      if (!r) return;
      try {
        await context.workspaceState.update("goalGuardian.tour.commandCenterUsed", true);
        // workspaceState changes don't touch watched files — refresh so the
        // tour tick shows immediately, from every entry point (status bar too).
        void controller.refresh();
        await openCommandCenter({ root: r, refresh: () => controller.refresh() });
      } catch (err) {
        void vscode.window.showWarningMessage(`Goal Guardian: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    "goalGuardian.uninstall": async () => {
      const r = requireRoot();
      if (!r) return;
      const confirmed = await vscode.window.showWarningMessage(
        "Remove Goal Guardian from this workspace? This deletes .cursor/goal-guardian and unwires the hook and MCP entries.",
        { modal: true },
        "Remove",
      );
      if (confirmed !== "Remove") return;
      await runUninstall(r);
      await controller.refresh();
    },
  };
  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  if (root) {
    const format = await detectWorkspaceFormat(root);
    if (format === "v1") {
      const result = await migrateV1toV2(root, {
        migratedBy: `cursor-goal-guardian-extension@${context.extension.packageJSON.version as string}`,
      });
      if (result.migrated) {
        // An 0.4.x workspace is an existing opt-in: finish the connection so
        // the upgraded user actually gets the recorder, the agent tools, and
        // the session rule — not just transformed files.
        await connectWorkspace(root, context);
        await doctorIntegration(root, context);
        void vscode.window.showInformationMessage(
          "Goal Guardian upgraded this workspace (backups saved as *.v1.bak) and connected session tracking — just ask your agent for something.",
        );
        // Upgraders hit the same one-time per-project MCP enable as fresh setups.
        offerMcpEnableGuidance();
      }
      startServices();
    } else if (format === "v2") {
      await doctorIntegration(root, context);
      startServices();
    } else if (!context.globalState.get<boolean>("goalGuardian.welcomed", false)) {
      // format "none": stay inert on disk, but introduce ourselves exactly
      // once per install — reveal the panel so the welcome card (and its
      // Connect button) is simply on screen. Setup never requires the
      // command palette. Never repeats: the flag is global, not per-workspace.
      // Remote windows restore their layout late and can stomp a one-shot
      // activation-time reveal (seen live on WSL), so verify the view actually
      // opened and retry until it does.
      await context.globalState.update("goalGuardian.welcomed", true);
      void (async () => {
        for (const delay of [0, 3_000, 8_000]) {
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          try {
            await vscode.commands.executeCommand("goalGuardian.goalPanel.focus");
          } catch {
            continue; // view not registered yet — try again
          }
          await new Promise((r) => setTimeout(r, 500));
          if (controller.isResolved()) return;
        }
      })();
    }
  }
}

export function deactivate(): void {}
