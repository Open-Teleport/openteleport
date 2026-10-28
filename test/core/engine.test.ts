import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapter, AdapterCapabilities, Ctx, WriteOpts } from "../../src/adapters/types.js";
import { readBundle } from "../../src/core/bundle.js";
import { SecretsFoundError, exportBundle, importBundle, move } from "../../src/core/engine.js";
import type { Bundle, Routine } from "../../src/core/schema.js";
import { type MemoryAdapter, createMemoryAdapter } from "../helpers/memory-adapter.js";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const KNOWN_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";

const encoder = new TextEncoder();
const bytes = (content: string): Uint8Array => encoder.encode(content);

const routine = (name: string, schedule: Routine["schedule"]): Routine => ({
  name,
  instruction: `Run ${name}.`,
  enabled: true,
  timezone: "Europe/Warsaw",
  schedule,
});

/** A manifest-less agent with something in every field. */
function fullAgent(overrides: Partial<Bundle> = {}): Bundle {
  return {
    manifest: {
      schemaVersion: "0.1",
      id: "",
      name: "Ada",
      models: [{ provider: "anthropic", model: "claude-opus-5-5" }],
      capabilities: [],
    },
    persona: "Calm and curious.\nNever rushed.\n",
    instructions: "Answer in five lines or fewer.\n",
    skills: [{ name: "web-brief", files: [{ path: "SKILL.md", bytes: bytes("# Web brief\n") }] }],
    routines: [routine("Daily", { kind: "cron", expression: "0 8 * * *" })],
    facts: ["Prefers Polish.", "Reads on a phone."],
    notes: [{ name: "2026-10-20", text: "Met the team." }],
    files: [{ path: "data/table.csv", bytes: bytes("a,b\n1,2\n") }],
    avatar: { name: "avatar.png", bytes: new Uint8Array([137, 80, 78, 71]) },
    unknownPaths: [],
    ...overrides,
  };
}

const WRITE: WriteOpts = { enableRoutines: false, includeFiles: true, onConflict: "copy" };

let home: string;
let ctx: Ctx;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openteleport-engine-"));
  const exec = (() => {
    throw new Error("the engine runs no commands");
  }) as unknown as typeof execa;
  ctx = { home, cwd: home, env: {}, exec, logger: () => {} };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const source = (agent: Bundle = fullAgent()): MemoryAdapter =>
  createMemoryAdapter({ name: "src", agents: { ada: agent } });
const target = (capabilities: Partial<AdapterCapabilities> = {}): MemoryAdapter =>
  createMemoryAdapter({ name: "dst", capabilities });

/** The only Bundle `to` received; fails when it received none or several. */
function writtenTo(to: MemoryAdapter): Bundle {
  expect(to.written).toHaveLength(1);
  return to.written[0]!.bundle;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("move", () => {
  it("skips facts when target has facts:false and lists them", async () => {
    const to = target({ facts: false });
    const report = await move({ from: source(), to, agent: "ada", ctx, write: WRITE });

    expect(report.skipped).toContainEqual({
      field: "memory.facts",
      detail: "In-memory dst does not support memory.facts",
    });
    expect(writtenTo(to).facts).toEqual([]);
    expect(report.moved.map(({ field }) => field)).not.toContain("memory.facts");
  });

  it("skips a routine whose schedule kind the target lacks", async () => {
    const agent = fullAgent({
      routines: [
        routine("Daily", { kind: "cron", expression: "0 8 * * *" }),
        routine("One-off", { kind: "at", at: "2026-11-01T09:00:00+01:00" }),
        routine("Hourly", { kind: "every", every: "1h" }),
      ],
    });
    const to = target({ schedules: ["cron", "every"] });
    const report = await move({ from: source(agent), to, agent: "ada", ctx, write: WRITE });

    expect(report.skipped[0]?.field).toBe("routine:One-off");
    expect(report.skipped).toEqual([
      { field: "routine:One-off", detail: "schedule kind 'at' is not supported by In-memory dst" },
    ]);
    expect(writtenTo(to).routines.map(({ name }) => name)).toEqual(["Daily", "Hourly"]);
    expect(report.moved).toContainEqual({ field: "routines", detail: "2 routines" });
  });

  it("aborts on secrets before writing", async () => {
    const agent = fullAgent({ instructions: `Use the key ${SECRET} for lookups.\n` });
    const to = target();
    const error: unknown = await move({
      from: source(agent),
      to,
      agent: "ada",
      ctx,
      write: WRITE,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SecretsFoundError);
    const { findings, message } = error as SecretsFoundError;
    expect(findings).toEqual([
      { path: "AGENTS.md", line: 1, kind: "anthropic-api-key", preview: "sk-ant…" },
    ]);
    expect(message.split("\n")).toContain("AGENTS.md:1 anthropic-api-key");
    expect(message).not.toContain(SECRET);
    expect(to.written.length).toBe(0);
  });

  it("drops files unless includeFiles", async () => {
    const without = target();
    const dropped = await move({
      from: source(),
      to: without,
      agent: "ada",
      ctx,
      write: { ...WRITE, includeFiles: false },
    });
    expect(writtenTo(without).files).toEqual([]);
    expect(dropped.skipped).toEqual([]);
    expect(dropped.moved.map(({ field }) => field)).not.toContain("files");

    const withFiles = target();
    const kept = await move({ from: source(), to: withFiles, agent: "ada", ctx, write: WRITE });
    expect(writtenTo(withFiles).files.map(({ path }) => path)).toEqual(["data/table.csv"]);
    expect(kept.moved).toContainEqual({ field: "files", detail: "1 file" });
  });

  it("drops files silently when includeFiles is off, even if the target lacks files", async () => {
    const to = target({ files: false });
    const report = await move({
      from: source(),
      to,
      agent: "ada",
      ctx,
      write: { ...WRITE, includeFiles: false },
    });
    expect(writtenTo(to).files).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("propagates outcome handoff and nextStep", async () => {
    const to = createMemoryAdapter({
      name: "dst",
      outcome: "handoff",
      nextStep: "Open dst and import ada.jetpack.",
    });
    const report = await move({ from: source(), to, agent: "ada", ctx, write: WRITE });

    expect(report.outcome).toBe("handoff");
    expect(report.nextStep).toBe("Open dst and import ada.jetpack.");
  });

  it("assigns an id to a manifest-less bundle", async () => {
    const from = source();
    const first = target();
    await move({ from, to: first, agent: "ada", ctx, write: WRITE });
    const id = writtenTo(first).manifest.id;
    expect(id).toHaveLength(26);
    expect(id).toMatch(ULID);

    // The same source agent keeps its id on the next move, and the source is left untouched.
    const second = target();
    await move({ from, to: second, agent: "ada", ctx, write: WRITE });
    expect(writtenTo(second).manifest.id).toBe(id);
    expect((await from.read(ctx, "ada")).bundle.manifest.id).toBe("");
  });

  it("keeps the id a bundle already has", async () => {
    const agent = fullAgent();
    agent.manifest.id = KNOWN_ID;
    const to = target();
    await move({ from: source(agent), to, agent: "ada", ctx, write: WRITE });
    expect(writtenTo(to).manifest.id).toBe(KNOWN_ID);
  });

  it.each([
    ["persona", { persona: false }, "persona", (b: Bundle) => b.persona === undefined],
    ["instructions", { instructions: false }, "instructions", (b: Bundle) => b.instructions === ""],
    ["notes", { notes: false }, "memory.notes", (b: Bundle) => b.notes.length === 0],
    ["files", { files: false }, "files", (b: Bundle) => b.files.length === 0],
    ["avatar", { avatar: false }, "avatar", (b: Bundle) => b.avatar === undefined],
    ["models", { models: false }, "models", (b: Bundle) => b.manifest.models.length === 0],
  ] as const)(
    "empties %s when the target does not support it",
    async (_capability, capabilities, field, emptied) => {
      const to = target(capabilities);
      const report = await move({ from: source(), to, agent: "ada", ctx, write: WRITE });

      expect(report.skipped).toEqual([{ field, detail: `In-memory dst does not support ${field}` }]);
      expect(emptied(writtenTo(to))).toBe(true);
      expect(report.moved.map((item) => item.field)).not.toContain(field);
    },
  );

  it("names every skill and routine a target without them leaves behind", async () => {
    const skill = (name: string) => ({
      name,
      files: [{ path: "SKILL.md", bytes: bytes(`# ${name}\n`) }],
    });
    const agent = fullAgent({
      skills: [skill("web-brief"), skill("summarise")],
      routines: [
        routine("Daily", { kind: "cron", expression: "0 8 * * *" }),
        routine("Weekly", { kind: "cron", expression: "0 8 * * 1" }),
      ],
    });
    const to = target({ skills: false, routines: false });

    const report = await move({ from: source(agent), to, agent: "ada", ctx, write: WRITE });

    expect(report.skipped).toEqual([
      { field: "skill:web-brief", detail: "In-memory dst does not support skills" },
      { field: "skill:summarise", detail: "In-memory dst does not support skills" },
      { field: "routine:Daily", detail: "In-memory dst does not support routines" },
      { field: "routine:Weekly", detail: "In-memory dst does not support routines" },
    ]);
    expect(writtenTo(to).skills).toEqual([]);
    expect(writtenTo(to).routines).toEqual([]);
    const moved = report.moved.map((item) => item.field);
    expect(moved).not.toContain("skills");
    expect(moved).not.toContain("routines");
  });

  it("does not list as moved what the target adapter then skipped", async () => {
    const agent = fullAgent({
      skills: [
        { name: "web-brief", files: [{ path: "SKILL.md", bytes: bytes("# Web brief\n") }] },
        { name: "summarise", files: [{ path: "SKILL.md", bytes: bytes("# Summarise\n") }] },
      ],
      routines: [
        routine("Daily", { kind: "cron", expression: "0 8 * * *" }),
        routine("Weekly", { kind: "cron", expression: "0 8 * * 1" }),
      ],
    });
    const memoryTarget = target();
    const to: Adapter = {
      ...memoryTarget,
      async write(writeCtx, bundle, opts) {
        const result = await memoryTarget.write(writeCtx, bundle, opts);
        return {
          ...result,
          items: {
            approximated: [],
            skipped: [
              { field: "routine:Daily", detail: "not created: the Gateway is down" },
              // One item per file of the same skill still drops one skill.
              { field: "skill:web-brief", detail: "unsafe path 'a'; not written" },
              { field: "skill:web-brief", detail: "unsafe path 'b'; not written" },
              { field: "memory.facts", detail: "MEMORY.md is a symlink; not written" },
              { field: "avatar", detail: "avatars/avatar.png is a symbolic link; not written" },
              { field: "note:2026-10-20", detail: "unsafe name; not written" },
              { field: "description", detail: "the app has no field for it" },
            ],
            warnings: [],
          },
        };
      },
    };

    const report = await move({ from: source(agent), to, agent: "ada", ctx, write: WRITE });

    expect(report.moved).toEqual([
      { field: "instructions", detail: "1 line" },
      { field: "persona", detail: "2 lines" },
      { field: "skills", detail: "1 skill" },
      { field: "routines", detail: "1 routine" },
      { field: "files", detail: "1 file" },
      { field: "models", detail: "1 model preference" },
    ]);
  });

  it("lists nothing as skipped for an unsupported field that is already empty", async () => {
    const agent = fullAgent({ facts: [], persona: undefined });
    const to = target({ facts: false, persona: false });
    const report = await move({ from: source(agent), to, agent: "ada", ctx, write: WRITE });
    expect(report.skipped).toEqual([]);
  });

  it("reports every field it handed to write, in a fixed order", async () => {
    const report = await move({ from: source(), to: target(), agent: "ada", ctx, write: WRITE });

    expect(report.moved).toEqual([
      { field: "instructions", detail: "1 line" },
      { field: "persona", detail: "2 lines" },
      { field: "skills", detail: "1 skill" },
      { field: "routines", detail: "1 routine" },
      { field: "memory.facts", detail: "2 facts" },
      { field: "memory.notes", detail: "1 note" },
      { field: "files", detail: "1 file" },
      { field: "avatar", detail: "avatar.png" },
      { field: "models", detail: "1 model preference" },
    ]);
  });

  it("builds the report from both adapters and merges the write result", async () => {
    const memorySource = source();
    const from: Adapter = {
      ...memorySource,
      async read(readCtx, agent) {
        const { bundle } = await memorySource.read(readCtx, agent);
        return { bundle, warnings: ["SOUL.md not found"] };
      },
    };
    const memoryTarget = target({ avatar: false });
    const to: Adapter = {
      ...memoryTarget,
      async write(writeCtx, bundle, opts) {
        const result = await memoryTarget.write(writeCtx, bundle, opts);
        return {
          ...result,
          items: {
            approximated: [{ field: "routine:Daily", detail: "became a daily job" }],
            skipped: [{ field: "skill:web-brief", detail: "scripts are not supported" }],
            warnings: ["Restart the app to load the agent"],
          },
        };
      },
    };

    const report = await move({ from, to, agent: "ada", ctx, write: WRITE });

    expect(report.source).toEqual({ app: "src", agent: "ada" });
    expect(report.target).toEqual({ app: "dst", agent: "Ada" });
    expect(report.outcome).toBe("done");
    expect(report).not.toHaveProperty("nextStep");
    expect(report.approximated).toEqual([{ field: "routine:Daily", detail: "became a daily job" }]);
    expect(report.skipped).toEqual([
      { field: "avatar", detail: "In-memory dst does not support avatar" },
      { field: "skill:web-brief", detail: "scripts are not supported" },
    ]);
    expect(report.warnings).toEqual(["SOUL.md not found", "Restart the app to load the agent"]);
  });

  it("passes the write options through and never changes the bundle it read", async () => {
    const memorySource = source();
    let read: Bundle | undefined;
    const from: Adapter = {
      ...memorySource,
      async read(readCtx, agent) {
        const result = await memorySource.read(readCtx, agent);
        read = deepFreeze(result.bundle);
        return { bundle: read, warnings: [] };
      },
    };
    const to = target({ facts: false, schedules: [] });
    const write: WriteOpts = { enableRoutines: true, includeFiles: false, onConflict: "replace" };

    await move({ from, to, agent: "ada", ctx, write });

    expect(to.written[0]?.opts).toEqual(write);
    expect(read?.manifest.id).toBe("");
    expect(read?.facts).toHaveLength(2);
    expect(read?.routines).toHaveLength(1);
    expect(read?.files).toHaveLength(1);
  });
});

describe("exportBundle", () => {
  it("writes a bundle with an id and reports it as exported", async () => {
    const out = join(home, "ada.jetpack");
    const { bundle, report } = await exportBundle({
      from: source(),
      agent: "ada",
      ctx,
      out,
      includeFiles: false,
    });

    expect(bundle.manifest.id).toMatch(ULID);
    expect(bundle.files).toEqual([]);
    const reread = await readBundle(out);
    expect(reread.manifest.id).toBe(bundle.manifest.id);
    expect(reread.instructions).toBe("Answer in five lines or fewer.\n");
    expect(reread.files).toEqual([]);

    expect(report.outcome).toBe("exported");
    expect(report.source).toEqual({ app: "src", agent: "ada" });
    expect(report).not.toHaveProperty("target");
    expect(report.moved.map(({ field }) => field)).not.toContain("files");
    expect(report.skipped).toEqual([]);
  });

  it("keeps files with includeFiles and writes nothing without out", async () => {
    const { bundle, report } = await exportBundle({
      from: source(),
      agent: "ada",
      ctx,
      includeFiles: true,
    });
    expect(bundle.files.map(({ path }) => path)).toEqual(["data/table.csv"]);
    expect(report.moved).toContainEqual({ field: "files", detail: "1 file" });
  });

  it("gives the same agent the same id as move does", async () => {
    const from = source();
    const to = target();
    await move({ from, to, agent: "ada", ctx, write: WRITE });
    const { bundle } = await exportBundle({ from, agent: "ada", ctx, includeFiles: false });
    expect(bundle.manifest.id).toBe(writtenTo(to).manifest.id);
  });

  it("refuses to export secrets and writes no file", async () => {
    const out = join(home, "ada.jetpack");
    const agent = fullAgent({ facts: [`Token ${SECRET}`] });
    await expect(
      exportBundle({ from: source(agent), agent: "ada", ctx, out, includeFiles: false }),
    ).rejects.toThrow(/MEMORY\.md:1 anthropic-api-key/);
    await expect(stat(out)).rejects.toThrow();
  });
});

describe("importBundle", () => {
  it("writes the bundle to the target and reports it as coming from the bundle", async () => {
    const to = target({ notes: false });
    const report = await importBundle({ to, bundle: fullAgent(), ctx, write: WRITE });

    const written = writtenTo(to);
    expect(written.manifest.id).toMatch(ULID);
    expect(written.notes).toEqual([]);
    expect(report.source).toEqual({ app: "jetpack", agent: "Ada" });
    expect(report.target).toEqual({ app: "dst", agent: "Ada" });
    expect(report.skipped).toEqual([
      { field: "memory.notes", detail: "In-memory dst does not support memory.notes" },
    ]);
  });

  it("gives a bundle without an id a stable id keyed by its name", async () => {
    const first = target();
    const second = target();
    await importBundle({ to: first, bundle: fullAgent(), ctx, write: WRITE });
    await importBundle({ to: second, bundle: fullAgent(), ctx, write: WRITE });
    expect(writtenTo(second).manifest.id).toBe(writtenTo(first).manifest.id);

    const cache: unknown = JSON.parse(
      await readFile(join(home, ".openteleport", "ids.json"), "utf8"),
    );
    expect(cache).toEqual({ "jetpack/Ada": writtenTo(first).manifest.id });
  });

  it("drops files unless includeFiles", async () => {
    const to = target();
    await importBundle({ to, bundle: fullAgent(), ctx, write: { ...WRITE, includeFiles: false } });
    expect(writtenTo(to).files).toEqual([]);
  });

  it("refuses a bundle with secrets before writing", async () => {
    const to = target();
    const bundle = fullAgent({ persona: `Bearer ${"x".repeat(30)}` });
    await expect(importBundle({ to, bundle, ctx, write: WRITE })).rejects.toBeInstanceOf(
      SecretsFoundError,
    );
    expect(to.written.length).toBe(0);
  });
});

describe("a secret in a file that is not carried over", () => {
  /** An agent whose only secret sits in `files/.secrets.txt`. */
  const agentWithSecretFile = (): Bundle =>
    fullAgent({
      files: [
        { path: "data/table.csv", bytes: bytes("a,b\n1,2\n") },
        { path: ".secrets.txt", bytes: bytes(`ANTHROPIC_KEY=${SECRET}\n`) },
      ],
    });
  const FINDING = { path: "files/.secrets.txt", line: 1, kind: "anthropic-api-key" };

  it("does not block a move without includeFiles, and blocks one with it", async () => {
    const without = target();
    const report = await move({
      from: source(agentWithSecretFile()),
      to: without,
      agent: "ada",
      ctx,
      write: { ...WRITE, includeFiles: false },
    });
    expect(writtenTo(without).files).toEqual([]);
    expect(report.skipped).toEqual([]);

    const withFiles = target();
    const error: unknown = await move({
      from: source(agentWithSecretFile()),
      to: withFiles,
      agent: "ada",
      ctx,
      write: { ...WRITE, includeFiles: true },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretsFoundError);
    expect((error as SecretsFoundError).findings).toMatchObject([FINDING]);
    expect(withFiles.written.length).toBe(0);
  });

  it("does not block an export without includeFiles, and blocks one with it", async () => {
    const out = join(home, "ada.jetpack");
    const { bundle, report } = await exportBundle({
      from: source(agentWithSecretFile()),
      agent: "ada",
      ctx,
      out,
      includeFiles: false,
    });
    expect(bundle.files).toEqual([]);
    expect((await readBundle(out)).files).toEqual([]);
    expect(report.skipped).toEqual([]);

    const blockedOut = join(home, "blocked.jetpack");
    const error: unknown = await exportBundle({
      from: source(agentWithSecretFile()),
      agent: "ada",
      ctx,
      out: blockedOut,
      includeFiles: true,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretsFoundError);
    expect((error as SecretsFoundError).findings).toMatchObject([FINDING]);
    await expect(stat(blockedOut)).rejects.toThrow();
  });

  it("does not block an import without includeFiles, and blocks one with it", async () => {
    const without = target();
    const report = await importBundle({
      to: without,
      bundle: agentWithSecretFile(),
      ctx,
      write: { ...WRITE, includeFiles: false },
    });
    expect(writtenTo(without).files).toEqual([]);
    expect(report.skipped).toEqual([]);

    const withFiles = target();
    const error: unknown = await importBundle({
      to: withFiles,
      bundle: agentWithSecretFile(),
      ctx,
      write: { ...WRITE, includeFiles: true },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretsFoundError);
    expect((error as SecretsFoundError).findings).toMatchObject([FINDING]);
    expect(withFiles.written.length).toBe(0);
  });
});

describe("the context each side gets", () => {
  /** The contexts `adapter` was called with, by method, recorded as it passes them on. */
  function watched(adapter: MemoryAdapter): { adapter: Adapter; seen: Record<string, Ctx[]> } {
    const seen: Record<string, Ctx[]> = { read: [], write: [] };
    return {
      seen,
      adapter: {
        ...adapter,
        read: (given, agent) => {
          seen.read?.push(given);
          return adapter.read(given, agent);
        },
        write: (given, bundle, opts) => {
          seen.write?.push(given);
          return adapter.write(given, bundle, opts);
        },
      },
    };
  }
  const both = (): Ctx => ({ ...ctx, sourceDir: "/from/here", targetDir: "/to/there" });
  const onlySource = (given: Ctx | undefined) => {
    expect(given?.sourceDir).toBe("/from/here");
    expect(given?.targetDir).toBeUndefined();
    expect(given?.home).toBe(home);
  };
  const onlyTarget = (given: Ctx | undefined) => {
    expect(given?.targetDir).toBe("/to/there");
    expect(given?.sourceDir).toBeUndefined();
    expect(given?.home).toBe(home);
  };

  it("move reads without the target's folder and writes without the source's", async () => {
    const from = watched(source());
    const to = watched(target());
    await move({ from: from.adapter, to: to.adapter, agent: "ada", ctx: both(), write: WRITE });

    expect(from.seen.read).toHaveLength(1);
    onlySource(from.seen.read?.[0]);
    expect(to.seen.write).toHaveLength(1);
    onlyTarget(to.seen.write?.[0]);
  });

  it("exportBundle reads without the target's folder", async () => {
    const from = watched(source());
    await exportBundle({ from: from.adapter, agent: "ada", ctx: both(), includeFiles: false });

    expect(from.seen.read).toHaveLength(1);
    onlySource(from.seen.read?.[0]);
  });

  it("importBundle writes without the source's folder", async () => {
    const to = watched(target());
    await importBundle({ to: to.adapter, bundle: fullAgent(), ctx: both(), write: WRITE });

    expect(to.seen.write).toHaveLength(1);
    onlyTarget(to.seen.write?.[0]);
  });

  it("leaves the caller's context as it was", async () => {
    const given = both();
    await move({ from: source(), to: target(), agent: "ada", ctx: given, write: WRITE });
    expect(given).toMatchObject({ sourceDir: "/from/here", targetDir: "/to/there" });
  });
});

describe("SecretsFoundError", () => {
  it("lists one finding per line without previews", () => {
    const error = new SecretsFoundError([
      { path: "AGENTS.md", line: 3, kind: "openai-api-key", preview: "sk-abc…" },
      { path: "jetpack.json", kind: "jwt", preview: "eyJhbG…" },
    ]);
    expect(error.message.split("\n").slice(1)).toEqual([
      "AGENTS.md:3 openai-api-key",
      "jetpack.json jwt",
    ]);
    expect(error.message).not.toContain("sk-abc");
    expect(error.findings).toHaveLength(2);
    expect(error.name).toBe("SecretsFoundError");
  });
});
