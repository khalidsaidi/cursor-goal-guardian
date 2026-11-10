import * as vscode from "vscode";
import { applyImprovement, controlGoal, improveReviewer, lastActiveConversation, readAuditTail, recordReviewFeedback, undoImprovement } from "@goal-guardian/core";

export type GoalCommand = "goal.pause" | "goal.resume" | "goal.done" | "goal.work";

export const WORK_PROMPT = "Work on the goal. Look at where the project stands now, then keep going until it's proved.";

/** Starts the agent on the goal in a new chat, sent at once. If Cursor's command has gone away, fills in a chat instead. */
async function startAgent(): Promise<void> {
  try {
    await vscode.commands.executeCommand("composer.createNew", { partialState: { text: WORK_PROMPT, richText: WORK_PROMPT, unifiedMode: "agent" }, autoSubmit: true, openInNewTab: true });
  } catch {
    await Promise.resolve(vscode.commands.executeCommand("workbench.action.chat.open", { query: WORK_PROMPT })).catch(() => undefined);
  }
}

/**
 * The user's goal buttons. Pausing also stops the chat at work; resuming and "work on it" start an agent. These
 * commands are Cursor's own and aren't a published API: if one goes away, the goal's state is still right.
 */
export async function applyGoalCommand(root: string, command: GoalCommand): Promise<void> {
  if (command === "goal.done") return controlGoal(root, "done");
  if (command === "goal.work") return startAgent();
  if (command === "goal.pause") {
    await controlGoal(root, "pause");
    const running = lastActiveConversation(await readAuditTail(root, 2000));
    if (running) await Promise.resolve(vscode.commands.executeCommand("composer.cancelChat", running)).catch(() => undefined);
    return;
  }
  await controlGoal(root, "resume");
  await startAgent();
}

/**
 * The reviewer buttons: a verdict on one objection, trying an improvement, applying one, or going back to the
 * built-in reviewer. Improving takes minutes, so it runs on and the panel refreshes when it's done.
 */
export async function applyReviewCommand(root: string, command: string, refresh: () => Promise<void>): Promise<void> {
  const [verb, id, index] = command.split(":");
  if ((verb === "review.right" || verb === "review.wrong") && id && index !== undefined) {
    await recordReviewFeedback(root, id, Number(index), verb === "review.right" ? "right" : "wrong");
  } else if (verb === "review.improve") {
    void improveReviewer(root)
      .catch((err) => vscode.window.showWarningMessage(`Goal Guardian: improving the reviewer failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => void refresh());
  } else if (verb === "review.apply" && id) {
    await applyImprovement(root, id).catch((err) => vscode.window.showWarningMessage(`Goal Guardian: ${err instanceof Error ? err.message : String(err)}`));
  } else if (verb === "review.undo") {
    await undoImprovement(root);
  }
}
