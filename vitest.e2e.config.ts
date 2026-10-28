import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e.test.ts", "test/remote.e2e.test.ts"],
    // The two files share one Next dev server and one Chromium; running them side by side on the four E-cores made
    // the first served-image fetches slow enough to hit the verify timeout and report a usage as unmeasured.
    fileParallelism: false,
    maxWorkers: 4,
    testTimeout: 10 * 60_000,
    hookTimeout: 15 * 60_000,
  },
});
