import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit,
  criteriaFromTexts,
  defaultConfig,
  defaultContract,
  getGuardianPaths,
  readAuditTail,
  runPipeline,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Hand-rolled v2 workspace (testkit depends on core, so core scaffolds itself). */
async function makeRoot(opts: { config?: unknown } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-pipe-"));
  roots.push(root);
  const paths = getGuardianPaths(root);
  await fs.mkdir(paths.telemetryDir, { recursive: true });

  const contract = {
    ...defaultContract(),
    goal: "Finish the CSV exporter",
    successCriteria: criteriaFromTexts(["Exporter writes valid CSV"]),
  };
  await writeJson(paths.contract, contract);
  await writeJson(paths.config, opts.config ?? defaultConfig());
  return root;
}

const OFF_GOAL = "docker build darkmode theme palette tokens .";

describe("the pipeline records and says nothing", () => {
  it("shell, MCP and edits go on the tape, always allowed, with nothing said", async () => {
    const root = await makeRoot();
    for (const [event, type, value] of [
      ["beforeShellExecution", "shell", "rm -rf /"],
      ["beforeMCPExecution", "mcp", "server/tool"],
      ["afterFileEdit", "edit", "src/app.ts"],
    ] as const) {
      expect(await runPipeline(root, event, type, value)).toEqual({ continue: true, permission: "allow" });
    }
    const records = await readAuditTail(root);
    expect(records.filter((r) => r.kind === "action.observed").map((r) => (r as { actionType: string }).actionType)).toEqual(["shell", "mcp", "edit"]);
    expect(records.filter((r) => r.kind === "hook.event")).toHaveLength(3);
    for (const old of ["policy.advisory", "loop.repeat", "drift.lexical"]) expect(records.some((r) => r.kind === old)).toBe(false);
  });

  it("the same command over and over gets no message and no flag", async () => {
    const root = await makeRoot();
    for (let i = 0; i < 9; i += 1) expect(await runPipeline(root, "beforeShellExecution", "shell", OFF_GOAL)).toEqual({ continue: true, permission: "allow" });
  });

  it("a record from the removed Windows observer still parses", async () => {
    const root = await makeRoot();
    await appendAudit(root, { ts: "2026-01-01T10:00:00.000Z", kind: "hook.event", event: "afterFileEdit", source: "observer" });
    expect(await readAuditTail(root)).toHaveLength(1);
  });
});
