import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { GoalPanelProvider } from "./goalPanel.js";
import { StatusBarManager } from "./statusBar.js";
import { AuditOutputChannel } from "./outputChannel.js";

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

type AuditEntry = {
  ts?: string;
  event?: string;
  actionType?: "shell" | "mcp" | "read" | "write";
  actionValue?: string;
  suggestedAllow?: string;
};

async function loadLastAction(workspaceRoot: string): Promise<AuditEntry | null> {
  const auditPath = path.join(workspaceRoot, ".ai", "goal-guardian", "audit.log");
  try {
    const raw = await fs.readFile(auditPath, "utf8");
    const lines = raw.trim().split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.actionType && entry.actionValue) return entry;
    }
    return null;
  } catch {
    return null;
  }
}

async function getCriteriaIds(workspaceRoot: string): Promise<string[]> {
  const contractPath = path.join(workspaceRoot, ".cursor", "goal-guardian", "contract.json");
  try {
    const raw = await fs.readFile(contractPath, "utf8");
    const parsed = JSON.parse(raw) as { success_criteria?: string[] };
    const list = parsed.success_criteria ?? [];
    return list.map((_, i) => `SC${i + 1}`);
  } catch {
    return [];
  }
}

async function autoPermitForLastAction(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
    return;
  }

  const last = await loadLastAction(workspaceRoot);
  if (!last) {
    vscode.window.showInformationMessage(`${EXT_NAME}: No recent actions found to permit.`);
    return;
  }

  const criteriaIds = await getCriteriaIds(workspaceRoot);
  if (criteriaIds.length === 0) {
    vscode.window.showErrorMessage(`${EXT_NAME}: No success criteria found. Define them in contract.json first.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(criteriaIds, {
    canPickMany: true,
    placeHolder: "Select success criteria IDs that justify this action",
  });
  if (!picked || picked.length === 0) return;

  const actionValue = last.actionValue ?? "";
  const actionType = last.actionType ?? "shell";
  const allowField =
    actionType === "shell" ? "allow_shell" :
    actionType === "mcp" ? "allow_mcp" :
    actionType === "read" ? "allow_read" : "allow_write";

  const stepText = `Permit ${actionType}: ${actionValue}`;

  const mcpCli = path.join(context.extensionPath, "bin", "goal-guardian-mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "goal-guardian-extension", version: "0.2.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [mcpCli],
    env: { GOAL_GUARDIAN_WORKSPACE_ROOT: workspaceRoot },
  });

  try {
    await client.connect(transport);
    const check = await client.callTool({
      name: "guardian_check_step",
      arguments: {
        step: stepText,
        expected_output: `Allowed action: ${actionValue}`,
        maps_to: picked,
      },
    });

    const checkText = (check as any)?.content?.[0]?.text ?? "{}";
    const record = JSON.parse(checkText);
    await client.callTool({
      name: "guardian_issue_permit",
      arguments: {
        step_id: record.step_id,
        ttl_seconds: 600,
        [allowField]: [last.suggestedAllow ?? actionValue],
      },
    });

    vscode.window.showInformationMessage(`${EXT_NAME}: Permit issued for ${actionType}.`);
  } catch (err) {
    vscode.window.showErrorMessage(`${EXT_NAME}: Failed to issue permit. ${String(err)}`);
  } finally {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
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
    },
    warningConfig: {
      maxWarningsBeforeBlock: 3,
      warningResetMinutes: 60,
      showGoalReminder: true
    },
    // Severity-based rules for graduated guardrails
    // HARD_BLOCK: Immediate denial, no recovery possible
    // WARN: Allow with warning, block after maxWarningsBeforeBlock
    // PERMIT_REQUIRED: Standard permit check
    // ALLOWED: Pass through immediately
    shellRules: [
      // HARD_BLOCK: Catastrophic commands
      { pattern: "rm -rf /", severity: "HARD_BLOCK", reason: "Catastrophic filesystem deletion" },
      { pattern: "rm -rf /*", severity: "HARD_BLOCK", reason: "Catastrophic filesystem deletion" },
      { pattern: "*curl*|*sh*", severity: "HARD_BLOCK", reason: "Remote code execution" },
      { pattern: "*wget*|*sh*", severity: "HARD_BLOCK", reason: "Remote code execution" },
      { pattern: "*curl*|*bash*", severity: "HARD_BLOCK", reason: "Remote code execution" },
      { pattern: "*wget*|*bash*", severity: "HARD_BLOCK", reason: "Remote code execution" },
      // WARN: Risky but recoverable
      { pattern: "rm -rf *", severity: "WARN", reason: "Recursive force delete" },
      { pattern: "*--force*", severity: "WARN", reason: "Force flag bypasses safety checks" },
      { pattern: "git reset --hard*", severity: "WARN", reason: "Destructive git operation" },
      { pattern: "git push --force*", severity: "WARN", reason: "Force push can overwrite history" },
      { pattern: "git push -f*", severity: "WARN", reason: "Force push can overwrite history" },
      { pattern: "npm publish*", severity: "WARN", reason: "Publishing to npm registry" },
      { pattern: "*sudo *", severity: "WARN", reason: "Elevated privileges requested" },
      // ALLOWED: Safe read-only commands
      { pattern: "git status*", severity: "ALLOWED", reason: "Read-only git operation" },
      { pattern: "git diff*", severity: "ALLOWED", reason: "Read-only git operation" },
      { pattern: "git log*", severity: "ALLOWED", reason: "Read-only git operation" },
      { pattern: "ls*", severity: "ALLOWED", reason: "List directory contents" },
      { pattern: "pwd", severity: "ALLOWED", reason: "Print working directory" },
      { pattern: "cat *", severity: "ALLOWED", reason: "Read file contents" },
      { pattern: "node -v", severity: "ALLOWED", reason: "Version check" },
      { pattern: "npm -v", severity: "ALLOWED", reason: "Version check" }
    ],
    mcpRules: [
      { pattern: "goal-guardian/*", severity: "ALLOWED", reason: "Goal Guardian MCP tools" }
    ],
    readRules: [
      { pattern: "**/.env", severity: "HARD_BLOCK", reason: "Environment secrets" },
      { pattern: "**/.env.*", severity: "HARD_BLOCK", reason: "Environment secrets" },
      { pattern: "**/*.pem", severity: "HARD_BLOCK", reason: "Private key file" },
      { pattern: "**/*.key", severity: "HARD_BLOCK", reason: "Private key file" },
      { pattern: ".git/**", severity: "HARD_BLOCK", reason: "Git internals" },
      { pattern: ".cursor/goal-guardian/**", severity: "ALLOWED", reason: "Guardian configuration" }
    ]
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
  // Create UI components
  const goalPanelProvider = new GoalPanelProvider(context.extensionUri);
  const statusBarManager = new StatusBarManager();
  const auditOutputChannel = new AuditOutputChannel();

  // Register webview provider for the Goal Panel in Explorer sidebar
  const panelRegistration = vscode.window.registerWebviewViewProvider(
    GoalPanelProvider.viewType,
    goalPanelProvider
  );

  // Register commands
  const installCmd = vscode.commands.registerCommand("goalGuardian.install", async () => {
    await installFiles(context);
    goalPanelProvider.refresh();
    statusBarManager.refresh();
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
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });

  const showPanelCmd = vscode.commands.registerCommand("goalGuardian.showPanel", async () => {
    // Focus on the Goal Guardian panel in the sidebar
    await vscode.commands.executeCommand("goalGuardian.goalPanel.focus");
  });

  const showAuditCmd = vscode.commands.registerCommand("goalGuardian.showAudit", async () => {
    auditOutputChannel.show();
  });

  const refreshCmd = vscode.commands.registerCommand("goalGuardian.refresh", async () => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
    auditOutputChannel.refresh();
    vscode.window.showInformationMessage(`${EXT_NAME}: Refreshed.`);
  });

  const requestPermitCmd = vscode.commands.registerCommand("goalGuardian.requestPermit", async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage(`${EXT_NAME}: Open a folder or workspace first.`);
      return;
    }

    // Show an input box to guide permit request
    const step = await vscode.window.showInputBox({
      title: "Request Permit - Step Description",
      prompt: "Describe what step you want to accomplish",
      placeHolder: "e.g., Run tests to verify authentication implementation",
    });

    if (!step) return;

    const mapsToInput = await vscode.window.showInputBox({
      title: "Request Permit - Success Criteria",
      prompt: "Which success criteria IDs does this map to? (comma-separated)",
      placeHolder: "e.g., SC1, SC2",
    });

    if (!mapsToInput) return;

    const shellPattern = await vscode.window.showInputBox({
      title: "Request Permit - Shell Patterns",
      prompt: "Shell command patterns to allow (comma-separated, leave empty for none)",
      placeHolder: "e.g., npm test*, npm run*",
    });

    // Build guidance message
    const mapsTo = mapsToInput.split(",").map((s) => s.trim()).filter(Boolean);
    const shellPatterns = shellPattern ? shellPattern.split(",").map((s) => s.trim()).filter(Boolean) : [];

    const guidance = `To request a permit, use the MCP tools in order:

1. guardian_check_step:
   - step: "${step}"
   - expected_output: "[describe what will be produced]"
   - maps_to: ${JSON.stringify(mapsTo)}

2. If approved, guardian_issue_permit:
   - step_id: [from check_step result]
   - allow_shell: ${JSON.stringify(shellPatterns)}

The AI agent can execute these commands via the goal-guardian MCP server.`;

    const action = await vscode.window.showInformationMessage(
      `${EXT_NAME}: Permit request guidance ready`,
      { modal: false },
      "Copy to Clipboard",
      "Open Contract"
    );

    if (action === "Copy to Clipboard") {
      await vscode.env.clipboard.writeText(guidance);
      vscode.window.showInformationMessage(`${EXT_NAME}: Guidance copied to clipboard.`);
    } else if (action === "Open Contract") {
      await vscode.commands.executeCommand("goalGuardian.openContract");
    }
  });

  const autoPermitCmd = vscode.commands.registerCommand("goalGuardian.autoPermitLastAction", async () => {
    await autoPermitForLastAction(context);
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });

  // Watch for contract file changes to auto-refresh
  const contractWatcher = vscode.workspace.createFileSystemWatcher(
    "**/goal-guardian/contract.json"
  );
  contractWatcher.onDidChange(() => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });
  contractWatcher.onDidCreate(() => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });
  contractWatcher.onDidDelete(() => {
    goalPanelProvider.refresh();
    statusBarManager.refresh();
  });

  context.subscriptions.push(
    panelRegistration,
    statusBarManager,
    auditOutputChannel,
    installCmd,
    openContract,
    uninstallCmd,
    showPanelCmd,
    showAuditCmd,
    refreshCmd,
    requestPermitCmd,
    autoPermitCmd,
    contractWatcher
  );
}

export function deactivate(): void {
  // Components will be disposed via subscriptions
}
