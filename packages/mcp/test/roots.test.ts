import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { makeWorkspace, type TestWorkspace } from "cursor-goal-guardian-testkit";

/**
 * Cursor's agent hub loads MCP servers from the USER-level config with no
 * workspace env and cwd pointing at the user's home — the only correct root
 * signal is the MCP roots capability. This is the regression guard for the
 * bug where a globally-registered server wrote the goal record into ~.
 */
let ws: TestWorkspace;
let client: Client;

beforeAll(async () => {
  ws = await makeWorkspace({ goal: "Roots resolution works", successCriteria: ["server writes into the advertised root"] });
  client = new Client({ name: "roots-test", version: "0.0.0" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, () => ({
    roots: [{ uri: pathToFileURL(ws.root).href, name: "workspace" }],
  }));
  const env = { ...process.env } as Record<string, string>;
  delete env.GOAL_GUARDIAN_WORKSPACE_ROOT; // the hub scenario: no env, only roots
  delete env.CURSOR_WORKSPACE_ROOT;
  await client.connect(
    new StdioClientTransport({
      command: path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      args: [path.join(process.cwd(), "src", "index.ts")],
      env,
      cwd: "/", // hostile cwd: nothing writable, nothing workspace-like
      stderr: "ignore",
    }),
  );
}, 30000);

afterAll(async () => {
  await client?.close();
  await ws?.cleanup();
});

describe("workspace resolution via MCP roots", () => {
  it("reads the contract from the client-advertised root, not env or cwd", async () => {
    const res = (await client.callTool({ name: "guardian_get_contract", arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(res.content[0]!.text).goal).toBe("Roots resolution works");
  });

  it("writes through tools into the advertised root", async () => {
    const res = (await client.callTool({
      name: "guardian_update_goal",
      arguments: { goal: "Rooted goal update" },
    })) as { isError?: boolean };
    expect(res.isError).not.toBe(true);
    const { readState } = await import("cursor-goal-guardian-testkit");
    expect((await readState(ws.root)).goal).toBe("Rooted goal update");
  });
});
