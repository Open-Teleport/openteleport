import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLI,
  STACK_LINE,
  type Sandbox,
  adapterModule,
  json,
  run,
  sandbox,
} from "../helpers/cli.js";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

describe("adapters", () => {
  it("prints one row per adapter: the built-in ones, then the extra one", async () => {
    const result = await run(box, ["adapters"]);
    expect(result.exitCode).toBe(0);
    const names = result.stdout
      .split(/\r?\n/)
      .slice(1)
      .filter((line) => line.trim() !== "")
      .map((line) => line.split(/\s+/)[0]);
    expect(names).toEqual([
      "folder",
      "openclaw",
      "claude-code",
      "codex",
      "letta",
      "grok-bot",
      "memory",
    ]);
    const [header] = result.stdout.split(/\r?\n/);
    expect(header).toMatch(/^name\s+app\s+found\s+version\s+location\s+hint$/);
  });

  it("prints what detect says for each adapter with --json", async () => {
    const result = await run(box, ["adapters", "--json"]);
    expect(result.exitCode).toBe(0);
    const rows = json<Record<string, unknown>[]>(result);
    expect(rows.map((row) => row.name)).toEqual([
      "folder",
      "openclaw",
      "claude-code",
      "codex",
      "letta",
      "grok-bot",
      "memory",
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["displayName", "found", "hint", "location", "name", "version"].sort(),
      );
      expect(typeof row.found).toBe("boolean");
    }
    expect(rows[6]).toEqual({
      name: "memory",
      displayName: "In-memory memory",
      found: true,
      location: "memory:memory",
      version: null,
      hint: null,
    });
    // Nothing of OpenClaw, Claude Code, Codex or Letta Code lives in the sandbox home, and Grok Bot
    // has no home at all: it is found only through a zip.
    expect(rows[1]).toMatchObject({ found: false, hint: expect.any(String) });
    expect(rows[2]).toMatchObject({ found: false, hint: expect.any(String) });
    expect(rows[3]).toMatchObject({ found: false, hint: expect.any(String) });
    expect(rows[4]).toMatchObject({
      name: "letta",
      displayName: "Letta Code",
      found: false,
      hint: expect.stringContaining("npm i -g @letta-ai/letta-code"),
    });
    expect(rows[5]).toEqual({
      name: "grok-bot",
      displayName: "Grok Bot",
      found: false,
      location: null,
      version: null,
      hint: "Grok Bot keeps agents in the cloud. Ask your Bot to run the OpenBot export skill, then pass --source-dir <openbot-export-*.zip>",
    });
  });

  it("lists only the built-in adapters without an extra one", async () => {
    const result = await run(box, ["adapters", "--json"], { extraAdapter: null });
    expect(result.exitCode).toBe(0);
    expect(json<{ name: string }[]>(result).map((row) => row.name)).toEqual([
      "folder",
      "openclaw",
      "claude-code",
      "codex",
      "letta",
      "grok-bot",
    ]);
  });
});

describe("a reader that goes away", () => {
  it("ends with 0 and no stack trace when stdout is closed early, as `| head` does", async () => {
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    const env: NodeJS.ProcessEnv = { ...process.env, OPENTELEPORT_HOME: box.home };
    delete env.OPENTELEPORT_EXTRA_ADAPTER;
    env[pathKey] = box.bin;
    const child = spawn(process.execPath, [CLI, "adapters", "--json"], {
      cwd: box.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // The reader is gone before the CLI has started, let alone written anything.
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

    expect(stderr).not.toMatch(STACK_LINE);
    expect(stderr).not.toContain("EPIPE");
    expect(code).toBe(0);
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
