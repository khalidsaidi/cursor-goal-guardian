import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests never start a real reviewer on the user's Cursor plan: every file begins with the stand-ins in
    // test/helpers/setup.ts (a Codex goal program, a reviewer and an evaluator that find nothing wrong).
    setupFiles: ["./test/helpers/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 90,
        branches: 85,
      },
    },
  },
});
