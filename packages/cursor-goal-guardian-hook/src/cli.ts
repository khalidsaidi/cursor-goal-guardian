#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { minimatch } from "minimatch";
import { fallback } from "fallback-chain-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  defaultPolicy,
  defaultWarningConfig,
  type GoalGuardianPolicy,
  type TaskScopeSensitivity,
  type PolicySeverity,
  type PolicyRule,
} from "./policy.js";
import {
  loadViolations,
  saveViolations,
  shouldResetWarnings,
  getWarningCount,
  incrementWarning,
  resetWarnings,
  type ViolationTracker,
} from "./violations.js";

/**
 * Cursor Goal Guardian Hook Gatekeeper
 *
 * Cursor hooks (per public examples) send JSON via stdin and expect JSON via stdout:
 * - beforeShellExecution / beforeMCPExecution / beforeReadFile can allow/deny/ask (continue + permission)
 * - afterFileEdit is informational, but your script can still run side effects (e.g., logging).
 *
 * IMPORTANT:
 *  - Do NOT write anything to stdout except the JSON response Cursor expects.
 *  - Use stderr for logs.
 */

type Permit = {
  token: string;
  step_id: string;
  issued_at: string;
  expires_at: string;
  allow: {
    shell: string[];
    mcp: string[];
    read: string[];
    write: string[];
  };
};

type PermitsDoc = { permits: Permit[] };

type PreviewResult = {
  wouldSucceed: boolean;
  severity: "HIGH_RISK" | "WARN" | "PERMIT_REQUIRED" | "ALLOWED";
  reason: string;
  warningCount?: number;
  maxWarnings?: number;
  suggestedPermitRequest?: {
    step: string;
    maps_to: string[];
    allow_field: "allow_shell" | "allow_mcp" | "allow_read" | "allow_write";
    allow_pattern: string;
  };
};

function toPosixRel(p: string): string {
  return p.split(path.sep).join("/");
}

function globAny(patterns: string[], value: string): boolean {
  return patterns.some((pat) => minimatch(value, pat, { dot: true, nocase: true }));
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readJson<T>(filePath: string, fallbackValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallbackValue;
  }
}

async function resolveWorkspaceRoot(payload: any): Promise<string> {
  return fallback([
    () => {
      const roots = payload?.workspace_roots;
      if (Array.isArray(roots) && roots.length > 0 && typeof roots[0] === "string") return roots[0];
      throw new Error("no workspace_roots");
    },
    () => process.cwd(),
  ]);
}

async function resolveHookEventName(payload: any): Promise<string> {
  const keys = ["hook_event_name", "hookEventName", "event", "name"];
  try {
    return await fallback(
      keys.map((k) => () => {
        const v = payload?.[k];
        if (typeof v !== "string" || v.trim().length === 0) throw new Error("missing");
        return v;
      }),
    );
  } catch {
    return "unknown";
  }
}

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return null;
  return next;
}

function resolveMcpPath(): string | null {
  return (
    getArgValue("--mcp") ??
    getArgValue("--mcpPath") ??
    process.env.GOAL_GUARDIAN_MCP_PATH ??
    null
  );
}

async function previewViaMcp(
  mcpPath: string,
  workspaceRoot: string,
  actionType: "shell" | "mcp" | "read" | "write",
  actionValue: string
): Promise<PreviewResult | null> {
  const client = new Client({ name: "goal-guardian-hook", version: "0.3.3" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [mcpPath],
    env: { GOAL_GUARDIAN_WORKSPACE_ROOT: workspaceRoot },
  });

  try {
    await client.connect(transport);
    const res = await client.callTool({
      name: "guardian_preview_action",
      arguments: {
        action_type: actionType,
        action_value: actionValue,
        record_warning: true,
      },
    });
    const text = (res as any)?.content?.[0]?.text ?? "{}";
    return JSON.parse(text) as PreviewResult;
  } catch {
    return null;
  } finally {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
}

function cursorResponseAllow(agentMessage?: string) {
  const res: any = { continue: true, permission: "allow" as const };
  if (agentMessage) res.agentMessage = agentMessage;
  return res;
}

type WarnContext = {
  warningCount: number;
  maxWarnings: number;
  suggestedAction: string;
  goalContext?: { goal: string; relevantCriteria: string[] };
};

function cursorResponseWarn(userMessage: string, agentMessage: string, context: WarnContext) {
  // Use "allow" permission since Cursor only recognizes allow/deny/ask
  // Warning info is conveyed via userMessage and agentMessage
  return {
    continue: true,
    permission: "allow" as const,
    userMessage,  // Shows warning to user
    agentMessage, // Tells agent about warning state
    // Include context for logging/debugging (Cursor may ignore these)
    _warning: {
      count: context.warningCount,
      max: context.maxWarnings,
      suggestedAction: context.suggestedAction,
      goalContext: context.goalContext,
    },
  };
}

type GoalContract = {
  goal: string;
  success_criteria: string[];
  constraints: string[];
};

type ReduxTask = {
  id: string;
  title?: string;
  status?: string;
};

type ReduxState = {
  goal?: string;
  definition_of_done?: string[];
  constraints?: string[];
  active_task?: string | null;
  tasks?: ReduxTask[];
  pinned_context?: string[];
};

async function loadContract(workspaceRoot: string): Promise<GoalContract | null> {
  const contractPath = path.join(workspaceRoot, ".cursor", "goal-guardian", "contract.json");
  try {
    const raw = await fs.readFile(contractPath, "utf8");
    return JSON.parse(raw) as GoalContract;
  } catch {
    return null;
  }
}

async function loadReduxState(workspaceRoot: string): Promise<ReduxState | null> {
  const statePath = path.join(workspaceRoot, ".cursor", "goal-guardian", "state.json");
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as ReduxState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isBootstrapReadPath(rel: string): boolean {
  return (
    rel.startsWith(".cursor/goal-guardian/") ||
    rel === ".cursor/hooks.json" ||
    rel === ".cursor/mcp.json"
  );
}

function activeTaskStatus(state: ReduxState, activeTaskId: string): string | null {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const task = tasks.find((t) => String(t?.id ?? "") === activeTaskId);
  if (!task) return null;
  return typeof task.status === "string" ? task.status : null;
}

function activeTask(state: ReduxState, activeTaskId: string): ReduxTask | null {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const task = tasks.find((t) => String(t?.id ?? "") === activeTaskId);
  return task ?? null;
}

function criterionTextForTask(state: ReduxState, taskId: string): string | null {
  const criteria = Array.isArray(state.definition_of_done) ? state.definition_of_done : [];
  if (criteria.length === 0) return null;

  const match = taskId.match(/^sc[_-]?(\d+)$/i) ?? taskId.match(/^task[_-]?(\d+)$/i);
  if (!match) return null;

  const idx = Number.parseInt(match[1] ?? "", 10) - 1;
  if (!Number.isFinite(idx) || idx < 0 || idx >= criteria.length) return null;
  const text = String(criteria[idx] ?? "").trim();
  return text.length > 0 ? text : null;
}

const scopeStopWords = new Set([
  "about",
  "again",
  "all",
  "also",
  "and",
  "are",
  "been",
  "being",
  "but",
  "can",
  "for",
  "from",
  "have",
  "into",
  "its",
  "just",
  "not",
  "off",
  "that",
  "the",
  "their",
  "then",
  "this",
  "those",
  "through",
  "with",
  "your",
]);

const genericTaskTerms = new Set([
  "add",
  "app",
  "application",
  "build",
  "change",
  "component",
  "create",
  "feature",
  "fix",
  "implement",
  "module",
  "page",
  "project",
  "refactor",
  "simple",
  "support",
  "task",
  "tasks",
  "update",
  "work",
]);

const genericActionTerms = new Set([
  "add",
  "awk",
  "bash",
  "cat",
  "cd",
  "check",
  "cmd",
  "command",
  "cp",
  "css",
  "curl",
  "delete",
  "dev",
  "diff",
  "docker",
  "echo",
  "file",
  "find",
  "git",
  "grep",
  "head",
  "install",
  "jest",
  "json",
  "js",
  "jsx",
  "lint",
  "log",
  "ls",
  "mcp",
  "mkdir",
  "move",
  "mv",
  "node",
  "npm",
  "npx",
  "package",
  "path",
  "pnpm",
  "pwd",
  "py",
  "python",
  "read",
  "remove",
  "rg",
  "run",
  "script",
  "sed",
  "sh",
  "shell",
  "src",
  "tail",
  "test",
  "tool",
  "touch",
  "ts",
  "tsx",
  "txt",
  "typecheck",
  "update",
  "vite",
  "write",
  "yarn",
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

function taskScopeTerms(parts: string[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    for (const token of tokenizeScope(part)) {
      if (scopeStopWords.has(token)) continue;
      if (genericTaskTerms.has(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      terms.push(token);
    }
  }
  return terms;
}

function actionScopeTerms(actionValue: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenizeScope(actionValue)) {
    if (scopeStopWords.has(token)) continue;
    if (genericActionTerms.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

function isNeutralShellCommand(cmd: string): boolean {
  const c = cmd.trim().toLowerCase();
  if (!c) return true;

  if (/^(git)\s+(status|diff|log|show|branch|rev-parse|fetch|pull)\b/.test(c)) return true;
  if (/^(ls|pwd|echo|cat|head|tail|which|type)\b/.test(c)) return true;
  if (/^(node|npm|pnpm|yarn)\s+-v\b/.test(c)) return true;
  if (/^(npm|pnpm|yarn)\s+(install|add|remove|uninstall|up|update)\b/.test(c)) return true;
  if (/^(npm|pnpm|yarn)\s+((run)\s+)?(test|build|lint|typecheck|dev|start|check)\b/.test(c)) return true;

  return false;
}

function isNeutralReadPath(rel: string): boolean {
  const p = rel.trim().toLowerCase();
  if (!p) return true;

  const base = path.posix.basename(p);
  if (
    base === "package.json" ||
    base === "package-lock.json" ||
    base === "pnpm-lock.yaml" ||
    base === "yarn.lock" ||
    base === "readme.md"
  ) {
    return true;
  }

  if (base === "tsconfig.json" || /^tsconfig\..*\.json$/.test(base)) return true;
  if (/^vite\.config\./.test(base)) return true;

  return false;
}

function matchesPinnedContext(state: ReduxState, actionType: "shell" | "mcp" | "read", actionValue: string): boolean {
  const pinned = Array.isArray(state.pinned_context) ? state.pinned_context : [];
  if (pinned.length === 0) return false;

  const value = actionValue.toLowerCase();
  if (actionType === "read") {
    return pinned.some((ctx) => {
      const norm = String(ctx ?? "").trim().toLowerCase().replace(/^\/+/, "");
      return norm.length > 0 && (value === norm || value.startsWith(`${norm}/`));
    });
  }

  if (actionType === "shell") {
    return pinned.some((ctx) => {
      const norm = String(ctx ?? "").trim().toLowerCase();
      return norm.length > 0 && value.includes(norm);
    });
  }

  return false;
}

type TaskScopeDrift = {
  activeTaskId: string;
  activeTaskTitle: string;
  sensitivity: TaskScopeSensitivity;
  confidence: "low" | "medium" | "high";
  taskTerms: string[];
  actionTerms: string[];
};

function resolveTaskScopeSensitivity(policy: GoalGuardianPolicy): TaskScopeSensitivity {
  const mode = String((policy as { taskScopeSensitivity?: unknown }).taskScopeSensitivity ?? "balanced");
  if (mode === "strict" || mode === "lenient" || mode === "balanced") return mode;
  return "balanced";
}

function normalizeScopeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function hasScopeOverlap(taskTerms: string[], actionTerms: string[]): boolean {
  const taskSet = new Set(taskTerms);
  const normalizedTask = taskTerms.map(normalizeScopeToken);

  for (const actionToken of actionTerms) {
    if (taskSet.has(actionToken)) return true;
    const normAction = normalizeScopeToken(actionToken);

    for (let i = 0; i < taskTerms.length; i += 1) {
      const t = taskTerms[i]!;
      const nt = normalizedTask[i]!;
      if (normAction === nt) return true;
      if (normAction.length >= 5 && nt.length >= 5) {
        if (normAction.startsWith(nt) || nt.startsWith(normAction)) return true;
      }
      if (actionToken.length >= 6 && t.length >= 6) {
        if (actionToken.startsWith(t) || t.startsWith(actionToken)) return true;
      }
    }
  }

  return false;
}

function evaluateTaskScopeDrift(
  policy: GoalGuardianPolicy,
  state: ReduxState | null,
  actionType: "shell" | "mcp" | "read",
  actionValue: string
): TaskScopeDrift | null {
  if (!state) return null;

  const activeTaskId = String(state.active_task ?? "").trim();
  if (!activeTaskId) return null;

  if (actionType === "shell" && isNeutralShellCommand(actionValue)) return null;
  if (actionType === "read" && isNeutralReadPath(actionValue)) return null;
  if (actionType === "mcp" && actionValue.toLowerCase().startsWith("goal-guardian/")) return null;
  if (matchesPinnedContext(state, actionType, actionValue)) return null;

  const task = activeTask(state, activeTaskId);
  const title = String(task?.title ?? activeTaskId).trim();
  if (!title) return null;

  const criterion = criterionTextForTask(state, activeTaskId);
  const taskTextParts = [title];
  if (criterion) taskTextParts.push(criterion);
  if (typeof state.goal === "string" && state.goal.trim()) taskTextParts.push(state.goal);

  const taskTerms = taskScopeTerms(taskTextParts);
  const actionTerms = actionScopeTerms(actionValue);
  const sensitivity = resolveTaskScopeSensitivity(policy);

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

function goalContextFromContract(contract: GoalContract | null) {
  return contract
    ? {
        goal: contract.goal,
        relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
      }
    : undefined;
}

function blockOrWarn(
  policy: GoalGuardianPolicy,
  contract: GoalContract | null,
  userMessage: string,
  agentMessage: string,
  suggestedAction: string
) {
  const advisoryUserMessage = userMessage.replace(/^(BLOCKED|HIGH-RISK|ADVISORY):\s*/i, "");
  return cursorResponseWarn(
    `Warning: ${advisoryUserMessage}`,
    `${agentMessage}\nAction allowed (advisory-only policy).`,
    {
      warningCount: 0,
      maxWarnings: policy.warningConfig.maxWarningsBeforeBlock,
      suggestedAction,
      goalContext: goalContextFromContract(contract),
    }
  );
}

function scopeWarn(
  policy: GoalGuardianPolicy,
  contract: GoalContract | null,
  actionType: "shell" | "mcp" | "read",
  actionValue: string,
  drift: TaskScopeDrift
) {
  const actionLabel = actionType === "mcp" ? "MCP call" : actionType === "read" ? "file read" : "command";
  return cursorResponseWarn(
    `Scope warning: ${actionLabel} may be outside active task "${drift.activeTaskTitle}".`,
    [
      `Active task: ${drift.activeTaskId} (${drift.activeTaskTitle})`,
      `Scope mode: ${drift.sensitivity} (${drift.confidence} confidence mismatch)`,
      `Task keywords: ${drift.taskTerms.join(", ") || "n/a"}`,
      `${actionLabel} keywords: ${drift.actionTerms.join(", ") || "n/a"}`,
      `Action seen: ${actionValue}`,
      "If intentional, switch active task first or record a decision for the switch.",
    ].join("\n"),
    {
      warningCount: 0,
      maxWarnings: policy.warningConfig.maxWarningsBeforeBlock,
      suggestedAction: `Switch state.active_task before running ${actionLabel}.`,
      goalContext: goalContextFromContract(contract),
    }
  );
}

function classifySeverity(
  rules: PolicyRule[] | undefined,
  value: string
): { severity: PolicySeverity; rule: PolicyRule | null } {
  if (!rules || rules.length === 0) {
    return { severity: "PERMIT_REQUIRED", rule: null };
  }

  for (const rule of rules) {
    if (minimatch(value, rule.pattern, { dot: true, nocase: true })) {
      return { severity: rule.severity, rule };
    }
  }

  return { severity: "PERMIT_REQUIRED", rule: null };
}

function buildRecoveryMessage(
  action: string,
  actionValue: string,
  contract: GoalContract | null,
  suggestedPermitFields: string
): string {
  const goalPart = contract?.goal
    ? `Current goal: "${contract.goal}"\n\n`
    : "No goal is set. Consider setting one first.\n\n";

  return (
    `${goalPart}` +
    `To proceed:\n` +
    `1. Call guardian_check_step with:\n` +
    `   - step: "Describe what this ${action} accomplishes"\n` +
    `   - maps_to: ["SC1", ...] (relevant success criteria IDs)\n` +
    `2. If approved, call guardian_issue_permit with:\n` +
    `   - ${suggestedPermitFields}\n` +
    `3. Retry the command`
  );
}

function previewToResponse(
  preview: PreviewResult,
  actionType: "shell" | "mcp" | "read" | "write",
  actionValue: string,
  policy: GoalGuardianPolicy,
  contract: GoalContract | null
) {
  const maxWarnings = preview.maxWarnings ?? policy.warningConfig.maxWarningsBeforeBlock;
  const warningCount = preview.warningCount ?? 0;
  const suggested = preview.suggestedPermitRequest;
  const suggestedAction = suggested
    ? `Request a permit with ${suggested.allow_field}: ["${suggested.allow_pattern}"]`
    : `Request a permit for ${actionType}`;

  const goalContext = goalContextFromContract(contract);

  // Guardrail behavior for high-risk actions: advisory warning only.
  if (preview.severity === "HIGH_RISK") {
    const agentMsg = suggested
      ? buildRecoveryMessage(actionType, actionValue, contract, `${suggested.allow_field}: ["${suggested.allow_pattern}"]`)
      : `High-risk action flagged by MCP policy. ${actionValue}`;
    return blockOrWarn(
      policy,
      contract,
      preview.reason,
      agentMsg,
      suggestedAction
    );
  }

  if (preview.severity === "WARN") {
    const warnMessage = preview.wouldSucceed
      ? `Allowed with warning. ${Math.max(0, maxWarnings - warningCount)} warnings remaining before escalation reminder.`
      : "Warning limit reached. Action allowed, but a permit is strongly recommended.";

    return cursorResponseWarn(
      preview.reason,
      warnMessage,
      {
        warningCount,
        maxWarnings,
        suggestedAction,
        goalContext,
      }
    );
  }

  if (preview.severity === "PERMIT_REQUIRED" && !preview.wouldSucceed) {
    const agentMsg = suggested
      ? buildRecoveryMessage(actionType, actionValue, contract, `${suggested.allow_field}: ["${suggested.allow_pattern}"]`)
      : `Permit recommended for ${actionType}: ${actionValue}`;
    return cursorResponseWarn(
      preview.reason,
      agentMsg,
      {
        warningCount: 0,
        maxWarnings,
        suggestedAction,
        goalContext,
      }
    );
  }

  return cursorResponseAllow();
}

async function loadPolicy(workspaceRoot: string): Promise<GoalGuardianPolicy> {
  const envPath = process.env.GOAL_GUARDIAN_POLICY_PATH;
  const candidatePaths = [
    envPath,
    path.join(workspaceRoot, ".cursor", "goal-guardian", "policy.json"),
    path.join(workspaceRoot, "goal-guardian.policy.json"),
  ].filter(Boolean) as string[];

  let filePath: string | null = null;
  for (const p of candidatePaths) {
    try {
      await fs.access(p);
      filePath = p;
      break;
    } catch {
      // continue
    }
  }

  const base = defaultPolicy();
  if (!filePath) return base;

  const fromFile = await readJson<Partial<GoalGuardianPolicy>>(filePath, {});
  return {
    ...base,
    ...fromFile,
    alwaysAllow: {
      shell: fromFile.alwaysAllow?.shell ?? base.alwaysAllow.shell,
      mcp: fromFile.alwaysAllow?.mcp ?? base.alwaysAllow.mcp,
      read: fromFile.alwaysAllow?.read ?? base.alwaysAllow.read,
    },
    highRiskPatterns: {
      shell: fromFile.highRiskPatterns?.shell ?? base.highRiskPatterns.shell,
      mcp: fromFile.highRiskPatterns?.mcp ?? base.highRiskPatterns.mcp,
      read: fromFile.highRiskPatterns?.read ?? base.highRiskPatterns.read,
    },
    warningConfig: {
      ...defaultWarningConfig(),
      ...fromFile.warningConfig,
    },
    shellRules: fromFile.shellRules ?? base.shellRules,
    mcpRules: fromFile.mcpRules ?? base.mcpRules,
    readRules: fromFile.readRules ?? base.readRules,
  };
}

async function loadActivePermit(workspaceRoot: string): Promise<Permit | null> {
  const permitsPath = path.join(workspaceRoot, ".ai", "goal-guardian", "permits.json");
  const doc = await readJson<PermitsDoc>(permitsPath, { permits: [] });

  const now = Date.now();
  const valid = (doc.permits ?? []).filter((p) => Date.parse(p.expires_at) > now);

  valid.sort((a, b) => Date.parse(b.issued_at) - Date.parse(a.issued_at));

  return valid.length > 0 ? valid[0] : null;
}

async function appendAudit(workspaceRoot: string, record: Record<string, unknown>): Promise<void> {
  const auditPath = path.join(workspaceRoot, ".ai", "goal-guardian", "audit.log");
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.appendFile(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf8");
}

async function tryGitRevert(workspaceRoot: string, relFilePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["checkout", "--", relFilePath], {
      cwd: workspaceRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function main(): Promise<void> {
  const raw = await readAllStdin();
  let payload: any = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write(JSON.stringify(cursorResponseAllow("Goal-Guardian hook: invalid JSON payload; allowing.")));
    return;
  }

  const eventName = await resolveHookEventName(payload);
  const workspaceRoot = await resolveWorkspaceRoot(payload);
  const policy = await loadPolicy(workspaceRoot);
  const permit = await loadActivePermit(workspaceRoot);
  const mcpPath = resolveMcpPath();
  const reduxState = await loadReduxState(workspaceRoot);

  await appendAudit(workspaceRoot, {
    event: eventName,
    conversation_id: payload?.conversation_id,
    generation_id: payload?.generation_id,
  });

  // Load violations tracker and contract for context
  let violations = await loadViolations(workspaceRoot);
  const contract = await loadContract(workspaceRoot);

  // Reset warnings if enough time has passed
  if (shouldResetWarnings(violations, policy.warningConfig.warningResetMinutes)) {
    resetWarnings(violations);
    await saveViolations(workspaceRoot, violations);
  }

  if (eventName === "beforeShellExecution") {
    const cmd = String(payload?.command ?? "");
    if (cmd.length === 0) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (policy.enforceReduxControl) {
      if (!reduxState) {
        process.stdout.write(
          JSON.stringify(
            blockOrWarn(
              policy,
              contract,
              "ADVISORY: Redux control requires .cursor/goal-guardian/state.json",
              "Initialize Goal Guardian state files, then retry.",
              "Create .cursor/goal-guardian/state.json (via extension install)."
            )
          )
        );
        return;
      }
      const activeTaskId = String(reduxState.active_task ?? "").trim();
      if (!activeTaskId) {
        process.stdout.write(
          JSON.stringify(
            blockOrWarn(
              policy,
              contract,
              "ADVISORY: No active Redux task.",
              "Set success criteria in contract.json and let Goal Guardian auto-start a task, then retry.",
              "Ensure state.active_task is set to a task in doing status."
            )
          )
        );
        return;
      }
      const status = activeTaskStatus(reduxState, activeTaskId);
      if (status && status !== "doing") {
        process.stdout.write(
          JSON.stringify(
            blockOrWarn(
              policy,
              contract,
              `ADVISORY: Active task ${activeTaskId} is not in doing state.`,
              "Ensure the active task is in progress before running commands.",
              "Mark the active task status as doing."
            )
          )
        );
        return;
      }
    }

    if (policy.enforceTaskScope) {
      const drift = evaluateTaskScopeDrift(policy, reduxState, "shell", cmd);
      if (drift) {
        await appendAudit(workspaceRoot, {
          event: "scopeDriftWarning",
          actionType: "shell",
          actionValue: cmd,
          activeTaskId: drift.activeTaskId,
          activeTaskTitle: drift.activeTaskTitle,
          taskTerms: drift.taskTerms,
          actionTerms: drift.actionTerms,
        });
        process.stdout.write(JSON.stringify(scopeWarn(policy, contract, "shell", cmd, drift)));
        return;
      }
    }

    if (mcpPath) {
      const preview = await previewViaMcp(mcpPath, workspaceRoot, "shell", cmd);
      if (preview) {
        const decision = previewToResponse(preview, "shell", cmd, policy, contract);
        process.stdout.write(JSON.stringify(decision));
        return;
      }
    }

    // Check severity-based rules first
    const { severity, rule } = classifySeverity(policy.shellRules, cmd);

    // HIGH_RISK policy match: advisory warning only.
    if (severity === "HIGH_RISK" || globAny(policy.highRiskPatterns.shell, cmd)) {
      const reason = rule?.reason ?? "High-risk command pattern";
      await appendAudit(workspaceRoot, {
        event: "shellHighRisk",
        command: cmd,
        severity: "HIGH_RISK",
        reason,
      });
      process.stdout.write(
        JSON.stringify(
          blockOrWarn(
            policy,
            contract,
            `HIGH-RISK: ${reason}`,
            `Command "${cmd}" matches a high-risk advisory policy pattern.`,
            `Avoid command: ${cmd}`
          )
        )
      );
      return;
    }

    // ALLOWED: Let through immediately
    if (severity === "ALLOWED" || globAny(policy.alwaysAllow.shell, cmd)) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    // WARN: Check warning count and escalate messaging.
    if (severity === "WARN") {
      const matchedPattern = rule?.pattern ?? cmd;
      const currentCount = getWarningCount(violations, matchedPattern);
      const maxWarnings = policy.warningConfig.maxWarningsBeforeBlock;

      if (currentCount >= maxWarnings) {
        // Soft guardrail: keep allowing but emphasize permit request
        await appendAudit(workspaceRoot, {
          event: "shellWarningLimit",
          command: cmd,
          severity: "WARN_ESCALATED",
          warningCount: currentCount,
          maxWarnings,
          reason: `Exceeded ${maxWarnings} warnings`,
          actionType: "shell",
          actionValue: cmd,
          suggestedAllow: cmd,
        });
        const warnMsg = `Warning (${currentCount}/${maxWarnings}): ${rule?.reason ?? "risky command"} — limit reached, consider a permit`;
        process.stdout.write(
          JSON.stringify(
            cursorResponseWarn(
              warnMsg,
              "Command allowed, but warning limit reached. Consider requesting a permit to keep actions aligned.",
              {
                warningCount: currentCount,
                maxWarnings,
                suggestedAction: `Request a permit with allow_shell: ["${cmd}"]`,
                goalContext: contract
                  ? {
                      goal: contract.goal,
                      relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
                    }
                  : undefined,
              }
            )
          )
        );
        return;
      }

      // Issue warning and allow
      const newCount = incrementWarning(violations, matchedPattern);
      await saveViolations(workspaceRoot, violations);
      await appendAudit(workspaceRoot, {
        event: "shellWarning",
        command: cmd,
        severity: "WARN",
        warningCount: newCount,
        maxWarnings,
        reason: rule?.reason,
        actionType: "shell",
        actionValue: cmd,
        suggestedAllow: cmd,
      });

      const goalContext = contract
        ? {
            goal: contract.goal,
            relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
          }
        : undefined;

      const warnMsg = policy.warningConfig.showGoalReminder && contract
        ? `Warning (${newCount}/${maxWarnings}): ${rule?.reason ?? "risky command"}\nGoal: "${contract.goal}"`
        : `Warning (${newCount}/${maxWarnings}): ${rule?.reason ?? "risky command"}`;

      process.stdout.write(
        JSON.stringify(
          cursorResponseWarn(
            warnMsg,
            `Command allowed with warning. ${maxWarnings - newCount} warnings remaining before escalation reminder.`,
            {
              warningCount: newCount,
              maxWarnings,
              suggestedAction: `Request a permit with allow_shell: ["${cmd.split(" ")[0]}*"]`,
              goalContext,
            }
          )
        )
      );
      return;
    }

    // PERMIT_REQUIRED: Standard permit check (existing behavior)
    if (!policy.requirePermitForShell) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (!permit) {
      const recoveryMsg = buildRecoveryMessage(
        "shell command",
        cmd,
        contract,
        `allow_shell: ["${cmd}"]`
      );
      await appendAudit(workspaceRoot, {
        event: "shellPermitSuggested",
        command: cmd,
        severity: "PERMIT_REQUIRED",
        reason: "No valid permit",
        actionType: "shell",
        actionValue: cmd,
        suggestedAllow: cmd,
      });
      process.stdout.write(
        JSON.stringify(
          cursorResponseWarn(
            `Goal check: "${contract?.goal ?? "No goal set"}"\nPermit recommended for: ${cmd}`,
            recoveryMsg,
            {
              warningCount: 0,
              maxWarnings: policy.warningConfig.maxWarningsBeforeBlock,
              suggestedAction: `Request a permit with allow_shell: ["${cmd}"]`,
              goalContext: contract
                ? {
                    goal: contract.goal,
                    relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
                  }
                : undefined,
            }
          )
        )
      );
      return;
    }

    const allowed = globAny(permit.allow.shell ?? [], cmd);
    if (!allowed) {
      const recoveryMsg = buildRecoveryMessage(
        "shell command",
        cmd,
        contract,
        `allow_shell: ["${cmd}"]`
      );
      await appendAudit(workspaceRoot, {
        event: "shellPermitSuggested",
        command: cmd,
        severity: "PERMIT_REQUIRED",
        reason: "Permit does not allow this command",
        actionType: "shell",
        actionValue: cmd,
        suggestedAllow: cmd,
      });
      process.stdout.write(
        JSON.stringify(
          cursorResponseWarn(
            `Goal check: "${contract?.goal ?? "No goal set"}"\nPermit recommended for: ${cmd}`,
            `Permit exists but does not allow this command.\n\n${recoveryMsg}`,
            {
              warningCount: 0,
              maxWarnings: policy.warningConfig.maxWarningsBeforeBlock,
              suggestedAction: `Request a permit with allow_shell: ["${cmd}"]`,
              goalContext: contract
                ? {
                    goal: contract.goal,
                    relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
                  }
                : undefined,
            }
          )
        )
      );
      return;
    }

    process.stdout.write(JSON.stringify(cursorResponseAllow()));
    return;
  }

  if (eventName === "beforeMCPExecution") {
    const server = String(payload?.server ?? "").trim() || "unknown";
    const tool = String(payload?.tool_name ?? "").trim() || "unknown";
    const key = `${server}/${tool}`;

    if (policy.enforceReduxControl) {
      if (!reduxState) {
        process.stdout.write(
          JSON.stringify(
            blockOrWarn(
              policy,
              contract,
              "ADVISORY: Redux control requires .cursor/goal-guardian/state.json",
              "Initialize Goal Guardian state files, then retry.",
              "Create .cursor/goal-guardian/state.json (via extension install)."
            )
          )
        );
        return;
      }
      const activeTaskId = String(reduxState.active_task ?? "").trim();
      if (!activeTaskId) {
        process.stdout.write(
          JSON.stringify(
            blockOrWarn(
              policy,
              contract,
              "ADVISORY: No active Redux task.",
              "Set success criteria in contract.json and let Goal Guardian auto-start a task, then retry.",
              "Ensure state.active_task is set to a task in doing status."
            )
          )
        );
        return;
      }
      const status = activeTaskStatus(reduxState, activeTaskId);
      if (status && status !== "doing") {
        process.stdout.write(
          JSON.stringify(
            blockOrWarn(
              policy,
              contract,
              `ADVISORY: Active task ${activeTaskId} is not in doing state.`,
              "Ensure the active task is in progress before running MCP tools.",
              "Mark the active task status as doing."
            )
          )
        );
        return;
      }
    }

    if (policy.enforceTaskScope) {
      const drift = evaluateTaskScopeDrift(policy, reduxState, "mcp", key);
      if (drift) {
        await appendAudit(workspaceRoot, {
          event: "scopeDriftWarning",
          actionType: "mcp",
          actionValue: key,
          activeTaskId: drift.activeTaskId,
          activeTaskTitle: drift.activeTaskTitle,
          taskTerms: drift.taskTerms,
          actionTerms: drift.actionTerms,
        });
        process.stdout.write(JSON.stringify(scopeWarn(policy, contract, "mcp", key, drift)));
        return;
      }
    }

    if (mcpPath) {
      const preview = await previewViaMcp(mcpPath, workspaceRoot, "mcp", key);
      if (preview) {
        const decision = previewToResponse(preview, "mcp", key, policy, contract);
        process.stdout.write(JSON.stringify(decision));
        return;
      }
    }

    // Check severity-based rules first
    const { severity, rule } = classifySeverity(policy.mcpRules, key);

    // HIGH_RISK policy match: advisory warning only.
    if (severity === "HIGH_RISK" || globAny(policy.highRiskPatterns.mcp, key)) {
      const reason = rule?.reason ?? "High-risk MCP pattern";
      await appendAudit(workspaceRoot, {
        event: "mcpHighRisk",
        mcpKey: key,
        severity: "HIGH_RISK",
        reason,
      });
      process.stdout.write(
        JSON.stringify(
          blockOrWarn(
            policy,
            contract,
            `HIGH-RISK: ${reason}`,
            `MCP call "${key}" matches a high-risk advisory policy pattern.`,
            `Avoid MCP call: ${key}`
          )
        )
      );
      return;
    }

    // ALLOWED
    if (severity === "ALLOWED" || globAny(policy.alwaysAllow.mcp, key)) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    // WARN: Check warning count
    if (severity === "WARN") {
      const matchedPattern = rule?.pattern ?? key;
      const currentCount = getWarningCount(violations, matchedPattern);
      const maxWarnings = policy.warningConfig.maxWarningsBeforeBlock;

      if (currentCount >= maxWarnings) {
        await appendAudit(workspaceRoot, {
          event: "mcpWarningLimit",
          mcpKey: key,
          severity: "WARN_ESCALATED",
          warningCount: currentCount,
          maxWarnings,
          actionType: "mcp",
          actionValue: key,
          suggestedAllow: key,
        });
        process.stdout.write(
          JSON.stringify(
            cursorResponseWarn(
              `Warning (${currentCount}/${maxWarnings}): ${rule?.reason ?? "MCP call requires attention"} — limit reached`,
              "MCP call allowed, but warning limit reached. Consider requesting a permit.",
              {
                warningCount: currentCount,
                maxWarnings,
                suggestedAction: `Request a permit with allow_mcp: ["${key}"]`,
                goalContext: contract
                  ? {
                      goal: contract.goal,
                      relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
                    }
                  : undefined,
              }
            )
          )
        );
        return;
      }

      const newCount = incrementWarning(violations, matchedPattern);
      await saveViolations(workspaceRoot, violations);
      await appendAudit(workspaceRoot, {
        event: "mcpWarning",
        mcpKey: key,
        severity: "WARN",
        warningCount: newCount,
        maxWarnings,
        actionType: "mcp",
        actionValue: key,
        suggestedAllow: key,
      });

      const goalContext = contract
        ? {
            goal: contract.goal,
            relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
          }
        : undefined;

      process.stdout.write(
        JSON.stringify(
          cursorResponseWarn(
            `Warning (${newCount}/${maxWarnings}): ${rule?.reason ?? "MCP call requires attention"}`,
            `MCP call allowed with warning. ${maxWarnings - newCount} warnings remaining.`,
            {
              warningCount: newCount,
              maxWarnings,
              suggestedAction: `Request a permit with allow_mcp: ["${key}"]`,
              goalContext,
            }
          )
        )
      );
      return;
    }

    // PERMIT_REQUIRED
    if (!policy.requirePermitForMcp) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (!permit) {
      const recoveryMsg = buildRecoveryMessage(
        "MCP call",
        key,
        contract,
        `allow_mcp: ["${key}"]`
      );
      await appendAudit(workspaceRoot, {
        event: "mcpPermitSuggested",
        mcpKey: key,
        severity: "PERMIT_REQUIRED",
        reason: "No valid permit",
        actionType: "mcp",
        actionValue: key,
        suggestedAllow: key,
      });
      process.stdout.write(
        JSON.stringify(
          cursorResponseWarn(
            `Goal check: "${contract?.goal ?? "No goal set"}"\nPermit recommended for MCP: ${key}`,
            recoveryMsg,
            {
              warningCount: 0,
              maxWarnings: policy.warningConfig.maxWarningsBeforeBlock,
              suggestedAction: `Request a permit with allow_mcp: ["${key}"]`,
              goalContext: contract
                ? {
                    goal: contract.goal,
                    relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
                  }
                : undefined,
            }
          )
        )
      );
      return;
    }

    const allowed = globAny(permit.allow.mcp ?? [], key);
    if (!allowed) {
      const recoveryMsg = buildRecoveryMessage(
        "MCP call",
        key,
        contract,
        `allow_mcp: ["${key}"]`
      );
      await appendAudit(workspaceRoot, {
        event: "mcpPermitSuggested",
        mcpKey: key,
        severity: "PERMIT_REQUIRED",
        reason: "Permit does not allow this call",
        actionType: "mcp",
        actionValue: key,
        suggestedAllow: key,
      });
      process.stdout.write(
        JSON.stringify(
          cursorResponseWarn(
            `Goal check: "${contract?.goal ?? "No goal set"}"\nPermit recommended for MCP: ${key}`,
            `Permit exists but does not allow this MCP call.\n\n${recoveryMsg}`,
            {
              warningCount: 0,
              maxWarnings: policy.warningConfig.maxWarningsBeforeBlock,
              suggestedAction: `Request a permit with allow_mcp: ["${key}"]`,
              goalContext: contract
                ? {
                    goal: contract.goal,
                    relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
                  }
                : undefined,
            }
          )
        )
      );
      return;
    }

    process.stdout.write(JSON.stringify(cursorResponseAllow()));
    return;
  }

  if (eventName === "beforeReadFile" || eventName === "beforeTabFileRead") {
    const rel = toPosixRel(String(payload?.file_path ?? "")).replace(/^\/+/, "");
    if (!rel) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (policy.enforceReduxControl && !isBootstrapReadPath(rel)) {
      if (!reduxState) {
        process.stdout.write(
          JSON.stringify(
            blockOrWarn(
              policy,
              contract,
              "ADVISORY: Redux control requires .cursor/goal-guardian/state.json",
              "Initialize Goal Guardian state files, then retry.",
              "Create .cursor/goal-guardian/state.json (via extension install)."
            )
          )
        );
        return;
      }
      const activeTaskId = String(reduxState.active_task ?? "").trim();
      if (!activeTaskId) {
        process.stdout.write(
          JSON.stringify(
            blockOrWarn(
              policy,
              contract,
              "ADVISORY: No active Redux task.",
              "Set success criteria in contract.json and let Goal Guardian auto-start a task, then retry.",
              "Ensure state.active_task is set to a task in doing status."
            )
          )
        );
        return;
      }
      const status = activeTaskStatus(reduxState, activeTaskId);
      if (status && status !== "doing") {
        process.stdout.write(
          JSON.stringify(
            blockOrWarn(
              policy,
              contract,
              `ADVISORY: Active task ${activeTaskId} is not in doing state.`,
              "Ensure the active task is in progress before reading workspace files.",
              "Mark the active task status as doing."
            )
          )
        );
        return;
      }
    }

    if (policy.enforceTaskScope && !isBootstrapReadPath(rel)) {
      const drift = evaluateTaskScopeDrift(policy, reduxState, "read", rel);
      if (drift) {
        await appendAudit(workspaceRoot, {
          event: "scopeDriftWarning",
          actionType: "read",
          actionValue: rel,
          activeTaskId: drift.activeTaskId,
          activeTaskTitle: drift.activeTaskTitle,
          taskTerms: drift.taskTerms,
          actionTerms: drift.actionTerms,
        });
        process.stdout.write(JSON.stringify(scopeWarn(policy, contract, "read", rel, drift)));
        return;
      }
    }

    if (mcpPath) {
      const preview = await previewViaMcp(mcpPath, workspaceRoot, "read", rel);
      if (preview) {
        const decision = previewToResponse(preview, "read", rel, policy, contract);
        process.stdout.write(JSON.stringify(decision));
        return;
      }
    }

    // Check severity-based rules first
    const { severity, rule } = classifySeverity(policy.readRules, rel);

    // HIGH_RISK policy match: advisory warning only.
    if (severity === "HIGH_RISK" || globAny(policy.highRiskPatterns.read, rel)) {
      const reason = rule?.reason ?? "High-risk file access pattern";
      await appendAudit(workspaceRoot, {
        event: "readHighRisk",
        filePath: rel,
        severity: "HIGH_RISK",
        reason,
      });
      process.stdout.write(
        JSON.stringify(
          blockOrWarn(
            policy,
            contract,
            `HIGH-RISK: ${reason}`,
            `Reading "${rel}" matches a high-risk advisory policy pattern.`,
            `Avoid reading: ${rel}`
          )
        )
      );
      return;
    }

    // ALLOWED
    if (severity === "ALLOWED" || globAny(policy.alwaysAllow.read, rel)) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    // WARN
    if (severity === "WARN") {
      const matchedPattern = rule?.pattern ?? rel;
      const currentCount = getWarningCount(violations, matchedPattern);
      const maxWarnings = policy.warningConfig.maxWarningsBeforeBlock;

      if (currentCount >= maxWarnings) {
        await appendAudit(workspaceRoot, {
          event: "readWarningLimit",
          filePath: rel,
          severity: "WARN_ESCALATED",
          warningCount: currentCount,
          maxWarnings,
          actionType: "read",
          actionValue: rel,
          suggestedAllow: rel,
        });
        process.stdout.write(
          JSON.stringify(
            cursorResponseWarn(
              `Warning (${currentCount}/${maxWarnings}): ${rule?.reason ?? "file access requires attention"} — limit reached`,
              "File read allowed, but warning limit reached. Consider requesting a permit.",
              {
                warningCount: currentCount,
                maxWarnings,
                suggestedAction: `Request a permit with allow_read: ["${rel}"]`,
                goalContext: contract
                  ? {
                      goal: contract.goal,
                      relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
                    }
                  : undefined,
              }
            )
          )
        );
        return;
      }

      const newCount = incrementWarning(violations, matchedPattern);
      await saveViolations(workspaceRoot, violations);
      await appendAudit(workspaceRoot, {
        event: "readWarning",
        filePath: rel,
        severity: "WARN",
        warningCount: newCount,
        maxWarnings,
        actionType: "read",
        actionValue: rel,
        suggestedAllow: rel,
      });

      const goalContext = contract
        ? {
            goal: contract.goal,
            relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
          }
        : undefined;

      process.stdout.write(
        JSON.stringify(
          cursorResponseWarn(
            `Warning (${newCount}/${maxWarnings}): ${rule?.reason ?? "file access requires attention"}`,
            `File read allowed with warning. ${maxWarnings - newCount} warnings remaining.`,
            {
              warningCount: newCount,
              maxWarnings,
              suggestedAction: `Request a permit with allow_read: ["${rel}"]`,
              goalContext,
            }
          )
        )
      );
      return;
    }

    // PERMIT_REQUIRED
    if (!policy.requirePermitForRead) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (!permit) {
      const recoveryMsg = buildRecoveryMessage(
        "file read",
        rel,
        contract,
        `allow_read: ["${rel}"]`
      );
      await appendAudit(workspaceRoot, {
        event: "readPermitSuggested",
        filePath: rel,
        severity: "PERMIT_REQUIRED",
        reason: "No valid permit",
        actionType: "read",
        actionValue: rel,
        suggestedAllow: rel,
      });
      process.stdout.write(
        JSON.stringify(
          cursorResponseWarn(
            `Goal check: "${contract?.goal ?? "No goal set"}"\nPermit recommended for read: ${rel}`,
            recoveryMsg,
            {
              warningCount: 0,
              maxWarnings: policy.warningConfig.maxWarningsBeforeBlock,
              suggestedAction: `Request a permit with allow_read: ["${rel}"]`,
              goalContext: contract
                ? {
                    goal: contract.goal,
                    relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
                  }
                : undefined,
            }
          )
        )
      );
      return;
    }

    const allowed = globAny(permit.allow.read ?? [], rel);
    if (!allowed) {
      const recoveryMsg = buildRecoveryMessage(
        "file read",
        rel,
        contract,
        `allow_read: ["${rel}"]`
      );
      await appendAudit(workspaceRoot, {
        event: "readPermitSuggested",
        filePath: rel,
        severity: "PERMIT_REQUIRED",
        reason: "Permit does not allow this file",
        actionType: "read",
        actionValue: rel,
        suggestedAllow: rel,
      });
      process.stdout.write(
        JSON.stringify(
          cursorResponseWarn(
            `Goal check: "${contract?.goal ?? "No goal set"}"\nPermit recommended for read: ${rel}`,
            `Permit exists but does not allow reading ${rel}.\n\n${recoveryMsg}`,
            {
              warningCount: 0,
              maxWarnings: policy.warningConfig.maxWarningsBeforeBlock,
              suggestedAction: `Request a permit with allow_read: ["${rel}"]`,
              goalContext: contract
                ? {
                    goal: contract.goal,
                    relevantCriteria: contract.success_criteria.map((c, i) => `SC${i + 1}: ${c}`),
                  }
                : undefined,
            }
          )
        )
      );
      return;
    }

    process.stdout.write(JSON.stringify(cursorResponseAllow()));
    return;
  }

  if (eventName === "afterFileEdit" || eventName === "afterTabFileEdit") {
    const rel = toPosixRel(String(payload?.file_path ?? "")).replace(/^\/+/, "");
    if (rel) {
      const isHighRiskReadArea = globAny(policy.highRiskPatterns.read, rel);
      const writeAllowed = permit ? globAny(permit.allow.write ?? [], rel) : false;

      await appendAudit(workspaceRoot, {
        event: eventName,
        file_path: rel,
        has_permit: Boolean(permit),
        write_allowed: writeAllowed,
      });

      if (policy.autoRevertUnauthorizedEdits && (isHighRiskReadArea || !writeAllowed)) {
        const reverted = await tryGitRevert(workspaceRoot, rel);
        await appendAudit(workspaceRoot, {
          event: "autoRevert",
          file_path: rel,
          reverted,
        });
      }
    }

    process.stdout.write(JSON.stringify(cursorResponseAllow()));
    return;
  }

  process.stdout.write(JSON.stringify(cursorResponseAllow()));
}

main().catch((err) => {
  console.error("Goal-Guardian hook fatal:", err);
  process.stdout.write(JSON.stringify({ continue: true, permission: "allow" }));
});
