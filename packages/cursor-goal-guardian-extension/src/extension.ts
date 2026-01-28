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

async function writeJson(filePath: string, data: unknown, overwrite: boolean): Promise<boolean> {
  if (!overwrite && (await fileExists(filePath))) return false;
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

async function installFiles(context: vscode.ExtensionContext, overwrite: boolean): Promise<void> {
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

  const wroteContract = await writeJson(contractPath, defaultContract(), overwrite);
  const wrotePolicy = await writeJson(policyPath, defaultPolicy(), overwrite);
  const wroteHooks = await writeJson(hooksPath, hooksJson, overwrite);
  const wroteMcp = await writeJson(mcpPath, mcpJson, overwrite);

  const changed = [
    wroteContract ? "contract.json" : null,
    wrotePolicy ? "policy.json" : null,
    wroteHooks ? "hooks.json" : null,
    wroteMcp ? "mcp.json" : null
  ].filter(Boolean);

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
    const overwrite = await vscode.window.showWarningMessage(
      `${EXT_NAME}: Overwrite existing .cursor configs if they exist?`,
      { modal: true },
      "Overwrite",
      "Cancel"
    );
    if (overwrite !== "Overwrite") return;
    await installFiles(context, true);
  });

  const openContract = vscode.commands.registerCommand("goalGuardian.openContract", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
      return;
    }
    const contractPath = path.join(workspaceRoot, ".cursor", "goal-guardian", "contract.json");
    if (!(await fileExists(contractPath))) {
      await installFiles(context, false);
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
