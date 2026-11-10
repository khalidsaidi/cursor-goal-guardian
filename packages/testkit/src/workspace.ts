import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getGuardianPaths,
  defaultContract,
  defaultConfig,
  criteriaFromTexts,
  type Contract,
  type GuardianConfig,
} from "@goal-guardian/core";

export interface MakeWorkspaceOptions {
  goal?: string;
  successCriteria?: string[];
  constraints?: string[];
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
  }

  return {
    root,
    paths,
    cleanup: async () => {
      // Windows can hold a just-written file's handle for a beat, failing a
      // recursive delete with ENOTEMPTY; retries make cleanup deterministic.
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}
