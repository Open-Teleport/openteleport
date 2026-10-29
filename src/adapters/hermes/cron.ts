// The cron jobs of a Hermes profile (`cron/jobs.json`) and their translation to routines. Field
// names and values follow `create_job` in `cron/jobs.py`, so that a job written here is the one
// `hermes cron create --paused` would have made.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describeSchedule, everyToMs, msToEvery, zonedToInstant } from "../../core/schedule.js";
import type { Routine, Schedule } from "../../core/schema.js";
import { withoutMark } from "../../core/text.js";
import { isRecord, nonBlank } from "../../core/values.js";
import { backUp, isNotFound, lstatIfAny, replaceFile } from "../fs.js";

/** A job record as far as the adapter needs it; everything else in it is kept as it is. */
export type HermesJob = Record<string, unknown> & {
  id: string;
  name: string;
  prompt: string;
  schedule: unknown;
};

const isJob = (value: unknown): value is HermesJob =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  typeof value.prompt === "string";

/** A time the way Python's `datetime.isoformat()` writes a UTC one, which Hermes reads back. */
const iso = (date: Date): string => date.toISOString().replace("Z", "+00:00");

// -- The file ----------------------------------------------------------------------------------

export type JobsFile = {
  jobs: HermesJob[];
  /** The top-level keys other than `jobs`. */
  rest: Record<string, unknown>;
  /**
   * The entries that are not a job with a text id, name and prompt, in file order. They are not
   * the adapter's to read, but they are someone's job (Hermes tolerates a null name), so a
   * caller that rewrites the file puts them back.
   */
  ignored: unknown[];
};

/**
 * Reads `cron/jobs.json`: `{ "jobs": [...], ...rest }` or a bare list, with or without a byte
 * order mark. A missing file holds no jobs. `{ error }` says why the file cannot be used, which
 * is also the reason not to write it.
 */
export async function readJobsFile(file: string): Promise<JobsFile | { error: string }> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { jobs: [], rest: {}, ignored: [] };
    return { error: `${file} could not be read (${(error as Error).message})` };
  }
  let data: unknown;
  try {
    data = JSON.parse(withoutMark(source));
  } catch (error) {
    return { error: `${file} is not valid JSON: ${(error as Error).message}` };
  }
  let rest: Record<string, unknown> = {};
  let entries: unknown;
  if (Array.isArray(data)) {
    entries = data;
  } else if (isRecord(data)) {
    const { jobs, ...others } = data;
    rest = others;
    entries = jobs ?? [];
  } else {
    return { error: `${file} is neither a list of jobs nor an object with a "jobs" list` };
  }
  if (!Array.isArray(entries)) return { error: `${file} has "jobs" that is not a list` };
  return {
    jobs: entries.filter(isJob),
    rest,
    ignored: entries.filter((entry) => !isJob(entry)),
  };
}

/**
 * Writes `{ ...rest, jobs, updated_at }` to `file` in one step through a temporary sibling, so
 * that Hermes never reads half of it, after a copy of the file as it was (`<file>.bak-<time>`).
 * The file keeps its mode; a new one is owner-only, as Hermes makes it. `jobs` holds every job
 * to keep, other people's and the `ignored` entries of `readJobsFile` included. Throws, and
 * writes nothing, when `file` is a link or not a regular file.
 */
export async function writeJobsFile(
  file: string,
  jobs: readonly unknown[],
  rest: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const existing = await lstatIfAny(file);
  if (existing?.isSymbolicLink()) {
    throw new Error(`${file} is a symbolic link; not written through`);
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new Error(`${file} is not a regular file`);
  }
  // The backup is `<file>.bak-<ISO time>`.
  if (existing !== undefined) await backUp(file, now.toISOString().replace(/:/g, "-"));

  const mode = existing === undefined ? 0o600 : existing.mode & 0o777;
  const content = JSON.stringify({ ...rest, jobs, updated_at: iso(now) }, null, 2);
  await replaceFile(file, `${content}\n`, { mode });
}

/** A job id the way `create_job` makes one: twelve hexadecimal characters. */
export function newJobId(): string {
  return randomBytes(6).toString("hex");
}

// -- Job to routine ----------------------------------------------------------------------------

// `YYYY-MM-DD`, then optionally a time with seconds and fraction and, with a time, an offset.
const WHEN =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?$/i;

/**
 * A one-off time as the instant it names, in UTC. Python writes `isoformat()`, with an offset,
 * but a hand-written job may have none: the time is then the wall clock of `timezone`.
 */
function instantOf(value: unknown, timezone: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = WHEN.exec(value.trim());
  if (parts === null) return undefined;
  const [, date = "", time = "00:00", seconds = "00", fraction = "", zone] = parts;
  const local = `${date}T${time}:${seconds}`;
  const ms = Number(fraction.slice(0, 3).padEnd(3, "0"));
  if (zone === undefined) {
    const instant = zonedToInstant(local, timezone);
    return instant === undefined ? undefined : new Date(Date.parse(instant) + ms).toISOString();
  }
  const utc = zonedToInstant(local, "UTC"); // checks that the day exists
  if (utc === undefined) return undefined;
  const offset = /^z$/i.test(zone) ? [0, 0] : [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
  const [hours = 0, minutes = 0] = offset;
  if (hours > 23 || minutes > 59) return undefined;
  const sign = zone.startsWith("-") ? -1 : 1;
  return new Date(Date.parse(utc) + ms - sign * (hours * 60 + minutes) * 60_000).toISOString();
}

function scheduleOf(spec: unknown, timezone: string): Schedule | null {
  if (!isRecord(spec)) return null;
  switch (spec.kind) {
    case "cron": {
      const expression = nonBlank(spec.expr);
      // Hermes reads cron expressions with croniter, whose sixth field is seconds at the end,
      // not at the start as in the manifest: only the five field form means the same to both.
      return expression !== undefined && expression.split(/\s+/).length === 5
        ? { kind: "cron", expression }
        : null;
    }
    case "interval": {
      const every =
        typeof spec.minutes === "number" ? msToEvery(spec.minutes * 60_000) : null;
      return every === null ? null : { kind: "every", every };
    }
    case "once": {
      const at = instantOf(spec.run_at, timezone);
      return at === undefined ? null : { kind: "at", at };
    }
    default:
      return null;
  }
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;

/** The count of runs a job is limited to; `undefined` for none. */
function repeatTimes(repeat: unknown): number | undefined {
  const times = isRecord(repeat) ? repeat.times : undefined;
  return typeof times === "number" && Number.isInteger(times) && times > 0 ? times : undefined;
}

/**
 * What a job has that a routine has no place for, to be kept in `x-hermes`: where its output goes
 * (unless that is the default, `local`), its working directory, skills, toolsets, a limit on its
 * runs (unless that is the default of its kind) and the chat it was created in.
 */
function extraOf(job: HermesJob, kind: Schedule["kind"]): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const deliver = nonBlank(job.deliver);
  if (deliver !== undefined && deliver !== "local") extra.deliver = deliver;
  const workdir = nonBlank(job.workdir);
  if (workdir !== undefined) extra.workdir = workdir;
  const skills = stringList(job.skills);
  if (skills !== undefined && skills.length > 0) extra.skills = skills;
  // An empty list of toolsets is a choice (nothing is allowed), unlike an absent one.
  const toolsets = stringList(job.enabled_toolsets);
  if (toolsets !== undefined) extra.enabled_toolsets = toolsets;
  const times = repeatTimes(job.repeat);
  if (times !== undefined && times !== (kind === "at" ? 1 : undefined)) extra.repeat = { times };
  if (isRecord(job.origin) && Object.keys(job.origin).length > 0) extra.origin = job.origin;
  return extra;
}

/** Whether Hermes would run the job: enabled, and not marked paused or done. */
function isEnabled(job: HermesJob): boolean {
  const enabled = job.enabled === undefined ? true : Boolean(job.enabled);
  return enabled && job.state !== "paused" && job.state !== "completed" && !job.paused_at;
}

/**
 * The routine a job stands for, in the time zone of the profile, and what stays behind as
 * `extra`. `null` for a job without a prompt, or whose schedule the manifest cannot express: an
 * unknown kind, a cron expression that is not five fields, an interval that is not a whole
 * number of minutes, a one-off time that is not a date.
 */
export function jobToRoutine(
  job: HermesJob,
  timezone: string,
): { routine: Routine; extra: Record<string, unknown> } | null {
  const schedule = scheduleOf(job.schedule, timezone);
  const name = nonBlank(job.name) ?? nonBlank(job.id);
  if (schedule === null || name === undefined || job.prompt.trim() === "") return null;
  return {
    routine: { name, instruction: job.prompt, enabled: isEnabled(job), timezone, schedule },
    extra: extraOf(job, schedule.kind),
  };
}

// -- Routine to job ----------------------------------------------------------------------------

function scheduleRecord(schedule: Schedule, display: string): Record<string, unknown> {
  switch (schedule.kind) {
    case "cron":
      return { kind: "cron", expr: schedule.expression, display };
    case "every":
      return { kind: "interval", minutes: everyToMs(schedule.every) / 60_000, display };
    case "at":
      return {
        kind: "once",
        run_at: iso(new Date(schedule.at)).replace(/\.000\+00:00$/, "+00:00"),
        display,
      };
  }
}

/**
 * The job for a routine, paused, as `create_job(..., paused=True)` makes it: no `next_run_at`
 * (Hermes works it out when the job is resumed, in its own time zone), `enabled: false` and
 * `state: "paused"` whatever the routine says. Of `extra` (what `jobToRoutine` kept) only the
 * fields it names are taken, and only when they have the right type: a bundle must not be able
 * to set a script, the state or any other field of the job.
 */
export function routineToJob(
  routine: Routine,
  extra: Record<string, unknown> | undefined,
  now: Date,
  id: string,
): HermesJob {
  const display = describeSchedule(routine.schedule);
  const skills = stringList(extra?.skills) ?? [];
  const toolsets = stringList(extra?.enabled_toolsets);
  const times = repeatTimes(extra?.repeat) ?? (routine.schedule.kind === "at" ? 1 : null);
  const stamp = iso(now);
  return {
    id,
    name: routine.name,
    prompt: routine.instruction,
    skills,
    skill: skills[0] ?? null,
    model: null,
    provider: null,
    base_url: null,
    script: null,
    no_agent: false,
    monitor_script: null,
    monitor_url: null,
    monitor_state: null,
    context_from: null,
    schedule: scheduleRecord(routine.schedule, display),
    schedule_display: display,
    repeat: { times, completed: 0 },
    enabled: false,
    state: "paused",
    paused_at: stamp,
    paused_reason: `imported by OpenTeleport; resume with: hermes cron resume ${id}`,
    created_at: stamp,
    next_run_at: null,
    last_run_at: null,
    last_status: null,
    last_error: null,
    last_delivery_error: null,
    last_delivery_unverified: null,
    last_failure: null,
    failure_streak: 0,
    deliver: nonBlank(extra?.deliver) ?? "local",
    origin: isRecord(extra?.origin) ? extra.origin : null,
    enabled_toolsets: toolsets ?? null,
    workdir: nonBlank(extra?.workdir) ?? null,
  };
}
