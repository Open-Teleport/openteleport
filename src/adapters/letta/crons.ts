// Letta Code's scheduled tasks: `~/.letta/crons.json` on the way in, `letta cron add` lines on the
// way out [L9][L12][L17].
import { readFile } from "node:fs/promises";
import { everyToCron } from "../../core/schedule.js";
import { type Routine, RoutineSchema, ScheduleSchema } from "../../core/schema.js";
import { oneLine, withoutMark } from "./memfs.js";

/** One entry of `tasks[]` in `crons.json`; the fields Letta keeps beyond these stay in it. */
export type LettaCronTask = Record<string, unknown> & {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  status: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed, non-blank string, or `undefined`. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A string field of a task as it is, `""` when it is not a string. */
const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The tasks in `crons.json`. A file that is not there holds none. A file that cannot be read, is
 * not JSON or does not hold a `tasks` list is `{ error }`, so that the caller can say so and go
 * on without the routines. An entry without a string `agent_id` belongs to no agent and is left
 * out; `id`, `name`, `prompt` and `status` that are not strings read as `""`, which
 * `taskToRoutine` then reports as a task it cannot use.
 */
export async function readCrons(
  file: string,
): Promise<{ tasks: LettaCronTask[] } | { error: string }> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { tasks: [] };
    return { error: `${file} cannot be read: ${(error as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(withoutMark(source));
  } catch (error) {
    return { error: `${file} is not valid JSON: ${(error as Error).message}` };
  }
  if (!isRecord(json)) return { error: `${file} is not a JSON object` };
  const list = json.tasks ?? [];
  if (!Array.isArray(list)) return { error: `${file} has no list of tasks` };

  const tasks: LettaCronTask[] = [];
  for (const entry of list as unknown[]) {
    if (!isRecord(entry) || typeof entry.agent_id !== "string") continue;
    tasks.push({
      ...entry,
      id: stringOf(entry.id),
      agent_id: entry.agent_id,
      name: stringOf(entry.name),
      prompt: stringOf(entry.prompt),
      status: stringOf(entry.status),
    });
  }
  return { tasks };
}

// Building a formatter is the portable IANA check: V8 throws a RangeError for unknown zones.
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

type Converted = {
  routine: Routine;
  extra: Record<string, unknown>;
  /** The task is recurring but names no valid time zone, so UTC was taken (Cloud runs UTC). */
  assumedUtc: boolean;
};

const STATUS_REASONS: Record<string, string> = {
  fired: "a one-off task that already ran",
  missed: "a one-off task that did not run when it was due",
  cancelled: "a task that was cancelled",
};

/** The routine a task stands for, or why it stands for none. */
function convert(task: LettaCronTask): Converted | { skip: string } {
  const { status } = task;
  if (status !== "active" && status !== "paused") {
    const why = STATUS_REASONS[status];
    return {
      skip:
        why === undefined
          ? `its status "${status}" is not known`
          : `its status is ${status}, ${why}`,
    };
  }
  const name = oneLine(task.name);
  if (name === "") return { skip: "it has no name" };
  if (task.prompt.trim() === "") return { skip: "it has no prompt" };

  // A recurring task is read by its cron expression, a one-off by the time it was set for.
  const cron = text(task.cron);
  const when = text(task.scheduled_for);
  let schedule: unknown;
  if (cron !== undefined && task.recurring !== false) schedule = { kind: "cron", expression: cron };
  else if (when !== undefined) schedule = { kind: "at", at: when };
  else return { skip: "it has neither a cron expression nor a scheduled_for time" };
  const parsed = ScheduleSchema.safeParse(schedule);
  if (!parsed.success) return { skip: "its scheduled_for time is not an ISO 8601 instant" };

  const zone = text(task.timezone);
  const validZone = zone !== undefined && isTimeZone(zone);
  const routine: Routine = {
    name,
    instruction: task.prompt,
    enabled: status === "active",
    timezone: validZone ? zone : "UTC",
    schedule: parsed.data,
  };
  // Not expected to fail: every part was checked above.
  const checked = RoutineSchema.safeParse(routine);
  if (!checked.success) return { skip: "it does not make a valid routine" };

  const description = text(task.description);
  const conversation = text(task.conversation_id);
  return {
    routine: checked.data,
    extra: {
      ...(description === undefined ? {} : { description }),
      ...(conversation === undefined ? {} : { conversation_id: conversation }),
    },
    assumedUtc: parsed.data.kind === "cron" && !validZone,
  };
}

/**
 * The routine a task stands for, with the fields of the task that have no place in a routine
 * (`description`, `conversation_id`) as `extra`. `cron` with `timezone` becomes a cron schedule,
 * `scheduled_for` an `at` one; `active` is enabled and `paused` is not. A task that already
 * `fired`, was `missed` or `cancelled`, and one that has no usable schedule, name or prompt, is
 * `null`: `taskWarnings` says why.
 */
export function taskToRoutine(
  task: LettaCronTask,
): { routine: Routine; extra: Record<string, unknown> } | null {
  const converted = convert(task);
  return "skip" in converted ? null : { routine: converted.routine, extra: converted.extra };
}

/**
 * What to tell the user about a task: why it was not exported when `taskToRoutine` gave `null`,
 * that UTC was assumed when a recurring task named no valid time zone. No warnings for a task
 * that came across as it was.
 */
export function taskWarnings(task: LettaCronTask): string[] {
  const label = oneLine(task.name) === "" ? task.id : oneLine(task.name);
  const converted = convert(task);
  if ("skip" in converted) return [`routine '${label}' was not exported: ${converted.skip}`];
  return converted.assumedUtc
    ? [`routine '${label}' names no valid time zone; UTC was assumed`]
    : [];
}

// -- Routine -> `letta cron add` ---------------------------------------------------------------------

export type Shell = "sh" | "ps1";

/** Both shells expand `$AGENT_ID` inside double quotes; the script sets it from what is typed. */
const AGENT_FLAG = '--agent "$AGENT_ID"';

// PowerShell ends a double-quoted string at the straight quote and at the curly ones U+201C,
// U+201D and U+201E too, and expands `$` and the backtick.
const POWERSHELL_QUOTES = new RegExp(`[\`$"${String.fromCharCode(0x201c, 0x201d, 0x201e)}]`, "g");

/**
 * `value` as one double-quoted word for the shell, nothing in it left to expand: in `sh` the
 * backslash, `"`, `$` and the backtick are escaped with a backslash; in PowerShell the backtick,
 * `$`, and `"` together with the curly double quotes it also takes for a closing one are escaped
 * with a backtick.
 */
export function shellQuote(shell: Shell, value: string): string {
  const escaped =
    shell === "sh"
      ? value.replace(/[\\"$`]/g, "\\$&")
      : value.replace(POWERSHELL_QUOTES, "`$&");
  return `"${escaped}"`;
}

/**
 * The `letta cron add` command for `routine`, on one line, to run against the agent in
 * `$AGENT_ID`. The prompt is read from `promptFile` when the command runs (`$(cat ...)` in `sh`,
 * `Get-Content -Raw` in PowerShell), so it may be as long as it is and span lines. An `every`
 * schedule becomes a cron expression, an `at` one `--at` with the instant. `description` is the
 * task's own `description`, when it had one. Every value is quoted for the shell.
 */
export function cronAddCommand(
  routine: Routine,
  promptFile: string,
  shell: Shell,
  description?: string,
): string {
  const quote = (value: string): string => shellQuote(shell, value);
  const prompt =
    shell === "sh"
      ? `"$(cat ${quote(promptFile)})"`
      : `(Get-Content -Raw -Encoding UTF8 ${quote(promptFile)})`;
  const { schedule } = routine;
  const when =
    schedule.kind === "cron"
      ? `--cron ${quote(schedule.expression)}`
      : schedule.kind === "every"
        ? `--cron ${quote(everyToCron(schedule.every))}`
        : `--at ${quote(schedule.at)}`;
  const about = oneLine(description ?? "");
  return [
    "letta cron add",
    `--name ${quote(oneLine(routine.name))}`,
    ...(about === "" ? [] : [`--description ${quote(about)}`]),
    `--prompt ${prompt}`,
    when,
    AGENT_FLAG,
  ].join(" ");
}
