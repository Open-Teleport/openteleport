import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Ctx } from "../../src/adapters/types.js";
import type { Bundle } from "../../src/core/schema.js";
import { destinationScope } from "../../src/mcp/destination.js";
import { claudePaths } from "../../src/adapters/claude-code/paths.js";

let home: string;
let ctx: Ctx;
const bundle: Bundle = {
  manifest: { schemaVersion: "0.1", id: "", name: "Ada", models: [], capabilities: [] },
  instructions: "Private instructions", skills: [{ name: "review", files: [] }],
  facts: ["Private fact"], notes: [], routines: [], files: [], unknownPaths: [],
};
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openteleport-destination-"));
  ctx = { home, cwd: home, sourceDir: join(home, "source-must-not-be-used"), env: {},
    exec: vi.fn() as unknown as Ctx["exec"], logger: vi.fn() };
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it("discloses Codex shared skills outside an explicit destination", async () => {
  ctx.targetDir = join(home, "custom");
  ctx.env.CODEX_HOME = join(home, "ignored");
  const result = await destinationScope("codex", ctx, bundle);
  expect(result.locations).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: join(home, "custom", "agents") }),
    expect.objectContaining({ path: join(home, ".agents", "skills"), shared: true }),
  ]));
  const empty = await destinationScope("codex", ctx, { ...bundle, skills: [] });
  expect(empty.locations.some(location => location.path.endsWith("skills"))).toBe(false);
});

it("discloses Claude project memory outside the destination and respects its config override", async () => {
  ctx.targetDir = join(home, "project");
  ctx.env.CLAUDE_CONFIG_DIR = join(home, "claude-user");
  const result = await destinationScope("claude-code", ctx, bundle);
  const paths = claudePaths({ ...ctx, sourceDir: undefined });
  expect(result.locations).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: paths.projectAgents }),
    expect.objectContaining({ path: paths.memoryDir(paths.projectDir), shared: true }),
  ]));
});

it("uses OpenClaw config override only without an explicit target and leaves workspace unresolved", async () => {
  ctx.env.OPENCLAW_STATE_DIR = join(home, "state");
  ctx.env.OPENCLAW_CONFIG_PATH = join(home, "external-config.json");
  const result = await destinationScope("openclaw", ctx, bundle);
  expect(result.locations[1].path).toBe(ctx.env.OPENCLAW_CONFIG_PATH);
  expect(result.unresolved.join(" ")).toContain("workspace can be outside");
  ctx.targetDir = join(home, "explicit");
  expect((await destinationScope("openclaw", ctx, bundle)).locations[1].path)
    .toBe(join(ctx.targetDir, "openclaw.json"));
});

it.each(["folder", "codex", "claude-code", "hermes", "openclaw", "openbot", "grok-bot", "letta"])(
  "%s disclosure is read-only, isolates the source and excludes private content", async app => {
    ctx.targetDir = join(home, "target");
    const result = await destinationScope(app, ctx, bundle);
    expect(result.coverage).toBe("locations-only");
    expect(result.locations[0].path.startsWith(ctx.targetDir)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Private|source-must-not-be-used/);
    expect(ctx.exec).not.toHaveBeenCalled();
    expect(await readdir(home)).toEqual([]);
  });

it("does not claim coverage for an additional adapter", async () => {
  expect(await destinationScope("custom", ctx, bundle)).toMatchObject({ coverage: "unavailable", locations: [] });
});
