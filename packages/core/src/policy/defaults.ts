import type { PolicyRule } from "../schema/config.js";

/**
 * The single canonical rule list, merged from the two diverged v0.x copies
 * (hook policy.ts and the MCP server) and translated into the advisory
 * vocabulary: alert (formerly HIGH_RISK), caution (WARN), ok (ALLOWED).
 * An unmatched action is simply ok — nothing is recorded for it.
 */
export function defaultShellRules(): PolicyRule[] {
  return [
    { pattern: "rm -rf /", severity: "alert", reason: "Destructive filesystem command" },
    { pattern: "rm -rf /*", severity: "alert", reason: "Destructive filesystem command" },
    { pattern: "*:(){ :|:& };:*", severity: "alert", reason: "Fork bomb pattern" },
    { pattern: "*> /dev/sda*", severity: "alert", reason: "Direct disk write" },
    { pattern: "*dd if=*of=/dev/*", severity: "alert", reason: "Direct disk write" },
    { pattern: "*mkfs.*", severity: "alert", reason: "Filesystem format command" },
    { pattern: "*curl*|*sh*", severity: "alert", reason: "Remote code execution pattern" },
    { pattern: "*wget*|*sh*", severity: "alert", reason: "Remote code execution pattern" },
    { pattern: "*curl*|*bash*", severity: "alert", reason: "Remote code execution pattern" },
    { pattern: "*wget*|*bash*", severity: "alert", reason: "Remote code execution pattern" },

    { pattern: "rm -rf *", severity: "caution", reason: "Recursive force delete" },
    { pattern: "rm -r *", severity: "caution", reason: "Recursive delete" },
    { pattern: "*--force*", severity: "caution", reason: "Force flag bypasses safety checks" },
    { pattern: "git reset --hard*", severity: "caution", reason: "Destructive git operation" },
    { pattern: "git clean -fd*", severity: "caution", reason: "Removes untracked files" },
    { pattern: "git push --force*", severity: "caution", reason: "Force push can overwrite history" },
    { pattern: "git push -f*", severity: "caution", reason: "Force push can overwrite history" },
    { pattern: "npm publish*", severity: "caution", reason: "Publishing to npm registry" },
    { pattern: "yarn publish*", severity: "caution", reason: "Publishing to npm registry" },
    { pattern: "pnpm publish*", severity: "caution", reason: "Publishing to npm registry" },
    { pattern: "chmod 777*", severity: "caution", reason: "Overly permissive file permissions" },
    { pattern: "*sudo *", severity: "caution", reason: "Elevated privileges requested" },
    { pattern: "docker rm -f*", severity: "caution", reason: "Force remove container" },
    { pattern: "docker system prune*", severity: "caution", reason: "Removes unused Docker resources" },

    { pattern: "git status*", severity: "ok", reason: "Read-only git operation" },
    { pattern: "git diff*", severity: "ok", reason: "Read-only git operation" },
    { pattern: "git log*", severity: "ok", reason: "Read-only git operation" },
    { pattern: "git branch*", severity: "ok", reason: "Read-only git operation" },
    { pattern: "git rev-parse*", severity: "ok", reason: "Read-only git operation" },
    { pattern: "ls*", severity: "ok", reason: "List directory contents" },
    { pattern: "pwd", severity: "ok", reason: "Print working directory" },
    { pattern: "echo *", severity: "ok", reason: "Print text" },
    { pattern: "cat *", severity: "ok", reason: "Read file contents" },
    { pattern: "head *", severity: "ok", reason: "Read file head" },
    { pattern: "tail *", severity: "ok", reason: "Read file tail" },
    { pattern: "node -v", severity: "ok", reason: "Version check" },
    { pattern: "npm -v", severity: "ok", reason: "Version check" },
    { pattern: "pnpm -v", severity: "ok", reason: "Version check" },
    { pattern: "yarn -v", severity: "ok", reason: "Version check" },
    { pattern: "which *", severity: "ok", reason: "Locate command" },
    { pattern: "type *", severity: "ok", reason: "Describe command" },
  ];
}

export function defaultMcpRules(): PolicyRule[] {
  return [{ pattern: "goal-guardian/*", severity: "ok", reason: "Goal Guardian MCP tools" }];
}

export function defaultReadRules(): PolicyRule[] {
  return [
    { pattern: "**/.env", severity: "alert", reason: "Environment secrets" },
    { pattern: "**/.env.*", severity: "alert", reason: "Environment secrets" },
    { pattern: "**/*.pem", severity: "alert", reason: "Private key file" },
    { pattern: "**/*.key", severity: "alert", reason: "Private key file" },
    { pattern: ".git/**", severity: "alert", reason: "Git internals" },
    { pattern: ".cursor/goal-guardian/telemetry/**", severity: "caution", reason: "Guardian telemetry data" },

    { pattern: ".cursor/goal-guardian/**", severity: "ok", reason: "Guardian configuration" },
    { pattern: ".cursor/hooks.json", severity: "ok", reason: "Hooks configuration" },
    { pattern: ".cursor/mcp.json", severity: "ok", reason: "MCP configuration" },
  ];
}
