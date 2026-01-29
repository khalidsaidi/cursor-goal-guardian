export type PolicySeverity = "HARD_BLOCK" | "WARN" | "PERMIT_REQUIRED" | "ALLOWED";

export type PolicyRule = {
  pattern: string;
  severity: PolicySeverity;
  reason?: string;
};

export type WarningConfig = {
  maxWarningsBeforeBlock: number;  // default: 3
  warningResetMinutes: number;     // default: 60
  showGoalReminder: boolean;       // default: true
};

export type GoalGuardianPolicy = {
  requirePermitForShell: boolean;
  requirePermitForMcp: boolean;
  requirePermitForRead: boolean;

  // Optional: revert unauthorized edits via git (best-effort).
  autoRevertUnauthorizedEdits: boolean;

  alwaysAllow: {
    shell: string[]; // glob against full command string
    mcp: string[];   // glob against "server/tool_name"
    read: string[];  // glob against relative file path
  };

  alwaysDeny: {
    shell: string[];
    mcp: string[];
    read: string[];
  };

  // Warning behavior configuration
  warningConfig: WarningConfig;

  // Severity-based rules (optional, extends alwaysAllow/alwaysDeny)
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
    requirePermitForShell: true,
    requirePermitForMcp: true,

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
        "pnpm -v"
      ],
      mcp: [
        // Always allow the goal-guardian server itself so the agent can request permits.
        "goal-guardian/*"
      ],
      read: [
        // Allow the guardian contract itself to be read into context.
        ".cursor/goal-guardian/**",
        ".cursor/hooks.json",
        ".cursor/mcp.json"
      ]
    },

    alwaysDeny: {
      shell: [
        // Add your own hard-deny patterns here (examples):
        "rm -rf /*",
        "rm -rf /",
        "*curl*|*sh*",
        "*wget*|*sh*"
      ],
      mcp: [],
      read: [
        // Prevent the model from reading permits/checks/audit logs.
        ".ai/goal-guardian/**",
        ".git/**",
        "**/.env",
        "**/.env.*",
        "**/*.pem",
        "**/*.key"
      ]
    },

    warningConfig: defaultWarningConfig(),

    // Severity-based rules for graduated response
    shellRules: [
      // HARD_BLOCK: Catastrophic commands - immediate block, no recovery
      { pattern: "rm -rf /", severity: "HARD_BLOCK", reason: "Catastrophic filesystem deletion" },
      { pattern: "rm -rf /*", severity: "HARD_BLOCK", reason: "Catastrophic filesystem deletion" },
      { pattern: "*:(){ :|:& };:*", severity: "HARD_BLOCK", reason: "Fork bomb detected" },
      { pattern: "*> /dev/sda*", severity: "HARD_BLOCK", reason: "Direct disk write" },
      { pattern: "*dd if=*of=/dev/*", severity: "HARD_BLOCK", reason: "Direct disk write" },
      { pattern: "*mkfs.*", severity: "HARD_BLOCK", reason: "Filesystem format command" },
      { pattern: "*curl*|*sh*", severity: "HARD_BLOCK", reason: "Remote code execution via curl" },
      { pattern: "*wget*|*sh*", severity: "HARD_BLOCK", reason: "Remote code execution via wget" },
      { pattern: "*curl*|*bash*", severity: "HARD_BLOCK", reason: "Remote code execution via curl" },
      { pattern: "*wget*|*bash*", severity: "HARD_BLOCK", reason: "Remote code execution via wget" },

      // WARN: Risky commands - warn first, block after max warnings
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

      // ALLOWED: Safe read-only commands
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
      // Always allow goal-guardian tools
      { pattern: "goal-guardian/*", severity: "ALLOWED", reason: "Goal Guardian MCP tools" },
    ],

    readRules: [
      // HARD_BLOCK: Sensitive files
      { pattern: "**/.env", severity: "HARD_BLOCK", reason: "Environment secrets" },
      { pattern: "**/.env.*", severity: "HARD_BLOCK", reason: "Environment secrets" },
      { pattern: "**/*.pem", severity: "HARD_BLOCK", reason: "Private key file" },
      { pattern: "**/*.key", severity: "HARD_BLOCK", reason: "Private key file" },
      { pattern: ".git/**", severity: "HARD_BLOCK", reason: "Git internals" },
      { pattern: ".ai/goal-guardian/**", severity: "HARD_BLOCK", reason: "Guardian runtime data" },

      // ALLOWED: Guardian config files
      { pattern: ".cursor/goal-guardian/**", severity: "ALLOWED", reason: "Guardian configuration" },
      { pattern: ".cursor/hooks.json", severity: "ALLOWED", reason: "Hooks configuration" },
      { pattern: ".cursor/mcp.json", severity: "ALLOWED", reason: "MCP configuration" },
    ],
  };
}
