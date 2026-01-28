#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { minimatch } from "minimatch";
import { fallback } from "fallback-chain-js";
import { defaultPolicy, type GoalGuardianPolicy } from "./policy.js";

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

  const recoveryMsg =
    "Blocked by Goal-Guardian. To proceed: (1) call MCP tool guardian_check_step, (2) if approved, call guardian_issue_permit, then retry.";

  if (eventName === "beforeShellExecution") {
    const cmd = String(payload?.command ?? "");
    if (cmd.length === 0) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (globAny(policy.alwaysDeny.shell, cmd)) {
      process.stdout.write(JSON.stringify(cursorResponseDeny(`Blocked dangerous command: ${cmd}`)));
      return;
    }

    if (globAny(policy.alwaysAllow.shell, cmd)) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (!policy.requirePermitForShell) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (!permit) {
      process.stdout.write(JSON.stringify(cursorResponseDeny("No valid permit for shell command.", recoveryMsg)));
      return;
    }

    const allowed = globAny(permit.allow.shell ?? [], cmd);
    if (!allowed) {
      process.stdout.write(
        JSON.stringify(
          cursorResponseDeny(
            `Shell command not permitted for current step. Command: ${cmd}`,
            `Permit exists but does not allow this command. ${recoveryMsg}`,
          ),
        ),
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

    if (globAny(policy.alwaysAllow.mcp, key)) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (globAny(policy.alwaysDeny.mcp, key)) {
      process.stdout.write(JSON.stringify(cursorResponseDeny(`MCP call denied: ${key}`)));
      return;
    }

    if (!policy.requirePermitForMcp) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (!permit) {
      process.stdout.write(JSON.stringify(cursorResponseDeny("No valid permit for MCP call.", recoveryMsg)));
      return;
    }

    const allowed = globAny(permit.allow.mcp ?? [], key);
    if (!allowed) {
      process.stdout.write(
        JSON.stringify(
          cursorResponseDeny(
            `MCP call not permitted for current step: ${key}`,
            `Permit exists but does not allow this MCP call. ${recoveryMsg}`,
          ),
        ),
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

    if (globAny(policy.alwaysDeny.read, rel)) {
      process.stdout.write(JSON.stringify(cursorResponseDeny(`Reading file denied by policy: ${rel}`)));
      return;
    }

    if (globAny(policy.alwaysAllow.read, rel)) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (!policy.requirePermitForRead) {
      process.stdout.write(JSON.stringify(cursorResponseAllow()));
      return;
    }

    if (!permit) {
      process.stdout.write(JSON.stringify(cursorResponseDeny("No valid permit for file read.", recoveryMsg)));
      return;
    }

    const allowed = globAny(permit.allow.read ?? [], rel);
    if (!allowed) {
      process.stdout.write(
        JSON.stringify(
          cursorResponseDeny(
            `File read not permitted for current step: ${rel}`,
            `Permit exists but does not allow reading ${rel}. ${recoveryMsg}`,
          ),
        ),
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
