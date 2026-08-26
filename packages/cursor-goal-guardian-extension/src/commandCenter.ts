import * as vscode from "vscode";
import {
  dispatch,
  getGuardianPaths,
  parseConfig,
  readConfigSafe,
  readJsonFile,
  readStateSafe,
  writeJsonAtomic,
  type NotifyMode,
} from "@goal-guardian/core";

export interface CommandCenterDeps {
  root: string;
  rescoreNow(): Promise<void>;
  refresh(): Promise<void>;
}

/**
 * The one-keystroke surface: a QuickPick at the top center — where Cursor
 * users already live — with direct actions. The panel stays for reviewing
 * the tape; this is for steering without leaving the keyboard.
 */
export async function openCommandCenter(deps: CommandCenterDeps): Promise<void> {
  const state = await readStateSafe(deps.root);
  const config = await readConfigSafe(deps.root);
  const active = state.activeTaskId ? state.tasks.find((t) => t.id === state.activeTaskId) : null;
  const todos = state.tasks.filter((t) => t.status === "todo");

  interface Item extends vscode.QuickPickItem {
    action: string;
  }
  const items: Item[] = [];
  if (active) {
    items.push({ label: `$(check) Complete "${active.title}"`, action: "complete" });
  }
  if (todos.length > 0) {
    items.push({ label: "$(arrow-right) Switch task…", description: `${todos.length} to do`, action: "switch" });
  }
  items.push(
    { label: "$(pencil) Update goal…", description: state.goal || "no goal declared", action: "goal" },
    { label: "$(sparkle) Review recent drift with AI", action: "rescore" },
    { label: `$(bell) Notifications: ${config.notify}`, description: "quiet · balanced · vocal", action: "notify" },
    { label: "$(graph) Open the session panel", action: "panel" },
    { label: "$(files) Open a guardian file…", action: "files" },
    { label: "$(trash) Remove Guardian from this workspace…", description: "deletes everything it created", action: "remove" },
  );

  const picked = await vscode.window.showQuickPick(items, { title: "Goal Guardian", placeHolder: active ? `Active: ${active.title}` : "No active task" });
  if (!picked) return;

  switch (picked.action) {
    case "complete": {
      if (!active) return;
      await dispatch(deps.root, { type: "COMPLETE_TASK", actor: "human", payload: { taskId: active.id } });
      break;
    }
    case "switch": {
      const task = await vscode.window.showQuickPick(
        todos.map((t) => ({ label: t.title, id: t.id })),
        { title: "Switch to which task?" },
      );
      if (!task) return;
      if (active) {
        // The decision requirement, expressed as UX instead of a thrown error.
        const why = await vscode.window.showInputBox({
          title: `Why switch away from "${active.title}"?`,
          prompt: "One line — this goes on the record as a decision.",
        });
        if (!why) return;
        const next = await dispatch(deps.root, {
          type: "ADD_DECISION",
          actor: "human",
          payload: { text: `Switch to: ${task.label}`, rationale: why },
        });
        const decisionId = next.decisions[next.decisions.length - 1]?.id;
        await dispatch(deps.root, { type: "START_TASK", actor: "human", payload: { taskId: task.id, decisionId } });
      } else {
        await dispatch(deps.root, { type: "START_TASK", actor: "human", payload: { taskId: task.id } });
      }
      break;
    }
    case "goal": {
      const goal = await vscode.window.showInputBox({ title: "Goal", value: state.goal, prompt: "One unambiguous sentence." });
      if (goal === undefined) return;
      await dispatch(deps.root, { type: "SET_GOAL", actor: "human", payload: { goal } });
      break;
    }
    case "rescore":
      await deps.rescoreNow();
      break;
    case "notify": {
      const mode = await vscode.window.showQuickPick(
        [
          { label: "quiet", description: "record everything, never speak" },
          { label: "balanced", description: "one calm nudge per drift episode (default)" },
          { label: "vocal", description: "nudge on every drift" },
        ],
        { title: "Notification mode" },
      );
      if (!mode) return;
      await updateNotifyMode(deps.root, mode.label as NotifyMode);
      break;
    }
    case "panel":
      await vscode.commands.executeCommand("goalGuardian.showPanel");
      break;
    case "remove":
      // The uninstall command carries its own confirmation dialog.
      await vscode.commands.executeCommand("goalGuardian.uninstall");
      break;
    case "files": {
      const p = getGuardianPaths(deps.root);
      const file = await vscode.window.showQuickPick(
        [
          { label: "contract.json", path: p.contract },
          { label: "config.json", path: p.config },
          { label: "state.json", path: p.state },
          { label: "actions.jsonl", path: p.actions },
          { label: "telemetry/audit.jsonl", path: p.audit },
        ],
        { title: "Open guardian file" },
      );
      if (file) await vscode.window.showTextDocument(vscode.Uri.file(file.path));
      break;
    }
  }
  await deps.refresh();
}

/** Settings as controls: writes config.json so the user never edits schema by hand. */
async function updateNotifyMode(root: string, notify: NotifyMode): Promise<void> {
  const p = getGuardianPaths(root);
  let raw: Record<string, unknown>;
  try {
    raw = (await readJsonFile(p.config)) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  raw.notify = notify;
  await writeJsonAtomic(p.config, parseConfig(raw));
}
