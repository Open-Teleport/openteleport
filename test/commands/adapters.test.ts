import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, adapterModule, json, run, sandbox } from "../helpers/cli.js";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

describe("adapters", () => {
  it("prints one row per adapter: the three built in, then the extra one", async () => {
    const result = await run(box, ["adapters"]);
    expect(result.exitCode).toBe(0);
    const names = result.stdout
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.trim() !== "")
      .map((line) => line.split(/\s+/)[0]);
    expect(names).toEqual(["folder", "openclaw", "claude-code", "memory"]);
    const [header] = result.stdout.split(/\r?\n/);
    expect(header).toMatch(/^name\s+app\s+found\s+version\s+location\s+hint$/);
  });

  it("prints what detect says for each adapter with --json", async () => {
    const result = await run(box, ["adapters", "--json"]);
    expect(result.exitCode).toBe(0);
    const rows = json<Record<string, unknown>[]>(result);
    expect(rows.map((row) => row.name)).toEqual(["folder", "openclaw", "claude-code", "memory"]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["displayName", "found", "hint", "location", "name", "version"].sort(),
      );
      expect(typeof row.found).toBe("boolean");
    }
    expect(rows[3]).toEqual({
      name: "memory",
      displayName: "In-memory memory",
      found: true,
      location: "memory:memory",
      version: null,
      hint: null,
    });
    // Nothing of OpenClaw or Claude Code lives in the sandbox home.
    expect(rows[1]).toMatchObject({ found: false, hint: expect.any(String) });
    expect(rows[2]).toMatchObject({ found: false, hint: expect.any(String) });
  });

  it("lists only the built-in adapters without an extra one", async () => {
    const result = await run(box, ["adapters", "--json"], { extraAdapter: null });
    expect(result.exitCode).toBe(0);
    expect(json<{ name: string }[]>(result).map((row) => row.name)).toEqual([
      "folder",
      "openclaw",
      "claude-code",
    ]);
  });
});

describe("OPENTELEPORT_EXTRA_ADAPTER", () => {
  it("exits 2 when the module cannot be loaded", async () => {
    const missing = join(box.root, "missing.mjs");
    const result = await run(box, ["adapters"], { extraAdapter: missing });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/^error: Cannot load OPENTELEPORT_EXTRA_ADAPTER /m);
  });

  it("exits 2 when it would replace a built-in adapter", async () => {
    const shadow = await adapterModule(box, "shadow.mjs", { name: "folder" });
    const result = await run(box, ["adapters"], { extraAdapter: shadow });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("error: extra adapter 'folder' would replace a built-in adapter");
    expect(result.stdout).toBe("");
  });

  it("exits 2 when its cacheIdentity is there but is not a function", async () => {
    const odd = await adapterModule(box, "odd.mjs", { name: "odd" }, '{ cacheIdentity: "id" }');
    const result = await run(box, ["adapters"], { extraAdapter: odd });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/not an adapter: cacheIdentity is not a function/);
  });

  it("exits 2 when the default export is not an adapter", async () => {
    const path = join(box.root, "bad.mjs");
    await writeFile(path, 'export default { name: "bad", displayName: "Bad" };\n');
    const result = await run(box, ["adapters"], { extraAdapter: path });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/OPENTELEPORT_EXTRA_ADAPTER .*bad\.mjs.*not an adapter/);
    expect(result.stderr).toMatch(/capabilities/);
  });
});
