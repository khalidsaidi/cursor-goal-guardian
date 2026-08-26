import * as vscode from "vscode";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  criteriaFromTexts,
  defaultConfig,
  dispatch,
  ensureStateFiles,
  fileExists,
  getGuardianPaths,
  guardianRuleContent,
  GUARDIAN_RULE_RELATIVE_PATH,
  GUARDIAN_SKILLS,
  readJsonFile,
  writeJsonAtomic,
} from "@goal-guardian/core";

/**
 * The VSIX ships self-contained native executables (per-platform targeted
 * packages, the same shipping pattern OpenAI's extension uses). Nothing else
 * is required on the machine: no Node.js, no PATH, no downloads.
 */
export function bundledBinPaths(context: vscode.ExtensionContext): { hook: string; mcp: string } {
  const exe = process.platform === "win32" ? ".exe" : "";
  return {
    hook: path.join(context.extensionPath, "bin", `goal-guardian-hook${exe}`),
    mcp: path.join(context.extensionPath, "bin", `goal-guardian-mcp${exe}`),
  };
}

const HOOK_EVENTS = [
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "beforeTabFileRead",
  "afterFileEdit",
  "afterTabFileEdit",
];

function hookCommand(context: vscode.ExtensionContext): string {
  return `"${bundledBinPaths(context).hook}"`;
}

async function readJsonOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return (await readJsonFile(filePath)) as T;
  } catch {
    return fallback;
  }
}

/**
 * Cursor's agent hub loads MCP servers from the USER-level ~/.cursor/mcp.json,
 * not the workspace one — and the server resolves its workspace via MCP roots.
 * Registering there once makes the guardian's tools available in every hub
 * chat. Merge-preserving; uninstall removes only our entry.
 */
function mcpServerEntry(context: vscode.ExtensionContext, extraEnv?: Record<string, string>): Record<string, unknown> {
  const entry: Record<string, unknown> = { command: bundledBinPaths(context).mcp };
  if (extraEnv && Object.keys(extraEnv).length > 0) entry.env = extraEnv;
  return entry;
}

export async function wireUserLevelMcp(context: vscode.ExtensionContext): Promise<void> {
  const userMcpPath = path.join(process.env.GOAL_GUARDIAN_TEST_HOME ?? os.homedir(), ".cursor", "mcp.json");
  const config = await readJsonOr<{ mcpServers?: Record<string, unknown> }>(userMcpPath, {});
  config.mcpServers = config.mcpServers ?? {};
  const desired = mcpServerEntry(context);
  if (JSON.stringify(config.mcpServers["goal-guardian"]) === JSON.stringify(desired)) return;
  config.mcpServers["goal-guardian"] = desired;
  await writeJsonAtomic(userMcpPath, config);
}

export async function unwireUserLevelMcp(): Promise<void> {
  const userMcpPath = path.join(process.env.GOAL_GUARDIAN_TEST_HOME ?? os.homedir(), ".cursor", "mcp.json");
  const config = await readJsonOr<{ mcpServers?: Record<string, { command?: string; args?: string[] }> } | null>(userMcpPath, null);
  const entry = config?.mcpServers?.["goal-guardian"];
  const ours = Boolean(entry && (/goal-guardian-mcp/.test(entry.command ?? "") || entry.args?.some((a) => /goal-guardian-mcp/.test(a))));
  if (config?.mcpServers && ours) {
    delete config.mcpServers["goal-guardian"];
    await writeJsonAtomic(userMcpPath, config);
  }
}

/** Wire .cursor/hooks.json and .cursor/mcp.json to the bundled binaries, preserving unrelated entries. */
export async function wireIntegration(root: string, context: vscode.ExtensionContext): Promise<void> {
  const cursorDir = path.join(root, ".cursor");
  await fs.mkdir(cursorDir, { recursive: true });

  const hooksPath = path.join(cursorDir, "hooks.json");
  const hooks = await readJsonOr<{ version?: number; hooks?: Record<string, Array<{ command: string }>> }>(hooksPath, {});
  hooks.version = hooks.version ?? 1;
  hooks.hooks = hooks.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const entries = (hooks.hooks[event] ?? []).filter((e) => !isGuardianHookCommand(e?.command));
    entries.push({ command: hookCommand(context) });
    hooks.hooks[event] = entries;
  }
  await writeJsonAtomic(hooksPath, hooks);

  const mcpPath = path.join(cursorDir, "mcp.json");
  const mcp = await readJsonOr<{ mcpServers?: Record<string, unknown> }>(mcpPath, {});
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers["goal-guardian"] = mcpServerEntry(context, { GOAL_GUARDIAN_WORKSPACE_ROOT: root });
  await writeJsonAtomic(mcpPath, mcp);
}

export function isGuardianHookCommand(command: unknown): boolean {
  return typeof command === "string" && /goal-guardian-hook/.test(command);
}

/**
 * The full connection: watcher wiring, hub registration, session rule, skills.
 * Used by the invited Setup flow and by the 0.4.x upgrade — a migrated user
 * already opted in, and without this their agent never learns the protocol.
 */
export async function connectWorkspace(root: string, context: vscode.ExtensionContext): Promise<void> {
  await wireIntegration(root, context);
  await wireUserLevelMcp(context);
  await writeGuardianRule(root);
}

async function writeGuardianRule(root: string): Promise<void> {
  const rulePath = path.join(root, GUARDIAN_RULE_RELATIVE_PATH);
  await fs.mkdir(path.dirname(rulePath), { recursive: true });
  await fs.writeFile(rulePath, guardianRuleContent(), "utf8");
  // Skills: guardian actions in the chat input's `/` menu — the surface users
  // actually live in.
  for (const skill of GUARDIAN_SKILLS) {
    const dir = path.join(root, skill.relativeDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), skill.content, "utf8");
  }
}

/**
 * Doctor pass: extension updates change the bundled binary paths, and Cursor
 * server updates change the node runtime path — silently repoint any guardian
 * entries that reference stale locations. Runs only when guardian files
 * already exist; writes only when something actually differs.
 */
export async function doctorIntegration(root: string, context: vscode.ExtensionContext): Promise<void> {
  const hooksPath = path.join(root, ".cursor", "hooks.json");
  const hooks = await readJsonOr<{ hooks?: Record<string, Array<{ command: string }>> } | null>(hooksPath, null);
  if (hooks?.hooks) {
    let changed = false;
    const current = hookCommand(context);
    for (const entries of Object.values(hooks.hooks)) {
      for (const entry of entries) {
        if (isGuardianHookCommand(entry?.command) && entry.command !== current) {
          entry.command = current;
          changed = true;
        }
      }
    }
    if (changed) await writeJsonAtomic(hooksPath, hooks);
  }

  const mcpPath = path.join(root, ".cursor", "mcp.json");
  const mcp = await readJsonOr<{ mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> } | null>(mcpPath, null);
  const entry = mcp?.mcpServers?.["goal-guardian"];
  const referencesGuardian = (e: { command?: string; args?: string[] } | undefined): boolean =>
    Boolean(e && (/goal-guardian-mcp/.test(e.command ?? "") || e.args?.some((a) => /goal-guardian-mcp/.test(a))));
  if (referencesGuardian(entry)) {
    const desired = mcpServerEntry(context, { GOAL_GUARDIAN_WORKSPACE_ROOT: root });
    if (JSON.stringify(entry) !== JSON.stringify(desired)) {
      mcp!.mcpServers!["goal-guardian"] = desired as never;
      await writeJsonAtomic(mcpPath, mcp);
    }
  }

  // The hub reads the user-level registration; keep it fresh too.
  await wireUserLevelMcp(context);
}

/** The invited setup flow: goal -> criteria -> constraints (all skippable), then files + wiring. */
export async function runSetup(root: string, context: vscode.ExtensionContext): Promise<boolean> {
  const goal = await vscode.window.showInputBox({
    title: "Goal Guardian setup (1/3) — Goal",
    prompt: "One unambiguous sentence: what is this session/project trying to achieve? (Esc to skip)",
    placeHolder: "Ship the CSV export feature for the report table",
  });

  const criteriaRaw = await vscode.window.showInputBox({
    title: "Goal Guardian setup (2/3) — Success criteria",
    prompt: "Separate criteria with ';' — each becomes a trackable task. (Esc to skip)",
    placeHolder: "Users can export as CSV; Export respects filters; Serializer has tests",
  });

  const constraintsRaw = await vscode.window.showInputBox({
    title: "Goal Guardian setup (3/3) — Constraints",
    prompt: "Separate constraints with ';'. (Esc to skip)",
    placeHolder: "No new dependencies; No changes outside src/export/",
  });

  const split = (raw: string | undefined): string[] =>
    (raw ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

  const p = getGuardianPaths(root);
  await ensureStateFiles(root);
  if (!(await fileExists(p.config))) await writeJsonAtomic(p.config, defaultConfig());

  const criteria = criteriaFromTexts(split(criteriaRaw));
  await dispatch(root, {
    type: "SET_GOAL",
    actor: "human",
    payload: { goal: goal ?? "", successCriteria: criteria, constraints: split(constraintsRaw) },
  });
  if (criteria.length > 0) {
    await dispatch(root, {
      type: "ADD_TASKS",
      actor: "human",
      payload: { tasks: criteria.map((c) => ({ id: c.id, title: c.text, criterionId: c.id })) },
    });
    await dispatch(root, { type: "START_TASK", actor: "human", payload: { taskId: criteria[0]!.id } });
  }
  await writeJsonAtomic(p.migrationMarker, { from: 2, to: 2, ts: new Date().toISOString(), migratedBy: "setup" });

  await connectWorkspace(root, context);

  // Cursor gates project-configured MCP servers behind a one-time, per-project
  // enable (verified live on native Windows: every new project's source starts
  // "Disabled"). Remote hosts have historically started it without the toggle,
  // but the guidance is harmless there and vital on desktop.
  if (vscode.env.remoteName === undefined) {
    void vscode.window.showInformationMessage(
      "One more step from Cursor itself: it lists this project's goal-guardian server as Disabled until you enable it once — Settings → MCP → goal-guardian → turn on this project's source.",
    );
  }

  const gitignore = await vscode.window.showQuickPick(["Yes", "No"], {
    title: "Add .cursor/goal-guardian/telemetry/ to .gitignore?",
    placeHolder: "Telemetry files are machine-written and per-session",
  });
  if (gitignore === "Yes") {
    const giPath = path.join(root, ".gitignore");
    const existing = await fs.readFile(giPath, "utf8").catch(() => "");
    if (!existing.includes(".cursor/goal-guardian/telemetry/")) {
      await fs.writeFile(giPath, `${existing.replace(/\n?$/, "\n")}.cursor/goal-guardian/telemetry/\n`, "utf8");
    }
  }
  return true;
}

/** Remove everything setup created: guardian dir, rule, hook entries, MCP server entry. */
export async function runUninstall(root: string): Promise<void> {
  await fs.rm(getGuardianPaths(root).dir, { recursive: true, force: true });
  await fs.rm(path.join(root, GUARDIAN_RULE_RELATIVE_PATH), { force: true });
  await unwireUserLevelMcp();
  for (const skill of GUARDIAN_SKILLS) {
    await fs.rm(path.join(root, skill.relativeDir), { recursive: true, force: true });
  }

  const hooksPath = path.join(root, ".cursor", "hooks.json");
  const hooks = await readJsonOr<{ version?: number; hooks?: Record<string, Array<{ command: string }>> } | null>(hooksPath, null);
  if (hooks?.hooks) {
    for (const [event, entries] of Object.entries(hooks.hooks)) {
      hooks.hooks[event] = entries.filter((e) => !isGuardianHookCommand(e?.command));
      if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
    }
    // "Leaves no trace" means no trace: a shell holding nothing but our own
    // scaffolding is deleted, a file with someone else's hooks is preserved.
    if (Object.keys(hooks.hooks).length === 0) await fs.rm(hooksPath, { force: true });
    else await writeJsonAtomic(hooksPath, hooks);
  }

  const mcpPath = path.join(root, ".cursor", "mcp.json");
  const mcp = await readJsonOr<{ mcpServers?: Record<string, unknown> } | null>(mcpPath, null);
  if (mcp?.mcpServers && "goal-guardian" in mcp.mcpServers) {
    delete mcp.mcpServers["goal-guardian"];
    if (Object.keys(mcp.mcpServers).length === 0 && Object.keys(mcp).length === 1) await fs.rm(mcpPath, { force: true });
    else await writeJsonAtomic(mcpPath, mcp);
  }

  // Empty parent folders we created are litter too; rmdir refuses non-empty
  // ones, which is exactly the safety we want.
  for (const dir of ["rules", "skills", ""]) {
    await fs.rmdir(path.join(root, ".cursor", dir)).catch(() => undefined);
  }
}
