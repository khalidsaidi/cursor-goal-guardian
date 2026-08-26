import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  fileExists,
  getGuardianPaths,
  getLegacyPaths,
  loadActions,
  migrateV1toV2,
  replay,
} from "@goal-guardian/core";
import { scaffoldWorkspace, HOOK_BIN } from "../src/scaffold.js";
import { readState } from "../src/assert.js";

describe("09 [deterministic] a real v0.4.11 workspace migrates and the built hook runs on it", () => {
  it("migrates case-basic and the hook answers allow on the migrated workspace", async () => {
    const ws = await scaffoldWorkspace({ oldFormatFixture: "case-basic" });
    try {
      const result = await migrateV1toV2(ws.root, { migratedBy: "e2e" });
      expect(result.migrated).toBe(true);

      const p = getGuardianPaths(ws.root);
      const legacy = getLegacyPaths(ws.root);
      expect(await fileExists(p.migrationMarker)).toBe(true);
      expect(await fileExists(`${legacy.state}.v1.bak`)).toBe(true);
      expect(await fileExists(legacy.aiDir)).toBe(false);

      const state = await readState(ws.root);
      expect(state.activeTaskId).toBe("sc_1");
      expect(replay(await loadActions(ws.root))).toEqual(state);

      const res = spawnSync(process.execPath, [HOOK_BIN], {
        input: JSON.stringify({
          hook_event_name: "beforeShellExecution",
          command: "pnpm test",
          workspace_roots: [ws.root],
        }),
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout).permission).toBe("allow");

      expect(await migrateV1toV2(ws.root, { migratedBy: "e2e" })).toMatchObject({ migrated: false, reason: "already-v2" });
      await ws.cleanup();
    } catch (err) {
      await ws.cleanup(true);
      throw err;
    }
  }, 60_000);
});
