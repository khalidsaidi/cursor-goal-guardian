import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests never start a real reviewer on the user's Cursor plan.
    env: { GOAL_GUARDIAN_REVIEWER: "/nonexistent/guardian-reviewer" },
  },
});
