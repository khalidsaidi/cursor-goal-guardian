import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAudit,
  criteriaFromTexts,
  defaultConfig,
  defaultContract,
  defaultState,
  getGuardianPaths,
  newId,
  nowIso,
  readAuditTail,
  replay,
  runPipeline,
  type GuardianAction,
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
async function makeRoot(opts: { activeTask?: string; config?: unknown } = {}): Promise<string> {
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

  const { meta: _meta, ...imported } = defaultState();
  imported.goal = contract.goal;
  imported.successCriteria = contract.successCriteria;
  if (opts.activeTask) {
    imported.tasks = [{ id: "t1", title: opts.activeTask, status: "doing" }];
    imported.activeTaskId = "t1";
  }
  const action: GuardianAction = {
    id: newId("act"),
    ts: nowIso(),
    actor: "system",
    type: "MIGRATE_IMPORT",
    payload: { state: imported },
  };
  await fs.writeFile(paths.actions, JSON.stringify(action) + "\n", "utf8");
  await writeJson(paths.state, replay([action]));
  return root;
}

const EXPORTER_TASK = "Implement the CSV exporter serializer";
const OFF_GOAL = "docker build darkmode theme palette tokens .";

// The pipeline is shared between the hook binary and the extension's
// in-process observer. Provenance must survive onto the tape so the observer
// can tell live hooks from its own echo and never double-tapes.
describe("pipeline provenance", () => {
  it("hook-sourced runs leave no source marker", async () => {
    const root = await makeRoot();
    const outcome = await runPipeline(root, "beforeShellExecution", "shell", "git status");
    expect(outcome.permission).toBe("allow");
    const events = (await readAuditTail(root)).filter((r) => r.kind === "hook.event");
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("source");
  });

  it("observer-sourced runs stamp source on hook.event and action.observed", async () => {
    const root = await makeRoot();
    await runPipeline(root, "afterFileEdit", "edit", "src/app.ts", { source: "observer" });
    const records = await readAuditTail(root);
    expect(records.find((r) => r.kind === "hook.event")).toMatchObject({ source: "observer" });
    expect(records.find((r) => r.kind === "action.observed")).toMatchObject({
      source: "observer",
      actionType: "edit",
      actionValue: "src/app.ts",
    });
  });

  it("observer-sourced records round-trip through the audit schema", async () => {
    const root = await makeRoot();
    await appendAudit(root, {
      ts: "2026-01-01T10:00:00.000Z",
      kind: "hook.event",
      event: "afterFileEdit",
      source: "observer",
    });
    expect(await readAuditTail(root)).toHaveLength(1);
  });
});

describe("pipeline behavior (shared by hook binary and observer)", () => {
  it("off-goal burst: drift recorded every time, nudged once per episode", async () => {
    const root = await makeRoot({ activeTask: EXPORTER_TASK });
    const first = await runPipeline(root, "beforeShellExecution", "shell", OFF_GOAL);
    const second = await runPipeline(root, "beforeShellExecution", "shell", OFF_GOAL);
    expect(first.permission).toBe("allow");
    expect(second.permission).toBe("allow");
    const nudges = [first, second].filter((r) => typeof r.userMessage === "string");
    expect(nudges).toHaveLength(1);
    const drifts = (await readAuditTail(root)).filter((r) => r.kind === "drift.lexical");
    expect(drifts.length).toBe(2);
  });

  it("high-risk command: advisory recorded, alert nudge, still allow", async () => {
    const root = await makeRoot({ activeTask: EXPORTER_TASK });
    const outcome = await runPipeline(root, "beforeShellExecution", "shell", "rm -rf /");
    expect(outcome.permission).toBe("allow");
    expect(outcome.userMessage).toMatch(/high-risk/);
    expect((await readAuditTail(root)).some((r) => r.kind === "policy.advisory")).toBe(true);
  });

  it("quiet mode: everything recorded, zero messages", async () => {
    const root = await makeRoot({ activeTask: EXPORTER_TASK, config: { notify: "quiet" } });
    const drifted = await runPipeline(root, "beforeShellExecution", "shell", OFF_GOAL);
    const risky = await runPipeline(root, "beforeShellExecution", "shell", "rm -rf /");
    expect(drifted.userMessage).toBeUndefined();
    expect(risky.userMessage).toBeUndefined();
    expect((await readAuditTail(root)).length).toBeGreaterThan(0);
  });

  it("no active task: one episode-governed reminder, none for bootstrap paths", async () => {
    const root = await makeRoot();
    const bootstrap = await runPipeline(root, "afterFileEdit", "edit", ".cursor/rules/guardian.mdc");
    expect(bootstrap.userMessage).toBeUndefined();
    const first = await runPipeline(root, "beforeShellExecution", "shell", "git status");
    const second = await runPipeline(root, "beforeShellExecution", "shell", "git log");
    expect(first.userMessage).toMatch(/no task is active/);
    expect(second.userMessage).toBeUndefined();
  });

  it("opt-in escalation: confirmed drift continued past its nudge turns into an ask", async () => {
    const root = await makeRoot({
      activeTask: EXPORTER_TASK,
      config: { advisories: { escalateConfirmedDrift: "ask" } },
    });
    const nudged = await runPipeline(root, "beforeShellExecution", "shell", OFF_GOAL);
    expect(nudged.userMessage).toBeDefined();

    const drift = (await readAuditTail(root)).find((r) => r.kind === "drift.lexical");
    expect(drift?.kind).toBe("drift.lexical");
    const driftId = drift?.kind === "drift.lexical" ? drift.driftId : "";
    await writeJson(getGuardianPaths(root).verdicts, {
      schemaVersion: 2,
      entries: {
        [driftId]: { verdict: "confirmed", judge: "test", confidence: 0.9, rationale: "off goal", ts: nowIso() },
      },
    });

    const continued = await runPipeline(root, "beforeShellExecution", "shell", OFF_GOAL);
    expect(continued.permission).toBe("ask");
  });
});
