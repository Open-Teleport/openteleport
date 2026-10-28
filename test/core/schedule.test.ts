import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  everyToCron,
  everyToMs,
  fromOpenClawJob,
  msToEvery,
  parseCron,
  toOpenClawFlags,
  zonedToInstant,
} from "../../src/core/schedule.js";
import { type Schedule, ScheduleSchema } from "../../src/core/schema.js";

describe("parseCron", () => {
  it("accepts a weekday expression", () => {
    const result = parseCron("30 8 * * 1-5");
    expect(result.ok).toBe(true);
    expect(result).toStrictEqual({ ok: true, fields: 5 });
  });

  it.each([
    "* * * * *",
    "30 8 * * 1-5",
    "*/15 * * * *",
    "0 0 1 1 *",
    "0,30 8-18 * * mon-fri",
    "0 9 * * MON",
    "0 9 * * Sun",
    "0 9 * * 0",
    "0 9 * * 7",
    "0 9 1 JAN *",
    "0 9 1 jan-dec *",
    "0 0 1-31/2 * *",
    "5-10/2 * * * *",
    "5/10 * * * *",
    "0 0 * * mon,wed,fri",
    "0 0 * * mon-fri/2",
    "59 23 31 12 6",
    "  30   8\t* * 1-5  ",
  ])("accepts the 5-field expression %j", (expr) => {
    expect(parseCron(expr)).toStrictEqual({ ok: true, fields: 5 });
  });

  it.each(["0 30 8 * * 1-5", "*/10 * * * * *", "59 59 23 31 12 7", "0 0 0 * * mon"])(
    "accepts the 6-field expression %j",
    (expr) => {
      expect(parseCron(expr)).toStrictEqual({ ok: true, fields: 6 });
    },
  );

  it("rejects text that is not a cron expression", () => {
    const result = parseCron("x");
    expect(result.ok).toBe(false);
  });

  it.each([
    ["", "5 or 6 fields"],
    ["   ", "5 or 6 fields"],
    ["x", "5 or 6 fields"],
    ["* * * *", "5 or 6 fields"],
    ["* * * * * * *", "5 or 6 fields"],
    ["@daily", "5 or 6 fields"],
  ])("rejects %j for its field count", (expr, reason) => {
    const result = parseCron(expr);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(reason);
  });

  it.each([
    ["60 * * * *", "minute"],
    ["* 24 * * *", "hour"],
    ["* * 0 * *", "day of month"],
    ["* * 32 * *", "day of month"],
    ["* * * 0 *", "month"],
    ["* * * 13 *", "month"],
    ["* * * * 8", "day of week"],
    ["60 0 0 * * *", "second"],
    ["5-1 * * * *", "minute"],
    ["*/0 * * * *", "minute"],
    ["*/ * * * *", "minute"],
    ["*/-1 * * * *", "minute"],
    ["*/1/2 * * * *", "minute"],
    ["1- * * * *", "minute"],
    ["-1 * * * *", "minute"],
    ["1-2-3 * * * *", "minute"],
    ["1,,2 * * * *", "minute"],
    [",1 * * * *", "minute"],
    ["1, * * * *", "minute"],
    ["1.5 * * * *", "minute"],
    ["** * * * *", "minute"],
    ["a * * * *", "minute"],
    ["mon * * * *", "minute"],
    ["* mon * * *", "hour"],
    ["* * jan * *", "day of month"],
    ["* * * mon *", "month"],
    ["* * * * jan", "day of week"],
    ["* * * foo *", "month"],
    ["* * * * funday", "day of week"],
    ["* * * constructor *", "month"],
    ["* * * * toString", "day of week"],
    ["* * * * mon-xyz", "day of week"],
    ["? * * * *", "minute"],
    ["L * * * *", "minute"],
  ])("rejects %j and names the %s field", (expr, field) => {
    const result = parseCron(expr);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain(field);
  });
});

describe("everyToMs", () => {
  it.each([
    ["1m", 60_000],
    ["30m", 1_800_000],
    ["90m", 5_400_000],
    ["1h", 3_600_000],
    ["2h", 7_200_000],
    ["24h", 86_400_000],
    ["1d", 86_400_000],
    ["7d", 604_800_000],
  ])("converts %s to %i ms", (every, ms) => {
    expect(everyToMs(every)).toBe(ms);
  });

  it.each([
    "",
    "m",
    "30",
    "0m",
    "05m",
    "-5m",
    "1.5h",
    " 5m",
    "5m ",
    "5 m",
    "5s",
    "1w",
    "30M",
    "1h30m",
    "99999999999999999999d",
  ])("throws for %j", (every) => {
    expect(() => everyToMs(every)).toThrow(/duration/i);
  });
});

describe("everyToCron", () => {
  it.each([
    ["30m", "*/30 * * * *"],
    ["2h", "0 */2 * * *"],
    ["3d", "0 0 */3 * *"],
    ["1m", "* * * * *"],
    ["1h", "0 * * * *"],
    ["1d", "0 0 * * *"],
    ["15m", "*/15 * * * *"],
    ["12h", "0 */12 * * *"],
    ["7d", "0 0 */7 * *"],
  ])("converts %s to %j", (every, cron) => {
    expect(everyToCron(every)).toBe(cron);
  });

  it.each(["30m", "2h", "3d", "1m", "1h", "1d", "5m", "12h"])(
    "gives a cron expression parseCron accepts for %s",
    (every) => {
      expect(parseCron(everyToCron(every))).toEqual({ ok: true, fields: 5 });
    },
  );

  it.each([
    "",
    "m",
    "30",
    "0m",
    "05m",
    "-5m",
    "1.5h",
    " 5m",
    "5m ",
    "5s",
    "1w",
    "30M",
    "1h30m",
    "99999999999999999999d",
  ])("throws for %j, as everyToMs does", (every) => {
    const messageOf = (run: () => unknown): string => {
      try {
        run();
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    };

    expect(messageOf(() => everyToCron(every))).toMatch(/duration/i);
    expect(messageOf(() => everyToCron(every))).toBe(messageOf(() => everyToMs(every)));
  });
});

describe("msToEvery", () => {
  it.each([
    [60_000, "1m"],
    [1_800_000, "30m"],
    [5_400_000, "90m"],
    [3_600_000, "1h"],
    [7_200_000, "2h"],
    [86_400_000, "1d"],
    [172_800_000, "2d"],
    [90_000, null],
    [1_000, null],
    [1, null],
    [0, null],
    [-60_000, null],
    [60_000.5, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [Number.MAX_VALUE, null],
  ])("turns %d ms into %j", (ms, every) => {
    expect(msToEvery(ms)).toBe(every);
  });

  it.each(["1m", "30m", "90m", "2h", "36h", "1d", "7d"])(
    "round-trips %s through everyToMs",
    (every) => {
      const ms = everyToMs(every);
      const back = msToEvery(ms);
      expect(back).not.toBeNull();
      expect(everyToMs(back as string)).toBe(ms);
    },
  );

  it("prefers the largest whole unit", () => {
    expect(msToEvery(everyToMs("120m"))).toBe("2h");
    expect(msToEvery(everyToMs("48h"))).toBe("2d");
    expect(msToEvery(everyToMs("1440m"))).toBe("1d");
  });
});

describe("zonedToInstant", () => {
  /** The time on the clocks of `zone` at `instant`, as `YYYY-MM-DDTHH:MM`. */
  function onTheWall(instant: string, zone: string): string {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(instant));
    const at = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    return `${at("year")}-${at("month")}-${at("day")}T${at("hour")}:${at("minute")}`;
  }

  it.each([
    ["winter time in Warsaw", "2026-11-01T09:30", "Europe/Warsaw", "2026-11-01T08:30:00.000Z"],
    ["summer time in Warsaw", "2026-07-01T09:30", "Europe/Warsaw", "2026-07-01T07:30:00.000Z"],
    ["UTC", "2026-11-01T09:30", "UTC", "2026-11-01T09:30:00.000Z"],
    ["a zone ahead of UTC without daylight saving", "2026-07-01T09:30", "Asia/Tokyo", "2026-07-01T00:30:00.000Z"],
    ["a zone with a half hour offset", "2026-07-01T09:30", "Asia/Kolkata", "2026-07-01T04:00:00.000Z"],
    ["a zone behind UTC in summer", "2026-07-01T09:30", "America/New_York", "2026-07-01T13:30:00.000Z"],
    ["a zone behind UTC in winter", "2026-11-02T09:30", "America/New_York", "2026-11-02T14:30:00.000Z"],
    ["a zone whose day starts a day ahead", "2026-12-31T23:59", "Pacific/Kiritimati", "2026-12-31T09:59:00.000Z"],
    ["seconds", "2026-11-01T09:30:15", "Europe/Warsaw", "2026-11-01T08:30:15.000Z"],
    ["the day before the clocks go back", "2026-10-24T23:30", "Europe/Warsaw", "2026-10-24T21:30:00.000Z"],
    ["the first minute after the clocks go forward", "2026-03-29T03:00", "Europe/Warsaw", "2026-03-29T01:00:00.000Z"],
    ["the last minute before the clocks go forward", "2026-03-29T01:59", "Europe/Warsaw", "2026-03-29T00:59:00.000Z"],
    ["a leap day", "2028-02-29T10:00", "UTC", "2028-02-29T10:00:00.000Z"],
    ["midnight", "2026-07-01T00:00", "Europe/Warsaw", "2026-06-30T22:00:00.000Z"],
  ])("reads %s", (_what, local, zone, instant) => {
    expect(zonedToInstant(local, zone)).toBe(instant);
  });

  it("gives an instant for a time that does not exist when the clocks go forward", () => {
    const instant = zonedToInstant("2026-03-29T02:30", "Europe/Warsaw");

    expect(instant).toBeDefined();
    expect(["2026-03-29T01:30", "2026-03-29T03:30"]).toContain(
      onTheWall(instant ?? "", "Europe/Warsaw"),
    );
  });

  it("gives one of the two instants for a time that happens twice when the clocks go back", () => {
    const instant = zonedToInstant("2026-10-25T02:30", "Europe/Warsaw");

    expect(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]).toContain(instant);
    expect(onTheWall(instant ?? "", "Europe/Warsaw")).toBe("2026-10-25T02:30");
  });

  it("reads back to the time it was given, wherever the zone has the time", () => {
    for (const zone of ["Europe/Warsaw", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"]) {
      for (const local of ["2026-01-15T08:00", "2026-07-15T08:00", "2026-12-31T23:59"]) {
        expect(onTheWall(zonedToInstant(local, zone) ?? "", zone)).toBe(local);
      }
    }
  });

  it("is undefined for a zone that does not exist", () => {
    expect(zonedToInstant("2026-11-01T09:30", "Mars/Olympus")).toBeUndefined();
    expect(zonedToInstant("2026-11-01T09:30", "")).toBeUndefined();
  });

  it.each([
    ["30 February", "2026-02-30T09:30"],
    ["29 February of a year that is not a leap year", "2026-02-29T09:30"],
    ["29 February of a century that is not a leap year", "2100-02-29T09:30"],
    ["month 13", "2026-13-01T09:30"],
    ["month 0", "2026-00-10T09:30"],
    ["day 0", "2026-11-00T09:30"],
    ["31 November", "2026-11-31T09:30"],
    ["hour 24", "2026-11-01T24:00"],
    ["minute 60", "2026-11-01T09:60"],
    ["second 60", "2026-11-01T09:30:60"],
    ["a date without a time", "2026-11-01"],
    ["a time with a Z", "2026-11-01T09:30Z"],
    ["a time with an offset", "2026-11-01T09:30+01:00"],
    ["fractions of a second", "2026-11-01T09:30:00.5"],
    ["a space for the T", "2026-11-01 09:30"],
    ["a two digit year", "26-11-01T09:30"],
    ["nothing", ""],
    ["words", "tomorrow morning"],
  ])("is undefined for %s", (_what, local) => {
    expect(zonedToInstant(local, "UTC")).toBeUndefined();
    expect(zonedToInstant(local, "Europe/Warsaw")).toBeUndefined();
  });
});

describe("describeSchedule", () => {
  it("describes a weekday cron with its timezone", () => {
    expect(
      describeSchedule({ kind: "cron", expression: "30 8 * * 1-5" }, "Europe/Warsaw"),
    ).toBe("every weekday at 08:30 (Europe/Warsaw)");
  });

  it.each([
    ["30 8 * * 1-5", "every weekday at 08:30"],
    ["30 8 * * mon-fri", "every weekday at 08:30"],
    ["30 8 * * MON-FRI", "every weekday at 08:30"],
    ["15 * * * *", "every hour at minute 15"],
    ["0 * * * *", "every hour at minute 0"],
    ["5 9 * * *", "every day at 09:05"],
    ["0 0 * * *", "every day at 00:00"],
    ["59 23 * * *", "every day at 23:59"],
    ["0 18 * * 5", "every Friday at 18:00"],
    ["0 9 * * 1", "every Monday at 09:00"],
    ["0 9 * * mon", "every Monday at 09:00"],
    ["0 9 * * SUN", "every Sunday at 09:00"],
    ["0 9 * * 0", "every Sunday at 09:00"],
    ["0 9 * * 7", "every Sunday at 09:00"],
    ["0 9 * * 6", "every Saturday at 09:00"],
    ["0 9 15 * *", "monthly on day 15 at 09:00"],
    ["30 7 1 * *", "monthly on day 1 at 07:30"],
  ])("describes the simple cron %j as %j", (expression, text) => {
    expect(describeSchedule({ kind: "cron", expression })).toBe(text);
  });

  it.each([
    "*/15 * * * *",
    "0,30 * * * *",
    "0 8-18 * * *",
    "*/2 8 * * *",
    "0 8 * * 1-4",
    "0 8 * * 1,3",
    "0 8 * * 8",
    "0 8 1 6 *",
    "0 8 1 * 1",
    "0 8 1,15 * *",
    "0 8 * 6 *",
    "60 8 * * *",
    "0 24 * * *",
    "0 8 32 * *",
    "0 8 0 * *",
    "0 30 8 * * *",
    "x",
  ])("falls back to the raw expression for %j", (expression) => {
    expect(describeSchedule({ kind: "cron", expression })).toBe(`cron "${expression}"`);
  });

  it("describes an interval", () => {
    expect(describeSchedule({ kind: "every", every: "30m" })).toBe("every 30m");
    expect(describeSchedule({ kind: "every", every: "2d" })).toBe("every 2d");
  });

  it("describes a one-off run", () => {
    expect(describeSchedule({ kind: "at", at: "2026-11-01T09:00:00+01:00" })).toBe(
      "once at 2026-11-01T09:00:00+01:00",
    );
  });

  it.each<[Schedule, string]>([
    [{ kind: "cron", expression: "*/15 * * * *" }, 'cron "*/15 * * * *" (UTC)'],
    [{ kind: "every", every: "30m" }, "every 30m (UTC)"],
    [{ kind: "at", at: "2026-11-01T08:00:00Z" }, "once at 2026-11-01T08:00:00Z (UTC)"],
  ])("appends the timezone to %j", (schedule, text) => {
    expect(describeSchedule(schedule, "UTC")).toBe(text);
  });

  it("adds no suffix for a missing or empty timezone", () => {
    const schedule: Schedule = { kind: "cron", expression: "30 8 * * 1-5" };
    expect(describeSchedule(schedule)).toBe("every weekday at 08:30");
    expect(describeSchedule(schedule, undefined)).toBe("every weekday at 08:30");
    expect(describeSchedule(schedule, "")).toBe("every weekday at 08:30");
  });
});

describe("toOpenClawFlags", () => {
  it("passes a cron expression with its timezone", () => {
    expect(toOpenClawFlags({ kind: "cron", expression: "30 8 * * 1-5" }, "Europe/Warsaw")).toEqual([
      "--cron",
      "30 8 * * 1-5",
      "--tz",
      "Europe/Warsaw",
    ]);
  });

  it("passes an interval without a timezone", () => {
    expect(toOpenClawFlags({ kind: "every", every: "30m" }, "Europe/Warsaw")).toEqual([
      "--every",
      "30m",
    ]);
  });

  it("passes a one-off run with its timezone", () => {
    expect(
      toOpenClawFlags({ kind: "at", at: "2026-11-01T09:00:00+01:00" }, "Europe/Warsaw"),
    ).toEqual(["--at", "2026-11-01T09:00:00+01:00", "--tz", "Europe/Warsaw"]);
  });

  it("keeps an expression with spaces as one argument", () => {
    const flags = toOpenClawFlags({ kind: "cron", expression: "0 9 * * mon" }, "UTC");
    expect(flags).toHaveLength(4);
    expect(flags[1]).toBe("0 9 * * mon");
  });
});

describe("fromOpenClawJob", () => {
  it("reads a cron job with its timezone", () => {
    expect(
      fromOpenClawJob({ schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Warsaw" } }),
    ).toStrictEqual({
      schedule: { kind: "cron", expression: "0 8 * * 1-5" },
      timezone: "Europe/Warsaw",
    });
  });

  it("reads a cron job without a timezone", () => {
    expect(fromOpenClawJob({ schedule: { kind: "cron", expr: "*/5 * * * *" } })).toStrictEqual({
      schedule: { kind: "cron", expression: "*/5 * * * *" },
    });
  });

  it.each([
    ["empty", ""],
    ["blank", "  "],
    ["a number", 5],
    ["null", null],
    ["an object", {}],
  ])("ignores a cron timezone that is %s", (_name, tz) => {
    expect(fromOpenClawJob({ schedule: { kind: "cron", expr: "0 8 * * *", tz } })).toStrictEqual({
      schedule: { kind: "cron", expression: "0 8 * * *" },
    });
  });

  it("trims a cron expression and its timezone", () => {
    expect(
      fromOpenClawJob({ schedule: { kind: "cron", expr: " 0 8 * * * ", tz: " UTC " } }),
    ).toStrictEqual({ schedule: { kind: "cron", expression: "0 8 * * *" }, timezone: "UTC" });
  });

  it.each([
    [1_800_000, "30m"],
    [7_200_000, "2h"],
    [86_400_000, "1d"],
    [60_000, "1m"],
  ])("reads an interval of %d ms as %s", (everyMs, every) => {
    expect(fromOpenClawJob({ schedule: { kind: "every", everyMs } })).toStrictEqual({
      schedule: { kind: "every", every },
    });
  });

  it.each([
    ["not a whole minute", 90_000],
    ["zero", 0],
    ["negative", -60_000],
    ["fractional", 60_000.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["a numeric string", "1800000"],
    ["missing", undefined],
    ["null", null],
  ])("returns null for an interval that is %s", (_name, everyMs) => {
    expect(fromOpenClawJob({ schedule: { kind: "every", everyMs } })).toBeNull();
  });

  it.each([
    ["an offset", "2026-11-01T09:00:00+01:00", "2026-11-01T08:00:00.000Z"],
    ["a negative offset", "2026-11-01T09:00:00-05:00", "2026-11-01T14:00:00.000Z"],
    ["Z", "2026-11-01T09:00:00Z", "2026-11-01T09:00:00.000Z"],
    ["milliseconds", "2026-11-01T09:00:00.250Z", "2026-11-01T09:00:00.250Z"],
    ["microseconds", "2026-11-01T09:00:00.123456Z", "2026-11-01T09:00:00.123Z"],
    ["no seconds", "2026-11-01T09:00Z", "2026-11-01T09:00:00.000Z"],
    ["an offset across midnight", "2026-11-01T00:30:00+02:00", "2026-10-31T22:30:00.000Z"],
    ["a leap day", "2028-02-29T12:00:00Z", "2028-02-29T12:00:00.000Z"],
  ])("normalises a one-off time with %s to UTC", (_name, at, normalised) => {
    expect(fromOpenClawJob({ schedule: { kind: "at", at } })).toStrictEqual({
      schedule: { kind: "at", at: normalised },
    });
  });

  it.each([
    ["no zone", "2026-11-01T09:00"],
    ["no zone, with seconds", "2026-11-01T09:00:00"],
    ["a date only", "2026-11-01"],
    ["a time only", "09:00:00Z"],
    ["text", "tomorrow at nine"],
    ["an empty string", ""],
    ["an impossible month", "2026-13-01T09:00:00Z"],
    ["an impossible day", "2026-02-30T09:00:00Z"],
    ["a non-leap Feb 29", "2026-02-29T09:00:00Z"],
    ["hour 24", "2026-11-01T24:00:00Z"],
    ["an impossible minute", "2026-11-01T09:60:00Z"],
    ["an impossible second", "2026-11-01T09:00:60Z"],
    ["an impossible offset", "2026-11-01T09:00:00+24:00"],
    ["an offset without a colon", "2026-11-01T09:00:00+0100"],
    ["a space instead of T", "2026-11-01 09:00:00Z"],
    ["an epoch number", 1_793_523_600_000],
    ["null", null],
    ["a date object", new Date("2026-11-01T09:00:00Z")],
  ])("returns null for a one-off time with %s", (_name, at) => {
    expect(fromOpenClawJob({ schedule: { kind: "at", at } })).toBeNull();
  });

  it("returns null for a one-off job with no time", () => {
    expect(fromOpenClawJob({ schedule: { kind: "at" } })).toBeNull();
  });

  it.each([
    ["on-exit", { kind: "on-exit" }],
    ["stream", { kind: "stream" }],
    ["an unknown kind", { kind: "lunar", phase: "full" }],
    ["a kind with different case", { kind: "Cron", expr: "0 8 * * *" }],
    ["no kind", { expr: "0 8 * * *" }],
    ["a numeric kind", { kind: 1, expr: "0 8 * * *" }],
    ["a cron without an expression", { kind: "cron" }],
    ["a cron with a numeric expression", { kind: "cron", expr: 5 }],
    ["a cron with an empty expression", { kind: "cron", expr: "" }],
    ["a cron with a blank expression", { kind: "cron", expr: "   " }],
    ["a cron with the schema field name", { kind: "cron", expression: "0 8 * * *" }],
    ["an interval with the schema field name", { kind: "every", every: "30m" }],
    ["an empty object", {}],
    ["null", null],
    ["undefined", undefined],
    ["a string", "0 8 * * *"],
    ["a number", 1_800_000],
    ["an array", [{ kind: "cron", expr: "0 8 * * *" }]],
  ])("returns null for %s", (_name, schedule) => {
    expect(fromOpenClawJob({ schedule })).toBeNull();
  });

  it("returns null when the job itself is not an object", () => {
    expect(fromOpenClawJob(null as never)).toBeNull();
    expect(fromOpenClawJob(undefined as never)).toBeNull();
    expect(fromOpenClawJob("cron" as never)).toBeNull();
    expect(fromOpenClawJob({} as never)).toBeNull();
  });

  it("ignores everything else on the job", () => {
    expect(
      fromOpenClawJob({
        schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 1, jitter: true },
        name: "Daily digest",
      } as { schedule: unknown }),
    ).toStrictEqual({ schedule: { kind: "every", every: "1h" } });
  });

  it.each<[string, unknown]>([
    ["cron", { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Warsaw" }],
    ["every", { kind: "every", everyMs: 5_400_000 }],
    ["at", { kind: "at", at: "2026-11-01T09:00:00+01:00" }],
  ])("only ever returns a schedule the manifest schema accepts (%s)", (_name, schedule) => {
    const result = fromOpenClawJob({ schedule });
    expect(result).not.toBeNull();
    expect(ScheduleSchema.safeParse(result?.schedule).success).toBe(true);
  });
});

describe("schedule round-trips", () => {
  // The inverse of fromOpenClawJob for the job shape it reads; the CLI flags carry the same values.
  const toJobSchedule = (schedule: Schedule, tz: string): unknown => {
    switch (schedule.kind) {
      case "cron":
        return { kind: "cron", expr: schedule.expression, tz };
      case "every":
        return { kind: "every", everyMs: everyToMs(schedule.every) };
      case "at":
        return { kind: "at", at: schedule.at };
    }
  };

  it.each<Schedule>([
    { kind: "cron", expression: "30 8 * * 1-5" },
    { kind: "cron", expression: "*/15 * * * *" },
    { kind: "every", every: "30m" },
    { kind: "every", every: "2h" },
    { kind: "every", every: "1d" },
    { kind: "at", at: "2026-11-01T08:00:00.000Z" },
  ])("reads back what a job holds for %j", (schedule) => {
    const job = { schedule: toJobSchedule(schedule, "Europe/Warsaw") };
    const result = fromOpenClawJob(job);
    expect(result?.schedule).toStrictEqual(schedule);
    expect(result?.timezone).toBe(schedule.kind === "cron" ? "Europe/Warsaw" : undefined);
  });

  it("keeps the instant of a one-off run that is stored with an offset", () => {
    const schedule: Schedule = { kind: "at", at: "2026-11-01T09:00:00+01:00" };
    const result = fromOpenClawJob({ schedule: toJobSchedule(schedule, "Europe/Warsaw") });
    expect(result?.schedule.kind).toBe("at");
    expect(result?.schedule.kind === "at" && Date.parse(result.schedule.at)).toBe(
      Date.parse(schedule.at),
    );
  });

  it("emits flags whose values are the schedule's own fields", () => {
    const cron: Schedule = { kind: "cron", expression: "30 8 * * 1-5" };
    const flags = toOpenClawFlags(cron, "UTC");
    expect(flags.slice(0, 2)).toEqual(["--cron", cron.expression]);
    const every: Schedule = { kind: "every", every: "30m" };
    expect(toOpenClawFlags(every, "UTC")).toEqual(["--every", every.every]);
  });
});
