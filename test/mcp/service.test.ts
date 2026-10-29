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
  await expect(session.apply(failed.planId, true)).rejects.toThrow("destination may have changed");
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


it("reserves slots before concurrent source reads and releases failed reservations", async () => {
  const { source } = adapters();
  const original = source.read;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  source.read = async (context, agent) => {
    reads++;
    await gate;
    return original(context, agent);
  };
  const session = new TransferSession(ctx);
  const pending = Array.from({ length: 8 }, () => session.plan(request));
  await expect(session.plan(request)).rejects.toThrow("Too many");
  release();
  const plans = await Promise.all(pending);
  expect(reads).toBe(8);
  plans.forEach((plan) => session.cancel(plan.planId));
  source.read = async () => { throw new Error("read failed"); };
  for (let n = 0; n < 9; n++) await expect(session.plan(request)).rejects.toThrow("read failed");
  source.read = original;
  const retry = await session.plan(request);
  expect(retry.planId).toBeTruthy();
  session.dispose();
});

it("releases expired snapshots without waiting for another request", async () => {
  adapters();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const session = new TransferSession(ctx);
  try {
    const plan = await session.plan(request);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(600000);
    expect(vi.getTimerCount()).toBe(0);
    // cancel cannot find the data even though no intervening plan/apply performed a sweep.
    expect(session.cancel(plan.planId)).toEqual({ cancelled: false });
  } finally {
    session.dispose();
    vi.useRealTimers();
  }
});

it("cancellation and transport disposal clear timers and invalidate plans", async () => {
  adapters();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const session = new TransferSession(ctx);
  try {
    const a = await session.plan(request);
    const b = await session.plan(request);
    expect(vi.getTimerCount()).toBe(2);
    session.cancel(a.planId);
    expect(vi.getTimerCount()).toBe(1);
    session.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(session.cancel(b.planId)).toEqual({ cancelled: false });
    await expect(session.plan(request)).rejects.toThrow("closed");
    await expect(session.apply(b.planId, true)).rejects.toThrow("closed");
  } finally {
    session.dispose();
    vi.useRealTimers();
  }
});

it("does not retain a preview whose source finishes reading after transport disposal", async () => {
  const { source } = adapters();
  const original = source.read;
  let release!: () => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  source.read = async (context, agent) => {
    started();
    await gate;
    return original(context, agent);
  };
  const session = new TransferSession(ctx);
  const pending = session.plan(request);
  await reading;
  session.dispose();
  release();
  await expect(pending).rejects.toThrow("closed");
  expect(await readdir(home)).toEqual([]);
});


it("persists a successful outcome for a new session without storing agent content", async () => {
  adapters();
  const session = new TransferSession(ctx);
  const plan = await session.plan(request);
  const result = await session.apply(plan.planId, true);
  expect(result).toMatchObject({ operationId: plan.planId, receiptSaved: true });
  const saved = await readFile(result.receiptPath!, "utf8");
  expect(saved).not.toContain("Review carefully");
  expect(saved).not.toContain("Private preference");
  session.dispose();
  expect(await new TransferSession(ctx).operationStatus(plan.planId)).toMatchObject({
    state: "completed", execution: "completed", result: { outcome: "done" },
  });
});

it("persists partial failure and returns recovery data without raw exception content", async () => {
  const { target } = adapters();
  target.write = async () => {
    await writeFile(join(home, "partly-written.txt"), "partial");
    throw new Error("DO_NOT_RETURN_PRIVATE_EXCEPTION_TEXT");
  };
  const session = new TransferSession(ctx);
  const plan = await session.plan(request);
  const error = await session.apply(plan.planId, true).catch((error) => error);
  expect(error.receipt).toMatchObject({ operationId: plan.planId, state: "needs_review", errorCode: "TRANSFER_FAILED" });
  expect(error.message).toContain("Do not retry automatically");
  expect(error.message).not.toContain("DO_NOT_RETURN");
  expect(await readFile(error.receiptPath, "utf8")).not.toContain("DO_NOT_RETURN");
  expect(await new TransferSession(ctx).operationStatus(plan.planId)).toMatchObject({
    state: "needs_review", execution: "needs_review",
  });
  await expect(session.apply(plan.planId, true)).rejects.toThrow("missing");
});

it("refuses to invoke the destination writer if the initial receipt cannot be recorded", async () => {
  const { target } = adapters();
  const session = new TransferSession(ctx);
  const plan = await session.plan(request);
  await writeFile(join(home, ".openteleport"), "not a directory");
  await expect(session.apply(plan.planId, true)).rejects.toThrow("destination was not changed");
  expect(target.written).toHaveLength(0);
});

it("does not claim that a started receipt proves a live operation after reconnect", async () => {
  const { target } = adapters();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const write = target.write;
  target.write = async (context, data, options) => {
    started();
    await gate;
    return write(context, data, options);
  };
  const session = new TransferSession(ctx);
  const plan = await session.plan(request);
  const applying = session.apply(plan.planId, true);
  await entered;
  try {
    expect(await session.operationStatus(plan.planId)).toMatchObject({ state: "started", execution: "in_progress" });
    expect(await new TransferSession(ctx).operationStatus(plan.planId)).toMatchObject({ state: "started", execution: "unknown" });
  } finally { release(); }
  await applying;
});

it("distinguishes failure before the adapter writer from partial destination changes", async () => {
  const { target } = adapters();
  const session = new TransferSession(ctx);
  const plan = await session.plan(request);
  Object.defineProperty(target, "capabilities", { get() { throw new Error("adapter unavailable"); } });
  const error = await session.apply(plan.planId, true).catch((error) => error);
  expect(error.receipt.state).toBe("not_applied");
  expect(error.message).toContain("before writing");
  expect(target.written).toHaveLength(0);
});


it("keeps a successful transfer successful when final receipt persistence fails", async () => {
  const { target } = adapters();
  const write = target.write;
  target.write = async (context, data, options) => {
    const result = await write(context, data, options);
    await rm(join(home, ".openteleport", "transfers"), { recursive: true, force: true });
    return result;
  };
  const session = new TransferSession(ctx);
  const plan = await session.plan(request);
  const result = await session.apply(plan.planId, true);
  expect(result).toMatchObject({ outcome: "done", receiptSaved: false });
  expect(result.warnings).toContain("Transfer completed, but its receipt could not be finalized. Retain this result; a later status query may be inconclusive.");
  expect(target.written).toHaveLength(1);
  await expect(session.apply(plan.planId, true)).rejects.toThrow("missing");
});

it("retains the manual handoff step in the receipt after reconnecting", async () => {
  const { target } = adapters();
  target.write = async () => ({ outcome: "handoff", nextStep: "Import the package in Settings",
    items: { approximated: [], skipped: [], warnings: [] } });
  const session = new TransferSession(ctx);
  const plan = await session.plan(request);
  await session.apply(plan.planId, true);
  session.dispose();
  expect(await new TransferSession(ctx).operationStatus(plan.planId)).toMatchObject({
    state: "completed", result: { outcome: "handoff", nextStep: "Import the package in Settings" },
  });
});
