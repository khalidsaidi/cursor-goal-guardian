import { describe, it, expect } from "vitest";
import {
  evaluateLexicalDrift,
  hasScopeOverlap,
  defaultState,
  defaultConfig,
  parseConfig,
  criteriaFromTexts,
  type GuardianState,
} from "../src/index.js";

function stateWith(taskTitle: string, opts: { goal?: string; criterion?: string; pinned?: string[] } = {}): GuardianState {
  const s = defaultState();
  s.goal = opts.goal ?? "";
  if (opts.criterion) {
    s.successCriteria = criteriaFromTexts([opts.criterion]);
  }
  s.tasks = [{ id: "t1", title: taskTitle, status: "doing", ...(opts.criterion ? { criterionId: "sc_1" } : {}) }];
  s.activeTaskId = "t1";
  s.pinnedContext = opts.pinned ?? [];
  return s;
}

const config = defaultConfig();

// Characterization truth table: rows mirror the v0.4.11 hook behavior
// (test/cli.test.ts cases plus boundary probes). Each row: description,
// state, actionType, actionValue, expectation.
describe("lexical drift truth table", () => {
  it("flags an out-of-scope shell command (v1: docker build vs expense form task)", () => {
    const s = stateWith("Build the expense form component", { goal: "Expense tracker app" });
    const result = evaluateLexicalDrift(s, config, "shell", "docker build -t darkmode-theme .");
    expect(result).not.toBeNull();
    expect(result?.activeTaskTitle).toBe("Build the expense form component");
    expect(result?.actionTerms).toContain("darkmode");
  });

  it("does not flag an in-scope read (v1: expense-form.tsx vs expense form task)", () => {
    const s = stateWith("Build the expense form component");
    expect(evaluateLexicalDrift(s, config, "read", "src/expense-form.tsx")).toBeNull();
  });

  it("neutral shell commands are exempt regardless of scope", () => {
    const s = stateWith("Build the expense form component");
    for (const cmd of ["git status", "pnpm install", "npm run test", "ls -la", "yarn build", "node -v"]) {
      expect(evaluateLexicalDrift(s, config, "shell", cmd)).toBeNull();
    }
  });

  it("neutral read paths are exempt (manifests, configs, README, guardian files, out-of-workspace)", () => {
    const s = stateWith("Build the expense form component");
    for (const p of ["package.json", "pnpm-lock.yaml", "tsconfig.base.json", "vite.config.ts", "README.md", ".cursor/goal-guardian/contract.json", "../../home/user/.cursor/plugins/cache/darkmode-theme"]) {
      expect(evaluateLexicalDrift(s, config, "read", p)).toBeNull();
    }
  });

  it("goal-guardian MCP calls are exempt — even when the host omits the server name", () => {
    const s = stateWith("Build the expense form component");
    expect(evaluateLexicalDrift(s, config, "mcp", "goal-guardian/guardian_get_status")).toBeNull();
    expect(evaluateLexicalDrift(s, config, "mcp", "/guardian_declare_intent")).toBeNull();
    expect(evaluateLexicalDrift(s, config, "mcp", "browser-server/take_screenshot_of_theme")).not.toBeNull();
  });

  it("pinned context suppresses drift for reads, edits, and shell mentions", () => {
    const s = stateWith("Build the expense form component", { pinned: ["src/theme"] });
    expect(evaluateLexicalDrift(s, config, "read", "src/theme/dark.css")).toBeNull();
    expect(evaluateLexicalDrift(s, config, "edit", "src/theme/dark.css")).toBeNull();
    expect(evaluateLexicalDrift(s, config, "shell", "prettier --write src/theme/dark.css")).toBeNull();
  });

  it("linked success criterion vocabulary counts as in-scope (criterionId, not title regex)", () => {
    const s = stateWith("Task one", { criterion: "Users can export the report table as CSV" });
    expect(evaluateLexicalDrift(s, config, "shell", "generate csv-report snapshot")).toBeNull();
  });

  it("no active task means no drift signal", () => {
    const s = stateWith("anything");
    s.activeTaskId = null;
    expect(evaluateLexicalDrift(s, config, "shell", "docker build -t x .")).toBeNull();
    expect(evaluateLexicalDrift(null, config, "shell", "docker build -t x .")).toBeNull();
  });

  it("lexical scoring can be disabled in config", () => {
    const s = stateWith("Build the expense form component");
    const off = parseConfig({ drift: { lexical: { enabled: false } } });
    expect(evaluateLexicalDrift(s, off, "shell", "docker build -t darkmode-theme .")).toBeNull();
  });

  describe("sensitivity boundaries (v1: lenient reduces noise, strict warns on minimal mismatch)", () => {
    // Two meaningful action terms after filtering: "darkmode", "theme".
    const twoTermAction = "touch darkmode theme";

    it("balanced (min 2 action terms) flags a two-term mismatch", () => {
      const s = stateWith("Build the expense form component");
      expect(evaluateLexicalDrift(s, config, "shell", twoTermAction)).not.toBeNull();
    });

    it("lenient (min 3 action terms) ignores the same two-term mismatch", () => {
      const s = stateWith("Build the expense form component");
      const lenient = parseConfig({ drift: { lexical: { sensitivity: "lenient" } } });
      expect(evaluateLexicalDrift(s, lenient, "shell", twoTermAction)).toBeNull();
    });

    it("strict (min 1 term each) flags a single-term mismatch balanced would ignore", () => {
      const s = stateWith("Build the expense form component");
      const oneTermAction = "touch darkmode";
      expect(evaluateLexicalDrift(s, config, "shell", oneTermAction)).toBeNull();
      const strict = parseConfig({ drift: { lexical: { sensitivity: "strict" } } });
      expect(evaluateLexicalDrift(s, strict, "shell", oneTermAction)).not.toBeNull();
    });
  });

  it("confidence scales with the number of off-scope action terms", () => {
    const s = stateWith("Build the expense form component");
    const low = evaluateLexicalDrift(s, config, "shell", "touch darkmode theme");
    const medium = evaluateLexicalDrift(s, config, "shell", "touch darkmode theme palette");
    const high = evaluateLexicalDrift(s, config, "shell", "touch darkmode theme palette colors");
    expect(low?.confidence).toBe("low");
    expect(medium?.confidence).toBe("medium");
    expect(high?.confidence).toBe("high");
  });

  it("custom neutral commands and paths extend the built-in exemptions", () => {
    const s = stateWith("Build the expense form component");
    const custom = parseConfig({
      advisories: { neutralCommands: ["make "], neutralPaths: ["docs/"] },
    });
    expect(evaluateLexicalDrift(s, custom, "shell", "make darkmode-theme")).toBeNull();
    expect(evaluateLexicalDrift(s, custom, "read", "docs/darkmode-theme.md")).toBeNull();
  });

  it("unicode and short tokens are stripped; numbers never count as terms", () => {
    const s = stateWith("Build the expense form component");
    // All tokens are <3 chars or numeric -> too little signal.
    expect(evaluateLexicalDrift(s, config, "shell", "x 12 34 ab")).toBeNull();
  });
});

describe("hasScopeOverlap", () => {
  it("matches exact, singularized, and prefix forms", () => {
    expect(hasScopeOverlap(["export"], ["export"])).toBe(true);
    expect(hasScopeOverlap(["exports"], ["export"])).toBe(true);
    expect(hasScopeOverlap(["serializer"], ["serializers"])).toBe(true);
    expect(hasScopeOverlap(["expense"], ["expenses"])).toBe(true);
    expect(hasScopeOverlap(["darkmode"], ["expense"])).toBe(false);
  });
});
