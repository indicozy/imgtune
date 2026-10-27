import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e.test.ts"],
    maxWorkers: 4,
    testTimeout: 10 * 60_000,
    hookTimeout: 15 * 60_000,
  },
});
