import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { execa } from "execa";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hermesAdapter } from "../../../src/adapters/hermes/index.js";
import { parseEntries, renderEntries } from "../../../src/adapters/hermes/memory.js";
import {
  profileSlug,
  skillDigest,
  writeHermesProfile,
} from "../../../src/adapters/hermes/write.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import type { Bundle, Routine, Skill } from "../../../src/core/schema.js";
import { mergeInstructions } from "../../../src/core/text.js";
import { ADA_DIR, ADA_ID, json, run, sandbox } from "../../helpers/cli.js";
import type { MoveReport } from "../../../src/core/report.js";

const OTHER_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2U";
const RESTART_WARNING =
  "Restart the Hermes gateway (if it is running) so it picks up the profile and its cron jobs";
const SCANNER_WARNING =
  "Hermes scans memory entries and cron prompts for prompt injection; an entry it rejects is dropped on its side";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let root: string;
let hermes: string;
let ctx: Ctx;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-hermes-write-"));
  hermes = join(root, "hermes");
  await mkdir(hermes);
  await writeFile(join(hermes, "config.yaml"), "memory:\n  memory_char_limit: 2200\n");
  ctx = {
    home: join(root, "home"),
    cwd: root,
    env: { HERMES_HOME: hermes, HERMES_TIMEZONE: "Europe/Warsaw" },
    exec: noExec,
    logger: () => {},
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTS: WriteOpts = { enableRoutines: false, includeFiles: false, onConflict: "update" };
const opts = (overrides: Partial<WriteOpts> = {}): WriteOpts => ({ ...OPTS, ...overrides });

const profile = (id = "ada"): string => join(hermes, "profiles", id);
const text = (path: string): Promise<string> => readFile(path, "utf8");
const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value));

function skillOf(name: string, body = `# ${name}\n`, extra: Record<string, string> = {}): Skill {
  return {
    name,
    files: [
      { path: "SKILL.md", bytes: bytes(`---\nname: ${name}\ndescription: ${name}\n---\n\n${body}`) },
      ...Object.entries(extra).map(([path, content]) => ({ path, bytes: bytes(content) })),
    ],
  };
}

const CRON: Routine = {
  name: "Morning digest",
  instruction: "Summarise the overnight news.",
  enabled: true,
  timezone: "Europe/Warsaw",
  schedule: { kind: "cron", expression: "0 9 * * 1-5" },
};
const EVERY: Routine = {
  name: "Inbox sweep",
  instruction: "Sort the inbox.",
  enabled: true,
  timezone: "Europe/Warsaw",
  schedule: { kind: "every", every: "2h" },
};
const AT: Routine = {
  name: "Renew the domain",
  instruction: "Remind me to renew the domain.",
  enabled: false,
  timezone: "Europe/Warsaw",
  schedule: { kind: "at", at: "2099-01-01T08:00:00.000Z" },
};

const FACTS = [
  "Ada prefers metric units.",
  "Ada works in Europe/Warsaw.\nShe starts at nine.",
  "Ada reads the news before email.",
  "Ada never schedules meetings on Fridays.",
];

/** Ada as the tests use her, with the given fields laid over her. */
function ada(overrides: Partial<Bundle> & { manifest?: Partial<Bundle["manifest"]> } = {}): Bundle {
  const { manifest, ...rest } = overrides;
  return {
    manifest: {
      schemaVersion: "0.1",
      id: ADA_ID,
      name: "Ada",
      title: "Research assistant",
      models: [{ provider: "anthropic", model: "anthropic/claude-sonnet-4-5" }],
      capabilities: [],
      ...manifest,
    },
    persona: "Calm and curious.",
    instructions: "Answer briefly.",
    skills: [
      skillOf("web-brief", "Brief the web.\n", { "references/api.md": "API notes\n" }),
      skillOf("notes"),
    ],
    routines: [CRON, EVERY, AT],
    facts: FACTS,
    notes: [],
    files: [],
    unknownPaths: [],
    ...rest,
  };
}

/** Every file below `dir`, `/`-separated, sorted. */
async function files(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

type Job = Record<string, unknown> & { id: string; name: string };
type JobsFile = { jobs: Job[]; updated_at: string } & Record<string, unknown>;

const readJobs = async (dir = profile()): Promise<JobsFile> =>
  JSON.parse(await text(join(dir, "cron", "jobs.json"))) as JobsFile;

const readMarker = async (dir = profile()): Promise<Record<string, unknown>> =>
  JSON.parse(await text(join(dir, ".openteleport.json"))) as Record<string, unknown>;

const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

/** A link, or a skipped test where the system does not allow one. */
async function link(
  target: string,
  path: string,
  type: "file" | "junction",
  skip: () => void,
): Promise<void> {
  try {
    await symlink(target, path, type);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") skip();
    throw error;
  }
}

describe("profileSlug", () => {
  it.each([
    ["Ada", "ada"],
    ["Ada Lovelace", "ada-lovelace"],
    ["  --Weird__Name!! ", "weird-name"],
    ["R2-D2", "r2-d2"],
  ])("turns %j into %j", (name, slug) => {
    expect(profileSlug(name)).toBe(slug);
  });

  it("cuts a long name to 64 characters without a dash at the end", () => {
    const slug = profileSlug(`${"a".repeat(63)} b`);
    expect(slug).toBe("a".repeat(63));
    expect(profileSlug("b".repeat(80))).toHaveLength(64);
  });

  it("gives a Windows device name another name, since its folder could not be made", () => {
    expect(profileSlug("con")).toBe("con-r");
    expect(profileSlug("NUL")).toBe("nul-r");
  });

  it.each(["***", "", "   ", "!?"])("refuses %j, which holds no letter or digit", (name) => {
    expect(() => profileSlug(name)).toThrow(/no letters or digits/);
  });

  it.each(["default", "Default", " DEFAULT! ", "profiles"])(
    "refuses %j, which Hermes uses for something else",
    (name) => {
      expect(() => profileSlug(name)).toThrow(/reserved/);
    },
  );
});

describe("skillDigest", () => {
  const file = (path: string, content: string) => ({ path, bytes: Buffer.from(content) });

  it("hashes each path with the hash of its bytes, in path order", () => {
    const skill: Skill = { name: "x", files: [file("b.md", "two"), file("SKILL.md", "one")] };
    const expected = createHash("sha256")
      .update(`SKILL.md\n${sha("one")}\nb.md\n${sha("two")}\n`)
      .digest("hex");
    expect(skillDigest(skill)).toBe(expected);
  });

  it("does not depend on the order of the files or the name of the skill", () => {
    const one: Skill = { name: "x", files: [file("SKILL.md", "a"), file("z.md", "b")] };
    const two: Skill = { name: "y", files: [file("z.md", "b"), file("SKILL.md", "a")] };
    expect(skillDigest(one)).toBe(skillDigest(two));
  });

  it("changes with a byte or a path", () => {
    const base = skillDigest({ name: "x", files: [file("SKILL.md", "a")] });
    expect(skillDigest({ name: "x", files: [file("SKILL.md", "b")] })).not.toBe(base);
    expect(skillDigest({ name: "x", files: [file("SKILL.txt", "a")] })).not.toBe(base);
    expect(skillDigest({ name: "x", files: [file("SKILL.md", "a"), file("n.md", "")] })).not.toBe(
      base,
    );
  });
});

describe("a new profile", () => {
  it("is written as profiles/<slug>/ with everything the Bundle holds", async () => {
    const bundle = ada();
    const result = await writeHermesProfile(ctx, bundle, opts());

    expect(result.outcome).toBe("done");
    expect(result.targetAgentId).toBe("ada");
    expect(result.artifactPath).toBe(profile());
    expect(result.items.skipped).toEqual([]);

    expect(await files(profile())).toEqual([
      ".openteleport.json",
      "SOUL.md",
      "config.yaml",
      "cron/jobs.json",
      "memories/MEMORY.md",
      "profile.yaml",
      "skills/notes/SKILL.md",
      "skills/web-brief/SKILL.md",
      "skills/web-brief/references/api.md",
    ]);

    expect(parse(await text(join(profile(), "profile.yaml")))).toEqual({
      display_name: "Ada",
      description: "Research assistant",
    });
    expect(await text(join(profile(), "SOUL.md"))).toBe(
      mergeInstructions("Calm and curious.", "Answer briefly."),
    );
    expect(parse(await text(join(profile(), "config.yaml")))).toEqual({
      model: { default: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
    });

    const memory = await text(join(profile(), "memories", "MEMORY.md"));
    expect(memory).toBe(renderEntries(FACTS));
    expect(parseEntries(memory)).toEqual(FACTS);

    for (const skill of bundle.skills) {
      for (const entry of skill.files) {
        const written = await readFile(join(profile(), "skills", skill.name, entry.path));
        expect(written.equals(entry.bytes)).toBe(true);
      }
    }

    const { jobs, updated_at } = await readJobs();
    expect(typeof updated_at).toBe("string");
    expect(jobs.map((job) => job.name)).toEqual(["Morning digest", "Inbox sweep", "Renew the domain"]);
    for (const job of jobs) {
      expect(job).toMatchObject({
        enabled: false,
        state: "paused",
        next_run_at: null,
        deliver: "local",
        paused_reason: `imported by OpenTeleport; resume with: hermes cron resume ${job.id}`,
      });
      expect(job.id).toMatch(/^[0-9a-f]{12}$/);
    }
    expect(jobs.map((job) => (job.schedule as { kind: string }).kind)).toEqual([
      "cron",
      "interval",
      "once",
    ]);
    expect(jobs[1]?.prompt).toBe("Sort the inbox.");

    expect(await readMarker()).toEqual({
      id: ADA_ID,
      movedAt: expect.any(String),
      cronJobIds: jobs.map((job) => job.id),
      memoryEntries: FACTS,
      skills: {
        "web-brief": skillDigest(bundle.skills[0] as Skill),
        notes: skillDigest(bundle.skills[1] as Skill),
      },
    });
  });

  it("reports the persona and instructions sharing a file, and warns about the gateway and scanners", async () => {
    const { items } = await writeHermesProfile(ctx, ada(), opts());
    expect(items.approximated).toEqual([
      { field: "instructions", detail: "persona and instructions share one file (SOUL.md)" },
    ]);
    expect(items.warnings).toEqual([RESTART_WARNING, SCANNER_WARNING]);
  });

  it("writes jobs paused even with enableRoutines, and says how to resume each", async () => {
    const { items } = await writeHermesProfile(ctx, ada(), opts({ enableRoutines: true }));
    const { jobs } = await readJobs();
    expect(jobs.every((job) => job.enabled === false && job.state === "paused")).toBe(true);
    for (const job of jobs) {
      expect(items.approximated).toContainEqual({
        field: `routine:${job.name}`,
        detail: `Hermes jobs are written paused; resume it with \`hermes cron resume ${job.id}\``,
      });
      expect(items.warnings).toContain(`routine '${job.name}' stays paused: hermes cron resume ${job.id}`);
    }
  });

  it("does not say so without enableRoutines", async () => {
    const { items } = await writeHermesProfile(ctx, ada(), opts());
    expect(items.approximated.some((item) => item.field.startsWith("routine:"))).toBe(false);
  });

  it("leaves no temporary file behind and does not change the Bundle", async () => {
    const bundle = ada();
    const before = structuredClone(bundle);
    await writeHermesProfile(ctx, bundle, opts());
    expect(bundle).toEqual(before);
    expect((await files(hermes)).filter((path) => path.endsWith(".tmp"))).toEqual([]);
  });

  it("writes only what the Bundle has", async () => {
    await writeHermesProfile(
      ctx,
      ada({ persona: undefined, instructions: "", skills: [], routines: [], facts: [], manifest: { title: undefined, models: [] } }),
      opts(),
    );
    expect(await files(profile())).toEqual([".openteleport.json", "profile.yaml"]);
    expect(parse(await text(join(profile(), "profile.yaml")))).toEqual({ display_name: "Ada" });
    expect(await readMarker()).toMatchObject({ cronJobIds: [], memoryEntries: [], skills: {} });
  });

  it("names the profile after the slug and keeps the name as the display name", async () => {
    const { targetAgentId } = await writeHermesProfile(
      ctx,
      ada({ manifest: { name: "Ada Lovelace" } }),
      opts(),
    );
    expect(targetAgentId).toBe("ada-lovelace");
    expect(parse(await text(join(profile("ada-lovelace"), "profile.yaml")))).toMatchObject({
      display_name: "Ada Lovelace",
    });
  });

  it("writes a device name under another name", async () => {
    expect((await writeHermesProfile(ctx, ada({ manifest: { name: "con" } }), opts())).targetAgentId).toBe(
      "con-r",
    );
  });

  it("refuses a name with no letter or digit, and default, before it writes anything", async () => {
    await expect(
      writeHermesProfile(ctx, ada({ manifest: { name: "***" } }), opts()),
    ).rejects.toThrow(/no letters or digits/);
    await expect(
      writeHermesProfile(ctx, ada({ manifest: { name: "default" } }), opts()),
    ).rejects.toThrow(/reserved/);
    expect(await exists(join(hermes, "profiles"))).toBe(false);
    expect(await files(hermes)).toEqual(["config.yaml"]);
  });

  it("writes a persona alone as it is", async () => {
    const { items } = await writeHermesProfile(ctx, ada({ instructions: "" }), opts());
    expect(await text(join(profile(), "SOUL.md"))).toBe("Calm and curious.\n");
    expect(items.approximated).toEqual([]);
  });

  it("writes instructions alone, and says that Hermes reads them as the persona", async () => {
    const { items } = await writeHermesProfile(ctx, ada({ persona: undefined }), opts());
    expect(await text(join(profile(), "SOUL.md"))).toBe("Answer briefly.");
    expect(items.approximated).toEqual([
      {
        field: "instructions",
        detail: "no persona to share SOUL.md with; Hermes reads all of SOUL.md as the persona",
      },
    ]);
  });

  it("takes the first preference that names a model, and says what it left out", async () => {
    const models = [{ runtime: "codex" }, { provider: "openai", model: "gpt-x" }, { model: "second" }];
    const { items } = await writeHermesProfile(ctx, ada({ manifest: { models } }), opts());
    expect(parse(await text(join(profile(), "config.yaml")))).toEqual({
      model: { default: "gpt-x", provider: "openai" },
    });
    expect(items.approximated).toContainEqual({
      field: "models",
      detail: "Hermes holds one model; used gpt-x, 1 other preference not set",
    });
  });

  it("writes no config.yaml, and says so, when no preference names a model", async () => {
    const { items } = await writeHermesProfile(
      ctx,
      ada({ manifest: { models: [{ provider: "anthropic" }] } }),
      opts(),
    );
    expect(await exists(join(profile(), "config.yaml"))).toBe(false);
    expect(items.approximated).toContainEqual({
      field: "models",
      detail: "no preference names a model; Hermes's default applies",
    });
  });

  it("restores the base URL kept in x-hermes", async () => {
    const manifest = { "x-hermes": { profile: "default", baseUrl: "https://example.test/v1" } };
    await writeHermesProfile(ctx, ada({ manifest }), opts());
    expect(parse(await text(join(profile(), "config.yaml")))).toEqual({
      model: {
        default: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        base_url: "https://example.test/v1",
      },
    });
  });

  it("restores the fields of x-hermes that belong to a job, and nothing else", async () => {
    const manifest = {
      "x-hermes": {
        routines: {
          "Inbox sweep": { deliver: "telegram", workdir: "/home/ada/inbox", script: "rm -rf /" },
        },
      },
    };
    await writeHermesProfile(ctx, ada({ manifest }), opts());
    const sweep = (await readJobs()).jobs.find((job) => job.name === "Inbox sweep");
    expect(sweep).toMatchObject({ deliver: "telegram", workdir: "/home/ada/inbox", script: null });
  });
});

describe("the routines", () => {
  it("skips a one-off time in the past", async () => {
    const old: Routine = { ...AT, name: "Old", schedule: { kind: "at", at: "2020-01-01T08:00:00.000Z" } };
    const { items } = await writeHermesProfile(ctx, ada({ routines: [CRON, old] }), opts());
    expect(items.skipped).toEqual([
      { field: "routine:Old", detail: "Hermes rejects past one-off jobs" },
    ]);
    expect((await readJobs()).jobs.map((job) => job.name)).toEqual(["Morning digest"]);
    expect((await readMarker()).cronJobIds).toHaveLength(1);
  });

  it.each([
    ["a cron expression that does not parse", "61 * * * *", /invalid cron expression/],
    ["a cron expression with a seconds field", "0 0 9 * * 1-5", /five fields/],
  ])("skips %s", async (_name, expression, detail) => {
    const bad: Routine = { ...CRON, name: "Bad", schedule: { kind: "cron", expression } };
    const { items } = await writeHermesProfile(ctx, ada({ routines: [bad, EVERY] }), opts());
    expect(items.skipped).toEqual([{ field: "routine:Bad", detail: expect.stringMatching(detail) }]);
    expect((await readJobs()).jobs.map((job) => job.name)).toEqual(["Inbox sweep"]);
  });

  it("writes a cron expression unchanged and notes a time zone other than the profile's", async () => {
    const elsewhere: Routine = { ...CRON, name: "New York", timezone: "America/New_York" };
    const { items } = await writeHermesProfile(
      ctx,
      ada({ routines: [elsewhere, { ...EVERY, timezone: "America/New_York" }, { ...AT, timezone: "Asia/Tokyo" }] }),
      opts(),
    );
    const { jobs } = await readJobs();
    expect(jobs[0]?.schedule).toMatchObject({ kind: "cron", expr: "0 9 * * 1-5" });
    // An interval and a point in time mean the same in every zone.
    expect(items.approximated).toEqual([
      expect.objectContaining({ field: "instructions" }),
      {
        field: "routine:New York",
        detail:
          "Hermes has one time zone per profile; this routine assumed Europe/Warsaw instead of America/New_York",
      },
    ]);
  });

  it("takes the time zone of the profile from the environment", async () => {
    const newYork: Routine = { ...CRON, timezone: "America/New_York" };
    const env = { HERMES_HOME: hermes, HERMES_TIMEZONE: "America/New_York" };
    const { items } = await writeHermesProfile({ ...ctx, env }, ada({ routines: [newYork] }), opts());
    expect(items.approximated.filter((item) => item.field.startsWith("routine:"))).toEqual([]);
  });

  it("takes it from the config.yaml of a profile that is already there when the environment has none", async () => {
    await writeHermesProfile(ctx, ada({ routines: [] }), opts());
    await writeFile(join(profile(), "config.yaml"), "timezone: America/New_York\n");
    const env = { HERMES_HOME: hermes };
    const routines = [CRON, { ...CRON, name: "New York", timezone: "America/New_York" }];
    const { items } = await writeHermesProfile({ ...ctx, env }, ada({ routines }), opts());
    expect(items.approximated.filter((item) => item.field.startsWith("routine:"))).toEqual([
      {
        field: "routine:Morning digest",
        detail:
          "Hermes has one time zone per profile; this routine assumed America/New_York instead of Europe/Warsaw",
      },
    ]);
  });

  it("leaves the jobs of another person where they are and backs the file up", async () => {
    await writeHermesProfile(ctx, ada({ routines: [] }), opts());
    const foreign = { id: "ffffffffffff", name: "Theirs", prompt: "Mine.", schedule: { kind: "weird" }, extra: [1] };
    const half = { id: "x", name: null };
    const original = JSON.stringify({ jobs: [foreign, half], custom: { keep: true } });
    await mkdir(join(profile(), "cron"));
    await writeFile(join(profile(), "cron", "jobs.json"), original);

    await writeHermesProfile(ctx, ada({ routines: [CRON] }), opts());

    const written = await readJobs();
    expect(written.custom).toEqual({ keep: true });
    expect(written.jobs).toHaveLength(3);
    // What was there keeps its order; the new job comes after it.
    expect(written.jobs[0]).toEqual(foreign);
    expect(written.jobs[1]).toEqual(half);
    expect(written.jobs[2]?.name).toBe("Morning digest");
    const backups = (await readdir(join(profile(), "cron"))).filter((name) => name.includes(".bak-"));
    expect(backups).toHaveLength(1);
    expect(await text(join(profile(), "cron", backups[0] as string))).toBe(original);
  });

  it("skips every routine, and leaves the file as it is, when jobs.json is not JSON", async () => {
    await writeHermesProfile(ctx, ada(), opts());
    const ids = (await readMarker()).cronJobIds;
    await writeFile(join(profile(), "cron", "jobs.json"), "{ not json");

    const { items } = await writeHermesProfile(ctx, ada(), opts());

    expect(items.skipped.map((item) => item.field)).toEqual([
      "routine:Morning digest",
      "routine:Inbox sweep",
      "routine:Renew the domain",
    ]);
    expect(items.skipped[0]?.detail).toMatch(/is not valid JSON.*not written/);
    // The jobs written the first time are still there, and the report says so.
    expect(items.warnings.some((w) => /earlier were left as they are/.test(w))).toBe(true);
    expect(await text(join(profile(), "cron", "jobs.json"))).toBe("{ not json");
    expect((await readMarker()).cronJobIds).toEqual(ids);
  });

  it("skips every routine when cron is a link", async (task) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(profile(), { recursive: true });
    await writeFile(join(profile(), "SOUL.md"), "mine");
    await link(outside, join(profile(), "cron"), "junction", () => task.skip());
    await writeFile(join(profile(), ".openteleport.json"), JSON.stringify({ id: ADA_ID, movedAt: "x" }));

    const { items } = await writeHermesProfile(ctx, ada(), opts());

    expect(items.skipped.map((item) => item.field)).toEqual([
      "routine:Morning digest",
      "routine:Inbox sweep",
      "routine:Renew the domain",
    ]);
    expect(items.skipped[0]?.detail).toMatch(/cron is a symbolic link/);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("the memory", () => {
  const fact = (n: number): string => `${String(n).padStart(2, "0")}${"x".repeat(198)}`;

  it("keeps to the limit of 2200 characters of the whole file and skips the rest", async () => {
    const facts = Array.from({ length: 20 }, (_unused, index) => fact(index + 1));
    const { items } = await writeHermesProfile(ctx, ada({ facts }), opts());

    const written = parseEntries(await text(join(profile(), "memories", "MEMORY.md")));
    expect(written).toEqual(facts.slice(0, 10));
    expect(renderEntries(written).length).toBeLessThanOrEqual(2200);
    expect(items.skipped).toHaveLength(10);
    expect(items.skipped[0]).toEqual({
      field: "fact:11",
      detail: `${fact(11).slice(0, 60)}… (Hermes memory limit: 2200 chars)`,
    });
    expect(items.skipped.map((item) => item.field)).toEqual(
      Array.from({ length: 10 }, (_unused, index) => `fact:${index + 11}`),
    );
    expect((await readMarker()).memoryEntries).toEqual(facts.slice(0, 10));
  });

  it("counts the entries that are already there, and takes the limit from the profile's config", async () => {
    await writeHermesProfile(ctx, ada({ facts: [] }), opts());
    await writeFile(join(profile(), "config.yaml"), "memory:\n  memory_char_limit: 300\n");
    await mkdir(join(profile(), "memories"));
    await writeFile(join(profile(), "memories", "MEMORY.md"), renderEntries(["Theirs."]));

    const { items } = await writeHermesProfile(
      ctx,
      ada({ facts: ["a".repeat(120), "b".repeat(120), "c".repeat(120)] }),
      opts(),
    );

    // 7 + 3 + 120 + 3 + 120 = 253; a third entry would make 376.
    expect(parseEntries(await text(join(profile(), "memories", "MEMORY.md")))).toEqual([
      "Theirs.",
      "a".repeat(120),
      "b".repeat(120),
    ]);
    expect(items.skipped).toEqual([
      { field: "fact:3", detail: `${"c".repeat(60)}… (Hermes memory limit: 300 chars)` },
    ]);
  });

  it("skips a fact that could never fit, and one that is blank, and goes on", async () => {
    const { items } = await writeHermesProfile(
      ctx,
      ada({ facts: ["  ", "x".repeat(2300), "fits"] }),
      opts(),
    );
    expect(items.skipped.map((item) => item.field)).toEqual(["fact:1", "fact:2"]);
    expect(items.skipped[0]?.detail).toBe("… (empty)");
    expect(parseEntries(await text(join(profile(), "memories", "MEMORY.md")))).toEqual(["fits"]);
  });

  it("does not repeat a fact the file already holds, or one the Bundle repeats", async () => {
    await writeHermesProfile(ctx, ada({ facts: [] }), opts());
    await mkdir(join(profile(), "memories"));
    await writeFile(join(profile(), "memories", "MEMORY.md"), renderEntries(["Known.", "Other."]));

    const { items } = await writeHermesProfile(ctx, ada({ facts: ["Known.", "New.", "New."] }), opts());

    expect(parseEntries(await text(join(profile(), "memories", "MEMORY.md")))).toEqual([
      "Known.",
      "Other.",
      "New.",
    ]);
    expect(items.skipped).toEqual([]);
    expect((await readMarker()).memoryEntries).toEqual(["New."]);
  });

  it("writes a fact with a line of its own that is only a section sign as one entry", async () => {
    await writeHermesProfile(ctx, ada({ facts: ["before\n§\nafter", "next"] }), opts());
    expect(parseEntries(await text(join(profile(), "memories", "MEMORY.md")))).toEqual([
      "before\nafter",
      "next",
    ]);
  });

  it("skips the facts when MEMORY.md is a link", async (task) => {
    await writeHermesProfile(ctx, ada({ facts: [] }), opts());
    const target = join(root, "elsewhere.md");
    await writeFile(target, "outside");
    await mkdir(join(profile(), "memories"));
    await link(target, join(profile(), "memories", "MEMORY.md"), "file", () => task.skip());

    const { items } = await writeHermesProfile(ctx, ada(), opts());

    expect(items.skipped).toContainEqual({
      field: "memory.facts",
      detail: expect.stringMatching(/MEMORY\.md is a symbolic link; not written/),
    });
    expect(await text(target)).toBe("outside");
  });
});

describe("an agent that is already there", () => {
  async function firstWrite(bundle: Bundle = ada()): Promise<void> {
    await writeHermesProfile(ctx, bundle, opts());
  }

  it("is updated in place, replacing what OpenTeleport wrote and keeping the rest", async () => {
    await firstWrite();
    const first = await readJobs();
    const firstIds = first.jobs.map((job) => job.id);
    const config = await text(join(profile(), "config.yaml"));

    // What the user and Hermes did in the meantime.
    const memoryFile = join(profile(), "memories", "MEMORY.md");
    await writeFile(memoryFile, `${await text(memoryFile)}\n§\nLearned later.`);
    const foreign = { id: "ffffffffffff", name: "Theirs", prompt: "Mine.", schedule: { kind: "interval", minutes: 5 } };
    await writeFile(
      join(profile(), "cron", "jobs.json"),
      JSON.stringify({ ...first, jobs: [...first.jobs, foreign], custom: 1 }),
    );
    await mkdir(join(profile(), "skills", "mine"));
    await writeFile(join(profile(), "skills", "mine", "SKILL.md"), "theirs");
    await writeFile(join(profile(), "profile.yaml"), 'display_name: "Ada, edited"\n');

    const second = ada({
      facts: ["Only two now.", "Second fact."],
      skills: [skillOf("web-brief", "Brief the web better.\n"), skillOf("notes")],
      routines: [
        { ...CRON, instruction: "Summarise again." },
        { ...EVERY, instruction: "Sort again." },
        { ...AT, instruction: "Remind again." },
      ],
    });
    const result = await writeHermesProfile(ctx, second, opts());

    expect(result.targetAgentId).toBe("ada");
    expect(await readdir(join(hermes, "profiles"))).toEqual(["ada"]);
    expect(result.items.warnings).toEqual([RESTART_WARNING, SCANNER_WARNING]);
    expect(result.items.approximated).toContainEqual({
      field: "models",
      detail: "kept the profile's own model",
    });
    expect(await text(join(profile(), "config.yaml"))).toBe(config);
    expect(await text(join(profile(), "profile.yaml"))).toBe('display_name: "Ada, edited"\n');

    // Memory: the old entries of ours are replaced, the one Hermes learned stays.
    expect(parseEntries(await text(memoryFile))).toEqual(["Learned later.", "Only two now.", "Second fact."]);

    // Jobs: three new ones in place of the three old, the foreign one and the other keys stay.
    const jobs = await readJobs();
    expect(jobs.custom).toBe(1);
    expect(jobs.jobs[0]).toEqual(foreign);
    expect(jobs.jobs.slice(1).map((job) => job.prompt)).toEqual([
      "Summarise again.",
      "Sort again.",
      "Remind again.",
    ]);
    expect(jobs.jobs.slice(1).some((job) => firstIds.includes(job.id))).toBe(false);
    expect(jobs.jobs).toHaveLength(4);
    const backups = (await readdir(join(profile(), "cron"))).filter((name) => name.includes(".bak-"));
    expect(backups).toHaveLength(1);

    // Skills: ours written over in place (the stale file gone), the foreign one untouched.
    expect(await text(join(profile(), "skills", "web-brief", "SKILL.md"))).toContain("better");
    expect(await exists(join(profile(), "skills", "web-brief", "references", "api.md"))).toBe(false);
    expect(await exists(join(profile(), "skills", "web-brief", "references"))).toBe(false);
    expect((await readdir(join(profile(), "skills"))).sort()).toEqual(["mine", "notes", "web-brief"]);
    expect(await text(join(profile(), "skills", "mine", "SKILL.md"))).toBe("theirs");

    expect(await readMarker()).toEqual({
      id: ADA_ID,
      movedAt: expect.any(String),
      cronJobIds: jobs.jobs.slice(1).map((job) => job.id),
      memoryEntries: ["Only two now.", "Second fact."],
      skills: {
        "web-brief": skillDigest(second.skills[0] as Skill),
        notes: skillDigest(second.skills[1] as Skill),
      },
    });
  });

  it("removes what it wrote when the Bundle no longer has it", async () => {
    await firstWrite();
    await writeHermesProfile(ctx, ada({ facts: [], routines: [] }), opts());
    expect(await text(join(profile(), "memories", "MEMORY.md"))).toBe("");
    expect((await readJobs()).jobs).toEqual([]);
    expect(await readMarker()).toMatchObject({ cronJobIds: [], memoryEntries: [] });
  });

  it("leaves a skill the user changed, and writes the new one next to it as <name>-2", async () => {
    await firstWrite();
    const edited = join(profile(), "skills", "web-brief", "SKILL.md");
    await writeFile(edited, "the user's own version");

    const second = ada({ skills: [skillOf("web-brief", "Version two.\n"), skillOf("notes")] });
    const { items } = await writeHermesProfile(ctx, second, opts());

    expect(await text(edited)).toBe("the user's own version");
    expect(await text(join(profile(), "skills", "web-brief-2", "SKILL.md"))).toContain("Version two.");
    expect(items.warnings).toContain(
      "skill 'web-brief' already exists with different content; written as 'web-brief-2'",
    );
    const marker = await readMarker();
    expect(marker.skills).toMatchObject({
      "web-brief-2": skillDigest(second.skills[0] as Skill),
    });

    // The next move updates that copy in place instead of starting a third.
    const third = ada({ skills: [skillOf("web-brief", "Version three.\n"), skillOf("notes")] });
    await writeHermesProfile(ctx, third, opts());
    expect(await text(join(profile(), "skills", "web-brief-2", "SKILL.md"))).toContain("Version three.");
    expect(await exists(join(profile(), "skills", "web-brief-3", "SKILL.md"))).toBe(false);
    expect(await text(edited)).toBe("the user's own version");
  });

  it("leaves a skill that has a file the user added, since that folder is no longer ours", async () => {
    await firstWrite();
    await writeFile(join(profile(), "skills", "notes", "extra.md"), "added by the user");
    const second = ada({ skills: [skillOf("notes", "Changed.\n")] });
    await writeHermesProfile(ctx, second, opts());
    expect(await text(join(profile(), "skills", "notes", "extra.md"))).toBe("added by the user");
    expect(await exists(join(profile(), "skills", "notes-2", "SKILL.md"))).toBe(true);
  });

  it("reuses a skill that is already there with the same content", async () => {
    await mkdir(join(profile(), "skills"), { recursive: true });
    const same = skillOf("notes");
    await mkdir(join(profile(), "skills", "notes"));
    await writeFile(join(profile(), "skills", "notes", "SKILL.md"), same.files[0]?.bytes as Uint8Array);
    await writeFile(join(profile(), ".openteleport.json"), JSON.stringify({ id: ADA_ID, movedAt: "x" }));
    await writeHermesProfile(ctx, ada({ skills: [same] }), opts());
    expect(await readdir(join(profile(), "skills"))).toEqual(["notes"]);
    // It was not ours to begin with, so a later move does not own it either.
    expect((await readMarker()).skills).toEqual({});
  });

  it("is not touched by another agent of the same name, which goes to <slug>-2", async () => {
    await mkdir(profile(), { recursive: true });
    await writeFile(join(profile(), "SOUL.md"), "someone else's soul");

    const first = await writeHermesProfile(ctx, ada(), opts());
    expect(first.targetAgentId).toBe("ada-2");
    expect(first.items.warnings).toContain("profile 'ada' already exists; written as 'ada-2'");
    expect(await text(join(profile(), "SOUL.md"))).toBe("someone else's soul");
    expect(await readdir(profile())).toEqual(["SOUL.md"]);

    // A second move of the same agent updates the copy it made.
    const second = await writeHermesProfile(ctx, ada({ facts: ["Two."] }), opts());
    expect(second.targetAgentId).toBe("ada-2");
    expect(await readdir(join(hermes, "profiles"))).toEqual(["ada", "ada-2"]);
    expect(parseEntries(await text(join(profile("ada-2"), "memories", "MEMORY.md")))).toEqual(["Two."]);
  });

  it("is not touched by a profile that carries the marker of another agent", async () => {
    await firstWrite();
    const result = await writeHermesProfile(ctx, ada({ manifest: { id: OTHER_ID } }), opts());
    expect(result.targetAgentId).toBe("ada-2");
    expect(await readMarker(profile())).toMatchObject({ id: ADA_ID });
    expect(await readMarker(profile("ada-2"))).toMatchObject({ id: OTHER_ID });
  });

  it("is never taken for the same agent when the Bundle has no id", async () => {
    await firstWrite();
    const result = await writeHermesProfile(ctx, ada({ manifest: { id: "" } }), opts());
    expect(result.targetAgentId).toBe("ada-2");
  });

  it("goes to the next free name with copy, every time", async () => {
    await firstWrite();
    const second = await writeHermesProfile(ctx, ada(), opts({ onConflict: "copy" }));
    const third = await writeHermesProfile(ctx, ada(), opts({ onConflict: "copy" }));
    expect([second.targetAgentId, third.targetAgentId]).toEqual(["ada-2", "ada-3"]);
    expect(second.items.warnings).not.toContainEqual(expect.stringContaining("already exists"));
  });

  it("is not written through a link, and goes to <slug>-2", async (task) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await mkdir(join(hermes, "profiles"));
    await link(outside, profile(), "junction", () => task.skip());

    const result = await writeHermesProfile(ctx, ada(), opts());

    expect(result.targetAgentId).toBe("ada-2");
    expect(result.items.warnings.some((warning) => /ada.*symlink/.test(warning))).toBe(true);
    expect(await readdir(outside)).toEqual([]);
    expect(await exists(join(profile("ada-2"), "SOUL.md"))).toBe(true);
  });

  it("is replaced whole when it carries a marker, even another agent's", async () => {
    await firstWrite();
    await writeFile(join(profile(), "junk.txt"), "left over");
    await writeFile(join(profile(), "memories", "USER.md"), "learned");

    const result = await writeHermesProfile(
      ctx,
      ada({ manifest: { id: OTHER_ID }, facts: ["Fresh."] }),
      opts({ onConflict: "replace" }),
    );

    expect(result.targetAgentId).toBe("ada");
    expect(await readdir(join(hermes, "profiles"))).toEqual(["ada"]);
    expect(await exists(join(profile(), "junk.txt"))).toBe(false);
    expect(await exists(join(profile(), "memories", "USER.md"))).toBe(false);
    expect(parseEntries(await text(join(profile(), "memories", "MEMORY.md")))).toEqual(["Fresh."]);
    expect(await readMarker()).toMatchObject({ id: OTHER_ID, memoryEntries: ["Fresh."] });
  });

  it("is written as a new profile with replace when nothing is there", async () => {
    const result = await writeHermesProfile(ctx, ada(), opts({ onConflict: "replace" }));
    expect(result.targetAgentId).toBe("ada");
    expect(await exists(join(profile(), "SOUL.md"))).toBe(true);
  });

  it("is not replaced without a marker, since OpenTeleport did not write it", async () => {
    await mkdir(profile(), { recursive: true });
    await writeFile(join(profile(), "SOUL.md"), "mine");
    await expect(writeHermesProfile(ctx, ada(), opts({ onConflict: "replace" }))).rejects.toThrow(
      /Refusing to replace .*ada/,
    );
    expect(await text(join(profile(), "SOUL.md"))).toBe("mine");
  });

  it("is not replaced when it is a link", async (task) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "SOUL.md"), "mine");
    await mkdir(join(hermes, "profiles"));
    await link(outside, profile(), "junction", () => task.skip());
    await expect(writeHermesProfile(ctx, ada(), opts({ onConflict: "replace" }))).rejects.toThrow(
      /Refusing to replace .*symbolic link/,
    );
    expect(await text(join(outside, "SOUL.md"))).toBe("mine");
  });

  it("takes an empty folder of the name as free", async () => {
    await mkdir(profile(), { recursive: true });
    expect((await writeHermesProfile(ctx, ada(), opts())).targetAgentId).toBe("ada");
  });

  it("reports SOUL.md as skipped, and does not write through it, when it is a link", async (task) => {
    await firstWrite();
    const target = join(root, "soul.md");
    await writeFile(target, "outside");
    await rm(join(profile(), "SOUL.md"));
    await link(target, join(profile(), "SOUL.md"), "file", () => task.skip());

    const { items } = await writeHermesProfile(ctx, ada(), opts());

    expect(items.skipped.map((item) => item.field)).toEqual(["persona", "instructions"]);
    expect(items.skipped[0]?.detail).toMatch(/SOUL\.md is a symbolic link; not written/);
    expect(await text(target)).toBe("outside");
  });

  it("skips the skills when skills is a link", async (task) => {
    await mkdir(profile(), { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    await link(outside, join(profile(), "skills"), "junction", () => task.skip());
    await writeFile(join(profile(), ".openteleport.json"), JSON.stringify({ id: ADA_ID, movedAt: "x" }));

    const { items } = await writeHermesProfile(ctx, ada(), opts());

    expect(items.skipped.map((item) => item.field)).toEqual(["skill:web-brief", "skill:notes"]);
    expect(items.skipped[0]?.detail).toMatch(/skills is a symbolic link/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("skips a skill whose name or file paths are not safe to write", async () => {
    const bad: Skill = { name: "../escape", files: [{ path: "SKILL.md", bytes: Buffer.from("x") }] };
    const hidden: Skill = { name: ".hub", files: [{ path: "SKILL.md", bytes: Buffer.from("x") }] };
    const odd: Skill = { name: "odd", files: [{ path: "../SKILL.md", bytes: Buffer.from("x") }] };
    const { items } = await writeHermesProfile(ctx, ada({ skills: [bad, hidden, odd, skillOf("ok")] }), opts());
    expect(items.skipped.map((item) => item.field)).toEqual([
      "skill:../escape",
      "skill:.hub",
      "skill:odd",
    ]);
    expect(await readdir(join(profile(), "skills"))).toEqual(["ok"]);
  });
});

describe("hermesAdapter", () => {
  it("is named and declared as the spec says", () => {
    expect(hermesAdapter.name).toBe("hermes");
    expect(hermesAdapter.displayName).toBe("Hermes Agent");
    expect(hermesAdapter.createsOnWrite).toBe(false);
    expect(hermesAdapter.capabilities).toEqual({
      persona: true,
      instructions: true,
      skills: true,
      routines: true,
      facts: true,
      notes: false,
      files: false,
      avatar: false,
      models: true,
      schedules: ["cron", "every", "at"],
    });
    expect(typeof hermesAdapter.cacheIdentity).toBe("function");
  });

  it("is found where the home holds a profile file, and not in an empty directory", async () => {
    expect(await hermesAdapter.detect(ctx)).toEqual({ found: true, location: hermes });
    const empty = join(root, "empty");
    await mkdir(empty);
    expect(await hermesAdapter.detect({ ...ctx, targetDir: empty })).toEqual({
      found: false,
      location: empty,
      hint: "Install Hermes Agent or pass --source-dir <HERMES_HOME>",
    });
  });

  it("writes what it lists and reads back", async () => {
    await hermesAdapter.write(ctx, ada(), opts());
    expect((await hermesAdapter.list(ctx)).map((ref) => ref.id)).toEqual(["default", "ada"]);
    const { bundle } = await hermesAdapter.read(ctx, "ada");
    expect(bundle.manifest.id).toBe(ADA_ID);
    expect(bundle.persona).toBe("Calm and curious.");
    expect(bundle.instructions).toBe("Answer briefly.");
    expect(bundle.facts).toEqual(FACTS);
    expect(bundle.skills.map((skill) => skill.name).sort()).toEqual(["notes", "web-brief"]);
    expect(bundle.routines.map((routine) => routine.name)).toEqual([
      "Morning digest",
      "Inbox sweep",
      "Renew the domain",
    ]);
    // Written paused, so read back as not enabled.
    expect(bundle.routines.every((routine) => !routine.enabled)).toBe(true);
  });
});

describe("openteleport move --to hermes", () => {
  it("moves a folder agent into a named profile and ends with done", async () => {
    const box = await sandbox();
    try {
      const home = join(box.home, ".hermes");
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "config.yaml"), "memory:\n  memory_char_limit: 2200\n");

      const result = await run(box, [
        "move",
        "--from",
        "folder",
        "--source-dir",
        ADA_DIR,
        "--agent",
        "Ada",
        "--to",
        "hermes",
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const report = json<MoveReport>(result);
      expect(report).toMatchObject({
        source: { app: "folder" },
        target: { app: "hermes", agent: "ada" },
        outcome: "done",
      });
      expect(report.warnings).toContain(RESTART_WARNING);
      expect(await exists(join(home, "profiles", "ada", "SOUL.md"))).toBe(true);
      expect(await exists(join(home, "profiles", "ada", ".openteleport.json"))).toBe(true);
      expect((await readJobs(join(home, "profiles", "ada"))).jobs.every((job) => job.enabled === false)).toBe(
        true,
      );
    } finally {
      await box.cleanup();
    }
  });

  it("prints the report, ending in done, and updates the profile in place the second time", async () => {
    const box = await sandbox();
    try {
      const home = join(box.home, ".hermes");
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "config.yaml"), "memory:\n  memory_char_limit: 2200\n");
      const args = ["move", "--from", "folder", "--source-dir", ADA_DIR, "--agent", "Ada", "--to", "hermes"];

      const first = await run(box, args);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("Target: hermes / ada");
      expect(first.stdout).toContain("Outcome: done");
      expect(first.stdout).toContain("Restart the Hermes gateway");

      const second = await run(box, args);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("Target: hermes / ada");
      expect(await readdir(join(home, "profiles"))).toEqual(["ada"]);
    } finally {
      await box.cleanup();
    }
  });

  it("ends with exit code 3 and the hint when Hermes is not there", async () => {
    const box = await sandbox();
    try {
      const result = await run(box, [
        "move",
        "--from",
        "folder",
        "--source-dir",
        ADA_DIR,
        "--agent",
        "Ada",
        "--to",
        "hermes",
      ]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("Hermes Agent was not detected");
      expect(result.stderr).toContain("pass --source-dir <HERMES_HOME>");
    } finally {
      await box.cleanup();
    }
  });
});
