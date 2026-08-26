import fs from "node:fs/promises";
import { getGuardianPaths, getLegacyPaths } from "../paths.js";
import { fileExists, readJsonFile } from "../fsutil.js";

export type WorkspaceFormat = "none" | "v1" | "v2";

/**
 * A workspace is v1 when guardian files exist but predate the v2 schemas:
 * state without schemaVersion 2, v1-only files (rules.json / reducer.js /
 * policy.json), or the legacy .ai/goal-guardian split — and no migration
 * marker has been written yet.
 */
export async function detectWorkspaceFormat(workspaceRoot: string): Promise<WorkspaceFormat> {
  const p = getGuardianPaths(workspaceRoot);
  const legacy = getLegacyPaths(workspaceRoot);

  const hasGuardianDir = await fileExists(p.dir);
  const hasAiDir = await fileExists(legacy.aiDir);
  if (!hasGuardianDir && !hasAiDir) return "none";

  if (await fileExists(p.migrationMarker)) return "v2";

  if ((await fileExists(legacy.rules)) || (await fileExists(legacy.reducer)) || (await fileExists(legacy.policy))) {
    return "v1";
  }
  if (hasAiDir) return "v1";

  if (await fileExists(p.state)) {
    try {
      const raw = (await readJsonFile(p.state)) as { schemaVersion?: unknown };
      return raw.schemaVersion === 2 ? "v2" : "v1";
    } catch {
      return "v1";
    }
  }

  if (await fileExists(p.contract)) {
    try {
      const raw = (await readJsonFile(p.contract)) as { schemaVersion?: unknown };
      return raw.schemaVersion === 2 ? "v2" : "v1";
    } catch {
      return "v1";
    }
  }

  // Guardian dir exists but holds nothing recognizable; treat as fresh.
  const entries = await fs.readdir(p.dir).catch(() => []);
  return entries.length === 0 ? "none" : "v1";
}
