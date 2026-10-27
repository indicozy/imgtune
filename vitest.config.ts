import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The end-to-end run starts a real next dev and Chromium; it has its own config (vitest.e2e.config.ts).
    exclude: ["test/e2e.test.ts", "**/node_modules/**"],
    maxWorkers: 4,
  },
});
