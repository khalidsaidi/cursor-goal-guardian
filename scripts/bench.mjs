#!/usr/bin/env node
/**
 * Real benchmarks against real artifacts:
 *   1. Hook latency — spawns of the PACKAGED bin (what users run) per path
 *   2. MCP round-trips — real stdio calls against the PACKAGED server
 *
 * Usage: node scripts/bench.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(path.join(ROOT, "packages/core/dist/index.js"));
const HOOK = path.join(ROOT, "packages/cursor-goal-guardian-extension/bin/goal-guardian-hook.cjs");
const MCP = path.join(ROOT, "packages/cursor-goal-guardian-extension/bin/goal-guardian-mcp.mjs");

const lines = [];
const log = (s = "") => {
  lines.push(s);
  console.log(s);
};
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
const stats = (samples) => {
  const s = [...samples].sort((a, b) => a - b);
  return `p50 ${pct(s, 0.5)}ms · p95 ${pct(s, 0.95)}ms · p99 ${pct(s, 0.99)}ms (n=${s.length})`;
};

async function makeWorkspace(config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-bench-"));
  const p = core.getGuardianPaths(root);
  await fs.mkdir(p.telemetryDir, { recursive: true });
  const criteria = core.criteriaFromTexts(["Users can export the report table as CSV"]);
  await fs.writeFile(p.contract, JSON.stringify({ schemaVersion: 2, goal: "Ship the CSV export feature", successCriteria: criteria, constraints: [] }, null, 2));
  await fs.writeFile(p.config, JSON.stringify(core.parseConfig(config), null, 2));
  return { root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

// ---------------- 1. hook latency ----------------
log("# Goal Guardian benchmarks");
log(`\nDate: ${new Date().toISOString()} · Node ${process.version} · ${os.cpus()[0]?.model ?? "?"} (${os.cpus().length} cores)\n`);
log("## 1. Hook latency (packaged bin, spawn-to-response)\n");
{
  const baseline = [];
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
    baseline.push(performance.now() - t);
  }
  log(`- bare \`node -e 0\` baseline: ${stats(baseline)}`);

  const cases = [
    ["neutral shell", { hook_event_name: "beforeShellExecution", command: "git status" }, {}],
  ];
  for (const [label, payload, config] of cases) {
    const ws = await makeWorkspace(config);
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const t = performance.now();
      const res = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ ...payload, workspace_roots: [ws.root] }),
        encoding: "utf8",
      });
      samples.push(performance.now() - t);
      if (res.status !== 0) throw new Error(`hook failed on ${label}`);
    }
    log(`- ${label}: ${stats(samples)}`);
    await ws.cleanup();
  }
}

// ---------------- 2. MCP round-trips ----------------
log("\n## 2. MCP tool round-trips (packaged server, real stdio)\n");
{
  const { Client } = await import(path.join(ROOT, "packages/e2e/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"));
  const { StdioClientTransport } = await import(path.join(ROOT, "packages/e2e/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js"));
  const ws = await makeWorkspace();
  const client = new Client({ name: "bench", version: "0" });
  const t0 = performance.now();
  await client.connect(new StdioClientTransport({ command: "node", args: [MCP], env: { ...process.env, GOAL_GUARDIAN_WORKSPACE_ROOT: ws.root }, stderr: "ignore" }));
  log(`- cold start + handshake: ${(performance.now() - t0).toFixed(1)}ms`);
  for (const [name, args] of [
    ["guardian_get_contract", {}],
    ["guardian_get_status", {}],
  ]) {
    const samples = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      await client.callTool({ name, arguments: args });
      samples.push(performance.now() - t);
    }
    log(`- ${name}: ${stats(samples)}`);
  }
  await client.close();
  await ws.cleanup();
}

await fs.writeFile(path.join(ROOT, "docs", "benchmarks.md"), lines.join("\n") + "\n").catch(async () => {
  await fs.mkdir(path.join(ROOT, "docs"), { recursive: true });
  await fs.writeFile(path.join(ROOT, "docs", "benchmarks.md"), lines.join("\n") + "\n");
});
console.log("\nwritten to docs/benchmarks.md");
