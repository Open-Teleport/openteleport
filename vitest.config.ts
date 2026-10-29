import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // CLI tests spawn several node processes each; 5 s is not enough on a loaded machine or
    // a slow CI runner, and a hung test still fails, only later.
    testTimeout: 30_000,
  },
});
