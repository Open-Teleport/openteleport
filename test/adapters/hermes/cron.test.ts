import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HermesJob,
  jobToRoutine,
  newJobId,
  readJobsFile,
  routineToJob,
  writeJobsFile,
} from "../../../src/adapters/hermes/cron.js";
import { describeSchedule } from "../../../src/core/schedule.js";
import type { Routine } from "../../../src/core/schema.js";

const JOBS = fileURLToPath(new URL("../../fixtures/hermes/home/cron/jobs.json", import.meta.url));
const WARSAW = "Europe/Warsaw";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-hermes-cron-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A job as the fixture holds it, with the given fields laid over it. */
function jobOf(overrides: Record<string, unknown> = {}): HermesJob {
  return {
    id: "0123456789ab",
    name: "Digest",
    prompt: "Summarise the news.",
    schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
    enabled: true,
    state: "scheduled",
    ...overrides,
  };
}

async function fixtureJobs(): Promise<HermesJob[]> {
  const read = await readJobsFile(JOBS);
  if ("error" in read) throw new Error(read.error);
  return read.jobs;
}

describe("readJobsFile", () => {
  it("reads the jobs of the fixture and keeps the other top-level keys", async () => {
    const read = await readJobsFile(JOBS);
    expect(read).toMatchObject({ rest: { updated_at: "2026-10-01T09:10:00+02:00" }, ignored: [] });
    if ("error" in read) throw new Error(read.error);
    expect(read.jobs.map((job) => job.name)).toEqual([
      "Morning digest",
      "Inbox sweep",
      "Renew the domain",
    ]);
    expect(read.rest).not.toHaveProperty("jobs");
  });

  it("treats a missing file as no jobs", async () => {
    expect(await readJobsFile(join(root, "jobs.json"))).toEqual({ jobs: [], rest: {}, ignored: [] });
  });

  it("accepts a bare list", async () => {
    const file = join(root, "jobs.json");
    await writeFile(file, JSON.stringify([jobOf()]));
    expect(await readJobsFile(file)).toEqual({ jobs: [jobOf()], rest: {}, ignored: [] });
  });

  it("accepts an object without jobs and drops a byte order mark", async () => {
    const file = join(root, "jobs.json");
    await writeFile(file, `\uFEFF${JSON.stringify({ updated_at: "x" })}`);
    expect(await readJobsFile(file)).toEqual({ jobs: [], rest: { updated_at: "x" }, ignored: [] });
  });

  it("returns an error for a file that is not JSON", async () => {
    const file = join(root, "jobs.json");
    await writeFile(file, "{ not json");
    const read = await readJobsFile(file);
    expect(read).toEqual({ error: expect.stringMatching(/jobs\.json is not valid JSON/) });
  });

  it.each([
    ["a number", "5"],
    ["a text", '"jobs"'],
    ["jobs that are not a list", '{ "jobs": { "a": {} } }'],
  ])("returns an error for %s", async (_name, content) => {
    const file = join(root, "jobs.json");
    await writeFile(file, content);
    expect(await readJobsFile(file)).toEqual({ error: expect.stringMatching(/jobs\.json/) });
  });

  it("returns an error for a path that cannot be read", async () => {
    await mkdir(join(root, "jobs.json"));
    expect(await readJobsFile(join(root, "jobs.json"))).toEqual({
      error: expect.stringMatching(/jobs\.json could not be read/),
    });
  });

  it("sets entries aside that lack a text id, name or prompt, in the order they came", async () => {
    const file = join(root, "jobs.json");
    const half = { id: "x", name: null, prompt: "p", schedule: {} };
    await writeFile(file, JSON.stringify({ jobs: [half, jobOf(), 5, { id: 1 }] }));
    expect(await readJobsFile(file)).toEqual({
      jobs: [jobOf()],
      rest: {},
      ignored: [half, 5, { id: 1 }],
    });
  });
});

describe("jobToRoutine", () => {
  it("turns the three jobs of the fixture into a cron, an every and an at routine", async () => {
    const [digest, sweep, domain] = await fixtureJobs();
    const routines = [digest, sweep, domain].map((job) => jobToRoutine(job as HermesJob, WARSAW));
    expect(routines.map((entry) => entry?.routine)).toEqual([
      {
        name: "Morning digest",
        instruction: "Summarise the overnight GitHub notifications and list what needs a reply.",
        enabled: true,
        timezone: WARSAW,
        schedule: { kind: "cron", expression: "0 9 * * 1-5" },
      },
      {
        name: "Inbox sweep",
        instruction: "Sort the inbox into reply, read later and archive.",
        enabled: true,
        timezone: WARSAW,
        schedule: { kind: "every", every: "2h" },
      },
      {
        name: "Renew the domain",
        instruction: "Remind me to renew the domain before it lapses.",
        enabled: true,
        timezone: WARSAW,
        schedule: { kind: "at", at: "2026-12-01T07:00:00.000Z" },
      },
    ]);
  });

  it("keeps what a routine has no place for as extra", async () => {
    const [digest, sweep, domain] = await fixtureJobs();
    expect(jobToRoutine(sweep as HermesJob, WARSAW)?.extra).toEqual({
      deliver: "telegram",
      workdir: "/home/ada/inbox",
    });
    // The default delivery, no skills and a null workdir carry nothing worth keeping.
    expect(jobToRoutine(digest as HermesJob, WARSAW)?.extra).toEqual({});
    expect(jobToRoutine(domain as HermesJob, WARSAW)?.extra).toEqual({});
  });

  it("keeps skills, toolsets, the repeat count and the origin when they say something", () => {
    const origin = { platform: "telegram", chat_id: "42" };
    const { extra } = jobToRoutine(
      jobOf({
        skills: ["release-notes"],
        enabled_toolsets: [],
        repeat: { times: 3, completed: 1 },
        origin,
        deliver: "origin",
      }),
      WARSAW,
    ) ?? { extra: {} };
    expect(extra).toEqual({
      deliver: "origin",
      skills: ["release-notes"],
      enabled_toolsets: [],
      repeat: { times: 3 },
      origin,
    });
  });

  it("does not keep the repeat count of a one-off or an endless job", () => {
    const once = jobToRoutine(
      jobOf({
        schedule: { kind: "once", run_at: "2026-12-01T08:00:00+01:00" },
        repeat: { times: 1, completed: 0 },
      }),
      WARSAW,
    );
    expect(once?.extra).toEqual({});
    expect(jobToRoutine(jobOf({ repeat: { times: null, completed: 4 } }), WARSAW)?.extra).toEqual({});
  });

  it.each([
    ["an unknown schedule kind", { kind: "weird" }],
    ["no schedule", undefined],
    ["a schedule that is not an object", "every 5m"],
    ["a cron job without an expression", { kind: "cron", expr: " " }],
    ["a cron expression with a seconds field", { kind: "cron", expr: "0 0 9 * * *" }],
    ["an interval of zero minutes", { kind: "interval", minutes: 0 }],
    ["an interval that is not a whole number", { kind: "interval", minutes: 1.5 }],
    ["an interval that is a text", { kind: "interval", minutes: "30" }],
    ["a one-off without a time", { kind: "once" }],
    ["a one-off time that is not a date", { kind: "once", run_at: "tomorrow" }],
    ["a one-off on a day that does not exist", { kind: "once", run_at: "2026-02-30T08:00:00" }],
  ])("is null for %s", (_name, schedule) => {
    expect(jobToRoutine(jobOf({ schedule }), WARSAW)).toBeNull();
  });

  it("is null for a job with no prompt to run", () => {
    expect(jobToRoutine(jobOf({ prompt: "  " }), WARSAW)).toBeNull();
  });

  it("names a job without a name after its id", () => {
    expect(jobToRoutine(jobOf({ name: " " }), WARSAW)?.routine.name).toBe("0123456789ab");
  });

  it.each([
    ["minutes", 45, "45m"],
    ["hours", 180, "3h"],
    ["days", 2880, "2d"],
  ])("writes an interval in %s", (_name, minutes, every) => {
    const entry = jobToRoutine(jobOf({ schedule: { kind: "interval", minutes } }), WARSAW);
    expect(entry?.routine.schedule).toEqual({ kind: "every", every });
  });

  it.each([
    ["with an offset", "2026-12-01T08:00:00+02:00", "2026-12-01T06:00:00.000Z"],
    ["with Z", "2026-12-01T08:00:00Z", "2026-12-01T08:00:00.000Z"],
    ["with microseconds", "2026-12-01T08:00:00.123456+00:00", "2026-12-01T08:00:00.123Z"],
    ["without an offset, in the zone of the profile", "2026-12-01T08:00", "2026-12-01T07:00:00.000Z"],
    ["with a space instead of the T", "2026-07-01 08:00:00", "2026-07-01T06:00:00.000Z"],
    ["with fractions of a second and no offset", "2026-12-01T08:00:00.5", "2026-12-01T07:00:00.500Z"],
    ["with a date only", "2026-12-01", "2026-11-30T23:00:00.000Z"],
  ])("reads a one-off time %s", (_name, run_at, at) => {
    const entry = jobToRoutine(jobOf({ schedule: { kind: "once", run_at } }), WARSAW);
    expect(entry?.routine.schedule).toEqual({ kind: "at", at });
  });

  it("is not enabled when the job is paused, disabled or done", () => {
    for (const overrides of [
      { enabled: false },
      { state: "paused" },
      { paused_at: "2026-10-01T10:00:00+02:00" },
      { state: "completed" },
    ]) {
      expect(jobToRoutine(jobOf(overrides), WARSAW)?.routine.enabled).toBe(false);
    }
    expect(jobToRoutine(jobOf({ enabled: undefined, state: undefined }), WARSAW)?.routine.enabled).toBe(
      true,
    );
  });
});

describe("routineToJob", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");
  const routine = (schedule: Routine["schedule"], overrides: Partial<Routine> = {}): Routine => ({
    name: "Digest",
    instruction: "Summarise the news.",
    enabled: true,
    timezone: WARSAW,
    schedule,
    ...overrides,
  });

  it("writes a cron job paused, the way `hermes cron create --paused` does", () => {
    const schedule: Routine["schedule"] = { kind: "cron", expression: "0 9 * * 1-5" };
    const job = routineToJob(routine(schedule), undefined, now, "abc123abc123");
    const display = describeSchedule(schedule);
    expect(job).toEqual({
      id: "abc123abc123",
      name: "Digest",
      prompt: "Summarise the news.",
      skills: [],
      skill: null,
      model: null,
      provider: null,
      base_url: null,
      script: null,
      no_agent: false,
      monitor_script: null,
      monitor_url: null,
      monitor_state: null,
      context_from: null,
      schedule: { kind: "cron", expr: "0 9 * * 1-5", display },
      schedule_display: display,
      repeat: { times: null, completed: 0 },
      enabled: false,
      state: "paused",
      paused_at: "2026-10-28T12:00:00.000+00:00",
      paused_reason: "imported by OpenTeleport; resume with: hermes cron resume abc123abc123",
      created_at: "2026-10-28T12:00:00.000+00:00",
      next_run_at: null,
      last_run_at: null,
      last_status: null,
      last_error: null,
      last_delivery_error: null,
      last_delivery_unverified: null,
      last_failure: null,
      failure_streak: 0,
      deliver: "local",
      origin: null,
      enabled_toolsets: null,
      workdir: null,
    });
  });

  it("writes an interval in minutes", () => {
    const schedule: Routine["schedule"] = { kind: "every", every: "2h" };
    const job = routineToJob(routine(schedule), undefined, now, "abc123abc123");
    expect(job.schedule).toEqual({
      kind: "interval",
      minutes: 120,
      display: describeSchedule(schedule),
    });
    expect(job.schedule_display).toBe(describeSchedule(schedule));
    expect(job.repeat).toEqual({ times: null, completed: 0 });
  });

  it("writes a one-off with an offset and a repeat count of one", () => {
    const schedule: Routine["schedule"] = { kind: "at", at: "2026-12-01T07:00:00.000Z" };
    const job = routineToJob(routine(schedule), undefined, now, "abc123abc123");
    expect(job.schedule).toEqual({
      kind: "once",
      run_at: "2026-12-01T07:00:00+00:00",
      display: describeSchedule(schedule),
    });
    expect(job.repeat).toEqual({ times: 1, completed: 0 });
    expect(job).toMatchObject({ enabled: false, state: "paused", next_run_at: null });
  });

  it("is paused whatever the routine says", () => {
    const schedule: Routine["schedule"] = { kind: "cron", expression: "0 9 * * *" };
    expect(routineToJob(routine(schedule, { enabled: true }), undefined, now, "a")).toMatchObject({
      enabled: false,
      state: "paused",
    });
  });

  it("puts back the fields of x-hermes that have a place in a job", () => {
    const origin = { platform: "telegram", chat_id: "42" };
    const job = routineToJob(
      routine({ kind: "cron", expression: "0 9 * * *" }),
      {
        deliver: "telegram",
        workdir: "/home/ada/inbox",
        skills: ["release-notes", "triage"],
        enabled_toolsets: ["web"],
        repeat: { times: 3 },
        origin,
      },
      now,
      "abc123abc123",
    );
    expect(job).toMatchObject({
      deliver: "telegram",
      workdir: "/home/ada/inbox",
      skills: ["release-notes", "triage"],
      skill: "release-notes",
      enabled_toolsets: ["web"],
      repeat: { times: 3, completed: 0 },
      origin,
    });
  });

  it("never lets x-hermes set the state, a script or anything else outside that list", () => {
    const job = routineToJob(
      routine({ kind: "cron", expression: "0 9 * * *" }),
      {
        enabled: true,
        state: "scheduled",
        next_run_at: "2026-12-01T00:00:00+00:00",
        script: "rm -rf /",
        interpreter: "/bin/sh",
        no_agent: true,
        id: "other",
        prompt: "other",
        schedule: "other",
      },
      now,
      "abc123abc123",
    );
    expect(job).toMatchObject({
      id: "abc123abc123",
      prompt: "Summarise the news.",
      enabled: false,
      state: "paused",
      next_run_at: null,
      script: null,
      no_agent: false,
    });
    expect(job).not.toHaveProperty("interpreter");
    expect(job.schedule).toMatchObject({ kind: "cron" });
  });

  it("ignores x-hermes values of the wrong type", () => {
    const job = routineToJob(
      routine({ kind: "cron", expression: "0 9 * * *" }),
      {
        deliver: 5,
        workdir: ["x"],
        skills: "triage",
        enabled_toolsets: [1],
        repeat: "often",
        origin: "telegram",
      },
      now,
      "abc123abc123",
    );
    expect(job).toMatchObject({
      deliver: "local",
      workdir: null,
      skills: [],
      enabled_toolsets: null,
      repeat: { times: null, completed: 0 },
      origin: null,
    });
  });

  it("reads back what jobToRoutine produced", () => {
    const original = jobOf({
      schedule: { kind: "interval", minutes: 120 },
      deliver: "telegram",
      workdir: "/w",
    });
    const entry = jobToRoutine(original, WARSAW);
    if (entry === null) throw new Error("expected a routine");
    const job = routineToJob(entry.routine, entry.extra, now, "abc123abc123");
    expect(jobToRoutine(job, WARSAW)).toEqual({
      routine: { ...entry.routine, enabled: false },
      extra: entry.extra,
    });
  });
});

describe("newJobId", () => {
  it("is twelve hexadecimal characters, a different one each time", () => {
    const ids = new Set(Array.from({ length: 20 }, () => newJobId()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("writeJobsFile", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");

  it("creates the file and its directory without a backup", async () => {
    const file = join(root, "cron", "jobs.json");
    await writeJobsFile(file, [jobOf()], {}, now);
    const text = await readFile(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ jobs: [jobOf()], updated_at: "2026-10-28T12:00:00.000+00:00" });
    expect(await readdir(join(root, "cron"))).toEqual(["jobs.json"]);
  });

  it("backs the old file up first and keeps foreign jobs and top-level keys", async () => {
    const file = join(root, "cron", "jobs.json");
    await mkdir(join(root, "cron"));
    const foreign = jobOf({ id: "ffffffffffff", name: "Theirs", extra_field: { a: [1, 2] } });
    const odd = { id: "x", name: null };
    const original = `${JSON.stringify({ jobs: [foreign, odd], schema: 7, updated_at: "old" })}\n`;
    await writeFile(file, original);

    const read = await readJobsFile(file);
    if ("error" in read) throw new Error(read.error);
    const mine = jobOf({ id: "aaaaaaaaaaaa", name: "Mine" });
    await writeJobsFile(file, [...read.jobs, mine, ...read.ignored], read.rest, now);

    const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({
      schema: 7,
      jobs: [foreign, mine, odd],
      updated_at: "2026-10-28T12:00:00.000+00:00",
    });
    const backup = join(root, "cron", "jobs.json.bak-2026-10-28T12-00-00.000Z");
    expect(await readFile(backup, "utf8")).toBe(original);
    expect((await readdir(join(root, "cron"))).sort()).toEqual([
      "jobs.json",
      "jobs.json.bak-2026-10-28T12-00-00.000Z",
    ]);
  });

  it("never overwrites an earlier backup", async () => {
    const file = join(root, "jobs.json");
    await writeFile(file, '{"jobs":[]}');
    await writeJobsFile(file, [jobOf()], {}, now);
    await writeJobsFile(file, [], {}, now);
    expect((await readdir(root)).sort()).toEqual([
      "jobs.json",
      "jobs.json.bak-2026-10-28T12-00-00.000Z",
      "jobs.json.bak-2026-10-28T12-00-00.000Z-2",
    ]);
    expect(await readFile(join(root, "jobs.json.bak-2026-10-28T12-00-00.000Z"), "utf8")).toBe(
      '{"jobs":[]}',
    );
  });

  it("does not write through a symbolic link", async (task) => {
    const real = join(root, "real.json");
    const link = join(root, "jobs.json");
    await writeFile(real, '{"jobs":[]}');
    try {
      await symlink(real, link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") task.skip();
      throw error;
    }
    await expect(writeJobsFile(link, [jobOf()], {}, now)).rejects.toThrow(/symbolic link/);
    expect(await readFile(real, "utf8")).toBe('{"jobs":[]}');
    expect(await readdir(root)).toEqual(["jobs.json", "real.json"]);
  });

  it("refuses to replace something that is not a file", async () => {
    await mkdir(join(root, "jobs.json"));
    await expect(writeJobsFile(join(root, "jobs.json"), [], {}, now)).rejects.toThrow(
      /not a regular file/,
    );
  });
});
