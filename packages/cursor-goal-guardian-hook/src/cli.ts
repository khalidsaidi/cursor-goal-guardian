#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { minimatch } from "minimatch";
import { fallback } from "fallback-chain-js";
import {
  defaultPolicy,
  defaultWarningConfig,
  type GoalGuardianPolicy,
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

function cursorResponseAllow(agentMessage?: string) {
  const res: any = { continue: true, permission: "allow" as const };
  if (agentMessage) res.agentMessage = agentMessage;
  return res;
}

function cursorResponseDeny(userMessage: string, agentMessage?: string) {
  const res: any = { continue: false, permission: "deny" as const, userMessage };
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

async function loadContract(workspaceRoot: string): Promise<GoalContract | null> {
  const contractPath = path.join(workspaceRoot, ".cursor", "goal-guardian", "contract.json");
  try {
    const raw = await fs.readFile(contractPath, "utf8");
    return JSON.parse(raw) as GoalContract;
  } catch {
    return null;
  }
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
    alwaysDeny: {
      shell: fromFile.alwaysDeny?.shell ?? base.alwaysDeny.shell,
      mcp: fromFile.alwaysDeny?.mcp ?? base.alwaysDeny.mcp,
      read: fromFile.alwaysDeny?.read ?? base.alwaysDeny.read,
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

    // Check severity-based rules first
    const { severity, rule } = classifySeverity(policy.shellRules, cmd);

    // HARD_BLOCK: Immediate block, no recovery
    if (severity === "HARD_BLOCK" || globAny(policy.alwaysDeny.shell, cmd)) {
      const reason = rule?.reason ?? "Blocked by policy";
      await appendAudit(workspaceRoot, {
        event: "shellBlocked",
        command: cmd,
        severity: "HARD_BLOCK",
        reason,
      });
      process.stdout.write(
        JSON.stringify(
          cursorResponseDeny(
            `BLOCKED: ${reason}`,
            `Command "${cmd}" is permanently blocked. This action cannot be permitted.`
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

    // WARN: Check warning count, warn first then block
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
            `Command allowed with warning. ${maxWarnings - newCount} warnings remaining before block.`,
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

    // Check severity-based rules first
    const { severity, rule } = classifySeverity(policy.mcpRules, key);

    // HARD_BLOCK
    if (severity === "HARD_BLOCK" || globAny(policy.alwaysDeny.mcp, key)) {
      const reason = rule?.reason ?? "Blocked by policy";
      await appendAudit(workspaceRoot, {
        event: "mcpBlocked",
        mcpKey: key,
        severity: "HARD_BLOCK",
        reason,
      });
      process.stdout.write(
        JSON.stringify(
          cursorResponseDeny(
            `BLOCKED: ${reason}`,
            `MCP call "${key}" is permanently blocked.`
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

    // Check severity-based rules first
    const { severity, rule } = classifySeverity(policy.readRules, rel);

    // HARD_BLOCK
    if (severity === "HARD_BLOCK" || globAny(policy.alwaysDeny.read, rel)) {
      const reason = rule?.reason ?? "Blocked by policy";
      await appendAudit(workspaceRoot, {
        event: "readBlocked",
        filePath: rel,
        severity: "HARD_BLOCK",
        reason,
      });
      process.stdout.write(
        JSON.stringify(
          cursorResponseDeny(
            `BLOCKED: ${reason}`,
            `Reading "${rel}" is permanently blocked for security.`
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
      const isDeniedReadArea = globAny(policy.alwaysDeny.read, rel);
      const writeAllowed = permit ? globAny(permit.allow.write ?? [], rel) : false;

      await appendAudit(workspaceRoot, {
        event: eventName,
        file_path: rel,
        has_permit: Boolean(permit),
        write_allowed: writeAllowed,
      });

      if (policy.autoRevertUnauthorizedEdits && (isDeniedReadArea || !writeAllowed)) {
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
