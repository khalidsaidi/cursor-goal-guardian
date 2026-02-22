import * as path from "node:path";
import * as fs from "node:fs/promises";

export type CleanupResult = {
  hooksCleaned: boolean;
  mcpCleaned: boolean;
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function backupIfExists(filePath: string): Promise<void> {
  if (!(await fileExists(filePath))) return;
  const backupPath = `${filePath}.bak-${Date.now()}`;
  await fs.copyFile(filePath, backupPath);
}

async function readJson<T>(filePath: string, fallbackValue: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallbackValue;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export function isGoalGuardianHookCommand(command: string): boolean {
  return command.includes("goal-guardian-hook") || command.includes("cursor-goal-guardian-hook");
}

export async function cleanupLegacyIntegration(workspaceRoot: string): Promise<CleanupResult> {
  const cursorDir = path.join(workspaceRoot, ".cursor");
  const hooksPath = path.join(cursorDir, "hooks.json");
  const mcpPath = path.join(cursorDir, "mcp.json");

  let hooksCleaned = false;
  let mcpCleaned = false;

  if (await fileExists(hooksPath)) {
    const existing = await readJson<any>(hooksPath, { version: 1, hooks: {} });
    const hooks = existing?.hooks ?? {};
    let changed = false;

    for (const [hookName, handlers] of Object.entries(hooks)) {
      if (!Array.isArray(handlers)) continue;
      const filtered = (handlers as Array<{ command?: string }>).filter((h) => {
        const cmd = typeof h?.command === "string" ? h.command : "";
        return !isGoalGuardianHookCommand(cmd);
      });
      if (filtered.length !== handlers.length) {
        changed = true;
      }
      if (filtered.length === 0) {
        delete hooks[hookName];
      } else {
        hooks[hookName] = filtered;
      }
    }

    if (changed) {
      await backupIfExists(hooksPath);
      await writeJson(hooksPath, { version: existing.version ?? 1, hooks });
      hooksCleaned = true;
    }
  }

  if (await fileExists(mcpPath)) {
    const existing = await readJson<any>(mcpPath, { mcpServers: {} });
    if (existing?.mcpServers && existing.mcpServers["goal-guardian"]) {
      delete existing.mcpServers["goal-guardian"];
      await backupIfExists(mcpPath);
      await writeJson(mcpPath, existing);
      mcpCleaned = true;
    }
  }

  return { hooksCleaned, mcpCleaned };
}

