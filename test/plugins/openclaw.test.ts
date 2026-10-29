import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as library from "../../src/index.js";
import type { Ctx } from "../../src/adapters/types.js";
import { createMemoryAdapter } from "../helpers/memory-adapter.js";
// JavaScript plugin entry is deliberately independent of the host at discovery time.
import plugin from "../../plugins/openclaw/index.mjs";
import { registerTeleportCommands } from "../../plugins/openclaw/commands.mjs";
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "openteleport-plugin-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
function harness() {
  const adapter = createMemoryAdapter({ name: "openclaw", agents: { reviewer: {
    manifest: { schemaVersion: "0.1", id: "", name: "Reviewer", models: [], capabilities: [] },
    instructions: "Review changes", facts: [], notes: [], routines: [], skills: [], files: [], unknownPaths: [],
  } } });
  const ctx: Ctx = { home, cwd: home, env: { OPENCLAW_CONFIG_PATH: "separate-config" },
    exec: vi.fn() as unknown as Ctx["exec"], logger: vi.fn() };
  const output = vi.fn();
  const load = vi.fn(async () => ({ library: { ...library, getAdapter: () => adapter }, ctx }));
  const program = new Command().exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerTeleportCommands(program, { load, output, failure: (error: Error) => { throw error; } });
  return { program, load, output, adapter, ctx };
}
it("only registers metadata during discovery and refuses a root collision", () => {
  const registerCli = vi.fn();
  plugin.register({ registerCli });
  expect(registerCli).toHaveBeenCalledTimes(1);
  expect(registerCli.mock.calls[0][1].descriptors[0].name).toBe("teleport");
  const { program, load } = harness();
  expect(load).not.toHaveBeenCalled();
  expect(() => registerTeleportCommands(program)).toThrow("already exists");
});
it("help does not load adapters or execute an operation", async () => {
  const { program, load } = harness();
  await expect(program.parseAsync(["teleport", "--help"], { from: "user" })).rejects.toMatchObject({ code: "commander.helpDisplayed" });
  expect(load).not.toHaveBeenCalled();
});
it("exports/imports through the engine and preserves context and flags", async () => {
  const h = harness();
  await h.program.parseAsync(["teleport", "export", "reviewer", "--out", "reviewer.jetpack"], { from: "user" });
  expect(h.output.mock.calls[0][0].outcome).toBe("exported");
  const imported = harness();
  const write = imported.adapter.write;
  imported.adapter.write = async (ctx, bundle, opts) => {
    expect(ctx.env.OPENCLAW_CONFIG_PATH).toBe("separate-config");
    expect(ctx.sourceDir).toBeUndefined();
    expect(ctx.targetDir).toBeUndefined();
    return write(ctx, bundle, opts);
  };
  await imported.program.parseAsync(["teleport", "import", "reviewer.jetpack", "--copy"], { from: "user" });
  expect(imported.output.mock.calls[0][0].outcome).toBe("done");
  expect(imported.adapter.written[0].opts).toEqual({ onConflict: "copy", includeFiles: false, enableRoutines: false });
});
it("refuses archive overwrite and replace, and exposes handoff", async () => {
  const h = harness();
  await writeFile(join(home, "reviewer.jetpack"), "sentinel");
  await expect(h.program.parseAsync(["teleport", "export", "reviewer", "--out", "reviewer.jetpack"], { from: "user" })).rejects.toThrow();
  expect(await readFile(join(home, "reviewer.jetpack"), "utf8")).toBe("sentinel");
  await expect(h.program.parseAsync(["teleport", "import", "reviewer.jetpack", "--replace"], { from: "user" })).rejects.toMatchObject({ code: "commander.unknownOption" });
  const source = harness();
  await source.program.parseAsync(["teleport", "export", "reviewer", "--out", "valid.jetpack"], { from: "user" });
  const target = harness();
  target.adapter.write = async () => ({ outcome: "handoff", nextStep: "Review output",
    items: { approximated: [], skipped: [], warnings: ["Check destination"] } });
  await target.program.parseAsync(["teleport", "import", "valid.jetpack"], { from: "user" });
  expect(target.output.mock.calls[0][0]).toMatchObject({ outcome: "handoff", nextStep: "Review output", warnings: ["Check destination"] });
});
