import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scenarios/**/*.e2e.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    maxConcurrency: 1,
    retry: 0,
  },
});
