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
};

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
    }
  };
}
