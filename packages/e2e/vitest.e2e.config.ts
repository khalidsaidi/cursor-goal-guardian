import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests never start a real reviewer on the user's Cursor plan.
    env: { GOAL_GUARDIAN_REVIEWER: "/nonexistent/guardian-reviewer" },
    include: ["scenarios/**/*.e2e.ts"],
    globalSetup: ["./globalSetup.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    maxConcurrency: 1,
    retry: 0,
  },
});
