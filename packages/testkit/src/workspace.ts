import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getGuardianPaths,
  defaultContract,
  defaultConfig,
  defaultState,
  criteriaFromTexts,
  newId,
  nowIso,
  replay,
  type Contract,
  type GuardianAction,
  type GuardianConfig,
  type GuardianState,
  type Task,
} from "@goal-guardian/core";

export interface MakeWorkspaceOptions {
  goal?: string;
  successCriteria?: string[];
  constraints?: string[];
  /** Tasks to seed; the first `doing` task becomes activeTaskId. */
  tasks?: Array<Pick<Task, "id" | "title" | "status"> & { criterionId?: string }>;
  /** Deep-partial config merged by the core config parser. */
  config?: unknown;
  /** Skip writing guardian files entirely (bare workspace). */
  bare?: boolean;
}

export interface TestWorkspace {
  root: string;
  paths: ReturnType<typeof getGuardianPaths>;
  cleanup(): Promise<void>;
}

/** Create a temp workspace with v2 guardian files, mirroring what extension setup writes. */
export async function makeWorkspace(opts: MakeWorkspaceOptions = {}): Promise<TestWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-v2-"));
  const paths = getGuardianPaths(root);

  if (!opts.bare) {
    await fs.mkdir(paths.telemetryDir, { recursive: true });

    const contract: Contract = {
      ...defaultContract(),
      goal: opts.goal ?? "Stay on task",
      successCriteria: criteriaFromTexts(opts.successCriteria ?? ["goal met", "tests added"]),
      constraints: opts.constraints ?? ["No scope creep"],
    };
    await writeJson(paths.contract, contract);

    const config: GuardianConfig = defaultConfig();
    await writeJson(paths.config, opts.config === undefined ? config : opts.config);

    // Seed through a MIGRATE_IMPORT action so state === replay(actions) holds
    // in test workspaces exactly as it does in real ones (setup/migration).
    const { meta: _meta, ...imported } = defaultState();
    imported.goal = contract.goal;
    imported.successCriteria = contract.successCriteria;
    imported.constraints = contract.constraints;
    imported.tasks = (opts.tasks ?? [{ id: "t1", title: "Task 1", status: "doing" }]).map((t) => ({ ...t }));
    imported.activeTaskId = imported.tasks.find((t) => t.status === "doing")?.id ?? null;
    const action: GuardianAction = {
      id: newId("act"),
      ts: nowIso(),
      actor: "system",
      type: "MIGRATE_IMPORT",
      payload: { state: imported },
    };
    const state: GuardianState = replay([action]);
    await fs.writeFile(paths.actions, JSON.stringify(action) + "\n", "utf8");
    await writeJson(paths.state, state);
  }

  return {
    root,
    paths,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}
