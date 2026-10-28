import type { Schedule } from "./schema.js";
import { isRecord, nonBlank } from "./values.js";

type FieldSpec = {
  label: string;
  min: number;
  max: number;
  /** Accepted names (compared lower-case) and the numbers they stand for. */
  names?: ReadonlyMap<string, number>;
};

const MONTH_NAMES = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (name, index) => [name, index + 1] as const,
  ),
);
// Sunday is both 0 and 7; the names map to 0.
const WEEKDAY_NAMES = new Map(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((name, index) => [name, index] as const),
);
const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const SECOND: FieldSpec = { label: "second", min: 0, max: 59 };
const MINUTE: FieldSpec = { label: "minute", min: 0, max: 59 };
const HOUR: FieldSpec = { label: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { label: "day of month", min: 1, max: 31 };
const MONTH: FieldSpec = { label: "month", min: 1, max: 12, names: MONTH_NAMES };
const DAY_OF_WEEK: FieldSpec = { label: "day of week", min: 0, max: 7, names: WEEKDAY_NAMES };

const FIVE_FIELDS: readonly FieldSpec[] = [MINUTE, HOUR, DAY_OF_MONTH, MONTH, DAY_OF_WEEK];
const SIX_FIELDS: readonly FieldSpec[] = [SECOND, ...FIVE_FIELDS];

function fieldValue(token: string, spec: FieldSpec): number | undefined {
  const value = /^\d+$/.test(token) ? Number(token) : spec.names?.get(token.toLowerCase());
  return value !== undefined && value >= spec.min && value <= spec.max ? value : undefined;
}

// One field is a comma-separated list; each entry is `*`, a value or an `a-b` range, optionally
// followed by `/step`.
function isValidField(token: string, spec: FieldSpec): boolean {
  return token.split(",").every((entry) => {
    const [range, step, ...extra] = entry.split("/");
    if (extra.length > 0) return false;
    if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false;
    if (range === "*") return true;
    const ends = range.split("-");
    if (ends.length > 2) return false;
    const [from, to] = ends.map((end) => fieldValue(end, spec));
    if (from === undefined) return false;
    return ends.length === 1 || (to !== undefined && from <= to);
  });
}

/**
 * Checks the shape of a cron expression: five fields (minute, hour, day of month, month, day of
 * week) or six with leading seconds. Each field is `*`, numbers within the field's range, `a-b`
 * ranges, `,` lists and `/n` steps; month and weekday fields also take three-letter names in any
 * case. It does not work out when the expression next fires.
 */
export function parseCron(
  expr: string,
): { ok: true; fields: 5 | 6 } | { ok: false; reason: string } {
  const trimmed = expr.trim();
  const tokens = trimmed === "" ? [] : trimmed.split(/\s+/);
  if (tokens.length !== 5 && tokens.length !== 6) {
    return { ok: false, reason: `Expected 5 or 6 fields, found ${tokens.length}` };
  }
  const specs = tokens.length === 5 ? FIVE_FIELDS : SIX_FIELDS;
  for (const [index, token] of tokens.entries()) {
    const spec = specs[index] as FieldSpec;
    if (!isValidField(token, spec)) {
      return { ok: false, reason: `Invalid ${spec.label} field "${token}"` };
    }
  }
  return { ok: true, fields: tokens.length };
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const UNIT_MS = { m: MS_PER_MINUTE, h: MS_PER_HOUR, d: MS_PER_DAY } as const;
const EVERY_PATTERN = /^([1-9]\d*)(m|h|d)$/;

/** Converts an interval such as `30m`, `2h` or `1d` to milliseconds. Throws on anything else. */
export function everyToMs(every: string): number {
  const match = EVERY_PATTERN.exec(every);
  const unit = match?.[2] as keyof typeof UNIT_MS | undefined;
  const ms = match && unit ? Number(match[1]) * UNIT_MS[unit] : Number.NaN;
  if (!Number.isSafeInteger(ms)) {
    throw new Error(
      `Invalid duration "${every}": expected a positive whole number followed by m, h or d`,
    );
  }
  return ms;
}

/**
 * Converts an interval such as `30m`, `2h` or `3d` to a five field cron expression: a step of 30
 * on the minute field, a step of 2 on the hour field (at minute 0), a step of 3 on the day of
 * month field (at midnight). An interval of 1 is the unit itself: `1h` is minute 0 of every
 * hour. Throws on anything else, as `everyToMs` does. Cron has no "every N after the last run":
 * an interval that does not divide its unit evenly (`45m`, `5h`) fires at fixed positions of the
 * clock, not strictly N apart. Two cases are worse than that. A step that reaches past the field
 * fires once per round of the next unit: `90m` and `120m` (a step of 90 or 120 on the minute
 * field) fire at minute 0 only, so every hour, not every hour and a half or two hours. And a step
 * on the day of month field starts again with every month (a step of 3 fires on days 1, 4, 7...
 * up to 31, then on day 1 of the next month), so `3d` is not strictly periodic either. A caller
 * that needs the interval exact reports the schedule as approximated.
 */
export function everyToCron(every: string): string {
  everyToMs(every); // throws unless it is a positive whole number followed by m, h or d
  const count = Number.parseInt(every, 10);
  const step = count === 1 ? "*" : `*/${count}`;
  switch (every.slice(-1)) {
    case "m":
      return `${step} * * * *`;
    case "h":
      return `0 ${step} * * *`;
    default:
      return `0 0 ${step} * *`;
  }
}

/**
 * Writes a millisecond interval in the largest unit that divides it exactly (days, then hours,
 * then minutes). Anything that is not a whole number of minutes has no schedule form: `null`.
 */
export function msToEvery(ms: number): string | null {
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  if (ms % MS_PER_DAY === 0) return `${ms / MS_PER_DAY}d`;
  if (ms % MS_PER_HOUR === 0) return `${ms / MS_PER_HOUR}h`;
  if (ms % MS_PER_MINUTE === 0) return `${ms / MS_PER_MINUTE}m`;
  return null;
}

function plainNumber(token: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(token)) return undefined;
  const value = Number(token);
  return value >= min && value <= max ? value : undefined;
}

function weekdayIndex(token: string): number | undefined {
  const value = fieldValue(token, DAY_OF_WEEK);
  // Both 0 and 7 are Sunday; a range or list is not a single day.
  return value === undefined ? undefined : value % 7;
}

const twoDigits = (value: number): string => String(value).padStart(2, "0");

// Words for the few cron shapes people write by hand; every other expression gets no description.
function describeCron(expression: string): string | undefined {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [minuteToken, hourToken, dayToken, monthToken, weekdayToken] = parts;
  const minute = plainNumber(minuteToken, 0, 59);
  if (minute === undefined || monthToken !== "*") return undefined;

  if (hourToken === "*") {
    return dayToken === "*" && weekdayToken === "*" ? `every hour at minute ${minute}` : undefined;
  }
  const hour = plainNumber(hourToken, 0, 23);
  if (hour === undefined) return undefined;
  const time = `${twoDigits(hour)}:${twoDigits(minute)}`;

  if (dayToken === "*") {
    if (weekdayToken === "*") return `every day at ${time}`;
    if (/^(?:1-5|mon-fri)$/i.test(weekdayToken)) return `every weekday at ${time}`;
    const weekday = weekdayIndex(weekdayToken);
    return weekday === undefined ? undefined : `every ${WEEKDAY_LABELS[weekday]} at ${time}`;
  }
  const day = plainNumber(dayToken, 1, 31);
  return day !== undefined && weekdayToken === "*"
    ? `monthly on day ${day} at ${time}`
    : undefined;
}

/**
 * A one-line, human-readable form of a schedule, e.g. `every weekday at 08:30 (Europe/Warsaw)`.
 * Simple cron shapes are put into words; any other cron expression is quoted as written. The
 * timezone, when given, is appended in parentheses.
 */
export function describeSchedule(s: Schedule, timezone?: string): string {
  let text: string;
  switch (s.kind) {
    case "cron":
      text = describeCron(s.expression) ?? `cron "${s.expression}"`;
      break;
    case "every":
      text = `every ${s.every}`;
      break;
    case "at":
      text = `once at ${s.at}`;
      break;
  }
  return timezone ? `${text} (${timezone})` : text;
}

/**
 * Command-line flags that create a job on the target scheduler. A cron expression and a one-off
 * time are read in the given zone; an interval has none.
 */
export function toOpenClawFlags(s: Schedule, tz: string): string[] {
  switch (s.kind) {
    case "cron":
      return ["--cron", s.expression, "--tz", tz];
    case "every":
      return ["--every", s.every];
    case "at":
      return ["--at", s.at, "--tz", tz];
  }
}

// date, then time with optional seconds and fraction, then a mandatory `Z` or `+hh:mm` offset
const INSTANT_PATTERN = new RegExp(
  [
    String.raw`^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})`,
    String.raw`T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.\d+)?)?`,
    String.raw`(?:Z|[+-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$`,
  ].join(""),
);

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// The manifest wants a full ISO 8601 instant, so a time without a zone, an impossible date (which
// `Date` would roll over, as 30 February to 2 March) or anything else that is not one is rejected.
// An accepted instant is written in UTC with seconds, milliseconds and `Z`.
function normaliseInstant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const groups = INSTANT_PATTERN.exec(value)?.groups;
  if (!groups) return undefined;
  // Groups for the seconds and the offset are absent when the string has none (or ends in `Z`).
  const part = (name: string): number => Number(groups[name] ?? 0);
  const month = part("month");
  const valid =
    month >= 1 &&
    month <= 12 &&
    part("day") >= 1 &&
    part("day") <= daysInMonth(part("year"), month) &&
    part("hour") <= 23 &&
    part("minute") <= 59 &&
    part("second") <= 59 &&
    part("offsetHour") <= 23 &&
    part("offsetMinute") <= 59;
  if (!valid) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// `YYYY-MM-DDTHH:MM`, seconds optional, and no zone or offset: the time as the clock on the wall
// of the zone shows it
const LOCAL_PATTERN = new RegExp(
  [
    String.raw`^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})`,
    String.raw`T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2}))?$`,
  ].join(""),
);

/** The wall clock reading read as if it were UTC, in milliseconds since the epoch. */
function asUtc(year: number, month: number, day: number, h: number, m: number, s: number): number {
  const date = new Date(0);
  // Not `Date.UTC`, which would read the years 0 to 99 as 1900 to 1999.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(h, m, s, 0);
  return date.getTime();
}

/**
 * The instant at which the clocks of `timeZone` show `local` (`YYYY-MM-DDTHH:MM` or with
 * `:SS`, no offset), written in UTC with a `Z`; `undefined` for a zone that does not exist or a
 * date that does not (30 February). The clocks' offset from UTC is read for the time taken as
 * UTC and subtracted, and read and subtracted once more where it changes in between, which is
 * where the clocks go forward or back. A time the clocks skip (02:30 on the day they go forward)
 * is not an error: the result is an instant the clocks show shifted by the change (03:30 in
 * Warsaw). A time they show twice gives the later of the two.
 */
export function zonedToInstant(local: string, timeZone: string): string | undefined {
  const groups = LOCAL_PATTERN.exec(local)?.groups;
  if (!groups) return undefined;
  // The group for the seconds is absent when the string has none.
  const part = (name: string): number => Number(groups[name] ?? 0);
  const [year, month, day, hour, minute, second] = [
    part("year"),
    part("month"),
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  ] as const;
  const valid =
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59;
  if (!valid) return undefined;

  let clock: Intl.DateTimeFormat;
  try {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return undefined; // a RangeError: there is no such zone
  }
  /** How far ahead of UTC the clocks of the zone are at `instant`, in milliseconds. */
  const offsetAt = (instant: number): number => {
    const parts = clock.formatToParts(new Date(instant));
    const shown = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((candidate) => candidate.type === type)?.value);
    const shownAsUtc = asUtc(
      shown("year"),
      shown("month"),
      shown("day"),
      shown("hour"),
      shown("minute"),
      shown("second"),
    );
    return shownAsUtc - instant;
  };

  const wall = asUtc(year, month, day, hour, minute, second);
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first)).toISOString();
}

/**
 * Reads the schedule of a job from the target scheduler's own store: `{ kind: "cron", expr, tz? }`,
 * `{ kind: "every", everyMs }` or `{ kind: "at", at }`. A cron job's zone comes back separately,
 * because the manifest keeps the timezone on the routine, not on the schedule. `null` means the
 * job has no schedule the manifest can express: an event trigger, an interval that is not a whole
 * number of minutes, a one-off time without a zone, or a shape this does not recognise.
 */
export function fromOpenClawJob(job: {
  schedule: unknown;
}): { schedule: Schedule; timezone?: string } | null {
  const spec = isRecord(job) ? job.schedule : undefined;
  if (!isRecord(spec)) return null;
  switch (spec.kind) {
    case "cron": {
      const expression = nonBlank(spec.expr);
      if (expression === undefined) return null;
      const timezone = nonBlank(spec.tz);
      const schedule: Schedule = { kind: "cron", expression };
      return timezone === undefined ? { schedule } : { schedule, timezone };
    }
    case "every": {
      const every = typeof spec.everyMs === "number" ? msToEvery(spec.everyMs) : null;
      return every === null ? null : { schedule: { kind: "every", every } };
    }
    case "at": {
      const at = normaliseInstant(spec.at);
      return at === undefined ? null : { schedule: { kind: "at", at } };
    }
    default:
      return null;
  }
}

/**
 * The schedule shapes OpenBot keeps for a routine (`ipc-routines.ts`). `once` is only in a
 * transfer file, never in an agent import. `advanced` is the plain form the design maps: some
 * months, some days of the month and a time. OpenBot writes the day and the time nested
 * (`{ kind: "days-of-month", days }`, `{ kind: "at-time", time }`); `fromOpenBotSchedule` reads
 * both forms.
 */
export type OpenBotSchedule =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string }
  | { kind: "monthly"; day: number; time: string }
  | {
      kind: "interval";
      amount: number;
      unit: "minutes" | "hours" | "days";
      /** When the interval started counting; OpenBot starts it at the import when it is absent. */
      anchorAt?: string;
    }
  | { kind: "advanced"; months: number[]; days: number[]; time: string }
  | { kind: "custom"; expression: string }
  | { kind: "once"; date: string; time: string };

/** The largest amount OpenBot takes in an interval. */
const OPENBOT_MAX_INTERVAL_AMOUNT = 100_000;
/** The shortest interval OpenBot runs a routine at, in minutes. */
export const OPENBOT_MIN_INTERVAL_MINUTES = 3;
/** The longest cron expression of a `custom` schedule. */
const OPENBOT_MAX_CRON_CHARS = 255;

const OPENBOT_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const OPENBOT_UNIT_SUFFIX = new Map([
  ["minutes", "m"],
  ["hours", "h"],
  ["days", "d"],
]);
// Largest unit first: an interval is written in the largest one that divides it exactly.
const OPENBOT_UNITS = [
  ["days", MS_PER_DAY],
  ["hours", MS_PER_HOUR],
  ["minutes", MS_PER_MINUTE],
] as const;

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** `HH:MM` on a 24 hour clock as its two parts. */
function clockOf(value: unknown): { hour: number; minute: number } | undefined {
  const match = typeof value === "string" ? OPENBOT_TIME.exec(value) : null;
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : undefined;
}

/** A non-empty list of whole numbers within a range. */
function numberList(value: unknown, min: number, max: number): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const entries: readonly unknown[] = value;
  return entries.every((entry) => integerIn(entry, min, max)) ? (entries as number[]) : undefined;
}

// The cron of an `advanced` schedule. Both forms are read: the plain one (a list of days of the
// month and a time) and OpenBot's nested one. A nested time that repeats within a day has no
// cron form that keeps its meaning.
function advancedToCron(spec: Record<string, unknown>): string | undefined {
  const months = numberList(spec.months, 1, 12);
  if (months === undefined) return undefined;
  let clock: { hour: number; minute: number } | undefined;
  let dayOfMonth = "*";
  let dayOfWeek = "*";
  if (Array.isArray(spec.days)) {
    const days = numberList(spec.days, 1, 31);
    if (days === undefined) return undefined;
    dayOfMonth = days.join(",");
    clock = clockOf(spec.time);
  } else if (isRecord(spec.days)) {
    if (spec.days.kind === "days-of-month") {
      const days = numberList(spec.days.days, 1, 31);
      if (days === undefined) return undefined;
      dayOfMonth = days.join(",");
    } else if (spec.days.kind === "days-of-week") {
      const days = numberList(spec.days.days, 0, 6);
      if (days === undefined) return undefined;
      dayOfWeek = days.join(",");
    } else if (spec.days.kind !== "every-day") {
      return undefined;
    }
    clock =
      isRecord(spec.time) && spec.time.kind === "at-time" ? clockOf(spec.time.time) : undefined;
  }
  if (clock === undefined) return undefined;
  return `${clock.minute} ${clock.hour} ${dayOfMonth} ${months.join(",")} ${dayOfWeek}`;
}

/**
 * Reads the schedule of an OpenBot routine, from an agent import or a transfer file, as a
 * manifest schedule (the table in the design). `timezone` is the zone of the routine, which a
 * `once` date and time are read in. An interval's `anchorAt` comes back as `extra`, for the
 * caller to keep with the routine. `null` means the schedule has no manifest form: a shape this
 * does not know, a value out of range, a `custom` expression that is not cron, a date that does
 * not exist or a zone that does not.
 */
export function fromOpenBotSchedule(
  schedule: unknown,
  timezone: string,
): { schedule: Schedule; extra?: Record<string, unknown> } | null {
  if (!isRecord(schedule)) return null;
  const cron = (expression: string): { schedule: Schedule } => ({
    schedule: { kind: "cron", expression },
  });
  switch (schedule.kind) {
    case "hourly":
      return integerIn(schedule.minute, 0, 59) ? cron(`${schedule.minute} * * * *`) : null;
    case "daily":
    case "weekdays": {
      const clock = clockOf(schedule.time);
      if (clock === undefined) return null;
      const days = schedule.kind === "daily" ? "*" : "1-5";
      return cron(`${clock.minute} ${clock.hour} * * ${days}`);
    }
    case "weekly": {
      const clock = clockOf(schedule.time);
      if (clock === undefined || !integerIn(schedule.weekday, 0, 6)) return null;
      return cron(`${clock.minute} ${clock.hour} * * ${schedule.weekday}`);
    }
    case "monthly": {
      const clock = clockOf(schedule.time);
      if (clock === undefined || !integerIn(schedule.day, 1, 31)) return null;
      return cron(`${clock.minute} ${clock.hour} ${schedule.day} * *`);
    }
    case "interval": {
      const suffix =
        typeof schedule.unit === "string" ? OPENBOT_UNIT_SUFFIX.get(schedule.unit) : undefined;
      if (suffix === undefined || !integerIn(schedule.amount, 1, OPENBOT_MAX_INTERVAL_AMOUNT)) {
        return null;
      }
      const every: Schedule = { kind: "every", every: `${schedule.amount}${suffix}` };
      const anchorAt = schedule.anchorAt;
      return typeof anchorAt === "string" && !Number.isNaN(Date.parse(anchorAt))
        ? { schedule: every, extra: { anchorAt } }
        : { schedule: every };
    }
    case "advanced": {
      const expression = advancedToCron(schedule);
      return expression === undefined ? null : cron(expression);
    }
    case "custom": {
      const expression = nonBlank(schedule.expression);
      return expression !== undefined && parseCron(expression).ok ? cron(expression) : null;
    }
    case "once": {
      if (typeof schedule.date !== "string" || clockOf(schedule.time) === undefined) return null;
      const at = zonedToInstant(`${schedule.date}T${String(schedule.time)}`, timezone);
      return at === undefined ? null : { schedule: { kind: "at", at } };
    }
    default:
      return null;
  }
}

function plainList(token: string, min: number, max: number): number[] | undefined {
  const values = token.split(",").map((entry) => plainNumber(entry, min, max));
  return values.every((value) => value !== undefined) ? (values as number[]) : undefined;
}

// The named shape of a five field cron expression, if it has one: the shapes `describeCron` puts
// into words, and the advanced one (lists of days of the month and of months).
function namedCronShape(
  parts: readonly string[],
): Exclude<OpenBotSchedule, { kind: "interval" | "custom" | "once" }> | undefined {
  const [minuteToken, hourToken, dayToken, monthToken, weekdayToken] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minute = plainNumber(minuteToken, 0, 59);
  if (minute === undefined) return undefined;
  if (hourToken === "*") {
    return dayToken === "*" && monthToken === "*" && weekdayToken === "*"
      ? { kind: "hourly", minute }
      : undefined;
  }
  const hour = plainNumber(hourToken, 0, 23);
  if (hour === undefined) return undefined;
  const time = `${twoDigits(hour)}:${twoDigits(minute)}`;

  if (monthToken === "*") {
    if (dayToken === "*") {
      if (weekdayToken === "*") return { kind: "daily", time };
      if (/^(?:1-5|mon-fri)$/i.test(weekdayToken)) return { kind: "weekdays", time };
      const weekday = weekdayIndex(weekdayToken);
      return weekday === undefined ? undefined : { kind: "weekly", weekday, time };
    }
    const day = plainNumber(dayToken, 1, 31);
    return day !== undefined && weekdayToken === "*" ? { kind: "monthly", day, time } : undefined;
  }
  if (weekdayToken !== "*") return undefined;
  const months = plainList(monthToken, 1, 12);
  const days = plainList(dayToken, 1, 31);
  return months !== undefined && days !== undefined
    ? { kind: "advanced", months, days, time }
    : undefined;
}

/**
 * Writes a manifest schedule as an OpenBot schedule. A cron expression of five fields becomes
 * the shape that names it (hourly, daily, weekdays, weekly, monthly, or advanced for lists of
 * days of the month and of months) and any other cron expression becomes `custom`. An interval
 * becomes an `interval` in the largest unit that divides it. `null` means OpenBot cannot hold
 * the schedule: a one-off time (only a transfer file has those), an interval under 3 minutes or
 * over what OpenBot takes, and a cron expression that is not valid or is over 255 characters.
 *
 * The `advanced` result is the flat form of the design (`days: number[]`, `time: string`), which
 * OpenBot does not read: put the result through `toOpenBotWireSchedule` before it is written.
 */
export function toOpenBotSchedule(
  schedule: Schedule,
): Exclude<OpenBotSchedule, { kind: "once" }> | null {
  switch (schedule.kind) {
    case "at":
      return null;
    case "every": {
      let ms: number;
      try {
        ms = everyToMs(schedule.every);
      } catch {
        return null;
      }
      if (ms < OPENBOT_MIN_INTERVAL_MINUTES * MS_PER_MINUTE) return null;
      for (const [unit, size] of OPENBOT_UNITS) {
        if (ms % size !== 0) continue;
        const amount = ms / size;
        return amount <= OPENBOT_MAX_INTERVAL_AMOUNT ? { kind: "interval", amount, unit } : null;
      }
      return null;
    }
    case "cron": {
      const expression = schedule.expression.trim();
      if (!parseCron(expression).ok || expression.length > OPENBOT_MAX_CRON_CHARS) return null;
      const parts = expression.split(/\s+/);
      const named = parts.length === 5 ? namedCronShape(parts) : undefined;
      return named ?? { kind: "custom", expression };
    }
  }
}

/**
 * The schedule as OpenBot reads it from a file it is given. Every shape is its own form but
 * `advanced`: OpenBot keeps the days and the time of that one as choices of their own
 * (`{ kind: "days-of-month", days }` and `{ kind: "at-time", time }`), where the plain form of
 * `OpenBotSchedule` has a list and a string. Whatever a writer puts in a file for OpenBot to read
 * goes through here.
 */
export function toOpenBotWireSchedule(schedule: OpenBotSchedule): unknown {
  if (schedule.kind !== "advanced") return schedule;
  return {
    kind: "advanced",
    months: schedule.months,
    days: { kind: "days-of-month", days: schedule.days },
    time: { kind: "at-time", time: schedule.time },
  };
}
