import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-"));
  await fs.mkdir(path.join(dir, ".cursor", "goal-guardian"), { recursive: true });
  return dir;
}

function getRepoRoot(): string {
  return path.resolve(process.cwd(), "..", "..");
}

function getTsxPath(): string {
  const root = getRepoRoot();
  return path.join(root, "node_modules", ".bin", "tsx");
}

function getMcpEntry(): string {
  return path.join(getRepoRoot(), "packages", "cursor-goal-guardian-mcp", "src", "index.ts");
}

async function runPreview(client: Client, action_type: "shell" | "mcp" | "read" | "write", action_value: string) {
  const res = await client.callTool({
    name: "guardian_preview_action",
    arguments: {
      action_type,
      action_value,
      record_warning: true,
    },
  });
  const text = (res as any)?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

describe("guardian_preview_action", () => {
  it("treats high-risk actions as advisory in preview mode", async () => {
    const workspaceRoot = await makeTempWorkspace();
    const tsx = getTsxPath();
    const entry = getMcpEntry();

    const client = new Client({ name: "goal-guardian-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: tsx,
      args: [entry],
      env: { GOAL_GUARDIAN_WORKSPACE_ROOT: workspaceRoot },
    });

    await client.connect(transport);

    const preview = await runPreview(client, "shell", "rm -rf /");
    expect(preview.severity).toBe("HIGH_RISK");
    expect(preview.wouldSucceed).toBe(true);
    expect(String(preview.reason)).toMatch(/high-risk|destructive/i);

    await client.close();
  });

  it("records warnings via MCP and increments counts", async () => {
    const workspaceRoot = await makeTempWorkspace();
    const tsx = getTsxPath();
    const entry = getMcpEntry();

    const client = new Client({ name: "goal-guardian-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: tsx,
      args: [entry],
      env: { GOAL_GUARDIAN_WORKSPACE_ROOT: workspaceRoot },
    });

    await client.connect(transport);

    const first = await runPreview(client, "shell", "git reset --hard");
    expect(first.severity).toBe("WARN");
    expect(first.warningCount).toBe(1);

    const second = await runPreview(client, "shell", "git reset --hard");
    expect(second.severity).toBe("WARN");
    expect(second.warningCount).toBe(2);

    const third = await runPreview(client, "shell", "git reset --hard");
    expect(third.severity).toBe("WARN");
    expect(third.warningCount).toBe(3);

    const fourth = await runPreview(client, "shell", "git reset --hard");
    expect(fourth.severity).toBe("WARN");
    expect(fourth.wouldSucceed).toBe(true);
    expect(String(fourth.reason)).toMatch(/allowed/i);

    const violationsPath = path.join(workspaceRoot, ".ai", "goal-guardian", "violations.json");
    const violations = JSON.parse(await fs.readFile(violationsPath, "utf8"));
    expect(violations.warningCounts["git reset --hard*"]).toBe(3);

    await client.close();
  });

  it("keeps permit-required actions non-blocking in preview mode", async () => {
    const workspaceRoot = await makeTempWorkspace();
    const tsx = getTsxPath();
    const entry = getMcpEntry();
    const policyPath = path.join(workspaceRoot, ".cursor", "goal-guardian", "policy.json");
    await fs.writeFile(
      policyPath,
      JSON.stringify(
        {
          requirePermitForShell: true,
          requirePermitForMcp: true,
          requirePermitForRead: false,
        },
        null,
        2,
      ),
      "utf8",
    );

    const client = new Client({ name: "goal-guardian-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: tsx,
      args: [entry],
      env: { GOAL_GUARDIAN_WORKSPACE_ROOT: workspaceRoot },
    });

    await client.connect(transport);

    const preview = await runPreview(client, "shell", "pnpm test");
    expect(preview.severity).toBe("PERMIT_REQUIRED");
    expect(preview.wouldSucceed).toBe(true);
    expect(String(preview.reason)).toMatch(/allowed/i);

    await client.close();
  });
});
