#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { fallback } from "fallback-chain-js";
import { minimatch } from "minimatch";
/**
 * Cursor Goal Guardian MCP Server
 *
 * Purpose:
 *  - Hold the "goal contract" outside the model (on disk)
 *  - Validate steps against success criteria IDs
 *  - Issue short-lived permit tokens that the Cursor hook gate enforces
 *
 * Storage layout (relative to workspace root):
 *  - .cursor/goal-guardian/contract.json   (committable)
 *  - .cursor/goal-guardian/progress.json   (optional)
 *  - .ai/goal-guardian/checks.json         (gitignored runtime)
 *  - .ai/goal-guardian/permits.json        (gitignored runtime)
 *
 * IMPORTANT: This is an STDIO MCP server.
 * Never write to stdout except MCP JSON-RPC. Use console.error for logs.
 */
const SERVER_NAME = "goal-guardian";
const SERVER_VERSION = "0.1.0";
function nowIso() {
    return new Date().toISOString();
}
function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}
async function computeWorkspaceRoot() {
    return fallback([
        () => {
            const v = process.env.GOAL_GUARDIAN_WORKSPACE_ROOT ?? process.env.CURSOR_WORKSPACE_ROOT;
            if (!v || v.trim().length === 0)
                throw new Error("missing env root");
            return v;
        },
        () => process.cwd(),
    ]);
}
function getPaths(workspaceRoot) {
    const cursorDir = path.join(workspaceRoot, ".cursor", "goal-guardian");
    const aiDir = path.join(workspaceRoot, ".ai", "goal-guardian");
    return {
        workspaceRoot,
        cursorDir,
        aiDir,
        contractPath: path.join(cursorDir, "contract.json"),
        progressPath: path.join(cursorDir, "progress.json"),
        checksPath: path.join(aiDir, "checks.json"),
        permitsPath: path.join(aiDir, "permits.json"),
        violationsPath: path.join(aiDir, "violations.json"),
        policyPath: path.join(cursorDir, "policy.json"),
    };
}
async function ensureDirs(pathsObj) {
    await fs.mkdir(pathsObj.cursorDir, { recursive: true });
    await fs.mkdir(pathsObj.aiDir, { recursive: true });
}
async function readJson(filePath, fallbackValue) {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return fallbackValue;
    }
}
async function writeJsonAtomic(filePath, value) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tmp, filePath);
}
function defaultContract() {
    return {
        goal: "",
        success_criteria: [],
        constraints: [],
    };
}
function criteriaIds(contract) {
    return contract.success_criteria.map((text, i) => ({
        id: `SC${i + 1}`,
        text,
    }));
}
function validateMapsTo(contract, mapsTo) {
    const ids = new Set(criteriaIds(contract).map((x) => x.id));
    const missing = mapsTo.filter((m) => !ids.has(m));
    return { ok: missing.length === 0, missing };
}
function stepRubric(contract, input) {
    if (!contract.goal || contract.goal.trim().length === 0) {
        return {
            on_goal: false,
            score: 0,
            reason: "No goal is set. Initialize contract first (guardian_initialize_contract).",
            suggested_revision: "Call guardian_initialize_contract with a concrete goal and success criteria.",
        };
    }
    const crit = criteriaIds(contract);
    if (crit.length === 0) {
        return {
            on_goal: false,
            score: 0,
            reason: "No success criteria are set. Add at least 1 success criterion (guardian_initialize_contract).",
            suggested_revision: "Add success criteria so steps can map to SC1/SC2/...",
        };
    }
    const { ok, missing } = validateMapsTo(contract, input.maps_to);
    if (!ok) {
        return {
            on_goal: false,
            score: 0.2,
            reason: `maps_to contains unknown success criteria IDs: ${missing.join(", ")}.`,
            suggested_revision: `Pick from: ${crit.map((c) => c.id).join(", ")}.`,
        };
    }
    const stepLower = input.step.toLowerCase();
    const suspicious = ["also", "by the way", "extra", "bonus", "while we're at it"];
    if (suspicious.some((w) => stepLower.includes(w))) {
        return {
            on_goal: false,
            score: 0.4,
            reason: "Step looks like scope expansion. Keep steps tight and map each to explicit success criteria.",
            suggested_revision: "Rewrite the step to do exactly one thing that maps to specific success criteria.",
        };
    }
    return {
        on_goal: true,
        score: 1,
        reason: "Step maps to valid success criteria IDs.",
    };
}
function permitDocPruneExpired(doc) {
    const now = Date.now();
    const permits = (doc.permits ?? []).filter((p) => Date.parse(p.expires_at) > now);
    return { permits };
}
// Use minimatch for glob matching (same as hook)
function globAny(patterns, value) {
    return patterns.some((pat) => minimatch(value, pat, { dot: true, nocase: true }));
}
function classifySeverity(rules, value) {
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
function defaultPolicy() {
    return {
        requirePermitForShell: true,
        requirePermitForMcp: true,
        requirePermitForRead: false,
        autoRevertUnauthorizedEdits: false,
        alwaysAllow: {
            shell: ["git status*", "git diff*", "git rev-parse*", "ls*", "pwd", "node -v", "npm -v", "pnpm -v"],
            mcp: ["goal-guardian/*"],
            read: [".cursor/goal-guardian/**", ".cursor/hooks.json", ".cursor/mcp.json"],
        },
        alwaysDeny: {
            shell: ["rm -rf /*", "rm -rf /", "*curl*|*sh*", "*wget*|*sh*"],
            mcp: [],
            read: [".ai/goal-guardian/**", ".git/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"],
        },
        warningConfig: {
            maxWarningsBeforeBlock: 3,
            warningResetMinutes: 60,
            showGoalReminder: true,
        },
        shellRules: [
            { pattern: "rm -rf /", severity: "HARD_BLOCK", reason: "Catastrophic filesystem deletion" },
            { pattern: "rm -rf /*", severity: "HARD_BLOCK", reason: "Catastrophic filesystem deletion" },
            { pattern: "*curl*|*sh*", severity: "HARD_BLOCK", reason: "Remote code execution" },
            { pattern: "*wget*|*sh*", severity: "HARD_BLOCK", reason: "Remote code execution" },
            { pattern: "rm -rf *", severity: "WARN", reason: "Recursive force delete" },
            { pattern: "*--force*", severity: "WARN", reason: "Force flag bypasses safety checks" },
            { pattern: "git reset --hard*", severity: "WARN", reason: "Destructive git operation" },
            { pattern: "git push --force*", severity: "WARN", reason: "Force push can overwrite history" },
            { pattern: "npm publish*", severity: "WARN", reason: "Publishing to npm registry" },
            { pattern: "git status*", severity: "ALLOWED", reason: "Read-only git operation" },
            { pattern: "git diff*", severity: "ALLOWED", reason: "Read-only git operation" },
            { pattern: "ls*", severity: "ALLOWED", reason: "List directory contents" },
            { pattern: "pwd", severity: "ALLOWED", reason: "Print working directory" },
        ],
        mcpRules: [{ pattern: "goal-guardian/*", severity: "ALLOWED", reason: "Goal Guardian MCP tools" }],
        readRules: [
            { pattern: "**/.env", severity: "HARD_BLOCK", reason: "Environment secrets" },
            { pattern: "**/.env.*", severity: "HARD_BLOCK", reason: "Environment secrets" },
            { pattern: ".cursor/goal-guardian/**", severity: "ALLOWED", reason: "Guardian configuration" },
        ],
    };
}
async function loadPolicy(pathsObj) {
    const base = defaultPolicy();
    const fromFile = await readJson(pathsObj.policyPath, {});
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
            ...base.warningConfig,
            ...fromFile.warningConfig,
        },
        shellRules: fromFile.shellRules ?? base.shellRules,
        mcpRules: fromFile.mcpRules ?? base.mcpRules,
        readRules: fromFile.readRules ?? base.readRules,
    };
}
const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
});
server.registerTool("guardian_get_contract", {
    description: "Get the current goal contract (goal + success criteria + constraints).",
    inputSchema: {},
}, async () => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);
    const contract = await readJson(p.contractPath, defaultContract());
    const crit = criteriaIds(contract);
    const payload = {
        contract,
        criteria_ids: crit,
        files: {
            contract: path.relative(root, p.contractPath),
            progress: path.relative(root, p.progressPath),
            permits: path.relative(root, p.permitsPath),
            checks: path.relative(root, p.checksPath),
        },
    };
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
});
server.registerTool("guardian_initialize_contract", {
    description: "Initialize/replace the goal contract on disk. This is the canonical source of truth for goal + success criteria.",
    inputSchema: {
        goal: z.string().min(1).describe("Short, unambiguous goal statement."),
        success_criteria: z
            .array(z.string().min(1))
            .min(1)
            .describe("List of success criteria. IDs will be SC1, SC2, ..."),
        constraints: z.array(z.string().min(1)).default([]).describe("Constraints / guardrails."),
    },
}, async ({ goal, success_criteria, constraints }) => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);
    const contract = { goal, success_criteria, constraints };
    await writeJsonAtomic(p.contractPath, contract);
    return {
        content: [
            {
                type: "text",
                text: `✅ Contract written to ${path.relative(root, p.contractPath)}\n` +
                    `Success criteria IDs: ${criteriaIds(contract).map((c) => c.id).join(", ")}`,
            },
        ],
    };
});
server.registerTool("guardian_check_step", {
    description: "Check whether a proposed step is on-goal by requiring explicit mapping to success criteria IDs. Records a check in .ai for auditability.",
    inputSchema: {
        step: z.string().min(1),
        rationale: z.string().optional(),
        expected_output: z.string().min(1).describe("What concrete artifact/result will exist after this step?"),
        maps_to: z.array(z.string().min(1)).min(1).describe("Which success criteria IDs does this step satisfy?"),
    },
}, async ({ step, rationale, expected_output, maps_to }) => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);
    const contract = await readJson(p.contractPath, defaultContract());
    const verdict = stepRubric(contract, { step, maps_to });
    const record = {
        step_id: newId("step"),
        step,
        rationale,
        expected_output,
        maps_to,
        on_goal: verdict.on_goal,
        score: verdict.score,
        reason: verdict.reason,
        suggested_revision: verdict.suggested_revision,
        ts: nowIso(),
    };
    const checksDoc = await readJson(p.checksPath, { checks: [] });
    checksDoc.checks.unshift(record);
    await writeJsonAtomic(p.checksPath, checksDoc);
    return {
        content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
    };
});
server.registerTool("guardian_issue_permit", {
    description: "Issue a short-lived permit token tied to a step_id from guardian_check_step. The Cursor hook gate reads permits from .ai and blocks actions without a valid permit.",
    inputSchema: {
        step_id: z.string().min(1),
        ttl_seconds: z.number().int().min(30).max(3600).default(600),
        allow_shell: z.array(z.string().min(1)).default([]).describe("Glob patterns matched against the full command."),
        allow_mcp: z
            .array(z.string().min(1))
            .default([])
            .describe("Glob patterns like 'server/tool_name' matched against MCP calls."),
        allow_read: z.array(z.string().min(1)).default([]).describe("Glob patterns matched against relative file paths."),
        allow_write: z.array(z.string().min(1)).default([]).describe("Glob patterns matched against relative file paths."),
    },
}, async ({ step_id, ttl_seconds, allow_shell, allow_mcp, allow_read, allow_write }) => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);
    const checksDoc = await readJson(p.checksPath, { checks: [] });
    const check = checksDoc.checks.find((c) => c.step_id === step_id);
    if (!check) {
        return {
            content: [{ type: "text", text: `❌ Unknown step_id: ${step_id}. Run guardian_check_step first.` }],
        };
    }
    if (!check.on_goal || check.score < 0.5) {
        return {
            content: [
                {
                    type: "text",
                    text: `❌ Step is not approved (on_goal=${check.on_goal}, score=${check.score}).\n` +
                        `Reason: ${check.reason}\n` +
                        `Suggested revision: ${check.suggested_revision ?? "n/a"}`,
                },
            ],
        };
    }
    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + ttl_seconds * 1000).toISOString();
    const permit = {
        token: newId("permit"),
        step_id,
        issued_at: issuedAt,
        expires_at: expiresAt,
        allow: {
            shell: allow_shell,
            mcp: allow_mcp,
            read: allow_read,
            write: allow_write,
        },
    };
    const permitsDoc = permitDocPruneExpired(await readJson(p.permitsPath, { permits: [] }));
    permitsDoc.permits.unshift(permit);
    await writeJsonAtomic(p.permitsPath, permitsDoc);
    return {
        content: [{ type: "text", text: JSON.stringify(permit, null, 2) }],
    };
});
server.registerTool("guardian_commit_result", {
    description: "Commit a step result into progress.json and revoke any permits for that step_id.",
    inputSchema: {
        step_id: z.string().min(1),
        result_summary: z.string().min(1),
        evidence_refs: z.array(z.string().min(1)).default([]),
    },
}, async ({ step_id, result_summary, evidence_refs }) => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);
    const progressDoc = await readJson(p.progressPath, { progress: [] });
    progressDoc.progress.unshift({
        step_id,
        result_summary,
        evidence_refs,
        ts: nowIso(),
    });
    await writeJsonAtomic(p.progressPath, progressDoc);
    const permitsDoc = await readJson(p.permitsPath, { permits: [] });
    const before = permitsDoc.permits.length;
    permitsDoc.permits = permitsDoc.permits.filter((perm) => perm.step_id !== step_id);
    const after = permitsDoc.permits.length;
    await writeJsonAtomic(p.permitsPath, permitsDoc);
    return {
        content: [
            {
                type: "text",
                text: `✅ Progress recorded in ${path.relative(root, p.progressPath)}\n` +
                    `Revoked ${before - after} permit(s) for step_id ${step_id}`,
            },
        ],
    };
});
server.registerTool("guardian_preview_action", {
    description: "Preview whether an action would be allowed without actually attempting it. Use this to check if a command, MCP call, or file read would succeed before trying.",
    inputSchema: {
        action_type: z.enum(["shell", "mcp", "read", "write"]).describe("The type of action to preview."),
        action_value: z
            .string()
            .min(1)
            .describe("The action value (command string, 'server/tool' for MCP, or file path for read/write)."),
    },
}, async ({ action_type, action_value }) => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);
    const policy = await loadPolicy(p);
    const permitsDoc = permitDocPruneExpired(await readJson(p.permitsPath, { permits: [] }));
    const violations = await readJson(p.violationsPath, { warningCounts: {}, lastReset: nowIso() });
    const permit = permitsDoc.permits.length > 0 ? permitsDoc.permits[0] : null;
    let result;
    if (action_type === "shell") {
        const { severity, rule } = classifySeverity(policy.shellRules, action_value);
        if (severity === "HARD_BLOCK" || globAny(policy.alwaysDeny.shell, action_value)) {
            result = {
                wouldSucceed: false,
                severity: "HARD_BLOCK",
                reason: rule?.reason ?? "Blocked by policy - cannot be permitted",
            };
        }
        else if (severity === "ALLOWED" || globAny(policy.alwaysAllow.shell, action_value)) {
            result = {
                wouldSucceed: true,
                severity: "ALLOWED",
                reason: rule?.reason ?? "Always allowed",
            };
        }
        else if (severity === "WARN") {
            const pattern = rule?.pattern ?? action_value;
            const count = violations.warningCounts[pattern] ?? 0;
            const max = policy.warningConfig.maxWarningsBeforeBlock;
            if (count >= max) {
                result = {
                    wouldSucceed: false,
                    severity: "WARN",
                    reason: `Warning limit exceeded (${count}/${max}). Request a permit to proceed.`,
                    suggestedPermitRequest: {
                        step: `Execute shell command: ${action_value}`,
                        maps_to: ["SC1"],
                        allow_field: "allow_shell",
                        allow_pattern: `${action_value.split(" ")[0]}*`,
                    },
                };
            }
            else {
                result = {
                    wouldSucceed: true,
                    severity: "WARN",
                    reason: `Would issue warning (${count + 1}/${max}): ${rule?.reason ?? "risky operation"}`,
                };
            }
        }
        else {
            // PERMIT_REQUIRED
            if (!policy.requirePermitForShell) {
                result = {
                    wouldSucceed: true,
                    severity: "PERMIT_REQUIRED",
                    reason: "Permit not required for shell (policy setting)",
                };
            }
            else if (permit && globAny(permit.allow.shell ?? [], action_value)) {
                result = {
                    wouldSucceed: true,
                    severity: "PERMIT_REQUIRED",
                    reason: "Current permit allows this command",
                };
            }
            else {
                result = {
                    wouldSucceed: false,
                    severity: "PERMIT_REQUIRED",
                    reason: "No valid permit for this command",
                    suggestedPermitRequest: {
                        step: `Execute shell command: ${action_value}`,
                        maps_to: ["SC1"],
                        allow_field: "allow_shell",
                        allow_pattern: `${action_value.split(" ")[0]}*`,
                    },
                };
            }
        }
    }
    else if (action_type === "mcp") {
        const { severity, rule } = classifySeverity(policy.mcpRules, action_value);
        if (severity === "HARD_BLOCK" || globAny(policy.alwaysDeny.mcp, action_value)) {
            result = {
                wouldSucceed: false,
                severity: "HARD_BLOCK",
                reason: rule?.reason ?? "Blocked by policy",
            };
        }
        else if (severity === "ALLOWED" || globAny(policy.alwaysAllow.mcp, action_value)) {
            result = {
                wouldSucceed: true,
                severity: "ALLOWED",
                reason: rule?.reason ?? "Always allowed",
            };
        }
        else if (!policy.requirePermitForMcp) {
            result = {
                wouldSucceed: true,
                severity: "PERMIT_REQUIRED",
                reason: "Permit not required for MCP (policy setting)",
            };
        }
        else if (permit && globAny(permit.allow.mcp ?? [], action_value)) {
            result = {
                wouldSucceed: true,
                severity: "PERMIT_REQUIRED",
                reason: "Current permit allows this MCP call",
            };
        }
        else {
            result = {
                wouldSucceed: false,
                severity: "PERMIT_REQUIRED",
                reason: "No valid permit for this MCP call",
                suggestedPermitRequest: {
                    step: `Execute MCP call: ${action_value}`,
                    maps_to: ["SC1"],
                    allow_field: "allow_mcp",
                    allow_pattern: action_value,
                },
            };
        }
    }
    else {
        // read or write
        const { severity, rule } = classifySeverity(policy.readRules, action_value);
        if (severity === "HARD_BLOCK" || globAny(policy.alwaysDeny.read, action_value)) {
            result = {
                wouldSucceed: false,
                severity: "HARD_BLOCK",
                reason: rule?.reason ?? "Blocked by policy",
            };
        }
        else if (severity === "ALLOWED" || globAny(policy.alwaysAllow.read, action_value)) {
            result = {
                wouldSucceed: true,
                severity: "ALLOWED",
                reason: rule?.reason ?? "Always allowed",
            };
        }
        else if (!policy.requirePermitForRead) {
            result = {
                wouldSucceed: true,
                severity: "PERMIT_REQUIRED",
                reason: "Permit not required for file operations (policy setting)",
            };
        }
        else {
            const allowField = action_type === "read" ? "allow_read" : "allow_write";
            const permitPatterns = action_type === "read" ? permit?.allow.read : permit?.allow.write;
            if (permit && globAny(permitPatterns ?? [], action_value)) {
                result = {
                    wouldSucceed: true,
                    severity: "PERMIT_REQUIRED",
                    reason: `Current permit allows this ${action_type} operation`,
                };
            }
            else {
                result = {
                    wouldSucceed: false,
                    severity: "PERMIT_REQUIRED",
                    reason: `No valid permit for this ${action_type} operation`,
                    suggestedPermitRequest: {
                        step: `${action_type === "read" ? "Read" : "Write"} file: ${action_value}`,
                        maps_to: ["SC1"],
                        allow_field: allowField,
                        allow_pattern: action_value,
                    },
                };
            }
        }
    }
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
server.registerTool("guardian_get_status", {
    description: "Get the current Goal Guardian status including contract, permits, and warning state. Useful for understanding the current guardrail state.",
    inputSchema: {},
}, async () => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);
    const contract = await readJson(p.contractPath, defaultContract());
    const permitsDoc = permitDocPruneExpired(await readJson(p.permitsPath, { permits: [] }));
    const violations = await readJson(p.violationsPath, { warningCounts: {}, lastReset: nowIso() });
    const policy = await loadPolicy(p);
    const hasContract = Boolean(contract.goal && contract.goal.trim().length > 0);
    const criteriaCount = contract.success_criteria.length;
    const activePermits = permitsDoc.permits.map((perm) => ({
        token: perm.token,
        step_id: perm.step_id,
        expires_at: perm.expires_at,
        shell_patterns: perm.allow.shell.length,
        mcp_patterns: perm.allow.mcp.length,
        read_patterns: perm.allow.read.length,
        write_patterns: perm.allow.write.length,
    }));
    const totalWarnings = Object.values(violations.warningCounts).reduce((sum, c) => sum + c, 0);
    const warningsByPattern = Object.entries(violations.warningCounts)
        .filter(([_, count]) => count > 0)
        .map(([pattern, count]) => ({ pattern, count }))
        .sort((a, b) => b.count - a.count);
    const status = {
        hasContract,
        goal: contract.goal || null,
        criteriaCount,
        criteria: criteriaIds(contract),
        constraints: contract.constraints,
        activePermits,
        warningState: {
            totalWarnings,
            maxWarningsBeforeBlock: policy.warningConfig.maxWarningsBeforeBlock,
            warningsByPattern,
            lastReset: violations.lastReset,
        },
        policy: {
            requirePermitForShell: policy.requirePermitForShell,
            requirePermitForMcp: policy.requirePermitForMcp,
            requirePermitForRead: policy.requirePermitForRead,
        },
    };
    return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[${SERVER_NAME}] MCP server running on stdio (v${SERVER_VERSION})`);
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map