import path from "node:path";
import type { GuardianConfig } from "../schema/config.js";
import type { GuardianState } from "../schema/state.js";

export type DriftActionType = "shell" | "mcp" | "read" | "edit";

export interface LexicalDriftResult {
  activeTaskId: string;
  activeTaskTitle: string;
  sensitivity: "strict" | "balanced" | "lenient";
  confidence: "low" | "medium" | "high";
  taskTerms: string[];
  actionTerms: string[];
}

const scopeStopWords = new Set([
  "about", "again", "all", "also", "and", "are", "been", "being", "but", "can",
  "for", "from", "have", "into", "its", "just", "not", "off", "that", "the",
  "their", "then", "this", "those", "through", "with", "your",
]);

const genericTaskTerms = new Set([
  "add", "app", "application", "build", "change", "component", "create",
  "feature", "fix", "implement", "module", "page", "project", "refactor",
  "simple", "support", "task", "tasks", "update", "work",
]);

const genericActionTerms = new Set([
  "add", "awk", "bash", "cat", "cd", "check", "cmd", "command", "cp", "css",
  "curl", "delete", "dev", "diff", "docker", "echo", "file", "find", "git",
  "grep", "head", "install", "jest", "json", "js", "jsx", "lint", "log", "ls",
  "mcp", "mkdir", "move", "mv", "node", "npm", "npx", "package", "path",
  "pnpm", "pwd", "py", "python", "read", "remove", "rg", "run", "script",
  "sed", "sh", "shell", "src", "tail", "test", "tool", "touch", "ts", "tsx",
  "txt", "typecheck", "update", "vite", "write", "yarn",
]);

function tokenizeScope(text: string): string[] {
  const parts = text
    .toLowerCase()
    .replace(/[`"'()[\]{}:,;=]+/g, " ")
    .split(/[\s/\\|._:-]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of parts) {
    if (token.length < 3) continue;
    if (/^\d+$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function scopeTerms(parts: string[], generic: Set<string>): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const token of tokenizeScope(part)) {
      if (scopeStopWords.has(token)) continue;
      if (generic.has(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      terms.push(token);
    }
  }
  return terms;
}

function isNeutralShellCommand(cmd: string, extra: string[]): boolean {
  const c = cmd.trim().toLowerCase();
  if (!c) return true;
  if (/^(git)\s+(status|diff|log|show|branch|rev-parse|fetch|pull)\b/.test(c)) return true;
  if (/^(ls|pwd|echo|cat|head|tail|which|type)\b/.test(c)) return true;
  if (/^(node|npm|pnpm|yarn)\s+-v\b/.test(c)) return true;
  if (/^(npm|pnpm|yarn)\s+(install|add|remove|uninstall|up|update)\b/.test(c)) return true;
  if (/^(npm|pnpm|yarn)\s+((run)\s+)?(test|build|lint|typecheck|dev|start|check)\b/.test(c)) return true;
  return extra.some((prefix) => prefix.trim().length > 0 && c.startsWith(prefix.trim().toLowerCase()));
}

function isNeutralReadPath(rel: string, extra: string[]): boolean {
  const p = rel.trim().toLowerCase();
  if (!p) return true;
  // Paths outside the workspace (../..) are editor/plugin machinery, not the
  // user's work — never drift signal.
  if (p.startsWith("..")) return true;
  if (p.startsWith(".cursor/")) return true;
  const base = path.posix.basename(p);
  if (["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "readme.md"].includes(base)) return true;
  if (base === "tsconfig.json" || /^tsconfig\..*\.json$/.test(base)) return true;
  if (/^vite\.config\./.test(base)) return true;
  return extra.some((prefix) => {
    const norm = prefix.trim().toLowerCase().replace(/^\/+/, "");
    return norm.length > 0 && (p === norm || p.startsWith(`${norm}/`) || p.startsWith(norm));
  });
}

function matchesPinnedContext(state: GuardianState, actionType: DriftActionType, actionValue: string): boolean {
  if (state.pinnedContext.length === 0) return false;
  const value = actionValue.toLowerCase();
  if (actionType === "read" || actionType === "edit") {
    return state.pinnedContext.some((ctx) => {
      const norm = ctx.trim().toLowerCase().replace(/^\/+/, "");
      return norm.length > 0 && (value === norm || value.startsWith(`${norm}/`));
    });
  }
  if (actionType === "shell") {
    return state.pinnedContext.some((ctx) => {
      const norm = ctx.trim().toLowerCase();
      return norm.length > 0 && value.includes(norm);
    });
  }
  return false;
}

function normalizeScopeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

export function hasScopeOverlap(taskTerms: string[], actionTerms: string[]): boolean {
  const taskSet = new Set(taskTerms);
  const normalizedTask = taskTerms.map(normalizeScopeToken);

  for (const actionToken of actionTerms) {
    if (taskSet.has(actionToken)) return true;
    const normAction = normalizeScopeToken(actionToken);
    for (let i = 0; i < taskTerms.length; i += 1) {
      const t = taskTerms[i]!;
      const nt = normalizedTask[i]!;
      if (normAction === nt) return true;
      if (normAction.length >= 5 && nt.length >= 5 && (normAction.startsWith(nt) || nt.startsWith(normAction))) return true;
      if (actionToken.length >= 6 && t.length >= 6 && (actionToken.startsWith(t) || t.startsWith(actionToken))) return true;
    }
  }
  return false;
}

/** The active task's scope vocabulary (title + linked criterion + goal), for agent self-checks. */
export function taskScopeKeywords(state: GuardianState): string[] {
  const activeTaskId = state.activeTaskId?.trim() ?? "";
  if (!activeTaskId) return [];
  const task = state.tasks.find((t) => t.id === activeTaskId) ?? null;
  const title = (task?.title ?? activeTaskId).trim();
  const criterion = task?.criterionId
    ? state.successCriteria.find((c) => c.id === task.criterionId)?.text ?? null
    : null;
  const parts = [title];
  if (criterion) parts.push(criterion);
  if (state.goal.trim()) parts.push(state.goal);
  return scopeTerms(parts, genericTaskTerms);
}

/**
 * Lexical drift check: does this action share any vocabulary with the active
 * task (title + linked success criterion + goal)? Null means "no drift signal"
 * — either the action is in scope, neutral, pinned, or there is too little
 * signal to judge at the configured sensitivity.
 */
export function evaluateLexicalDrift(
  state: GuardianState | null,
  config: GuardianConfig,
  actionType: DriftActionType,
  actionValue: string,
): LexicalDriftResult | null {
  if (!config.drift.lexical.enabled) return null;
  if (!state) return null;

  const activeTaskId = state.activeTaskId?.trim() ?? "";
  if (!activeTaskId) return null;

  const neutralCommands = config.advisories.neutralCommands;
  const neutralPaths = config.advisories.neutralPaths;
  if (actionType === "shell" && isNeutralShellCommand(actionValue, neutralCommands)) return null;
  if ((actionType === "read" || actionType === "edit") && isNeutralReadPath(actionValue, neutralPaths)) return null;
  if (actionType === "mcp") {
    const lower = actionValue.toLowerCase();
    // The guardian's own tools are never drift, even when the host omits the
    // server name from the hook payload (value like "/guardian_get_status").
    if (lower.startsWith("goal-guardian/")) return null;
    const tool = lower.slice(lower.lastIndexOf("/") + 1);
    if (tool.startsWith("guardian_")) return null;
  }
  if (matchesPinnedContext(state, actionType, actionValue)) return null;

  const task = state.tasks.find((t) => t.id === activeTaskId) ?? null;
  const title = (task?.title ?? activeTaskId).trim();
  if (!title) return null;

  const criterion = task?.criterionId
    ? state.successCriteria.find((c) => c.id === task.criterionId)?.text ?? null
    : null;

  const taskTextParts = [title];
  if (criterion) taskTextParts.push(criterion);
  if (state.goal.trim()) taskTextParts.push(state.goal);

  const taskTerms = scopeTerms(taskTextParts, genericTaskTerms);
  const actionTerms = scopeTerms([actionValue], genericActionTerms);
  const sensitivity = config.drift.lexical.sensitivity;

  const minTaskTerms = sensitivity === "strict" ? 1 : 2;
  const minActionTerms = sensitivity === "strict" ? 1 : sensitivity === "balanced" ? 2 : 3;

  if (taskTerms.length < minTaskTerms) return null;
  if (actionTerms.length < minActionTerms) return null;
  if (hasScopeOverlap(taskTerms, actionTerms)) return null;

  return {
    activeTaskId,
    activeTaskTitle: title,
    sensitivity,
    confidence: actionTerms.length >= 4 ? "high" : actionTerms.length === 3 ? "medium" : "low",
    taskTerms: taskTerms.slice(0, 6),
    actionTerms: actionTerms.slice(0, 6),
  };
}
