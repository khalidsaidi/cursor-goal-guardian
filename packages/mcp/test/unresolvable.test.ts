import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * A globally-registered server spawned by a client that offers NO workspace
 * roots, with no env and a cwd that is not a workspace (the situation that
 * once made the guardian silently write session files into the user's home).
 * The correct behavior is an explicit, agent-relayable error — and zero
 * writes anywhere.
 */
let client: Client;
let hostileCwd: string;

beforeAll(async () => {
  hostileCwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-nowhere-"));
  client = new Client({ name: "rootless-test", version: "0.0.0" }, { capabilities: {} });
  const env = { ...process.env } as Record<string, string>;
  delete env.GOAL_GUARDIAN_WORKSPACE_ROOT;
  delete env.CURSOR_WORKSPACE_ROOT;
  delete env.WORKSPACE_FOLDER_PATHS;
  await client.connect(
    new StdioClientTransport({
      command: path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      args: [path.join(process.cwd(), "src", "index.ts")],
      env,
      cwd: hostileCwd,
      stderr: "ignore",
    }),
  );
}, 30000);

afterAll(async () => {
  await client?.close();
  await fs.rm(hostileCwd, { recursive: true, force: true });
});

describe("unresolvable workspace", () => {
  it("tools answer with guidance instead of writing into the wrong place", async () => {
    const res = (await client.callTool({ name: "guardian_get_contract", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/could not determine which workspace/);
    // Nothing was scaffolded in the hostile cwd, and nothing landed in home.
    await expect(fs.access(path.join(hostileCwd, ".cursor"))).rejects.toThrow();
  });
});
