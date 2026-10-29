import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Ctx } from "../../src/adapters/types.js";
import type { Bundle } from "../../src/core/schema.js";
import { registerAdapter } from "../../src/adapters/registry.js";
import { readBundle } from "../../src/core/bundle.js";
import { TransferSession } from "../../src/mcp/service.js";
import { createMemoryAdapter } from "../helpers/memory-adapter.js";
let home: string;
let ctx: Ctx;
const bundle = (): Bundle => ({
  manifest: { schemaVersion: "0.1", id: "", name: "Ada", models: [], capabilities: [] },
  instructions: "Review carefully", facts: ["Private preference"], notes: [], skills: [],
  routines: [{ name: "Daily", instruction: "Review", enabled: true, timezone: "UTC",
    schedule: { kind: "cron", expression: "0 8 * * *" } }],
  files: [], unknownPaths: [],
});
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openteleport-mcp-service-"));
  ctx = { home, cwd: home, env: {}, exec: vi.fn() as unknown as Ctx["exec"], logger: vi.fn() };
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
function adapters() {
  const source = createMemoryAdapter({ name: "source", agents: { ada: bundle() } });
  const target = createMemoryAdapter({ name: "target", capabilities: { facts: false } });
  registerAdapter(source); registerAdapter(target);
  return { source, target };
}
const request = { operation: "move" as const, from: "source", to: "target", agent: "ada" };
it("previews without writes and applies only the reviewed snapshot once", async () => {
  const { source, target } = adapters();
  const session = new TransferSession(ctx);
  const plan = await session.plan(request);
  expect(await readdir(home)).toEqual([]);
  expect(target.written).toHaveLength(0);
  expect(plan.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ field: "memory.facts" })]));
  source.read = async () => { throw new Error("changed source must not be reread"); };
  await expect(session.apply(plan.planId, false)).rejects.toThrow("Review");
  expect((await session.apply(plan.planId, true)).outcome).toBe("done");
  expect(target.written[0].bundle.instructions).toBe("Review carefully");
  expect(target.written[0].opts).toEqual({ onConflict: "update", includeFiles: false, enableRoutines: false });
  expect(target.written[0].bundle.facts).toEqual([]);
  await expect(session.apply(plan.planId, true)).rejects.toThrow("expired");
  expect(target.written).toHaveLength(1);
});
it("expires, cancels and bounds plans", async () => {
  adapters();
  let now = 0;
  const session = new TransferSession(ctx, () => now);
  const expired = await session.plan(request);
  now = 600001;
  await expect(session.apply(expired.planId, true)).rejects.toThrow("expired");
  const cancelled = await session.plan(request);
  expect(session.cancel(cancelled.planId)).toEqual({ cancelled: true });
  await expect(session.apply(cancelled.planId, true)).rejects.toThrow("missing");
  for (let n = 0; n < 8; n++) await session.plan(request);
  await expect(session.plan(request)).rejects.toThrow("Too many");
});
it("blocks secrets during preview without leaking their values", async () => {
  const { source, target } = adapters();
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";
  source.read = async () => ({ bundle: { ...bundle(), instructions: secret }, warnings: [] });
  const error = await new TransferSession(ctx).plan(request).catch((error: Error) => error);
  expect(String(error)).toContain("secret");
  expect(String(error)).not.toContain(secret);
  expect(target.written).toHaveLength(0);
  expect(await readdir(home)).toEqual([]);
});
it("preserves handoff and consumes failed writes without replay", async () => {
  const { target } = adapters();
  target.write = async () => ({ outcome: "handoff", nextStep: "Import in Settings",
    items: { approximated: [], skipped: [], warnings: ["Review settings"] } });
  const session = new TransferSession(ctx);
  expect(await session.apply((await session.plan(request)).planId, true)).toMatchObject({
    outcome: "handoff", nextStep: "Import in Settings", warnings: ["Review settings"] });
  target.write = async () => { throw new Error("partial write"); };
  const failed = await session.plan(request);
  await expect(session.apply(failed.planId, true)).rejects.toThrow("partial write");
  await expect(session.apply(failed.planId, true)).rejects.toThrow("expired");
});
it("never overwrites an archive created after preview", async () => {
  adapters();
  const session = new TransferSession(ctx);
  const out = join(home, "agent.jetpack");
  const plan = await session.plan({ operation: "export", from: "source", agent: "ada", out });
  await writeFile(out, "sentinel");
  await expect(session.apply(plan.planId, true)).rejects.toThrow();
  expect(await readFile(out, "utf8")).toBe("sentinel");
});
it("exports and imports through the core engine", async () => {
  const { target } = adapters();
  const session = new TransferSession(ctx);
  const out = join(home, "agent.jetpack");
  const plan = await session.plan({ operation: "export", from: "source", agent: "ada", out });
  expect((await session.apply(plan.planId, true)).artifactPath).toBe(out);
  expect((await readBundle(out)).manifest.id).not.toBe("");
  const importing = await session.plan({ operation: "import", path: out, to: "target", onConflict: "copy" });
  expect((await session.apply(importing.planId, true)).outcome).toBe("done");
  expect(target.written[0].opts.onConflict).toBe("copy");
});
it("serializes writes and isolates source/target paths", async () => {
  const { source, target } = adapters();
  const read = source.read;
  source.read = async (context, agent) => {
    expect(context.sourceDir).toBe(join(home, "source"));
    expect(context.targetDir).toBeUndefined();
    return read(context, agent);
  };
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const write = target.write;
  target.write = async (context, data, opts) => {
    expect(context.targetDir).toBe(join(home, "target"));
    expect(context.sourceDir).toBeUndefined();
    await waiting;
    return write(context, data, opts);
  };
  const session = new TransferSession(ctx);
  const a = await session.plan({ ...request, sourceDir: "source", targetDir: "target" });
  const b = await session.plan({ ...request, sourceDir: "source", targetDir: "target" });
  const first = session.apply(a.planId, true);
  await expect(session.apply(b.planId, true)).rejects.toThrow("Another transfer");
  release();
  await first;
  await session.apply(b.planId, true);
});
