import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests never start a real reviewer on the user's Cursor plan.
    env: { GOAL_GUARDIAN_REVIEWER: "/nonexistent/guardian-reviewer" },
    // Every case here spawns the built recorder binary, sometimes several
    // times; cold CI runners (Intel macOS especially) need far more headroom
    // than the 5s default. Generous timeouts change nothing for healthy runs
    // and stop slow-machine flakes from masquerading as failures.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
