import { execa } from "execa";
import { expect, it } from "vitest";
it("passes Python bridge contract tests without a Hermes installation", async () => {
  const python = process.env.OPENTELEPORT_TEST_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const result = await execa(python, ["-B", "test/plugins/hermes_test.py"], {
    env: { PYTHONDONTWRITEBYTECODE: "1" }, timeout: 30000, reject: false,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toContain("OK");
});
