import path from "node:path";
import * as vscode from "vscode";
import { applyImprovement, autoImprove, controlGoal, lastActiveConversation, readAuditTail, recordReviewFeedback, undoImprovement, type RsiPaths } from "@goal-guardian/core";

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

/** Google's RRSI, Guardian's domain for it and a Python, all inside the extension; the replay runs through the hook. */
export function bundledRsi(extensionPath: string): RsiPaths {
  const win = process.platform === "win32";
  return {
    python: path.join(extensionPath, "bin", "python", win ? "python.exe" : path.join("bin", "python3")),
    rrsiDir: path.join(extensionPath, "rsi", "rrsi"),
    domainDir: path.join(extensionPath, "rsi", "cgg"),
    replay: [path.join(extensionPath, "bin", `goal-guardian-hook${win ? ".exe" : ""}`), "replay-review"],
  };
}

/**
 * The reviewer buttons: a verdict on one objection, saying a passed goal wasn't done, using a kept improvement
 * again, or going back to the built-in reviewer. Improving itself has no button: see improveInBackground.
 */
export async function applyReviewCommand(root: string, command: string, refresh: () => Promise<void>, extensionPath: string): Promise<void> {
  const [verb, id, index] = command.split(":");
  if ((verb === "review.right" || verb === "review.wrong") && id && index !== undefined) {
    await recordReviewFeedback(root, id, Number(index), verb === "review.right" ? "right" : "wrong");
  } else if (verb === "review.missed" && id) {
    await recordReviewFeedback(root, id, 0, "missed");
  } else if (verb === "review.apply" && id) {
    await applyImprovement(root, id).catch((err) => vscode.window.showWarningMessage(`Goal Guardian: ${err instanceof Error ? err.message : String(err)}`));
  } else if (verb === "review.undo") {
    await undoImprovement(root);
  }
  improveInBackground(root, extensionPath, refresh);
}

let improving = false;

/**
 * Guardian improves its reviewer by itself, in the background, whenever enough new verdicts have come in: no
 * button and no dialog. core's autoImprove decides whether there is anything to do and applies only a result
 * that passed its gate; the panel shows each run, what it cost, and an Undo. Called after every panel refresh and
 * every verdict, it does nothing when a run is already going.
 */
export function improveInBackground(root: string, extensionPath: string, refresh: () => Promise<void>): void {
  if (improving) return;
  improving = true;
  void autoImprove(root, bundledRsi(extensionPath))
    .then((result) => (result ? refresh() : undefined))
    .catch(() => undefined)
    .finally(() => {
      improving = false;
    });
}
