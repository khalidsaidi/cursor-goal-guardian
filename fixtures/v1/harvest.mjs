// Harvest REAL v0.4.11 on-disk artifacts as migration golden fixtures.
// Drives the actual built code: extension stateStore (CJS), MCP server (stdio), hook CLI (stdio).
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const REPO = "/home/khali/cursor-goal-guardian";
const OUT = path.join(REPO, "fixtures", "v1");
const require = createRequire(import.meta.url);
const stateStore = require(path.join(REPO, "packages/cursor-goal-guardian-extension/dist/stateStore.js"));

const sdkDir = path.join(REPO, "packages/cursor-goal-guardian-mcp/node_modules/@modelcontextprotocol/sdk");
const { Client } = await import(path.join(sdkDir, "dist/esm/client/index.js"));
const { StdioClientTransport } = await import(path.join(sdkDir, "dist/esm/client/stdio.js"));

const HOOK_BIN = path.join(REPO, "packages/cursor-goal-guardian-hook/dist/cli.js");
const MCP_BIN = path.join(REPO, "packages/cursor-goal-guardian-mcp/dist/index.js");

function runHook(root, payload) {
  const res = spawnSync("node", [HOOK_BIN], {
    input: JSON.stringify({ ...payload, workspace_roots: [root] }),
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`hook exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

async function withMcp(root, fn) {
  const client = new Client({ name: "harvest", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_BIN],
    env: { ...process.env, GOAL_GUARDIAN_WORKSPACE_ROOT: root },
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const writeJson = (p, v) => fs.writeFile(p, JSON.stringify(v, null, 2) + "\n", "utf8");
const gg = (root) => path.join(root, ".cursor", "goal-guardian");

function defaultContract() {
  return {
    goal: "Replace this with a short, unambiguous goal statement.",
    success_criteria: ["Replace this with a concrete success criterion."],
    constraints: [
      "No silent scope expansion: every step must map to explicit success criteria IDs.",
      "Keep updates in the state store instead of chat-only planning.",
      "Prefer small, testable tasks with explicit completion criteria.",
    ],
  };
}

// ---------- case-empty: fresh install (extension installFiles equivalent) ----------
async function caseEmpty() {
  const root = path.join(OUT, "case-empty");
  await fs.mkdir(gg(root), { recursive: true });
  await writeJson(path.join(gg(root), "contract.json"), defaultContract());
  await stateStore.ensureStateStoreFiles(root);
}

// ---------- case-basic: realistic mid-session workspace ----------
async function caseBasic() {
  const root = path.join(OUT, "case-basic");
  await fs.mkdir(gg(root), { recursive: true });

  await withMcp(root, async (c) => {
    await c.callTool({
      name: "guardian_initialize_contract",
      arguments: {
        goal: "Ship the CSV export feature for the report table",
        success_criteria: [
          "Users can export the report table as CSV",
          "Export respects the currently active filters",
          "Unit tests cover the CSV serializer",
        ],
        constraints: ["No new dependencies", "No changes outside src/export/"],
      },
    });
  });

  await stateStore.ensureStateStoreFiles(root);

  // Mirror autoSyncStateFromContract: SET_GOAL, ADD_TASKS (SCn: title convention), START_TASK.
  const criteria = [
    "Users can export the report table as CSV",
    "Export respects the currently active filters",
    "Unit tests cover the CSV serializer",
  ];
  await stateStore.dispatchAction(root, {
    actor: "agent",
    type: "SET_GOAL",
    payload: {
      goal: "Ship the CSV export feature for the report table",
      definition_of_done: criteria,
      constraints: ["No new dependencies", "No changes outside src/export/"],
    },
  });
  await stateStore.dispatchAction(root, {
    actor: "agent",
    type: "ADD_TASKS",
    payload: { tasks: criteria.map((text, i) => ({ id: `sc_${i + 1}`, title: `SC${i + 1}: ${text}` })) },
  });
  await stateStore.dispatchAction(root, { actor: "agent", type: "START_TASK", payload: { taskId: "sc_1" } });
  await stateStore.dispatchAction(root, {
    actor: "human",
    type: "ADD_DECISION",
    payload: { text: "Use a hand-rolled serializer", rationale: "No-new-dependencies constraint rules out csv libs" },
  });
  await stateStore.dispatchAction(root, { actor: "agent", type: "PIN_CONTEXT", payload: { path: "src/export/csv.ts" } });
  await stateStore.dispatchAction(root, { actor: "human", type: "OPEN_QUESTION", payload: { text: "Should exports include hidden columns?" } });

  // Real v1 policy file (copied shape from examples/cursor-project).
  const examplePolicy = JSON.parse(
    await fs.readFile(path.join(REPO, "examples/cursor-project/.cursor/goal-guardian/policy.json"), "utf8"),
  );
  await writeJson(path.join(gg(root), "policy.json"), examplePolicy);

  // Permit-era MCP state: check -> permit -> previews (warn counters + high risk).
  await withMcp(root, async (c) => {
    const check = await c.callTool({
      name: "guardian_check_step",
      arguments: {
        step: "Implement the CSV serializer in src/export/csv.ts",
        expected_output: "src/export/csv.ts exporting serializeCsv()",
        maps_to: ["SC1"],
      },
    });
    const stepId = JSON.parse(check.content[0].text).step_id;
    await c.callTool({
      name: "guardian_issue_permit",
      arguments: {
        step_id: stepId,
        ttl_seconds: 3600,
        allow_shell: ["pnpm test*"],
        allow_read: ["src/export/**"],
        allow_write: ["src/export/**"],
      },
    });
    await c.callTool({ name: "guardian_preview_action", arguments: { action_type: "shell", action_value: "git reset --hard", record_warning: true } });
    await c.callTool({ name: "guardian_preview_action", arguments: { action_type: "shell", action_value: "git reset --hard", record_warning: true } });
    await c.callTool({ name: "guardian_preview_action", arguments: { action_type: "shell", action_value: "rm -rf /" } });
  });

  // Real hook traffic -> .ai/goal-guardian/audit.log (+ possibly violations).
  runHook(root, { hook_event_name: "beforeShellExecution", command: "pnpm test" });
  runHook(root, { hook_event_name: "beforeShellExecution", command: "docker build -t darkmode-theme ." });
  runHook(root, { hook_event_name: "beforeShellExecution", command: "rm -rf /" });
  runHook(root, { hook_event_name: "beforeReadFile", file_path: ".env" });
  runHook(root, { hook_event_name: "beforeReadFile", file_path: "src/export/csv.ts" });
  runHook(root, { hook_event_name: "afterFileEdit", file_path: "src/export/csv.ts" });
  runHook(root, { hook_event_name: "stop" });
}

// ---------- case-custom: non-default rules/policy + custom reducer present ----------
async function caseCustom() {
  const root = path.join(OUT, "case-custom");
  await fs.mkdir(gg(root), { recursive: true });
  await writeJson(path.join(gg(root), "contract.json"), {
    goal: "Fix the flaky login integration test",
    success_criteria: ["login.spec.ts passes 20 consecutive runs"],
    constraints: ["Do not change production auth code"],
  });
  await stateStore.ensureStateStoreFiles(root);
  await writeJson(path.join(gg(root), "rules.json"), {
    preferredReducer: "json",
    strictMode: false,
    snapshotInterval: 5,
    syncContractFromState: false,
    invariants: { singleActiveTask: true, requireDecisionForTaskSwitch: false, disallowTodoToDone: false },
  });
  await fs.writeFile(
    path.join(gg(root), "reducer.js"),
    "// user-customized reducer (v1 feature, removed in v2)\nexport default function reducer(state, action) {\n  return state;\n}\n",
    "utf8",
  );
  await writeJson(path.join(gg(root), "policy.json"), {
    enforceReduxControl: false,
    enforceTaskScope: true,
    taskScopeSensitivity: "strict",
    requirePermitForShell: true,
    requirePermitForMcp: false,
    requirePermitForRead: false,
    autoRevertUnauthorizedEdits: false,
    warningConfig: { maxWarningsBeforeBlock: 2, warningResetMinutes: 10 },
    alwaysAllow: { shell: ["git status*"], mcp: [], read: ["docs/**"] },
    highRiskPatterns: { shell: ["rm -rf *"], mcp: ["deploy/*"], read: ["**/*.pem"] },
    shellRules: [{ pattern: "npm publish*", severity: "HIGH_RISK", reason: "publishing is out of scope" }],
  });
  await stateStore.dispatchAction(root, {
    actor: "agent",
    type: "ADD_TASKS",
    payload: { tasks: [{ id: "t1", title: "Stabilize login.spec.ts" }] },
  });
  await stateStore.dispatchAction(root, { actor: "agent", type: "START_TASK", payload: { taskId: "t1" } });
  runHook(root, { hook_event_name: "beforeShellExecution", command: "pnpm vitest run login.spec.ts" });
}

// ---------- case-corrupt: damaged files migration must survive ----------
async function caseCorrupt() {
  const root = path.join(OUT, "case-corrupt");
  await fs.mkdir(gg(root), { recursive: true });
  await writeJson(path.join(gg(root), "contract.json"), {
    goal: "Corrupt workspace fixture",
    success_criteria: ["n/a"],
    constraints: [],
  });
  await fs.writeFile(path.join(gg(root), "state.json"), '{"schemaVersion": 1, "goal": "truncat', "utf8");
  await fs.writeFile(path.join(gg(root), "actions.jsonl"), '{"id":"act_1","type":"SET_GOAL"}\nnot-json-garbage\n', "utf8");
  await fs.mkdir(path.join(root, ".ai", "goal-guardian"), { recursive: true });
  await fs.writeFile(path.join(root, ".ai", "goal-guardian", "audit.log"), "corrupt-line\n", "utf8");
}

await fs.rm(OUT, { recursive: true, force: true });
await caseEmpty();
await caseBasic();
await caseCustom();
await caseCorrupt();
console.log("done");
