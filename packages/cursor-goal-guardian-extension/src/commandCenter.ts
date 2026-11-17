import * as vscode from "vscode";
import { appendAudit, criteriaFromTexts, getGuardianPaths, goalHash, goalPhaseOf, nowIso, parseRequest, readConfigSafe, readContractSafe, readGoalRecords, setEngineGoal, writeContract, writeJsonAtomic } from "@goal-guardian/core";

export interface CommandCenterDeps {
  root: string;
  refresh(): Promise<void>;
}

/** Both editing surfaces replace the checklist from the new request, as a chat edit does. */
export async function editWorkspaceGoal(root: string): Promise<void> {
  const contract = await readContractSafe(root);
  const value = await vscode.window.showInputBox({
    title: "Edit goal",
    value: contract.goal,
    prompt: "Include the finish conditions you want to keep in the new request.",
  });
  if (value === undefined || value.trim() === contract.goal.trim()) return;
  const { goal, items } = parseRequest(value);
  const current = await readContractSafe(root);
  if (current.goal !== contract.goal) throw new Error("The goal changed while you were editing. Open the current goal to edit it.");
  const completed = goalPhaseOf(await readGoalRecords(root), current) === "complete";
  if (!(await setEngineGoal(root, goal, completed && Boolean(goal)))) {
    throw new Error("Guardian could not change this goal.");
  }
  const saved = await writeContract(root, { ...current, goal, successCriteria: criteriaFromTexts(items) });
  await appendAudit(root, { ts: nowIso(), kind: "goal.set", goalHash: goalHash(saved) });
}

/**
 * The one-keystroke surface: a QuickPick at the top center — where Cursor
 * users already live — with direct actions. The panel stays for reviewing
 * the tape; this is for steering without leaving the keyboard.
 */
export async function openCommandCenter(deps: CommandCenterDeps): Promise<void> {
  const contract = await readContractSafe(deps.root);

  interface Item extends vscode.QuickPickItem {
    action: string;
  }
  const items: Item[] = [
    { label: "$(pencil) Update goal…", description: contract.goal || "no goal declared", action: "goal" },
    { label: "$(graph) Open the session panel", action: "panel" },
    { label: "$(files) Open a guardian file…", action: "files" },
    { label: "$(settings-gear) Automatic learning…", description: "choose how much background learning may use", action: "learning" },
    { label: "$(trash) Remove Guardian from this workspace…", description: "remove project files, hooks and chat skills", action: "remove" },
  ];

  const picked = await vscode.window.showQuickPick(items, { title: "Goal Guardian" });
  if (!picked) return;

  switch (picked.action) {
    case "goal":
      await editWorkspaceGoal(deps.root);
      break;
    case "learning": {
      const config = await readConfigSafe(deps.root);
      const allowance = await vscode.window.showQuickPick([
        { label: "Off", description: "Keep feedback; no automatic learning calls", limit: 0 },
        { label: "Light", description: "Up to 16 background model invocations per 24 hours", limit: 16 },
        { label: "Standard", description: "Up to 32 background model invocations per 24 hours (default)", limit: 32 },
      ], { title: "Automatic learning allowance for this workspace" });
      if (!allowance) return;
      await writeJsonAtomic(getGuardianPaths(deps.root).config, { ...config, learning: { ...config.learning, dailyCallLimit: allowance.limit } });
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
