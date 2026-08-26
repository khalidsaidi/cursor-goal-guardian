import * as vscode from "vscode";
import fs from "node:fs/promises";
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
  readJsonFile,
  writeJsonAtomic,
} from "@goal-guardian/core";

export function bundledBinPaths(context: vscode.ExtensionContext): { hook: string; mcp: string } {
  return {
    hook: path.join(context.extensionPath, "bin", "goal-guardian-hook.cjs"),
    mcp: path.join(context.extensionPath, "bin", "goal-guardian-mcp.mjs"),
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
  return `node "${bundledBinPaths(context).hook}"`;
}

async function readJsonOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return (await readJsonFile(filePath)) as T;
  } catch {
    return fallback;
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
  mcp.mcpServers["goal-guardian"] = {
    command: "node",
    args: [bundledBinPaths(context).mcp],
    env: { GOAL_GUARDIAN_WORKSPACE_ROOT: root },
  };
  await writeJsonAtomic(mcpPath, mcp);
}

export function isGuardianHookCommand(command: unknown): boolean {
  return typeof command === "string" && /goal-guardian-hook/.test(command);
}

async function writeGuardianRule(root: string): Promise<void> {
  const rulePath = path.join(root, GUARDIAN_RULE_RELATIVE_PATH);
  await fs.mkdir(path.dirname(rulePath), { recursive: true });
  await fs.writeFile(rulePath, guardianRuleContent(), "utf8");
}

/**
 * Doctor pass: extension updates change the bundled binary paths, so silently
 * repoint any guardian entries that reference a stale extension directory.
 * Runs only when guardian files already exist; writes only when needed.
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
  const mcp = await readJsonOr<{ mcpServers?: Record<string, { args?: string[] }> } | null>(mcpPath, null);
  const entry = mcp?.mcpServers?.["goal-guardian"];
  if (entry && Array.isArray(entry.args)) {
    const current = bundledBinPaths(context).mcp;
    if (entry.args.some((a) => /goal-guardian-mcp/.test(a) && a !== current)) {
      entry.args = entry.args.map((a) => (/goal-guardian-mcp/.test(a) ? current : a));
      await writeJsonAtomic(mcpPath, mcp);
    }
  }
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

  await wireIntegration(root, context);
  await writeGuardianRule(root);

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

  const hooksPath = path.join(root, ".cursor", "hooks.json");
  const hooks = await readJsonOr<{ hooks?: Record<string, Array<{ command: string }>> } | null>(hooksPath, null);
  if (hooks?.hooks) {
    for (const [event, entries] of Object.entries(hooks.hooks)) {
      hooks.hooks[event] = entries.filter((e) => !isGuardianHookCommand(e?.command));
      if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
    }
    await writeJsonAtomic(hooksPath, hooks);
  }

  const mcpPath = path.join(root, ".cursor", "mcp.json");
  const mcp = await readJsonOr<{ mcpServers?: Record<string, unknown> } | null>(mcpPath, null);
  if (mcp?.mcpServers && "goal-guardian" in mcp.mcpServers) {
    delete mcp.mcpServers["goal-guardian"];
    await writeJsonAtomic(mcpPath, mcp);
  }
}
