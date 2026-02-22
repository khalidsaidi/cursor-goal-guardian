export type PolicySeverity = "HIGH_RISK" | "WARN" | "PERMIT_REQUIRED" | "ALLOWED";
export type TaskScopeSensitivity = "strict" | "balanced" | "lenient";

type PolicyPatternSet = {
  shell: string[];
  mcp: string[];
  read: string[];
};

export type PolicyRule = {
  pattern: string;
  severity: PolicySeverity;
  reason?: string;
};

export type WarningConfig = {
  maxWarningsBeforeBlock: number;
  warningResetMinutes: number;
  showGoalReminder: boolean;
};

export type GoalGuardianPolicy = {
  // When true, execution requires a valid Redux-style active task in state.json.
  enforceReduxControl: boolean;
  // When true, action keywords are compared to the active task scope and out-of-scope
  // actions are warned (advisory-only).
  enforceTaskScope: boolean;
  // Controls how aggressively out-of-scope warnings are emitted.
  // strict: warn on weak mismatch signals
  // balanced: default, warn on medium confidence mismatch
  // lenient: warn only on strong mismatch signals
  taskScopeSensitivity: TaskScopeSensitivity;

  requirePermitForShell: boolean;
  requirePermitForMcp: boolean;
  requirePermitForRead: boolean;

  // Optional: revert unauthorized edits via git (best-effort).
  autoRevertUnauthorizedEdits: boolean;

  alwaysAllow: PolicyPatternSet;

  // Preferred advisory naming for high-risk patterns.
  highRiskPatterns: PolicyPatternSet;

  // Warning behavior configuration.
  warningConfig: WarningConfig;

  // Severity-based rules (optional, extends alwaysAllow/highRiskPatterns)
  shellRules?: PolicyRule[];
  mcpRules?: PolicyRule[];
  readRules?: PolicyRule[];
};

export function defaultWarningConfig(): WarningConfig {
  return {
    maxWarningsBeforeBlock: 3,
    warningResetMinutes: 60,
    showGoalReminder: true,
  };
}

export function defaultPolicy(): GoalGuardianPolicy {
  return {
    // Strict by default: agent actions require an active Redux task.
    enforceReduxControl: true,
    // Default on: compare each action against active task scope keywords.
    enforceTaskScope: true,
    // Good default for everyday use.
    taskScopeSensitivity: "balanced",

    // Soft anti-drift by default: guide with warnings, don't gate normal flow.
    // Teams that want strict permit gating can set these to true in policy.json.
    requirePermitForShell: false,
    requirePermitForMcp: false,

    // You can flip this to true in your project policy.json for stricter anti-drift.
    requirePermitForRead: false,

    autoRevertUnauthorizedEdits: false,

    alwaysAllow: {
      shell: [
        "git status*",
        "git diff*",
        "git rev-parse*",
        "ls*",
        "pwd",
        "node -v",
        "npm -v",
        "pnpm -v",
      ],
      mcp: [
        // Always allow the goal-guardian server itself so the agent can request permits.
        "goal-guardian/*",
      ],
      read: [
        // Allow the guardian contract itself to be read into context.
        ".cursor/goal-guardian/**",
        ".cursor/hooks.json",
        ".cursor/mcp.json",
      ],
    },

    highRiskPatterns: {
      shell: [
        // Add your own high-risk patterns here (examples):
        "rm -rf /*",
        "rm -rf /",
        "*curl*|*sh*",
        "*wget*|*sh*",
      ],
      mcp: [],
      read: [
        // Prevent the model from reading permits/checks/audit logs.
        ".ai/goal-guardian/**",
        ".git/**",
        "**/.env",
        "**/.env.*",
        "**/*.pem",
        "**/*.key",
      ],
    },

    warningConfig: defaultWarningConfig(),

    // Severity-based rules for graduated advisory response.
    shellRules: [
      // HIGH_RISK: destructive or remote-exec command patterns
      { pattern: "rm -rf /", severity: "HIGH_RISK", reason: "Destructive filesystem command" },
      { pattern: "rm -rf /*", severity: "HIGH_RISK", reason: "Destructive filesystem command" },
      { pattern: "*:(){ :|:& };:*", severity: "HIGH_RISK", reason: "Fork bomb pattern" },
      { pattern: "*> /dev/sda*", severity: "HIGH_RISK", reason: "Direct disk write" },
      { pattern: "*dd if=*of=/dev/*", severity: "HIGH_RISK", reason: "Direct disk write" },
      { pattern: "*mkfs.*", severity: "HIGH_RISK", reason: "Filesystem format command" },
      { pattern: "*curl*|*sh*", severity: "HIGH_RISK", reason: "Remote code execution pattern" },
      { pattern: "*wget*|*sh*", severity: "HIGH_RISK", reason: "Remote code execution pattern" },
      { pattern: "*curl*|*bash*", severity: "HIGH_RISK", reason: "Remote code execution pattern" },
      { pattern: "*wget*|*bash*", severity: "HIGH_RISK", reason: "Remote code execution pattern" },

      // WARN: Risky commands - warn first, escalate recommendation after max warnings.
      { pattern: "rm -rf *", severity: "WARN", reason: "Recursive force delete" },
      { pattern: "rm -r *", severity: "WARN", reason: "Recursive delete" },
      { pattern: "*--force*", severity: "WARN", reason: "Force flag bypasses safety checks" },
      { pattern: "*-f *", severity: "WARN", reason: "Force flag may bypass safety checks" },
      { pattern: "git reset --hard*", severity: "WARN", reason: "Destructive git operation" },
      { pattern: "git clean -fd*", severity: "WARN", reason: "Removes untracked files" },
      { pattern: "git push --force*", severity: "WARN", reason: "Force push can overwrite history" },
      { pattern: "git push -f*", severity: "WARN", reason: "Force push can overwrite history" },
      { pattern: "npm publish*", severity: "WARN", reason: "Publishing to npm registry" },
      { pattern: "yarn publish*", severity: "WARN", reason: "Publishing to npm registry" },
      { pattern: "pnpm publish*", severity: "WARN", reason: "Publishing to npm registry" },
      { pattern: "chmod 777*", severity: "WARN", reason: "Overly permissive file permissions" },
      { pattern: "*sudo *", severity: "WARN", reason: "Elevated privileges requested" },
      { pattern: "docker rm -f*", severity: "WARN", reason: "Force remove container" },
      { pattern: "docker system prune*", severity: "WARN", reason: "Removes unused Docker resources" },

      // ALLOWED: Safe read-only commands.
      { pattern: "git status*", severity: "ALLOWED", reason: "Read-only git operation" },
      { pattern: "git diff*", severity: "ALLOWED", reason: "Read-only git operation" },
      { pattern: "git log*", severity: "ALLOWED", reason: "Read-only git operation" },
      { pattern: "git branch*", severity: "ALLOWED", reason: "Read-only git operation" },
      { pattern: "git rev-parse*", severity: "ALLOWED", reason: "Read-only git operation" },
      { pattern: "ls*", severity: "ALLOWED", reason: "List directory contents" },
      { pattern: "pwd", severity: "ALLOWED", reason: "Print working directory" },
      { pattern: "echo *", severity: "ALLOWED", reason: "Print text" },
      { pattern: "cat *", severity: "ALLOWED", reason: "Read file contents" },
      { pattern: "head *", severity: "ALLOWED", reason: "Read file head" },
      { pattern: "tail *", severity: "ALLOWED", reason: "Read file tail" },
      { pattern: "node -v", severity: "ALLOWED", reason: "Version check" },
      { pattern: "npm -v", severity: "ALLOWED", reason: "Version check" },
      { pattern: "pnpm -v", severity: "ALLOWED", reason: "Version check" },
      { pattern: "yarn -v", severity: "ALLOWED", reason: "Version check" },
      { pattern: "which *", severity: "ALLOWED", reason: "Locate command" },
      { pattern: "type *", severity: "ALLOWED", reason: "Describe command" },
    ],

    mcpRules: [
      // Always allow goal-guardian tools.
      { pattern: "goal-guardian/*", severity: "ALLOWED", reason: "Goal Guardian MCP tools" },
    ],

    readRules: [
      // HIGH_RISK: sensitive files.
      { pattern: "**/.env", severity: "HIGH_RISK", reason: "Environment secrets" },
      { pattern: "**/.env.*", severity: "HIGH_RISK", reason: "Environment secrets" },
      { pattern: "**/*.pem", severity: "HIGH_RISK", reason: "Private key file" },
      { pattern: "**/*.key", severity: "HIGH_RISK", reason: "Private key file" },
      { pattern: ".git/**", severity: "HIGH_RISK", reason: "Git internals" },
      { pattern: ".ai/goal-guardian/**", severity: "HIGH_RISK", reason: "Guardian runtime data" },

      // ALLOWED: Guardian config files.
      { pattern: ".cursor/goal-guardian/**", severity: "ALLOWED", reason: "Guardian configuration" },
      { pattern: ".cursor/hooks.json", severity: "ALLOWED", reason: "Hooks configuration" },
      { pattern: ".cursor/mcp.json", severity: "ALLOWED", reason: "MCP configuration" },
    ],
  };
}
