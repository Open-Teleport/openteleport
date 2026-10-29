import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hermesCacheIdentity,
  listHermesProfiles,
  readHermesProfile,
} from "../../../src/adapters/hermes/read.js";
import { folderAdapter } from "../../../src/adapters/folder/index.js";
import { hermesAdapter } from "../../../src/adapters/hermes/index.js";
import type { Ctx } from "../../../src/adapters/types.js";
import { move } from "../../../src/core/engine.js";
import { machineTimezone } from "../../../src/adapters/hermes/paths.js";
import { zonedToInstant } from "../../../src/core/schedule.js";
import { RoutineSchema, parseManifest } from "../../../src/core/schema.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/hermes/home", import.meta.url));
const ULID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let root: string;
let hermes: string;
let ctx: Ctx;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-hermes-read-"));
  hermes = join(root, "hermes");
  await cp(FIXTURE, hermes, { recursive: true });
  ctx = {
    home: join(root, "home"),
    cwd: root,
    env: { HERMES_HOME: hermes },
    exec: noExec,
    logger: () => {},
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file and directory below `dir`, with a hash of each file, keyed by relative path. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const key = relative(dir, path).split("\\").join("/");
    out[key] = entry.isFile()
      ? createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
      : "<directory>";
  }
  return out;
}

/** Fixtures may be checked out with CRLF line endings on Windows. */
const lf = (text: string | undefined): string | undefined => text?.replace(/\r\n/g, "\n");

const put = async (path: string, text: string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
};

const skill = (name: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n\n# ${name}\n`;

describe("listHermesProfiles", () => {
  it("lists the default profile and the named ones", async () => {
    expect(await listHermesProfiles(ctx)).toEqual([
      { id: "default", name: "Main", location: hermes },
      {
        id: "reviewer",
        name: "Reviewer",
        title: "Reviews PRs",
        location: join(hermes, "profiles", "reviewer"),
      },
    ]);
  });

  it("names a profile after its id when profile.yaml gives no name or cannot be read", async () => {
    await writeFile(join(hermes, "profile.yaml"), "a: [1\n");
    await rm(join(hermes, "profiles", "reviewer", "profile.yaml"));
    expect((await listHermesProfiles(ctx)).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "default", name: "default" },
      { id: "reviewer", name: "reviewer" },
    ]);
  });

  it("leaves out the default profile when the home holds none of the profile files", async () => {
    for (const name of ["SOUL.md", "config.yaml", "profile.yaml"]) await rm(join(hermes, name));
    expect((await listHermesProfiles(ctx)).map(({ id }) => id)).toEqual(["reviewer"]);
  });

  it("leaves out directories that are not profiles or not named as Hermes names them", async () => {
    await mkdir(join(hermes, "profiles", "empty"));
    await put(join(hermes, "profiles", "Upper", "SOUL.md"), "x");
    await put(join(hermes, "profiles", ".deleted", "old", "SOUL.md"), "x");
    await put(join(hermes, "profiles", "file.md"), "x");
    await put(join(hermes, "profiles", "second", "state.db"), "");
    expect((await listHermesProfiles(ctx)).map(({ id }) => id)).toEqual([
      "default",
      "reviewer",
      "second",
    ]);
  });

  it("lists nothing for a home that does not exist", async () => {
    await rm(hermes, { recursive: true });
    expect(await listHermesProfiles(ctx)).toEqual([]);
  });

  it("takes the home from --source-dir before HERMES_HOME", async () => {
    const other = join(root, "other");
    await put(join(other, "SOUL.md"), "Other.");
    const refs = await listHermesProfiles({ ...ctx, sourceDir: other });
    expect(refs).toEqual([{ id: "default", name: "default", location: other }]);
  });
});

describe("readHermesProfile", () => {
  it("reads the default profile of the fixture", async () => {
    const { bundle, warnings } = await readHermesProfile(ctx, "default");

    expect(lf(bundle.persona)).toBe(lf(await readFile(join(FIXTURE, "SOUL.md"), "utf8")));
    expect(bundle.instructions).toBe("");
    expect(bundle.facts).toEqual([
      "The user prefers short answers and plain words.",
      "Deployments happen on Tuesdays. Never deploy on Fridays.",
      "Name: Ada. Works in Europe/Warsaw.",
    ]);
    expect(bundle.notes).toHaveLength(1);
    expect(bundle.notes[0]?.name).toBe("memory-3");
    expect(bundle.notes[0]?.text).toHaveLength(700);

    expect(bundle.routines).toEqual([
      {
        name: "Morning digest",
        instruction: "Summarise the overnight GitHub notifications and list what needs a reply.",
        enabled: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "cron", expression: "0 9 * * 1-5" },
      },
      {
        name: "Inbox sweep",
        instruction: "Sort the inbox into reply, read later and archive.",
        enabled: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "every", every: "2h" },
      },
      {
        name: "Renew the domain",
        instruction: "Remind me to renew the domain before it lapses.",
        enabled: true,
        timezone: "Europe/Warsaw",
        // The fixture's `run_at` has no offset: Hermes reads it in the zone of the machine.
        schedule: { kind: "at", at: zonedToInstant("2026-12-01T08:00:00", machineTimezone()) },
      },
    ]);

    // Without the skill that ships with Hermes (`triage`) and the state of the skills hub.
    expect(bundle.skills.map((entry) => entry.name)).toEqual(["old", "release-notes"]);
    const notes = bundle.skills.find((entry) => entry.name === "release-notes");
    expect(notes?.files.map((file) => file.path)).toEqual(["SKILL.md", "references/style.md"]);
    expect(Buffer.from(notes?.files[0]?.bytes ?? []).toString("utf8")).toBe(
      await readFile(join(FIXTURE, "skills", "writing", "release-notes", "SKILL.md"), "utf8"),
    );

    expect(bundle.manifest.models).toEqual([
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-5" },
    ]);
    expect(bundle.manifest).toMatchObject({
      schemaVersion: "0.1",
      id: "",
      name: "Main",
      capabilities: [],
      origin: { app: "hermes" },
      "x-hermes": {
        profile: "default",
        timezone: "Europe/Warsaw",
        routines: { "Inbox sweep": { deliver: "telegram", workdir: "/home/ada/inbox" } },
      },
    });
    expect(bundle.manifest.title).toBeUndefined();
    expect(bundle.files).toEqual([]);
    expect(bundle.avatar).toBeUndefined();

    expect(warnings).toContain("1 bundled Hermes skill left behind");
    expect(warnings).toContain(
      "1 memory entry over 500 characters was kept as the note memory-3",
    );
    expect(warnings).toContain("1 memory entry had line breaks folded into one line");
    expect(warnings).toContain(
      "cron job 'Renew the domain' has a one-off time without an offset; " +
        `read in this machine's time zone (${machineTimezone()}), as Hermes does`,
    );
    expect(warnings).toHaveLength(4);
  });

  it("reads a Bundle that the manifest and routine schemas accept", async () => {
    const { bundle } = await readHermesProfile(ctx, "default");
    expect(() => parseManifest({ ...bundle.manifest, id: ULID })).not.toThrow();
    for (const routine of bundle.routines) expect(() => RoutineSchema.parse(routine)).not.toThrow();
  });

  it("splits SOUL.md in the layout of mergeInstructions into persona and instructions", async () => {
    const { bundle, warnings } = await readHermesProfile(ctx, "reviewer");
    expect(bundle.persona).toBe("Terse, fair and never rude.");
    expect(bundle.instructions).toBe("Read the diff first. Flag risks, then style.");
    expect(bundle.routines).toEqual([]);
    expect(bundle.skills).toEqual([]);
    expect(bundle.facts).toEqual([]);
    expect(bundle.manifest).toMatchObject({
      name: "Reviewer",
      title: "Reviews PRs",
      models: [],
      "x-hermes": { profile: "reviewer", routines: {} },
    });
    expect(bundle.manifest["x-hermes"]).not.toHaveProperty("timezone");
    expect(warnings).toEqual([]);
  });

  it("reads SOUL.md without the layout as the persona alone", async () => {
    await writeFile(join(hermes, "profiles", "reviewer", "SOUL.md"), "# Persona notes\n\nCalm.\n");
    const { bundle } = await readHermesProfile(ctx, "reviewer");
    expect(lf(bundle.persona)).toBe("# Persona notes\n\nCalm.\n");
    expect(bundle.instructions).toBe("");
  });

  it("reads a layout with an empty persona as instructions only", async () => {
    await writeFile(
      join(hermes, "profiles", "reviewer", "SOUL.md"),
      "# Persona\n\n# Instructions\n\nDo it.\n",
    );
    const { bundle } = await readHermesProfile(ctx, "reviewer");
    expect(bundle.persona).toBeUndefined();
    expect(bundle.instructions).toBe("Do it.");
  });

  it("takes the instructions from agent.system_prompt when SOUL.md has no section for them", async () => {
    await writeFile(
      join(hermes, "config.yaml"),
      `${await readFile(join(hermes, "config.yaml"), "utf8")}agent:\n  system_prompt: Be brief.\n`,
    );
    const { bundle } = await readHermesProfile(ctx, "default");
    expect(bundle.instructions).toBe("Be brief.");
    expect(bundle.persona).toContain("You are Main");

    await writeFile(join(hermes, "SOUL.md"), "# Persona\n\nCalm.\n\n# Instructions\n\nFrom SOUL.\n");
    expect((await readHermesProfile(ctx, "default")).bundle.instructions).toBe("From SOUL.");
  });

  it("keeps a byte order mark out of the persona", async () => {
    await writeFile(join(hermes, "SOUL.md"), "\uFEFFHello there.");
    expect((await readHermesProfile(ctx, "default")).bundle.persona).toBe("Hello there.");
  });

  it("has no persona without SOUL.md or with a blank one", async () => {
    await rm(join(hermes, "SOUL.md"));
    expect((await readHermesProfile(ctx, "default")).bundle.persona).toBeUndefined();
    await writeFile(join(hermes, "SOUL.md"), " \n");
    expect((await readHermesProfile(ctx, "default")).bundle.persona).toBeUndefined();
  });

  it("skips a text file over 2 MiB with a warning", async () => {
    await writeFile(join(hermes, "SOUL.md"), "x".repeat(2 * 1024 * 1024 + 1));
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.persona).toBeUndefined();
    expect(warnings).toContain("SOUL.md is over 2 MiB; not exported");
  });

  it("names the profiles there are when the agent is not one", async () => {
    await expect(readHermesProfile(ctx, "nope")).rejects.toThrow(
      'Hermes has no profile "nope". Available: default, reviewer',
    );
  });

  it("finds only listed profiles, so an id cannot reach outside profiles/", async () => {
    for (const agent of ["../hermes", "profiles/reviewer", "..", ".", ""]) {
      await expect(readHermesProfile(ctx, agent)).rejects.toThrow(/Hermes has no profile/);
    }
  });

  it("says so when the home holds no profile at all", async () => {
    await rm(hermes, { recursive: true });
    await expect(readHermesProfile(ctx, "default")).rejects.toThrow(
      `Hermes has no profile "default": there are no profiles in ${hermes}`,
    );
  });

  it("warns about a cron/jobs.json that is not JSON and reads the rest", async () => {
    await writeFile(join(hermes, "cron", "jobs.json"), "{ not json");
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.routines).toEqual([]);
    expect(bundle.manifest["x-hermes"]).toMatchObject({ routines: {} });
    expect(bundle.facts).toHaveLength(3);
    expect(bundle.skills).toHaveLength(2);
    expect(warnings.some((w) => /cron[\\/]jobs\.json is not valid JSON.*no routines exported/.test(w))).toBe(
      true,
    );
  });

  it("warns about jobs it cannot read and entries that are not jobs", async () => {
    const jobs = JSON.parse(await readFile(join(hermes, "cron", "jobs.json"), "utf8")) as {
      jobs: Record<string, unknown>[];
    };
    jobs.jobs.push(
      { id: "d4e5f6a1b2c3", name: "Weird", prompt: "x", schedule: { kind: "weird" } },
      { id: "e5f6a1b2c3d4", name: "Morning digest", prompt: "again", schedule: { kind: "cron", expr: "5 5 * * *" } },
      { id: "f6a1b2c3d4e5", name: null, prompt: "no name", schedule: {} },
    );
    await writeFile(join(hermes, "cron", "jobs.json"), JSON.stringify(jobs));
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.routines.map((routine) => routine.name)).toEqual([
      "Morning digest",
      "Inbox sweep",
      "Renew the domain",
      "Morning digest (2)",
    ]);
    expect(warnings).toContain(
      "cron job 'Weird' has no prompt or a schedule OpenTeleport cannot express; not exported",
    );
    expect(warnings).toContain("cron job 'Morning digest' appears more than once; exported as 'Morning digest (2)'");
    expect(warnings).toContain("1 entry of cron/jobs.json is not a job OpenTeleport can read; left out");
  });

  it("reads a paused job as a routine that is not enabled", async () => {
    const jobs = JSON.parse(await readFile(join(hermes, "cron", "jobs.json"), "utf8")) as {
      jobs: Record<string, unknown>[];
    };
    Object.assign(jobs.jobs[0] ?? {}, { enabled: false, state: "paused" });
    await writeFile(join(hermes, "cron", "jobs.json"), JSON.stringify(jobs));
    const { bundle } = await readHermesProfile(ctx, "default");
    expect(bundle.routines.map((routine) => routine.enabled)).toEqual([false, true, true]);
  });

  it("reads at most 64 routines and names the others", async () => {
    const jobs = Array.from({ length: 66 }, (_unused, index) => ({
      id: `job${index}`,
      name: `Job ${index + 1}`,
      prompt: "Do it.",
      schedule: { kind: "interval", minutes: 30 },
    }));
    await writeFile(join(hermes, "cron", "jobs.json"), JSON.stringify({ jobs }));
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.routines).toHaveLength(64);
    expect(bundle.routines.at(-1)?.name).toBe("Job 64");
    expect(warnings).toContain("cron job 'Job 65' is over the limit of 64 routines; not exported");
    expect(warnings).toContain("cron job 'Job 66' is over the limit of 64 routines; not exported");
  });

  it("reads cron jobs in the time zone HERMES_TIMEZONE names and a bare one-off time in the machine's", async () => {
    // Whatever zone the machine running the test is in, HERMES_TIMEZONE is the other of the two.
    const host = machineTimezone();
    const profile = host === "America/New_York" ? "Asia/Tokyo" : "America/New_York";
    const { bundle, warnings } = await readHermesProfile(
      { ...ctx, env: { ...ctx.env, HERMES_TIMEZONE: profile } },
      "default",
    );
    expect(bundle.routines.map((routine) => routine.timezone)).toEqual([profile, profile, profile]);
    expect(bundle.routines[2]?.schedule).toEqual({
      kind: "at",
      at: zonedToInstant("2026-12-01T08:00:00", host),
    });
    expect(warnings).toContain(
      "cron job 'Renew the domain' has a one-off time without an offset; " +
        `read in this machine's time zone (${host}), as Hermes does`,
    );
  });

  it("warns about a config.yaml that does not parse and reads without a model", async () => {
    await writeFile(join(hermes, "config.yaml"), "a: [1\n");
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.manifest.models).toEqual([]);
    expect(bundle.persona).toContain("You are Main");
    expect(warnings.some((w) => /config\.yaml is not valid YAML.*not used/.test(w))).toBe(true);
  });

  it("warns about a profile.yaml that does not parse and names the profile after its id", async () => {
    await writeFile(join(hermes, "profile.yaml"), "a: [1\n");
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.manifest.name).toBe("default");
    expect(warnings.some((w) => /profile\.yaml is not valid YAML.*profile id is its name/.test(w))).toBe(
      true,
    );
  });

  it("keeps a base URL in x-hermes and a model without a provider", async () => {
    await writeFile(
      join(hermes, "config.yaml"),
      "model:\n  default: some/model\n  base_url: https://example.test/v1\n",
    );
    const { bundle } = await readHermesProfile(ctx, "default");
    expect(bundle.manifest.models).toEqual([{ model: "some/model" }]);
    expect(bundle.manifest["x-hermes"]).toMatchObject({ baseUrl: "https://example.test/v1" });
  });

  it("has no model preference without a model name", async () => {
    await writeFile(join(hermes, "config.yaml"), "model:\n  provider: auto\n");
    expect((await readHermesProfile(ctx, "default")).bundle.manifest.models).toEqual([]);
  });

  it("returns the id an earlier move recorded in the profile", async () => {
    const dir = join(hermes, "profiles", "reviewer");
    await writeFile(join(dir, ".openteleport.json"), JSON.stringify({ id: ULID, movedAt: "x" }));
    expect((await readHermesProfile(ctx, "reviewer")).bundle.manifest.id).toBe(ULID);
    await writeFile(join(dir, ".openteleport.json"), JSON.stringify({ id: "not-an-id" }));
    expect((await readHermesProfile(ctx, "reviewer")).bundle.manifest.id).toBe("");
  });

  it("cuts a name and a title that are too long and keeps the whole description", async () => {
    const description = "d".repeat(130);
    await writeFile(
      join(hermes, "profiles", "reviewer", "profile.yaml"),
      `display_name: ${"n".repeat(90)}\ndescription: ${description}\n`,
    );
    const { manifest } = (await readHermesProfile(ctx, "reviewer")).bundle;
    expect(manifest.name).toHaveLength(80);
    expect(manifest.title).toHaveLength(120);
    expect(manifest.description).toBe(description);
    expect(() => parseManifest({ ...manifest, id: ULID })).not.toThrow();
  });

  it("does not modify the profile", async () => {
    const before = await snapshot(hermes);
    await listHermesProfiles(ctx);
    await readHermesProfile(ctx, "default");
    await readHermesProfile(ctx, "reviewer");
    await hermesCacheIdentity(ctx, "default");
    expect(await snapshot(hermes)).toEqual(before);
  });
});

describe("memory", () => {
  it("reads CRLF files with a byte order mark, USER.md after MEMORY.md", async () => {
    await writeFile(join(hermes, "memories", "MEMORY.md"), "\uFEFFone\r\n§\r\ntwo");
    await writeFile(join(hermes, "memories", "USER.md"), "three\r\n§\r\n\r\n§\r\nfour");
    const { bundle } = await readHermesProfile(ctx, "default");
    expect(bundle.facts).toEqual(["one", "two", "three", "four"]);
    expect(bundle.notes).toEqual([]);
  });

  it("folds the line breaks of an entry of up to 500 characters into single spaces, and says so", async () => {
    await writeFile(join(hermes, "memories", "MEMORY.md"), "one\n§\ntwo\nlines\n§\nthree  \n \n  parts");
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.facts.slice(0, 3)).toEqual(["one", "two lines", "three parts"]);
    expect(bundle.facts.some((fact) => /[\r\n]/.test(fact))).toBe(false);
    expect(bundle.notes).toEqual([]);
    expect(warnings).toContain("2 memory entries had line breaks folded into one line");
  });

  it("folds the entries of USER.md the same way, counted with those of MEMORY.md", async () => {
    await writeFile(join(hermes, "memories", "MEMORY.md"), "plain\n§\nfirst\r\nsecond");
    await writeFile(join(hermes, "memories", "USER.md"), "likes tea\nno sugar");
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.facts).toEqual(["plain", "first second", "likes tea no sugar"]);
    expect(warnings).toContain("2 memory entries had line breaks folded into one line");
  });

  it("does not warn when no entry has a line break", async () => {
    await writeFile(join(hermes, "memories", "MEMORY.md"), "one\n§\ntwo");
    await rm(join(hermes, "memories", "USER.md"), { force: true });
    const { warnings } = await readHermesProfile(ctx, "default");
    expect(warnings.some((warning) => warning.includes("folded"))).toBe(false);
  });

  it("keeps an entry over 500 characters with its line breaks as a note, and does not count it as folded", async () => {
    const long = `${"first line ".repeat(30)}\nsecond line\n${"third line ".repeat(30)}`.trim();
    expect(long.length).toBeGreaterThan(500);
    await writeFile(join(hermes, "memories", "MEMORY.md"), `short\nentry\n§\n${long}`);
    await rm(join(hermes, "memories", "USER.md"), { force: true });
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.facts).toEqual(["short entry"]);
    expect(bundle.notes).toEqual([{ name: "memory-2", text: long }]);
    expect(bundle.notes[0]?.text.split("\n")).toHaveLength(3);
    expect(warnings).toContain("1 memory entry had line breaks folded into one line");
    expect(warnings).toContain("1 memory entry over 500 characters was kept as the note memory-2");
  });

  it("moves into a folder, which takes facts of one line only", async () => {
    const out = join(root, "out");
    const report = await move({
      from: hermesAdapter,
      to: folderAdapter,
      agent: "default",
      ctx: { ...ctx, targetDir: out },
      write: { enableRoutines: false, includeFiles: false, onConflict: "update" },
    });
    expect(report.outcome).toBe("done");
    expect(report.warnings).toContain("1 memory entry had line breaks folded into one line");
    const written = await readFile(join(out, "MEMORY.md"), "utf8");
    expect(written).toContain("- Deployments happen on Tuesdays. Never deploy on Fridays.\n");
  });

  it("keeps a USER.md entry over 500 characters as the note user-<n>", async () => {
    await writeFile(join(hermes, "memories", "USER.md"), `short\n§\n${"u".repeat(501)}`);
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.notes.map((note) => note.name)).toEqual(["memory-3", "user-2"]);
    expect(bundle.facts.at(-1)).toBe("short");
    expect(warnings).toContain(
      "2 memory entries over 500 characters were kept as the notes memory-3, user-2",
    );
  });

  it("has no facts without the memory files", async () => {
    await rm(join(hermes, "memories"), { recursive: true });
    const { bundle } = await readHermesProfile(ctx, "default");
    expect(bundle.facts).toEqual([]);
    expect(bundle.notes).toEqual([]);
  });
});

describe("skills", () => {
  it("leaves out the state of the skills hub and every other folder named with a dot", async () => {
    await put(join(hermes, "skills", ".hub", "quarantine", "x", "SKILL.md"), skill("x"));
    await put(join(hermes, "skills", ".archive", "y", "SKILL.md"), skill("y"));
    const names = (await readHermesProfile(ctx, "default")).bundle.skills.map((s) => s.name);
    expect(names).toEqual(["old", "release-notes"]);
  });

  it("flattens categories and renames a skill whose name is taken", async () => {
    await put(join(hermes, "skills", "other", "release-notes", "SKILL.md"), skill("release-notes"));
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.skills.map((s) => s.name)).toEqual(["old", "release-notes", "release-notes-2"]);
    expect(warnings).toContain(
      "skill 'release-notes' appears more than once (writing/release-notes); exported as 'release-notes-2'",
    );
    const second = bundle.skills.find((s) => s.name === "release-notes-2");
    expect(Buffer.from(second?.files[0]?.bytes ?? []).toString("utf8")).toContain("Release notes");
  });

  it("does not search inside a skill for more skills", async () => {
    await put(join(hermes, "skills", "writing", "release-notes", "nested", "SKILL.md"), skill("nested"));
    const { bundle } = await readHermesProfile(ctx, "default");
    expect(bundle.skills.map((s) => s.name)).toEqual(["old", "release-notes"]);
    const files = bundle.skills.find((s) => s.name === "release-notes")?.files.map((f) => f.path);
    expect(files).toEqual(["SKILL.md", "nested/SKILL.md", "references/style.md"]);
  });

  describe("the manifest of bundled skills", () => {
    const manifest = (text: string) => writeFile(join(hermes, "skills", ".bundled_manifest"), text);
    const names = async () =>
      (await readHermesProfile(ctx, "default")).bundle.skills.map((s) => s.name);

    it("lists skills as name:hash lines, and the older form with just the name", async () => {
      await manifest("old\r\nrelease-notes:0123456789abcdef0123456789abcdef\r\n\r\n");
      expect(await names()).toEqual(["triage"]);
    });

    it("reads a byte order mark and blank lines", async () => {
      await manifest("\uFEFF\n  triage:abc  \n\n");
      expect(await names()).toEqual(["old", "release-notes"]);
    });

    it("matches the name in the frontmatter of the skill as well as its folder", async () => {
      await put(
        join(hermes, "skills", "misc", "renamed", "SKILL.md"),
        "---\r\nname: triage-pro\r\ndescription: x\r\n---\r\n\r\nBody\r\n",
      );
      await manifest("triage:abc\ntriage-pro:def\n");
      expect(await names()).toEqual(["old", "release-notes"]);
    });

    it("counts the skills left behind", async () => {
      await manifest("triage:abc\nold:def\n");
      const { bundle, warnings } = await readHermesProfile(ctx, "default");
      expect(bundle.skills.map((s) => s.name)).toEqual(["release-notes"]);
      expect(warnings).toContain("2 bundled Hermes skills left behind");
    });

    it("leaves every skill in place without a manifest or with an empty one", async () => {
      await rm(join(hermes, "skills", ".bundled_manifest"));
      expect(await names()).toEqual(["old", "triage", "release-notes"]);
      await manifest("");
      expect(await names()).toEqual(["old", "triage", "release-notes"]);
    });

    it("leaves every skill in place, with a warning, when the manifest cannot be read", async () => {
      await rm(join(hermes, "skills", ".bundled_manifest"));
      await mkdir(join(hermes, "skills", ".bundled_manifest"));
      const { bundle, warnings } = await readHermesProfile(ctx, "default");
      expect(bundle.skills.map((s) => s.name)).toEqual(["old", "triage", "release-notes"]);
      expect(warnings).toContain(
        "skills/.bundled_manifest could not be read; no skill was left behind as bundled",
      );
    });
  });

  it("reads at most 32 skills and names the others", async () => {
    for (let n = 1; n <= 34; n += 1) {
      const name = `s${String(n).padStart(2, "0")}`;
      await put(join(hermes, "skills", "many", name, "SKILL.md"), skill(name));
    }
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.skills).toHaveLength(32);
    expect(bundle.skills.at(-1)?.name).toBe("s31");
    expect(warnings).toContain(
      "4 skills over the limit of 32 not exported: s32, s33, s34, release-notes",
    );
  });

  it("never follows a link, whether it stands for a skill folder or a file in one", async (task) => {
    const outside = join(root, "outside");
    await put(join(outside, "SKILL.md"), skill("outside"));
    await put(join(outside, "secret.txt"), "secret");
    await put(join(root, "elsewhere.txt"), "elsewhere");
    try {
      await symlink(outside, join(hermes, "skills", "linked"), "junction");
      await symlink(
        join(root, "elsewhere.txt"),
        join(hermes, "skills", "writing", "release-notes", "linked.txt"),
        "file",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") task.skip();
      throw error;
    }
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    expect(bundle.skills.map((s) => s.name)).toEqual(["old", "release-notes"]);
    expect(bundle.skills.flatMap((s) => s.files.map((f) => f.path))).not.toContain("linked.txt");
    expect(warnings).toContain("skill 'linked' is a symlink; not exported");
    expect(warnings).toContain("skill 'release-notes': 'linked.txt' is a symlink; not exported");
  });

  it("leaves forbidden files of a skill out and says so", async () => {
    await put(join(hermes, "skills", "writing", "release-notes", ".env"), "KEY=1");
    const { bundle, warnings } = await readHermesProfile(ctx, "default");
    const files = bundle.skills.find((s) => s.name === "release-notes")?.files.map((f) => f.path);
    expect(files).toEqual(["SKILL.md", "references/style.md"]);
    expect(warnings).toContain("skill 'release-notes': left out '.env'");
  });
});

describe("hermesCacheIdentity", () => {
  it("is the real path of the profile directory", async () => {
    expect(await hermesCacheIdentity(ctx, "reviewer")).toBe(
      await realpath(join(hermes, "profiles", "reviewer")),
    );
    expect(await hermesCacheIdentity(ctx, "default")).toBe(await realpath(hermes));
  });

  it("tells the default profiles of two Hermes homes apart, and sees through a link to one", async (task) => {
    const second = join(root, "second");
    await put(join(second, "SOUL.md"), "x");
    const link = join(root, "link");
    try {
      await symlink(second, link, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") task.skip();
      throw error;
    }
    const viaLink = await hermesCacheIdentity({ ...ctx, env: { HERMES_HOME: link } }, "default");
    expect(viaLink).toBe(await realpath(second));
    expect(viaLink).not.toBe(await hermesCacheIdentity(ctx, "default"));
  });

  it("refuses an id that is not one path segment", async () => {
    await expect(hermesCacheIdentity(ctx, "../x")).rejects.toThrow(/invalid Hermes profile id/);
  });
});
