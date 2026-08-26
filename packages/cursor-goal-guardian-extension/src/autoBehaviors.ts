import * as vscode from "vscode";
import path from "node:path";
import { dispatch, readStateSafe } from "@goal-guardian/core";

/**
 * Opt-in conveniences, both default-off: v0.x fired these on every save,
 * which startled people. They only act when the user turned them on.
 */
export function registerAutoBehaviors(
  context: vscode.ExtensionContext,
  root: string | null,
  isSetUp: () => Promise<boolean>,
): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!root || doc.uri.scheme !== "file") return;
      const rel = path.relative(root, doc.uri.fsPath).split(path.sep).join("/");
      if (rel.startsWith("..") || rel.startsWith(".cursor/")) return;

      const config = vscode.workspace.getConfiguration("goalGuardian");
      const autoStart = config.get<boolean>("autoStartNextTask", false);
      const autoPin = config.get<boolean>("autoPinEditedFiles", false);
      if (!autoStart && !autoPin) return;
      if (!(await isSetUp())) return;

      try {
        const state = await readStateSafe(root);
        if (autoStart && !state.activeTaskId) {
          const next = state.tasks.find((t) => t.status === "todo");
          if (next) await dispatch(root, { type: "START_TASK", actor: "human", payload: { taskId: next.id } });
        }
        if (autoPin && state.activeTaskId && !state.pinnedContext.includes(rel)) {
          await dispatch(root, { type: "PIN_CONTEXT", actor: "human", payload: { path: rel } });
        }
      } catch {
        // best-effort convenience; never surface errors for it
      }
    }),
  );
}
