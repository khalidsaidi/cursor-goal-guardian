import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  criteriaFromTexts,
  defaultConfig,
  defaultState,
  getGuardianPaths,
  guardianRuleContent,
  GUARDIAN_RULE_RELATIVE_PATH,
  newId,
  nowIso,
  parseConfig,
  replay,
  writeJsonAtomic,
  type GuardianAction,
  type Task,
} from "@goal-guardian/core";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const MCP_BIN = path.join(REPO, "packages", "mcp", "dist", "index.js");
export const HOOK_BIN = path.join(REPO, "packages", "hook", "dist", "cli.cjs");
export const FIXTURES = path.join(REPO, "fixtures", "v1");

export interface ScaffoldOptions {
  goal?: string;
  successCriteria?: string[];
  constraints?: string[];
  tasks?: Array<Pick<Task, "id" | "title" | "status"> & { criterionId?: string }>;
  config?: unknown;
  /** Copy a frozen v0.x fixture instead of writing v2 files (migration scenario). */
  oldFormatFixture?: string;
}

export interface E2EWorkspace {
  root: string;
  paths: ReturnType<typeof getGuardianPaths>;
  cleanup(keep?: boolean): Promise<void>;
}

/**
 * A real (tiny) project the agent can plausibly work in, wired to the BUILT
 * guardian binaries — the same artifacts users run, never the TS source.
 */
export async function scaffoldWorkspace(opts: ScaffoldOptions = {}): Promise<E2EWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-e2e-"));
  const paths = getGuardianPaths(root);

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await writeJsonAtomic(path.join(root, "package.json"), { name: "e2e-project", version: "0.0.0", private: true, type: "module" });
  await fs.writeFile(
    path.join(root, "src", "math.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "utf8",
  );
  await fs.writeFile(path.join(root, "README.md"), "# e2e project\n", "utf8");

  const cursorDir = path.join(root, ".cursor");
  await fs.mkdir(cursorDir, { recursive: true });
  await writeJsonAtomic(path.join(cursorDir, "mcp.json"), {
    mcpServers: {
      "goal-guardian": {
        command: "node",
        args: [MCP_BIN],
        env: { GOAL_GUARDIAN_WORKSPACE_ROOT: root },
      },
    },
  });
  const hookEntry = [{ command: `node "${HOOK_BIN}"` }];
  await writeJsonAtomic(path.join(cursorDir, "hooks.json"), {
    version: 1,
    hooks: {
      beforeShellExecution: hookEntry,
      beforeMCPExecution: hookEntry,
      beforeReadFile: hookEntry,
      afterFileEdit: hookEntry,
    },
  });

  if (opts.oldFormatFixture) {
    await fs.cp(path.join(FIXTURES, opts.oldFormatFixture), root, { recursive: true });
  } else {
    const rulePath = path.join(root, GUARDIAN_RULE_RELATIVE_PATH);
    await fs.mkdir(path.dirname(rulePath), { recursive: true });
    await fs.writeFile(rulePath, guardianRuleContent(), "utf8");
    await fs.mkdir(paths.telemetryDir, { recursive: true });
    const criteria = criteriaFromTexts(opts.successCriteria ?? ["add() has a working implementation and a test"]);
    await writeJsonAtomic(paths.contract, {
      schemaVersion: 2,
      goal: opts.goal ?? "Finish the math utilities",
      successCriteria: criteria,
      constraints: opts.constraints ?? [],
    });
    await writeJsonAtomic(paths.config, opts.config === undefined ? defaultConfig() : parseConfig(opts.config));
    // Seed via MIGRATE_IMPORT so state === replay(actions) — the same invariant
    // real setup and migration guarantee (a directly-written state with an
    // empty log broke live rebuild testing).
    const { meta: _meta, ...imported } = defaultState();
    imported.goal = opts.goal ?? "Finish the math utilities";
    imported.successCriteria = criteria;
    imported.constraints = opts.constraints ?? [];
    imported.tasks = (opts.tasks ?? [{ id: "t1", title: criteria[0]!.text, status: "doing", criterionId: criteria[0]!.id }]).map((t) => ({ ...t }));
    imported.activeTaskId = imported.tasks.find((t) => t.status === "doing")?.id ?? null;
    const seedAction: GuardianAction = {
      id: newId("act"),
      ts: nowIso(),
      actor: "system",
      type: "MIGRATE_IMPORT",
      payload: { state: imported },
    };
    await fs.writeFile(paths.actions, JSON.stringify(seedAction) + "\n", "utf8");
    await writeJsonAtomic(paths.state, replay([seedAction]));
    await writeJsonAtomic(paths.migrationMarker, { from: 2, to: 2, ts: nowIso(), migratedBy: "e2e-scaffold" });
  }

  return {
    root,
    paths,
    cleanup: async (keep = false) => {
      if (keep) {
        console.error(`[e2e] keeping failed workspace for inspection: ${root}`);
        return;
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
