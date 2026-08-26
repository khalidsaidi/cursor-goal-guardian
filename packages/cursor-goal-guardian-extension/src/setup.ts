import * as vscode from "vscode";
import { spawnSync } from "node:child_process";
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

export interface NodeInvocation {
  /** Absolute path to a Node.js runtime, or the bare name "node" (PATH). */
  exe: string;
  /** Extra env for MCP server entries (the run-Electron-as-Node fallback). */
  mcpEnv?: Record<string, string>;
  /** Env prefix for the hook shell command (POSIX Electron fallback). */
  hookPrefix?: string;
  /** True when even the fallback can't run the hook on this platform. */
  hookUnavailable?: boolean;
}

function pathHasNode(): boolean {
  const probe = process.platform === "win32" ? "node.exe" : "node";
  const result = spawnSync(probe, ["--version"], { timeout: 3000, shell: process.platform === "win32" });
  return result.status === 0;
}

/**
 * A user's machine is not required to have Node.js. Resolution ladder:
 * 1. The runtime the extension host itself runs on — in Cursor's remote server
 *    (WSL/SSH) process.execPath IS a real node binary, present by definition.
 * 2. A node on PATH (typical desktop developer machine).
 * 3. Cursor's Electron binary run as Node (works for MCP via env everywhere,
 *    and for hooks on POSIX; on Windows without node the hook is honestly
 *    reported as unavailable instead of silently wired to a dead command).
 */
export function resolveNodeInvocation(
  execPath: string = process.execPath,
  hasPathNode: () => boolean = pathHasNode,
  platform: NodeJS.Platform = process.platform,
): NodeInvocation {
  const base = execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "node" || base === "node.exe") return { exe: execPath };
  if (hasPathNode()) return { exe: "node" };
  if (platform === "win32") {
    return { exe: execPath, mcpEnv: { ELECTRON_RUN_AS_NODE: "1" }, hookUnavailable: true };
  }
  return { exe: execPath, mcpEnv: { ELECTRON_RUN_AS_NODE: "1" }, hookPrefix: "ELECTRON_RUN_AS_NODE=1 " };
}

function quoteExe(exe: string): string {
  return exe === "node" ? "node" : `"${exe}"`;
}

function hookCommand(context: vscode.ExtensionContext, inv: NodeInvocation = resolveNodeInvocation()): string {
  return `${inv.hookPrefix ?? ""}${quoteExe(inv.exe)} "${bundledBinPaths(context).hook}"`;
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
function mcpServerEntry(context: vscode.ExtensionContext, inv: NodeInvocation, extraEnv?: Record<string, string>): Record<string, unknown> {
  const env = { ...(inv.mcpEnv ?? {}), ...(extraEnv ?? {}) };
  const entry: Record<string, unknown> = { command: inv.exe, args: [bundledBinPaths(context).mcp] };
  if (Object.keys(env).length > 0) entry.env = env;
  return entry;
}

export async function wireUserLevelMcp(context: vscode.ExtensionContext, inv: NodeInvocation = resolveNodeInvocation()): Promise<void> {
  const userMcpPath = path.join(process.env.GOAL_GUARDIAN_TEST_HOME ?? os.homedir(), ".cursor", "mcp.json");
  const config = await readJsonOr<{ mcpServers?: Record<string, unknown> }>(userMcpPath, {});
  config.mcpServers = config.mcpServers ?? {};
  const desired = mcpServerEntry(context, inv);
  if (JSON.stringify(config.mcpServers["goal-guardian"]) === JSON.stringify(desired)) return;
  config.mcpServers["goal-guardian"] = desired;
  await writeJsonAtomic(userMcpPath, config);
}

export async function unwireUserLevelMcp(): Promise<void> {
  const userMcpPath = path.join(process.env.GOAL_GUARDIAN_TEST_HOME ?? os.homedir(), ".cursor", "mcp.json");
  const config = await readJsonOr<{ mcpServers?: Record<string, { args?: string[] }> } | null>(userMcpPath, null);
  const entry = config?.mcpServers?.["goal-guardian"];
  if (config?.mcpServers && entry && entry.args?.some((a) => /goal-guardian-mcp/.test(a))) {
    delete config.mcpServers["goal-guardian"];
    await writeJsonAtomic(userMcpPath, config);
  }
}

/** Wire .cursor/hooks.json and .cursor/mcp.json to the bundled binaries, preserving unrelated entries. */
export async function wireIntegration(root: string, context: vscode.ExtensionContext, inv: NodeInvocation = resolveNodeInvocation()): Promise<void> {
  const cursorDir = path.join(root, ".cursor");
  await fs.mkdir(cursorDir, { recursive: true });

  if (!inv.hookUnavailable) {
    const hooksPath = path.join(cursorDir, "hooks.json");
    const hooks = await readJsonOr<{ version?: number; hooks?: Record<string, Array<{ command: string }>> }>(hooksPath, {});
    hooks.version = hooks.version ?? 1;
    hooks.hooks = hooks.hooks ?? {};
    for (const event of HOOK_EVENTS) {
      const entries = (hooks.hooks[event] ?? []).filter((e) => !isGuardianHookCommand(e?.command));
      entries.push({ command: hookCommand(context, inv) });
      hooks.hooks[event] = entries;
    }
    await writeJsonAtomic(hooksPath, hooks);
  } else {
    void vscode.window.showWarningMessage(
      "Goal Guardian: the background watcher needs Node.js, which wasn't found on this machine. " +
        "Everything else works; install Node.js and run Setup again to enable it.",
    );
  }

  const mcpPath = path.join(cursorDir, "mcp.json");
  const mcp = await readJsonOr<{ mcpServers?: Record<string, unknown> }>(mcpPath, {});
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers["goal-guardian"] = mcpServerEntry(context, inv, { GOAL_GUARDIAN_WORKSPACE_ROOT: root });
  await writeJsonAtomic(mcpPath, mcp);
}

export function isGuardianHookCommand(command: unknown): boolean {
  return typeof command === "string" && /goal-guardian-hook/.test(command);
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
export async function doctorIntegration(root: string, context: vscode.ExtensionContext, inv: NodeInvocation = resolveNodeInvocation()): Promise<void> {
  const hooksPath = path.join(root, ".cursor", "hooks.json");
  const hooks = await readJsonOr<{ hooks?: Record<string, Array<{ command: string }>> } | null>(hooksPath, null);
  if (hooks?.hooks && !inv.hookUnavailable) {
    let changed = false;
    const current = hookCommand(context, inv);
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
  if (entry && Array.isArray(entry.args) && entry.args.some((a) => /goal-guardian-mcp/.test(a))) {
    const desired = mcpServerEntry(context, inv, { GOAL_GUARDIAN_WORKSPACE_ROOT: root });
    if (JSON.stringify(entry) !== JSON.stringify(desired)) {
      mcp!.mcpServers!["goal-guardian"] = desired as never;
      await writeJsonAtomic(mcpPath, mcp);
    }
  }

  // The hub reads the user-level registration; keep its runtime fresh too.
  await wireUserLevelMcp(context, inv);
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
  await wireUserLevelMcp(context);
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
  await unwireUserLevelMcp();
  for (const skill of GUARDIAN_SKILLS) {
    await fs.rm(path.join(root, skill.relativeDir), { recursive: true, force: true });
  }

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
