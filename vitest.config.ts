import { configDefaults, defineConfig } from "vitest/config";

// `test/e2e` drives the OpenClaw and Claude Code installed on the machine, so it is left out
// unless asked for: `OPENTELEPORT_E2E=1 npx vitest run test/e2e` (see docs/demo.md).
const e2e = process.env.OPENTELEPORT_E2E === "1";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: e2e ? [...configDefaults.exclude] : [...configDefaults.exclude, "test/e2e/**"],
  },
});
