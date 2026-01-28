import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const EXT_NAME = "Goal Guardian";

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0]?.uri.fsPath ?? null;
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

async function backupIfExists(filePath: string): Promise<void> {
  if (!(await fileExists(filePath))) return;
  const backupPath = `${filePath}.bak-${Date.now()}`;
  await fs.copyFile(filePath, backupPath);
}

async function readJson<T>(filePath: string, fallbackValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallbackValue;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<boolean> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  return true;
}

function defaultContract() {
  return {
    goal: "Replace this with a short, unambiguous goal statement.",
    success_criteria: [
      "Replace this with a concrete success criterion."
    ],
    constraints: [
      "No silent scope expansion: every step must map to explicit success criteria IDs.",
      "Prefer deterministic enforcement via hooks over prompt-only guidance.",
      "Never log to stdout inside the MCP server except JSON-RPC."
    ]
  };
}

function defaultPolicy() {
  return {
    requirePermitForShell: true,
    requirePermitForMcp: true,
    requirePermitForRead: false,
    autoRevertUnauthorizedEdits: false,
    alwaysAllow: {
      shell: ["git status*", "git diff*", "ls*", "pwd"],
      mcp: ["goal-guardian/*"],
      read: [".cursor/goal-guardian/**", ".cursor/hooks.json", ".cursor/mcp.json"]
    },
    alwaysDeny: {
      shell: ["rm -rf /*", "rm -rf /", "*curl*|*sh*", "*wget*|*sh*"],
      mcp: [],
      read: [".ai/goal-guardian/**", ".git/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"]
    }
  };
}

function hookCommand(hookPath: string): string {
  const quoted = hookPath.includes(" ") ? `"${hookPath}"` : hookPath;
  return `node ${quoted}`;
}

function mergeHookCommand(existing: any, hookName: string, command: string): boolean {
  if (!existing.hooks) existing.hooks = {};
  if (!Array.isArray(existing.hooks[hookName])) existing.hooks[hookName] = [];
  const arr = existing.hooks[hookName] as Array<{ command?: string }>;
  if (!arr.some((h) => h?.command === command)) {
    arr.push({ command });
    return true;
  }
  return false;
}

async function installFiles(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
    return;
  }

  const cursorDir = path.join(workspaceRoot, ".cursor");
  const guardianDir = path.join(cursorDir, "goal-guardian");

  const hookCli = path.join(context.extensionPath, "bin", "goal-guardian-hook.js");
  const mcpCli = path.join(context.extensionPath, "bin", "goal-guardian-mcp.js");

  const hooksJson = {
    version: 1,
    hooks: {
      beforeShellExecution: [{ command: hookCommand(hookCli) }],
      beforeMCPExecution: [{ command: hookCommand(hookCli) }],
      beforeReadFile: [{ command: hookCommand(hookCli) }],
      afterFileEdit: [{ command: hookCommand(hookCli) }],
      stop: [{ command: hookCommand(hookCli) }]
    }
  };

  const mcpJson = {
    mcpServers: {
      "goal-guardian": {
        command: "node",
        args: [mcpCli],
        env: {
          GOAL_GUARDIAN_WORKSPACE_ROOT: workspaceRoot
        }
      }
    }
  };

  const contractPath = path.join(guardianDir, "contract.json");
  const policyPath = path.join(guardianDir, "policy.json");
  const hooksPath = path.join(cursorDir, "hooks.json");
  const mcpPath = path.join(cursorDir, "mcp.json");

  await ensureDir(guardianDir);

  const changed: string[] = [];

  if (!(await fileExists(contractPath))) {
    await writeJson(contractPath, defaultContract());
    changed.push("contract.json");
  }

  if (!(await fileExists(policyPath))) {
    await writeJson(policyPath, defaultPolicy());
    changed.push("policy.json");
  }

  if (!(await fileExists(hooksPath))) {
    await writeJson(hooksPath, hooksJson);
    changed.push("hooks.json");
  } else {
    const existing = await readJson<any>(hooksPath, { version: 1, hooks: {} });
    const cmd = hookCommand(hookCli);
    let modified = false;
    modified = mergeHookCommand(existing, "beforeShellExecution", cmd) || modified;
    modified = mergeHookCommand(existing, "beforeMCPExecution", cmd) || modified;
    modified = mergeHookCommand(existing, "beforeReadFile", cmd) || modified;
    modified = mergeHookCommand(existing, "afterFileEdit", cmd) || modified;
    modified = mergeHookCommand(existing, "stop", cmd) || modified;
    if (modified) {
      await backupIfExists(hooksPath);
      await writeJson(hooksPath, { version: existing.version ?? 1, hooks: existing.hooks });
      changed.push("hooks.json (merged)");
    }
  }

  if (!(await fileExists(mcpPath))) {
    await writeJson(mcpPath, mcpJson);
    changed.push("mcp.json");
  } else {
    const existing = await readJson<any>(mcpPath, { mcpServers: {} });
    if (!existing.mcpServers) existing.mcpServers = {};
    if (!existing.mcpServers["goal-guardian"]) {
      existing.mcpServers["goal-guardian"] = mcpJson.mcpServers["goal-guardian"];
      await backupIfExists(mcpPath);
      await writeJson(mcpPath, existing);
      changed.push("mcp.json (merged)");
    }
  }

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
  const hooksPath = path.join(cursorDir, "hooks.json");
  const mcpPath = path.join(cursorDir, "mcp.json");

  const targets = [hooksPath, mcpPath, guardianDir];
  for (const t of targets) {
    try {
      await fs.rm(t, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  vscode.window.showInformationMessage(`${EXT_NAME}: Removed .cursor/goal-guardian and hooks/mcp configs (if present).`);
}

export function activate(context: vscode.ExtensionContext): void {
  const installCmd = vscode.commands.registerCommand("goalGuardian.install", async () => {
    await installFiles(context);
  });

  const openContract = vscode.commands.registerCommand("goalGuardian.openContract", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
      return;
    }
    const contractPath = path.join(workspaceRoot, ".cursor", "goal-guardian", "contract.json");
    if (!(await fileExists(contractPath))) {
      await installFiles(context);
    }
    const doc = await vscode.workspace.openTextDocument(contractPath);
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  const uninstallCmd = vscode.commands.registerCommand("goalGuardian.uninstall", async () => {
    const confirm = await vscode.window.showWarningMessage(
      `${EXT_NAME}: Remove .cursor/goal-guardian and hooks/mcp configs?`,
      { modal: true },
      "Remove",
      "Cancel"
    );
    if (confirm !== "Remove") return;
    await uninstallFiles();
  });

  context.subscriptions.push(installCmd, openContract, uninstallCmd);
}

export function deactivate(): void {
  // no-op
}
