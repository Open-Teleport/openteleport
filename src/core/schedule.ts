import type { Schedule } from "./schema.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
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
