import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { GoalPanelProvider } from "./goalPanel.js";
import { StatusBarManager } from "./statusBar.js";
import {
  ensureStateStoreFiles,
  dispatchAction,
  rebuildState,
  getStatePaths,
  loadState,
} from "./stateStore.js";

const EXT_NAME = "Goal Guardian";
type GoalGuardianContract = {
  goal?: string;
  success_criteria?: unknown;
  constraints?: unknown;
};

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0]?.uri.fsPath ?? null;
}

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string | null {
  const rel = path.relative(workspaceRoot, absolutePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function isGuardianInternalPath(relPath: string): boolean {
  return relPath.startsWith(".cursor/goal-guardian/");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function openFileInEditor(filePath: string): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    vscode.window.showErrorMessage(`${EXT_NAME}: Could not open ${filePath}`);
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push(text);
      continue;
    }
    if (item && typeof item === "object" && "text" in item) {
      const text = String((item as { text?: unknown }).text ?? "").trim();
      if (text) out.push(text);
    }
  }
  return out;
}

function sameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function getNextTodoTaskId(state: Awaited<ReturnType<typeof loadState>>): string | null {
  const queueCandidate = state.queue.find((id) => state.tasks.some((t) => t.id === id && t.status === "todo"));
  if (queueCandidate) return queueCandidate;
  const fallback = state.tasks.find((t) => t.status === "todo");
  return fallback?.id ?? null;
}

function buildTasksFromCriteria(criteria: string[]): Array<{ id: string; title: string }> {
  return criteria.map((text, idx) => {
    const id = `sc_${idx + 1}`;
    return { id, title: `SC${idx + 1}: ${text}` };
  });
}

async function loadContract(workspaceRoot: string): Promise<GoalGuardianContract | null> {
  const contractPath = getStatePaths(workspaceRoot).contract;
  try {
    const raw = await fs.readFile(contractPath, "utf8");
    const parsed = JSON.parse(raw) as GoalGuardianContract;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function ensureActiveTask(workspaceRoot: string): Promise<boolean> {
  const state = await loadState(workspaceRoot);
  if (state.active_task) return false;
  const nextTaskId = getNextTodoTaskId(state);
  if (!nextTaskId) return false;
  await dispatchAction(workspaceRoot, {
    actor: "agent",
    type: "START_TASK",
    payload: { taskId: nextTaskId },
  });
  return true;
}

async function autoSyncStateFromContract(workspaceRoot: string): Promise<boolean> {
  await ensureStateStoreFiles(workspaceRoot);
  const contract = await loadContract(workspaceRoot);
  if (!contract) return false;

  let changed = false;
  let state = await loadState(workspaceRoot);

  const goal = String(contract.goal ?? "");
  const definitionOfDone = normalizeStringList(contract.success_criteria);
  const constraints = normalizeStringList(contract.constraints);

  const needsGoalSync =
    state.goal !== goal ||
    !sameStringList(state.definition_of_done, definitionOfDone) ||
    !sameStringList(state.constraints, constraints);

  if (needsGoalSync) {
    await dispatchAction(workspaceRoot, {
      actor: "agent",
      type: "SET_GOAL",
      payload: {
        goal,
        definition_of_done: definitionOfDone,
        constraints,
      },
    });
    changed = true;
    state = await loadState(workspaceRoot);
  }

  if (state.tasks.length === 0 && definitionOfDone.length > 0) {
    await dispatchAction(workspaceRoot, {
      actor: "agent",
      type: "ADD_TASKS",
      payload: { tasks: buildTasksFromCriteria(definitionOfDone) },
    });
    changed = true;
    state = await loadState(workspaceRoot);
  }

  if (!state.active_task) {
    const started = await ensureActiveTask(workspaceRoot);
    changed = changed || started;
  }

  return changed;
}

async function autoPinEditedFile(workspaceRoot: string, absolutePath: string): Promise<boolean> {
  const relPath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
  if (!relPath) return false;
  if (isGuardianInternalPath(relPath)) return false;

  const state = await loadState(workspaceRoot);
  if (!state.active_task) return false;
  if (state.pinned_context.includes(relPath)) return false;

  await dispatchAction(workspaceRoot, {
    actor: "agent",
    type: "PIN_CONTEXT",
    payload: { path: relPath },
  });
  return true;
}

async function dispatchActionInteractive(workspaceRoot: string): Promise<void> {
  await ensureStateStoreFiles(workspaceRoot);
  const state = await loadState(workspaceRoot);

  const actionTypes = [
    "SET_GOAL",
    "ADD_TASKS",
    "START_TASK",
    "COMPLETE_TASK",
    "OPEN_QUESTION",
    "CLOSE_QUESTION",
    "ADD_DECISION",
    "PIN_CONTEXT",
    "UNPIN_CONTEXT",
    "CUSTOM_JSON",
  ];

  let picked = await vscode.window.showQuickPick(actionTypes, {
    placeHolder: "Select action type",
  });
  if (!picked) return;

  let payload: Record<string, unknown> = {};

  if (picked === "SET_GOAL") {
    const goal = await vscode.window.showInputBox({ prompt: "Goal statement", value: state.goal });
    if (goal === undefined) return;
    const dod = await vscode.window.showInputBox({
      prompt: "Definition of done (comma-separated)",
      value: state.definition_of_done.join(", "),
    });
    const constraints = await vscode.window.showInputBox({
      prompt: "Constraints (comma-separated)",
      value: state.constraints.join(", "),
    });
    payload = {
      goal,
      definition_of_done: (dod ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      constraints: (constraints ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  } else if (picked === "ADD_TASKS") {
    const tasks = await vscode.window.showInputBox({
      prompt: "Tasks (comma-separated)",
      placeHolder: "Design API, Implement handler, Add tests",
    });
    if (tasks === undefined) return;
    payload = {
      tasks: tasks.split(",").map((t) => ({ title: t.trim() })).filter((t) => t.title),
    };
  } else if (picked === "START_TASK" || picked === "COMPLETE_TASK") {
    const taskId = await vscode.window.showInputBox({
      prompt: "Task ID",
      placeHolder: "task_...",
    });
    if (!taskId) return;
    payload = { taskId };
  } else if (picked === "OPEN_QUESTION") {
    const text = await vscode.window.showInputBox({ prompt: "Question" });
    if (!text) return;
    payload = { text };
  } else if (picked === "CLOSE_QUESTION") {
    const qId = await vscode.window.showInputBox({ prompt: "Question ID" });
    if (!qId) return;
    payload = { id: qId };
  } else if (picked === "ADD_DECISION") {
    const text = await vscode.window.showInputBox({ prompt: "Decision text" });
    if (!text) return;
    const rationale = await vscode.window.showInputBox({ prompt: "Decision rationale" });
    if (!rationale) return;
    payload = { text, rationale };
  } else if (picked === "PIN_CONTEXT" || picked === "UNPIN_CONTEXT") {
    const p = await vscode.window.showInputBox({ prompt: "Path to pin/unpin" });
    if (!p) return;
    payload = { path: p };
  } else if (picked === "CUSTOM_JSON") {
    const raw = await vscode.window.showInputBox({
      prompt: "Paste full action JSON (must include type + payload)",
      placeHolder: "{\"type\":\"SET_GOAL\",\"payload\":{...}}",
    });
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const type = String(parsed.type ?? "");
      if (!type) throw new Error("Missing type");
      payload = parsed.payload ?? {};
      picked = type;
    } catch (err) {
      vscode.window.showErrorMessage(`${EXT_NAME}: Invalid JSON action. ${String(err)}`);
      return;
    }
  }

  await dispatchAction(workspaceRoot, {
    actor: "human",
    type: picked,
    payload,
  });
}

function defaultContract() {
  return {
    goal: "Replace this with a short, unambiguous goal statement.",
    success_criteria: [
      "Replace this with a concrete success criterion.",
    ],
    constraints: [
      "No silent scope expansion: every step must map to explicit success criteria IDs.",
      "Keep updates in the state store instead of chat-only planning.",
      "Prefer small, testable tasks with explicit completion criteria.",
    ],
  };
}

async function installFiles(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
    return;
  }

  const cursorDir = path.join(workspaceRoot, ".cursor");
  const guardianDir = path.join(cursorDir, "goal-guardian");
  const contractPath = path.join(guardianDir, "contract.json");

  await ensureDir(guardianDir);

  const changed: string[] = [];

  if (!(await fileExists(contractPath))) {
    await writeJson(contractPath, defaultContract());
    changed.push("contract.json");
  }

  await ensureStateStoreFiles(workspaceRoot);

  if (changed.length === 0) {
    vscode.window.showInformationMessage(`${EXT_NAME}: Files already exist. Nothing changed.`);
  } else {
    vscode.window.showInformationMessage(`${EXT_NAME}: Wrote ${changed.join(", ")}.`);
  }
}

async function uninstallFiles(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
    return;
  }

  const cursorDir = path.join(workspaceRoot, ".cursor");
  const guardianDir = path.join(cursorDir, "goal-guardian");

  try {
    await fs.rm(guardianDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  vscode.window.showInformationMessage(`${EXT_NAME}: Removed .cursor/goal-guardian.`);
}

export function activate(_context: vscode.ExtensionContext): void {
  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot) {
    ensureStateStoreFiles(workspaceRoot).catch(() => {
      // ignore; user can run Install/Configure to repair
    });
  }

  const goalPanelProvider = new GoalPanelProvider(_context.extensionUri);
  const statusBarManager = new StatusBarManager();

  const panelRegistration = vscode.window.registerWebviewViewProvider(
    GoalPanelProvider.viewType,
    goalPanelProvider,
  );

  const installCmd = vscode.commands.registerCommand("goalGuardian.install", async () => {
    await installFiles();
    const root = getWorkspaceRoot();
    if (root) {
      try {
        await autoSyncStateFromContract(root);
      } catch {
        // Best-effort sync.
      }
    }
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });

  const openContract = vscode.commands.registerCommand("goalGuardian.openContract", async () => {
    const root = getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
      return;
    }
    const contractPath = path.join(root, ".cursor", "goal-guardian", "contract.json");
    if (!(await fileExists(contractPath))) {
      await installFiles();
    }
    const doc = await vscode.workspace.openTextDocument(contractPath);
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  const uninstallCmd = vscode.commands.registerCommand("goalGuardian.uninstall", async () => {
    const confirm = await vscode.window.showWarningMessage(
      `${EXT_NAME}: Remove .cursor/goal-guardian state files?`,
      { modal: true },
      "Remove",
      "Cancel",
    );
    if (confirm !== "Remove") return;
    await uninstallFiles();
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });

  const showPanelCmd = vscode.commands.registerCommand("goalGuardian.showPanel", async () => {
    await vscode.commands.executeCommand("goalGuardian.goalPanel.focus");
  });

  const refreshCmd = vscode.commands.registerCommand("goalGuardian.refresh", async () => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
    vscode.window.showInformationMessage(`${EXT_NAME}: Refreshed.`);
  });

  const openStateCmd = vscode.commands.registerCommand("goalGuardian.openState", async () => {
    const root = getWorkspaceRoot();
    if (!root) return;
    const p = getStatePaths(root);
    await openFileInEditor(p.state);
  });

  const openActionsCmd = vscode.commands.registerCommand("goalGuardian.openActions", async () => {
    const root = getWorkspaceRoot();
    if (!root) return;
    const p = getStatePaths(root);
    await openFileInEditor(p.actions);
  });

  const openReducerCmd = vscode.commands.registerCommand("goalGuardian.openReducer", async () => {
    const root = getWorkspaceRoot();
    if (!root) return;
    const p = getStatePaths(root);
    await openFileInEditor(p.reducer);
  });

  const openRulesCmd = vscode.commands.registerCommand("goalGuardian.openRules", async () => {
    const root = getWorkspaceRoot();
    if (!root) return;
    const p = getStatePaths(root);
    await openFileInEditor(p.rules);
  });

  const dispatchActionCmd = vscode.commands.registerCommand("goalGuardian.dispatchAction", async () => {
    const root = getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
      return;
    }
    try {
      await dispatchActionInteractive(root);
      goalPanelProvider.refresh();
      statusBarManager.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`${EXT_NAME}: ${String(err)}`);
    }
  });

  const startNextTaskCmd = vscode.commands.registerCommand("goalGuardian.startNextTask", async () => {
    const root = getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
      return;
    }
    try {
      await ensureStateStoreFiles(root);
      const before = await loadState(root);
      if (before.active_task) {
        vscode.window.showInformationMessage(`${EXT_NAME}: Active task already in progress (${before.active_task}).`);
        return;
      }
      const started = await ensureActiveTask(root);
      if (!started) {
        vscode.window.showInformationMessage(`${EXT_NAME}: No todo task available to start.`);
        return;
      }
      const after = await loadState(root);

      goalPanelProvider.refresh();
      statusBarManager.refresh();
      vscode.window.showInformationMessage(`${EXT_NAME}: Started task ${after.active_task ?? "(unknown)"}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`${EXT_NAME}: ${String(err)}`);
    }
  });

  const completeActiveTaskCmd = vscode.commands.registerCommand("goalGuardian.completeActiveTask", async () => {
    const root = getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
      return;
    }
    try {
      await ensureStateStoreFiles(root);
      const state = await loadState(root);
      if (!state.active_task) {
        vscode.window.showInformationMessage(`${EXT_NAME}: No active task to complete.`);
        return;
      }

      const taskId = state.active_task;
      await dispatchAction(root, {
        actor: "human",
        type: "COMPLETE_TASK",
        payload: { taskId },
      });

      goalPanelProvider.refresh();
      statusBarManager.refresh();
      vscode.window.showInformationMessage(`${EXT_NAME}: Completed task ${taskId}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`${EXT_NAME}: ${String(err)}`);
    }
  });

  const rebuildStateCmd = vscode.commands.registerCommand("goalGuardian.rebuildState", async () => {
    const root = getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
      return;
    }
    try {
      await rebuildState(root);
      goalPanelProvider.refresh();
      statusBarManager.refresh();
      vscode.window.showInformationMessage(`${EXT_NAME}: State rebuilt from actions.`);
    } catch (err) {
      vscode.window.showErrorMessage(`${EXT_NAME}: ${String(err)}`);
    }
  });

  const contractWatcher = vscode.workspace.createFileSystemWatcher("**/goal-guardian/contract.json");
  const syncFromContract = () => {
    const root = getWorkspaceRoot();
    if (!root) return;
    autoSyncStateFromContract(root)
      .then(() => {
        goalPanelProvider.refresh();
        statusBarManager.refresh();
      })
      .catch(() => {
        goalPanelProvider.refresh();
        statusBarManager.refresh();
      });
  };
  contractWatcher.onDidChange(syncFromContract);
  contractWatcher.onDidCreate(syncFromContract);
  contractWatcher.onDidDelete(() => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });

  const stateWatcher = vscode.workspace.createFileSystemWatcher("**/goal-guardian/state.json");
  stateWatcher.onDidChange(() => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });
  stateWatcher.onDidCreate(() => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });
  stateWatcher.onDidDelete(() => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });

  const actionsWatcher = vscode.workspace.createFileSystemWatcher("**/goal-guardian/actions.jsonl");
  actionsWatcher.onDidChange(() => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });
  actionsWatcher.onDidCreate(() => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });

  const autoPinOnSave = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (doc.isUntitled || doc.uri.scheme !== "file") return;

    const root = getWorkspaceRoot();
    if (!root) return;
    try {
      const relPath = toWorkspaceRelativePath(root, doc.uri.fsPath);
      if (!relPath || isGuardianInternalPath(relPath)) return;

      const started = await ensureActiveTask(root);
      const pinned = await autoPinEditedFile(root, doc.uri.fsPath);
      if (started || pinned) {
        goalPanelProvider.refresh();
        statusBarManager.refresh();
      }
    } catch {
      // Best-effort, no user interruption.
    }
  });

  if (workspaceRoot) {
    autoSyncStateFromContract(workspaceRoot)
      .then((changed) => {
        if (changed) {
          goalPanelProvider.refresh();
          statusBarManager.refresh();
        }
      })
      .catch(() => {
        // Best-effort bootstrap only.
      });
  }

  _context.subscriptions.push(
    panelRegistration,
    statusBarManager,
    installCmd,
    openContract,
    uninstallCmd,
    showPanelCmd,
    refreshCmd,
    openStateCmd,
    openActionsCmd,
    openReducerCmd,
    openRulesCmd,
    dispatchActionCmd,
    startNextTaskCmd,
    completeActiveTaskCmd,
    rebuildStateCmd,
    contractWatcher,
    stateWatcher,
    actionsWatcher,
    autoPinOnSave,
  );
}

export function deactivate(): void {
  // Components are disposed via subscriptions.
}
