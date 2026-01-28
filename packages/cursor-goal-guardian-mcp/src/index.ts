#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { fallback } from "fallback-chain-js";

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

type GoalContract = {
  goal: string;
  success_criteria: string[];
  constraints: string[];
};

type ProgressEntry = {
  step_id: string;
  result_summary: string;
  evidence_refs: string[];
  ts: string;
};

type CheckRecord = {
  step_id: string;
  step: string;
  rationale?: string;
  expected_output: string;
  maps_to: string[];
  on_goal: boolean;
  score: number;
  reason: string;
  suggested_revision?: string;
  ts: string;
};

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
type ChecksDoc = { checks: CheckRecord[] };
type ProgressDoc = { progress: ProgressEntry[] };

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

async function computeWorkspaceRoot(): Promise<string> {
  return fallback([
    () => {
      const v = process.env.GOAL_GUARDIAN_WORKSPACE_ROOT ?? process.env.CURSOR_WORKSPACE_ROOT;
      if (!v || v.trim().length === 0) throw new Error("missing env root");
      return v;
    },
    () => process.cwd(),
  ]);
}

function getPaths(workspaceRoot: string) {
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
  };
}

async function ensureDirs(pathsObj: ReturnType<typeof getPaths>): Promise<void> {
  await fs.mkdir(pathsObj.cursorDir, { recursive: true });
  await fs.mkdir(pathsObj.aiDir, { recursive: true });
}

async function readJson<T>(filePath: string, fallbackValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallbackValue;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${crypto.randomBytes(6).toString("hex")}`,
  );
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

function defaultContract(): GoalContract {
  return {
    goal: "",
    success_criteria: [],
    constraints: [],
  };
}

function criteriaIds(contract: GoalContract): Array<{ id: string; text: string }> {
  return contract.success_criteria.map((text, i) => ({
    id: `SC${i + 1}`,
    text,
  }));
}

function validateMapsTo(contract: GoalContract, mapsTo: string[]): { ok: boolean; missing: string[] } {
  const ids = new Set(criteriaIds(contract).map((x) => x.id));
  const missing = mapsTo.filter((m) => !ids.has(m));
  return { ok: missing.length === 0, missing };
}

function stepRubric(contract: GoalContract, input: { step: string; maps_to: string[] }): {
  on_goal: boolean;
  score: number;
  reason: string;
  suggested_revision?: string;
} {
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

function permitDocPruneExpired(doc: PermitsDoc): PermitsDoc {
  const now = Date.now();
  const permits = (doc.permits ?? []).filter((p) => Date.parse(p.expires_at) > now);
  return { permits };
}

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

server.registerTool(
  "guardian_get_contract",
  {
    description: "Get the current goal contract (goal + success criteria + constraints).",
    inputSchema: {},
  },
  async () => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);

    const contract = await readJson<GoalContract>(p.contractPath, defaultContract());
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
  },
);

server.registerTool(
  "guardian_initialize_contract",
  {
    description:
      "Initialize/replace the goal contract on disk. This is the canonical source of truth for goal + success criteria.",
    inputSchema: {
      goal: z.string().min(1).describe("Short, unambiguous goal statement."),
      success_criteria: z
        .array(z.string().min(1))
        .min(1)
        .describe("List of success criteria. IDs will be SC1, SC2, ..."),
      constraints: z.array(z.string().min(1)).default([]).describe("Constraints / guardrails."),
    },
  },
  async ({ goal, success_criteria, constraints }) => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);

    const contract: GoalContract = { goal, success_criteria, constraints };
    await writeJsonAtomic(p.contractPath, contract);

    return {
      content: [
        {
          type: "text",
          text:
            `✅ Contract written to ${path.relative(root, p.contractPath)}\n` +
            `Success criteria IDs: ${criteriaIds(contract).map((c) => c.id).join(", ")}`,
        },
      ],
    };
  },
);

server.registerTool(
  "guardian_check_step",
  {
    description:
      "Check whether a proposed step is on-goal by requiring explicit mapping to success criteria IDs. Records a check in .ai for auditability.",
    inputSchema: {
      step: z.string().min(1),
      rationale: z.string().optional(),
      expected_output: z.string().min(1).describe("What concrete artifact/result will exist after this step?"),
      maps_to: z.array(z.string().min(1)).min(1).describe("Which success criteria IDs does this step satisfy?"),
    },
  },
  async ({ step, rationale, expected_output, maps_to }) => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);

    const contract = await readJson<GoalContract>(p.contractPath, defaultContract());
    const verdict = stepRubric(contract, { step, maps_to });

    const record: CheckRecord = {
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

    const checksDoc = await readJson<ChecksDoc>(p.checksPath, { checks: [] });
    checksDoc.checks.unshift(record);
    await writeJsonAtomic(p.checksPath, checksDoc);

    return {
      content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
    };
  },
);

server.registerTool(
  "guardian_issue_permit",
  {
    description:
      "Issue a short-lived permit token tied to a step_id from guardian_check_step. The Cursor hook gate reads permits from .ai and blocks actions without a valid permit.",
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
  },
  async ({ step_id, ttl_seconds, allow_shell, allow_mcp, allow_read, allow_write }) => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);

    const checksDoc = await readJson<ChecksDoc>(p.checksPath, { checks: [] });
    const check = checksDoc.checks.find((c) => c.step_id === step_id);

    if (!check) {
      return {
        content: [{ type: "text", text: `❌ Unknown step_id: ${step_id}. Run guardian_check_step first.` }],
      };
    }
    if (!check.on_goal || check.score < 0.6) {
      return {
        content: [
          {
            type: "text",
            text:
              `❌ Step is not approved (on_goal=${check.on_goal}, score=${check.score}).\n` +
              `Reason: ${check.reason}\n` +
              `Suggested revision: ${check.suggested_revision ?? "n/a"}`,
          },
        ],
      };
    }

    const issuedAt = nowIso();
    const expiresAt = new Date(Date.now() + ttl_seconds * 1000).toISOString();
    const permit: Permit = {
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

    const permitsDoc = permitDocPruneExpired(await readJson<PermitsDoc>(p.permitsPath, { permits: [] }));
    permitsDoc.permits.unshift(permit);
    await writeJsonAtomic(p.permitsPath, permitsDoc);

    return {
      content: [{ type: "text", text: JSON.stringify(permit, null, 2) }],
    };
  },
);

server.registerTool(
  "guardian_commit_result",
  {
    description: "Commit a step result into progress.json and revoke any permits for that step_id.",
    inputSchema: {
      step_id: z.string().min(1),
      result_summary: z.string().min(1),
      evidence_refs: z.array(z.string().min(1)).default([]),
    },
  },
  async ({ step_id, result_summary, evidence_refs }) => {
    const root = await computeWorkspaceRoot();
    const p = getPaths(root);
    await ensureDirs(p);

    const progressDoc = await readJson<ProgressDoc>(p.progressPath, { progress: [] });
    progressDoc.progress.unshift({
      step_id,
      result_summary,
      evidence_refs,
      ts: nowIso(),
    });
    await writeJsonAtomic(p.progressPath, progressDoc);

    const permitsDoc = await readJson<PermitsDoc>(p.permitsPath, { permits: [] });
    const before = permitsDoc.permits.length;
    permitsDoc.permits = permitsDoc.permits.filter((perm) => perm.step_id !== step_id);
    const after = permitsDoc.permits.length;
    await writeJsonAtomic(p.permitsPath, permitsDoc);

    return {
      content: [
        {
          type: "text",
          text:
            `✅ Progress recorded in ${path.relative(root, p.progressPath)}\n` +
            `Revoked ${before - after} permit(s) for step_id ${step_id}`,
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] MCP server running on stdio (v${SERVER_VERSION})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
