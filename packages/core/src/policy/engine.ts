import { minimatch } from "minimatch";
import type { AdvisorySeverity, GuardianConfig, PolicyRule } from "../schema/config.js";
import { defaultMcpRules, defaultReadRules, defaultShellRules } from "./defaults.js";

export type PolicyActionKind = "shell" | "mcp" | "read";

export interface Advisory {
  severity: AdvisorySeverity;
  /** The matched glob pattern; empty when nothing matched (severity ok). */
  rule: string;
  reason: string;
}

const wildcardCache = new Map<string, RegExp>();

/**
 * Shell commands and MCP tool names are flat strings, not paths: `*` must match
 * anything including `/`. (v0.x used path-glob semantics here, so any command
 * containing a slash — `rm -rf ./build` — silently escaped its rules.)
 */
function wildcardMatch(pattern: string, value: string): boolean {
  let re = wildcardCache.get(pattern);
  if (!re) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[\\s\\S]*");
    re = new RegExp(`^${escaped}$`, "i");
    wildcardCache.set(pattern, re);
  }
  return re.test(value);
}

function globMatch(kind: PolicyActionKind, pattern: string, value: string): boolean {
  if (kind === "read") return minimatch(value, pattern, { dot: true, nocase: true });
  return wildcardMatch(pattern, value);
}

function rulesFor(kind: PolicyActionKind, config: GuardianConfig): PolicyRule[] {
  const user =
    kind === "shell"
      ? config.advisories.shellRules
      : kind === "mcp"
        ? config.advisories.mcpRules
        : config.advisories.readRules;
  const defaults = kind === "shell" ? defaultShellRules() : kind === "mcp" ? defaultMcpRules() : defaultReadRules();
  // User rules first: a workspace rule overrides the built-in verdict for the same action.
  return [...user, ...defaults];
}

/** First matching rule wins; an unmatched action is ok and produces no record. */
export function evaluatePolicy(kind: PolicyActionKind, value: string, config: GuardianConfig): Advisory {
  for (const rule of rulesFor(kind, config)) {
    if (globMatch(kind, rule.pattern, value)) {
      return { severity: rule.severity, rule: rule.pattern, reason: rule.reason ?? "" };
    }
  }
  return { severity: "ok", rule: "", reason: "" };
}
