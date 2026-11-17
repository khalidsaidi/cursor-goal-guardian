import * as vscode from "vscode";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  criteriaFromTexts,
  defaultConfig,
  ensureGuardianFiles,
  fileExists,
  getGuardianPaths,
  GOAL_LOOP_LIMIT,
  guardianRuleContent,
  GUARDIAN_RULE_RELATIVE_PATH,
  GUARDIAN_SKILLS,
  processLease,
  writeContract,
  writeJsonAtomic,
} from "@goal-guardian/core";

/**
 * The VSIX ships self-contained native executables (per-platform targeted
 * packages). Nothing else
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
  "afterFileEdit",
  // The goal loop: the user's words, what commands printed, and the end of each turn.
  "beforeSubmitPrompt",
  "afterShellExecution",
  "postToolUse",
  "postToolUseFailure",
  "stop",
];

const GOAL_HOOK_EVENTS = ["beforeSubmitPrompt", "afterShellExecution", "postToolUse", "postToolUseFailure", "stop"];

type HookEntry = { command: string; loop_limit?: number };

/** Cursor's own cap on stop-hook follow-ups backs up Guardian's. */
function hookEntry(event: string, context: vscode.ExtensionContext): HookEntry {
  return event === "stop" ? { command: hookCommand(context), loop_limit: GOAL_LOOP_LIMIT } : { command: hookCommand(context) };
}

function hookCommand(context: vscode.ExtensionContext): string {
  return `"${bundledBinPaths(context).hook}"`;
}

async function readJsonOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Could not read ${filePath} as a JSON object. Check the file and try again.`);
  }
}

type McpConfig = { mcpServers?: Record<string, unknown> };

function guardianServer(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const { command, args } = entry as { command?: unknown; args?: unknown };
  const paths = [command, ...(Array.isArray(args) ? args : [])];
  return paths.some(p => typeof p === "string" && /(?:^|[\\/])(?:cursor-)?goal-guardian-mcp(?:\.exe|[\\/]dist[\\/]index\.js)?$/i.test(p));
}

async function readMcp(file: string): Promise<McpConfig> {
  const config = await readJsonOr<McpConfig>(file, {});
  if ("mcpServers" in config && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) {
    throw new Error(`Check the mcpServers setting in ${file} before connecting Guardian.`);
  }
  return config;
}

function mcpServerEntry(context: vscode.ExtensionContext, root?: string) {
  return { command: bundledBinPaths(context).mcp, ...(root ? { env: { GOAL_GUARDIAN_WORKSPACE_ROOT: root } } : {}) };
}

function userHome(): string {
  return process.env.GOAL_GUARDIAN_TEST_HOME ?? os.homedir();
}

async function isUserHome(root: string): Promise<boolean> {
  return path.relative(await fs.realpath(userHome()), await fs.realpath(root)) === "";
}

function checkServerName(config: McpConfig, file: string): void {
  if (config.mcpServers && "goal-guardian" in config.mcpServers && !guardianServer(config.mcpServers["goal-guardian"])) {
    throw new Error(`The name goal-guardian is already in use in ${file}.`);
  }
}

/** The agent hub uses one registration across windows. Older installs have no list of owners. */
async function updateHubRegistration(root: string, context?: vscode.ExtensionContext): Promise<void> {
  const cursorDir = path.join(userHome(), ".cursor");
  const file = path.join(cursorDir, "mcp.json");
  const ownersFile = path.join(cursorDir, "goal-guardian-workspaces.json");
  const lock = path.join(cursorDir, "goal-guardian-workspaces.lock");
  const deadline = Date.now() + 5000;
  let release = processLease(lock);
  while (!release) {
    if (Date.now() >= deadline) throw new Error("Another Cursor window is updating Guardian. Try again.");
    await new Promise(resolve => setTimeout(resolve, 50));
    release = processLease(lock);
  }
  try {
    const config = await readMcp(file);
    const entry = config.mcpServers?.["goal-guardian"];
    const owners = await readJsonOr(ownersFile, { workspaces: [] as string[], legacy: guardianServer(entry) });
    if (typeof owners.legacy !== "boolean" || !Array.isArray(owners.workspaces) || !owners.workspaces.every(p => typeof p === "string" && path.isAbsolute(p))) {
      throw new Error(`Check the Guardian workspace list in ${ownersFile}.`);
    }
    const workspace = await fs.realpath(root);
    const remaining = owners.workspaces.filter(p => path.relative(p, workspace) !== "");
    if (context) {
      checkServerName(config, file);
      if (remaining.length === owners.workspaces.length) {
        owners.workspaces.push(workspace);
        await writeJsonAtomic(ownersFile, owners);
      }
      const desired = mcpServerEntry(context);
      if (JSON.stringify(entry) !== JSON.stringify(desired)) {
        config.mcpServers ??= {};
        config.mcpServers["goal-guardian"] = desired;
        await writeJsonAtomic(file, config);
      }
    } else if (remaining.length !== owners.workspaces.length) {
      if (!remaining.length && !owners.legacy) {
        if (config.mcpServers && guardianServer(entry)) {
          delete config.mcpServers["goal-guardian"];
          await writeJsonAtomic(file, config);
        }
        await fs.rm(ownersFile, { force: true });
      } else {
        await writeJsonAtomic(ownersFile, { ...owners, workspaces: remaining });
      }
    }
  } finally {
    release();
  }
}

/** Wire .cursor/hooks.json and .cursor/mcp.json to the bundled binaries, preserving unrelated entries. */
export async function wireIntegration(root: string, context: vscode.ExtensionContext): Promise<void> {
  const cursorDir = path.join(root, ".cursor");
  await fs.mkdir(cursorDir, { recursive: true });

  const hooksPath = path.join(cursorDir, "hooks.json");
  const hooks = await readJsonOr<{ version?: number; hooks?: Record<string, HookEntry[]> }>(hooksPath, {});
  hooks.version = hooks.version ?? 1;
  hooks.hooks = hooks.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const entries = (hooks.hooks[event] ?? []).filter((e) => !isGuardianHookCommand(e?.command));
    entries.push(hookEntry(event, context));
    hooks.hooks[event] = entries;
  }
  const mcpPath = path.join(cursorDir, "mcp.json");
  const shared = await isUserHome(root);
  const mcp = await readMcp(mcpPath);
  checkServerName(mcp, mcpPath);
  await updateHubRegistration(root, context);
  await writeJsonAtomic(hooksPath, hooks);
  if (!shared) {
    mcp.mcpServers ??= {};
    mcp.mcpServers["goal-guardian"] = mcpServerEntry(context, root);
    await writeJsonAtomic(mcpPath, mcp);
  }
}

export function isGuardianHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  // Match our executable, or an older Node launcher whose script was under the hook package.
  return /^(?:["']?)(?:[^"']*[\\/])?goal-guardian-hook(?:\.exe)?["']?$/i.test(command)
    || /[\\/](?:cursor-)?goal-guardian-hook[\\/]dist[\\/]cli\.js["']?$/i.test(command);
}

/**
 * The full connection: watcher wiring, hub registration, session rule, skills.
 * Used by the invited Setup flow and by the 0.4.x upgrade — a migrated user
 * already opted in, and without this their agent never learns the protocol.
 */
export async function connectWorkspace(root: string, context: vscode.ExtensionContext): Promise<void> {
  await wireIntegration(root, context);
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
  // The rule is the agent's instructions: an update that changes them has to reach workspaces already connected.
  const rule = path.join(root, GUARDIAN_RULE_RELATIVE_PATH);
  if (await fileExists(rule) && (await fs.readFile(rule, "utf8")) !== guardianRuleContent()) await fs.writeFile(rule, guardianRuleContent(), "utf8");

  const hooksPath = path.join(root, ".cursor", "hooks.json");
  const hooks = await readJsonOr<{ hooks?: Record<string, HookEntry[]> } | null>(hooksPath, null);
  if (hooks?.hooks) {
    let changed = false;
    // Reads and Tab completions (the person typing): nothing listens to them any more.
    for (const event of ["beforeReadFile", "beforeTabFileRead", "afterTabFileEdit"]) {
      const entries = hooks.hooks[event];
      if (entries?.some((e) => isGuardianHookCommand(e?.command))) {
        const others = entries.filter((e) => !isGuardianHookCommand(e?.command));
        if (others.length) hooks.hooks[event] = others;
        else delete hooks.hooks[event];
        changed = true;
      }
    }
    const current = hookCommand(context);
    // Workspaces wired before the goal loop existed get its hooks, if Guardian is wired at all.
    const wired = Object.values(hooks.hooks).some((entries) => entries.some((e) => isGuardianHookCommand(e?.command)));
    for (const event of wired ? GOAL_HOOK_EVENTS : []) {
      if (!(hooks.hooks[event] ?? []).some((e) => isGuardianHookCommand(e?.command))) {
        hooks.hooks[event] = [...(hooks.hooks[event] ?? []), hookEntry(event, context)];
        changed = true;
      }
    }
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
  const mcp = await readMcp(mcpPath);
  const entry = mcp.mcpServers?.["goal-guardian"];
  if (mcp.mcpServers && guardianServer(entry) && !(await isUserHome(root))) {
    const desired = mcpServerEntry(context, root);
    if (JSON.stringify(entry) !== JSON.stringify(desired)) {
      mcp.mcpServers["goal-guardian"] = desired;
      await writeJsonAtomic(mcpPath, mcp);
    }
  }
  await updateHubRegistration(root, context);
}

/** The invited setup flow: goal -> criteria -> constraints (all skippable), then files + wiring. */
/** What the in-panel connect form submits. Everything optional except the shape. */
export interface SetupForm {
  goal: string;
  criteria: string[];
  constraints: string[];
  gitignore: boolean;
}

/**
 * The invited setup: called by the panel's connect form (the only setup UI —
 * no input boxes, no delimiters, no palette). Scaffolds files, records the
 * goal, wires the recorder and agent tools, and offers the one Cursor-side
 * step. Empty form values are fine: the user's first agent request becomes
 * the goal (rule-driven).
 */
export async function applySetup(root: string, context: vscode.ExtensionContext, form: SetupForm): Promise<void> {
  const clean = (values: string[]): string[] => values.map((s) => s.trim()).filter(Boolean);

  const p = getGuardianPaths(root);
  await connectWorkspace(root, context);
  await ensureGuardianFiles(root);
  if (!(await fileExists(p.config))) await writeJsonAtomic(p.config, defaultConfig());

  await writeContract(root, {
    schemaVersion: 2,
    goal: form.goal.trim(),
    successCriteria: criteriaFromTexts(clean(form.criteria)),
    constraints: clean(form.constraints),
  });
  await writeJsonAtomic(p.migrationMarker, { from: 2, to: 2, ts: new Date().toISOString(), migratedBy: "setup" });

  offerMcpEnableGuidance();

  if (form.gitignore) {
    const giPath = path.join(root, ".gitignore");
    const existing = await fs.readFile(giPath, "utf8").catch(err => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    });
    if (!existing.includes(".cursor/goal-guardian/telemetry/")) {
      await fs.writeFile(giPath, `${existing.replace(/\n?$/, "\n")}.cursor/goal-guardian/telemetry/\n`, "utf8");
    }
  }
}

/**
 * Cursor gates project-configured MCP servers behind a one-time, per-project
 * enable (verified live on native Windows: every new project's source starts
 * "Disabled"). Guide the user straight to the switch: one button that opens
 * Cursor's own MCP settings screen (workbench.action.openMCPSettings — no
 * per-server deep link exists). Remote hosts have historically started the
 * server without the toggle, so the guidance is desktop-only.
 */
export function offerMcpEnableGuidance(): void {
  if (vscode.env.remoteName !== undefined) return;
  const open = "Open MCP Settings";
  void vscode.window
    .showInformationMessage(
      "One more step from Cursor itself: it lists this project's goal-guardian server as Disabled until you switch it on once. Find goal-guardian in the list and enable this project's source.",
      open,
    )
    .then((choice) => {
      if (choice === open) void vscode.commands.executeCommand("workbench.action.openMCPSettings");
    });
}

/** Remove everything setup created: guardian dir, rule, hook entries, MCP server entry. */
export async function runUninstall(root: string): Promise<void> {
  const hooksPath = path.join(root, ".cursor", "hooks.json");
  const hooks = await readJsonOr<{ version?: number; hooks?: Record<string, HookEntry[]> } | null>(hooksPath, null);
  const mcpPath = path.join(root, ".cursor", "mcp.json");
  const shared = await isUserHome(root);
  const mcp = await readMcp(mcpPath);
  await updateHubRegistration(root);
  if (hooks?.hooks) {
    for (const [event, entries] of Object.entries(hooks.hooks)) {
      hooks.hooks[event] = entries.filter((e) => !isGuardianHookCommand(e?.command));
      if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
    }
    // "Leaves no trace" means no trace: a shell holding nothing but our own
    // scaffolding is deleted, a file with someone else's hooks is preserved.
    if (Object.keys(hooks.hooks).length === 0 && Object.keys(hooks).every(k => k === "hooks" || k === "version")) await fs.rm(hooksPath, { force: true });
    else await writeJsonAtomic(hooksPath, hooks);
  }

  if (!shared && mcp.mcpServers && guardianServer(mcp.mcpServers["goal-guardian"])) {
    delete mcp.mcpServers["goal-guardian"];
    if (Object.keys(mcp.mcpServers).length === 0 && Object.keys(mcp).length === 1) await fs.rm(mcpPath, { force: true });
    else await writeJsonAtomic(mcpPath, mcp);
  }

  await fs.rm(getGuardianPaths(root).dir, { recursive: true, force: true });
  await fs.rm(path.join(root, GUARDIAN_RULE_RELATIVE_PATH), { force: true });
  for (const skill of GUARDIAN_SKILLS) {
    await fs.rm(path.join(root, skill.relativeDir), { recursive: true, force: true });
  }

  // Empty parent folders we created are litter too; rmdir refuses non-empty
  // ones, which is exactly the safety we want.
  for (const dir of ["rules", "skills", ""]) {
    await fs.rmdir(path.join(root, ".cursor", dir)).catch(() => undefined);
  }

  // The .gitignore line setup offered: take back exactly our line, and the
  // file itself only when nothing else ever lived in it.
  const giPath = path.join(root, ".gitignore");
  const gi = await fs.readFile(giPath, "utf8").catch(() => null);
  if (gi !== null && gi.includes(".cursor/goal-guardian/telemetry/")) {
    const kept = gi.split("\n").filter((line) => line.trim() !== ".cursor/goal-guardian/telemetry/");
    if (kept.every((line) => line.trim() === "")) await fs.rm(giPath, { force: true });
    else await fs.writeFile(giPath, kept.join("\n"), "utf8");
  }
}
