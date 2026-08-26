import * as vscode from "vscode";
import {
  detectWorkspaceFormat,
  dispatch,
  getGuardianPaths,
  migrateV1toV2,
  rebuild,
  readStateSafe,
  ACTION_TYPES,
  type ActionType,
} from "@goal-guardian/core";
import { PanelController } from "./panel/panelController.js";
import { RescoreService } from "./rescoreService.js";
import { StatusBar } from "./statusBar.js";
import { registerAutoBehaviors } from "./autoBehaviors.js";
import { doctorIntegration, runSetup, runUninstall } from "./setup.js";
import { openCommandCenter } from "./commandCenter.js";

/**
 * Activation contract: in a workspace without guardian files this registers
 * commands and views and does NOTHING else — no file writes, no status bar,
 * no notifications. Services start only after setup, or for existing guardian
 * workspaces (where v1 files auto-migrate with backups and one passive notice).
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  const rescore = new RescoreService(context, root, undefined, () => void controller.refresh());
  const controller = new PanelController(context, root, {
    isSemanticConsented: () => rescore.isConsented(),
    isSemanticAvailable: () => rescore.isAvailable(),
    onCommand: async (command) => {
      if (command === "enableRescore") await rescore.grantConsent();
      else if (command === "editGoal") {
        if (!root) return;
        const state = await readStateSafe(root);
        const goal = await vscode.window.showInputBox({ title: "Goal", value: state.goal, prompt: "One unambiguous sentence." });
        if (goal !== undefined) await dispatch(root, { type: "SET_GOAL", actor: "human", payload: { goal } });
      } else await vscode.commands.executeCommand(`goalGuardian.${command}`);
      await controller.refresh();
    },
    onStartTask: async (taskId) => {
      if (!root) return;
      try {
        await dispatch(root, { type: "START_TASK", actor: "human", payload: { taskId } });
      } catch (err) {
        void vscode.window.showWarningMessage(`Goal Guardian: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    onRescoreOne: async () => rescore.rescoreNow(),
  });
  const statusBar = new StatusBar(context);
  controller.onDidUpdate((vm) => statusBar.update(vm));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelController.viewType, controller),
  );

  const startServices = (): void => {
    controller.startWatching();
    rescore.start();
    void controller.refresh();
  };

  const requireRoot = (): string | null => {
    if (!root) void vscode.window.showWarningMessage("Goal Guardian: open a folder first.");
    return root;
  };

  const openGuardianFile = (key: "contract" | "config" | "state" | "actions" | "audit"): (() => Promise<void>) => {
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
      const r = requireRoot();
      if (!r) return;
      if (await runSetup(r, context)) startServices();
    },
    "goalGuardian.showPanel": async () => {
      await vscode.commands.executeCommand("goalGuardian.goalPanel.focus");
    },
    "goalGuardian.refresh": async () => controller.refresh(),
    "goalGuardian.openContract": openGuardianFile("contract"),
    "goalGuardian.openConfig": openGuardianFile("config"),
    "goalGuardian.openState": openGuardianFile("state"),
    "goalGuardian.openActions": openGuardianFile("actions"),
    "goalGuardian.openAuditLog": openGuardianFile("audit"),
    "goalGuardian.startNextTask": async () => {
      const r = requireRoot();
      if (!r) return;
      const state = await readStateSafe(r);
      const next = state.tasks.find((t) => t.status === "todo");
      if (!next) return;
      await dispatch(r, { type: "START_TASK", actor: "human", payload: { taskId: next.id } }).catch((err) => {
        void vscode.window.showWarningMessage(`Goal Guardian: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    "goalGuardian.completeActiveTask": async () => {
      const r = requireRoot();
      if (!r) return;
      const state = await readStateSafe(r);
      if (!state.activeTaskId) return;
      await dispatch(r, { type: "COMPLETE_TASK", actor: "human", payload: { taskId: state.activeTaskId } });
    },
    "goalGuardian.rebuildState": async () => {
      const r = requireRoot();
      if (!r) return;
      try {
        await rebuild(r);
      } catch (err) {
        void vscode.window.showWarningMessage(
          `Goal Guardian: rebuild failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await controller.refresh();
    },
    "goalGuardian.dispatchAction": async () => {
      const r = requireRoot();
      if (!r) return;
      const type = await vscode.window.showQuickPick([...ACTION_TYPES], { title: "Action type" });
      if (!type) return;
      const payloadRaw = await vscode.window.showInputBox({ title: "Payload (JSON)", value: "{}" });
      if (payloadRaw === undefined) return;
      try {
        await dispatch(r, { type: type as ActionType, actor: "human", payload: JSON.parse(payloadRaw) });
      } catch (err) {
        void vscode.window.showWarningMessage(`Goal Guardian: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    "goalGuardian.rescoreDrift": async () => rescore.rescoreNow(),
    "goalGuardian.commandCenter": async () => {
      const r = requireRoot();
      if (!r) return;
      try {
        await openCommandCenter({ root: r, rescoreNow: () => rescore.rescoreNow(), refresh: () => controller.refresh() });
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

  registerAutoBehaviors(context, root, async () => (root ? (await detectWorkspaceFormat(root)) === "v2" : false));

  if (root) {
    const format = await detectWorkspaceFormat(root);
    if (format === "v1") {
      const result = await migrateV1toV2(root, {
        migratedBy: `cursor-goal-guardian-extension@${context.extension.packageJSON.version as string}`,
      });
      if (result.migrated) {
        await doctorIntegration(root, context);
        void vscode.window.showInformationMessage(
          "Goal Guardian upgraded this workspace to the v2 format (backups saved as *.v1.bak).",
        );
      }
      startServices();
    } else if (format === "v2") {
      await doctorIntegration(root, context);
      startServices();
    }
    // format "none": stay inert until invited via setup.
  }
}

export function deactivate(): void {}
