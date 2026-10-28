// The OpenClaw command line, as the adapter drives it.
//
// OpenClaw keeps scheduled jobs in its state database, so they are read and written through the
// CLI rather than through files. Their command family depends on the version: 2026.5.28 has
// `openclaw cron`, while the docs for 2026.6 and later call it `openclaw automations`. Each
// `OpenClawCli` settles this once, on its first job command: when
// `openclaw automations list --all --json` fails with "Unknown command" the family is `cron`,
// otherwise `automations`.
//
// Commands checked against `--help` of OpenClaw 2026.5.28:
// - `agents add <id> --workspace <dir> --non-interactive --json`
// - `agents set-identity --agent <id> --name <n> --emoji <e> --avatar <path> --theme <t> --json`
// - `agents list --json`
// - `config set <path> <value>`, without `--json`; `--strict-json` reads the value as JSON.
// - `gateway status --json`
// - `cron add --name <n> (--cron <expr> --tz <tz> | --every <dur> | --at <iso> --tz <tz>)
//   --message <prompt> --agent <id> --session isolated [--disabled] --json`
// - `cron list --all --json [--agent <id>]` and `cron rm <id> --json`; `cron disable <id>` and
//   `cron enable <id>` take no `--json`. Jobs go through the Gateway, so these fail while it is
//   not running.
//
// Not checked, taken from the docs on main: the `automations` family, with `list --all`, `add`
// with the flags of `cron add` but without `--disabled` (a job is disabled after it is added),
// `disable <id>` and `remove <id>`, each with `--json`.
//
// The JSON these commands print is not documented. What this module assumes, to be confirmed or
// corrected against a real install (Task 13):
//
// - Listing the jobs prints them as a bare array or under `jobs` or `automations`, one row per
//   job:
//     { id, name, agentId, disabled: boolean,
//       schedule: { kind: "cron", expr, tz? } | { kind: "every", everyMs } | { kind: "at", at }
//               | { kind: "on-exit" | "stream", ... },
//       payload: { kind: "agentTurn", message } }
//   Rows are read tolerantly: `agentId` or `agent`; `disabled` or `enabled` (neither: enabled);
//   `payload.message`, `payload.prompt` or a top-level `message`; a numeric id becomes a string.
//   A job without an agent belongs to `main`, the default agent. A cron job without `tz` runs in
//   the Gateway host's local zone. A row that is not an object or has no id is skipped, with a
//   warning naming it.
// - `openclaw agents list --json` prints `{ id, name?, workspace? }` rows, bare or under `agents`.
// - Adding a job prints the new job's id as `id`, `job.id` or `automation.id`.
// - `openclaw gateway status --json` prints an object with `running: true` or
//   `status: "running"` while the Gateway runs.
// - Output may start with log lines; the JSON document is the rest, from the first line that
//   opens an array or an object.
// - `--json` asks a command for JSON output. `config set`, `cron disable` and `cron enable` are
//   the exceptions and run without it.
// - A command this OpenClaw does not have fails with "unknown command" on stderr.
//
// On Windows npm installs `openclaw` as an `openclaw.cmd` shim, and running a `.cmd` file goes
// through `cmd.exe`, which ends a command line at its first line break: a multi-line routine
// instruction would lose every argument after its first line. So the shim is read and the
// script it starts is run with this node directly. When that is not possible, an argument with a
// line break is refused rather than cut.
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Ctx } from "../types.js";

/** A job as `openclaw automations list` reports it, normalised; `schedule` is passed on raw. */
export type JobRow = {
  id: string;
  name: string;
  agentId?: string;
  enabled: boolean;
  schedule: unknown;
  message?: string;
};

/** An agent as `openclaw agents list` reports it. */
export type AgentRow = { id: string; name?: string; workspace?: string };

/** The command family for jobs: `cron` up to 2026.5, `automations` from 2026.6. */
export type JobCommand = "automations" | "cron";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed, non-empty string, or `undefined`. */
function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A string with something other than whitespace in it, kept as it is. */
const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0]?.trim() ?? "";

function parseJson(stdout: string, command: string): unknown {
  const text = stdout.trim();
  const attempt = (source: string): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(source) };
    } catch {
      return { ok: false };
    }
  };
  // Each line that opens an array or an object may start the document; log lines may not.
  for (const { index } of text.matchAll(/^[[{]/gm)) {
    const parsed = attempt(text.slice(index));
    if (parsed.ok) return parsed.value;
  }
  throw new Error(`openclaw ${command} did not print JSON: ${firstLine(text) || "(nothing)"}`);
}

function rowsOf(json: unknown, keys: readonly string[], command: string): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
    for (const key of keys) {
      const rows = json[key];
      if (Array.isArray(rows)) return rows;
    }
  }
  throw new Error(`openclaw ${command} printed no list`);
}

function idOf(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : label(value);
}

/** A normalised job, or the warning that says why the row is skipped. */
function toJobRow(raw: unknown, index: number): JobRow | { skipped: string } {
  const skipped = (job: string, reason: string) => ({
    skipped: `automation ${job} skipped: openclaw automations list ${reason}`,
  });
  if (!isRecord(raw)) return skipped(`#${index + 1}`, "gave a row that is not an object");
  const name = label(raw.name);
  const id = idOf(raw.id);
  if (id === undefined) return skipped(`'${name ?? `#${index + 1}`}'`, "gave it no id");
  const payload = isRecord(raw.payload) ? raw.payload : {};
  const message = nonBlank(payload.message) ?? nonBlank(payload.prompt) ?? nonBlank(raw.message);
  const agentId = label(raw.agentId) ?? label(raw.agent);
  const enabled =
    typeof raw.disabled === "boolean"
      ? !raw.disabled
      : typeof raw.enabled === "boolean"
        ? raw.enabled
        : true;
  return {
    id,
    name: name ?? id,
    ...(agentId === undefined ? {} : { agentId }),
    enabled,
    schedule: raw.schedule,
    ...(message === undefined ? {} : { message }),
  };
}

const UNKNOWN_COMMAND = /unknown (?:sub)?command|no such command/i;

/** What a failed command said: its stderr, then the error message. */
function errorOutput(error: unknown): string {
  const { message, stderr } = error as { message?: unknown; stderr?: unknown };
  return `${String(stderr ?? "")}\n${String(message ?? "")}`;
}

// -- Starting `openclaw` -----------------------------------------------------------------------

/** How `openclaw` is started. */
export type OpenClawCommand = {
  /** The program to run. */
  file: string;
  /** Arguments that go before OpenClaw's own: the script, when node runs it directly. */
  prefix: string[];
  /** The arguments pass through `cmd.exe`, which ends a command line at its first line break. */
  viaShell: boolean;
};

/** How long `--version` and the probe for the job family may take. */
const SHORT_TIMEOUT_MS = 10_000;
/** How long a job, config or agents command may take: jobs go through the Gateway. */
const LONG_TIMEOUT_MS = 90_000;

/** How long commands may take, in milliseconds; tests make them short. */
export type OpenClawTimeouts = { short?: number; long?: number };

const duration = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

/** `openclaw` and the command words of `args` (`cron add`), its options left out. */
function commandName(args: readonly string[]): string {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || words.length === 2) break;
    words.push(arg);
  }
  return `openclaw ${words.length === 0 ? (args[0] ?? "") : words.join(" ")}`.trimEnd();
}

/** A command that did not finish in time; it is stopped and named, with the time it had. */
export class OpenClawTimeoutError extends Error {
  constructor(command: string, ms: number) {
    super(`${command} did not finish within ${duration(ms)}`);
    this.name = "OpenClawTimeoutError";
  }
}

/** Refused instead of run: a line break would cut the command line short in `cmd.exe`. */
export class ShimLineBreakError extends Error {
  constructor() {
    super("multi-line instructions cannot be passed through the Windows shim");
    this.name = "ShimLineBreakError";
  }
}

/** An environment variable by name in any case, as Windows looks them up. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

// The line of an npm `cmd-shim` that starts the package: `"%dp0%\node_modules\...\x.mjs"`, or
// `"%~dp0\..."` in older shims, the directory of the shim followed by the script's path.
const SHIM_TARGET = /"%~?dp0%?\\([^"%]+?\.(?:c?js|mjs))"/i;

/** The script an npm `.cmd` shim runs with node, when the shim names one that exists. */
async function shimTarget(shim: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(shim, "utf8");
  } catch {
    return undefined;
  }
  const relative = SHIM_TARGET.exec(text)?.[1];
  if (relative === undefined) return undefined;
  const target = join(dirname(shim), ...relative.split("\\"));
  return (await isFile(target)) ? target : undefined;
}

/**
 * How to start `openclaw` with the `PATH` of `env`. Outside Windows, by name. On Windows the
 * first `openclaw<ext>` on `PATH` (extensions from `PATHEXT`) decides: an `.exe` or `.com` runs
 * as it is; an npm `.cmd` or `.bat` shim is replaced by this node running the script the shim
 * names. Anything else, or nothing found, runs by name, through `cmd.exe` if it is a shim.
 */
export async function resolveOpenClawCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenClawCommand> {
  const byName: OpenClawCommand = { file: "openclaw", prefix: [], viaShell: false };
  if (platform !== "win32") return byName;
  const throughShell: OpenClawCommand = { ...byName, viaShell: true };
  const dirs = (envValue(env, "PATH") ?? "")
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir !== "");
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `openclaw${extension}`);
      if (!(await isFile(candidate))) continue;
      if (extension === ".exe" || extension === ".com") {
        return { file: candidate, prefix: [], viaShell: false };
      }
      if (extension !== ".cmd" && extension !== ".bat") return throughShell;
      const target = await shimTarget(candidate);
      if (target === undefined) return throughShell;
      return { file: process.execPath, prefix: [target], viaShell: false };
    }
  }
  return throughShell;
}

/**
 * Runs `openclaw` for one install. Every command runs with `OPENCLAW_STATE_DIR` and
 * `OPENCLAW_CONFIG_PATH` set to that install's state directory and config file, on top of
 * `ctx.env`, so OpenClaw works on exactly the config the adapter reads; and every command gets
 * `--json` unless noted otherwise.
 */
export class OpenClawCli {
  private readonly ctx: Ctx;
  private readonly stateDir: string;
  private readonly configFile: string;
  private readonly platform: NodeJS.Platform;
  /** Settled by the first job command; see `jobCommand`. */
  private jobFamily: JobCommand | undefined;
  /** Found by the first command; see `command`. */
  private resolved: Promise<OpenClawCommand> | undefined;
  private readonly shortTimeout: number;
  private readonly longTimeout: number;

  constructor(
    ctx: Ctx,
    stateDir: string,
    configFile: string,
    options: { platform?: NodeJS.Platform; timeouts?: OpenClawTimeouts } = {},
  ) {
    this.ctx = ctx;
    this.stateDir = stateDir;
    this.configFile = configFile;
    this.platform = options.platform ?? process.platform;
    this.shortTimeout = options.timeouts?.short ?? SHORT_TIMEOUT_MS;
    this.longTimeout = options.timeouts?.long ?? LONG_TIMEOUT_MS;
  }

  /** How `openclaw` is started (see `resolveOpenClawCommand`); found once and kept. */
  command(): Promise<OpenClawCommand> {
    this.resolved ??= resolveOpenClawCommand(this.ctx.env, this.platform);
    return this.resolved;
  }

  /**
   * Runs OpenClaw with `args`, for at most `timeout` milliseconds: then the command is stopped
   * and an `OpenClawTimeoutError` names it, so that a hung Gateway or CLI never hangs a move.
   * Through the Windows shim, an argument with a line break is refused with a
   * `ShimLineBreakError`, since `cmd.exe` would drop everything after it.
   */
  private async exec(args: readonly string[], timeout: number): Promise<string> {
    const command = await this.command();
    if (command.viaShell && args.some((arg) => /[\r\n]/.test(arg))) throw new ShimLineBreakError();
    const argv = [...command.prefix, ...args];
    const timedOut = new OpenClawTimeoutError(commandName(args), timeout);
    let timer: NodeJS.Timeout | undefined;
    // execa stops the process at `timeout`; the race also covers an exec that never settles.
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timedOut), timeout);
    });
    try {
      const { stdout } = await Promise.race([
        this.ctx.exec(command.file, argv, { env: this.env(), timeout }),
        late,
      ]);
      return stdout;
    } catch (error) {
      if ((error as { timedOut?: unknown }).timedOut === true) throw timedOut;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs `args`, with `--json` unless `json` is false, for at most `timeout` (90 s). */
  private async run(
    args: readonly string[],
    json = true,
    timeout: number = this.longTimeout,
  ): Promise<string> {
    return this.exec(json ? [...args, "--json"] : args, timeout);
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...this.ctx.env,
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_CONFIG_PATH: this.configFile,
    };
  }

  /**
   * Runs `automations list --all --json` to settle the job command family: `cron` when OpenClaw
   * answers "Unknown command", otherwise `automations`. Returns the listing when it ran; throws
   * when it failed for another reason, a timeout included. `timeout` is the long one when the
   * listing is what the caller wants, the short one when only the family is.
   */
  private async probeJobCommand(timeout: number = this.longTimeout): Promise<string | undefined> {
    try {
      const stdout = await this.run(["automations", "list", "--all"], true, timeout);
      this.jobFamily = "automations";
      return stdout;
    } catch (error) {
      const unknown = /unknown command/i.test(errorOutput(error));
      this.jobFamily = unknown ? "cron" : "automations";
      if (!unknown) throw error;
      return undefined;
    }
  }

  /**
   * The command family this OpenClaw has for jobs, found on first use and kept for the life of
   * this object. A probe that fails for a reason other than an unknown command leaves it at
   * `automations`.
   */
  async jobCommand(): Promise<JobCommand> {
    if (this.jobFamily === undefined) {
      // Only the family is wanted, and an OpenClaw without `automations` says so at once.
      await this.probeJobCommand(this.shortTimeout).catch(() => undefined);
    }
    return this.jobFamily ?? "automations";
  }

  /** The agents OpenClaw knows. A row without an id is left out and logged. */
  async agentsList(): Promise<AgentRow[]> {
    const json = parseJson(await this.run(["agents", "list"]), "agents list");
    const agents: AgentRow[] = [];
    rowsOf(json, ["agents"], "agents list").forEach((raw, index) => {
      const row = isRecord(raw) ? raw : {};
      const id = idOf(row.id);
      if (id === undefined) {
        this.ctx.logger(`openclaw agents list: row ${index + 1} has no id; ignored`);
        return;
      }
      const name = label(row.name);
      const workspace = label(row.workspace);
      agents.push({
        id,
        ...(name === undefined ? {} : { name }),
        ...(workspace === undefined ? {} : { workspace }),
      });
    });
    return agents;
  }

  /**
   * Every job, disabled ones included. A row that cannot be used is left out and `warn` is told
   * why, naming the job; `warn` defaults to `ctx.logger`.
   */
  async automationsList(warn: (message: string) => void = this.ctx.logger): Promise<JobRow[]> {
    // The probe is itself an `automations` listing: when it settles on that family, its output
    // is the list.
    const probed = this.jobFamily === undefined ? await this.probeJobCommand() : undefined;
    const family = await this.jobCommand();
    const command = `${family} list`;
    const stdout = probed ?? (await this.run([family, "list", "--all"]));
    const json = parseJson(stdout, command);
    const jobs: JobRow[] = [];
    rowsOf(json, ["jobs", "automations"], command).forEach((raw, index) => {
      const row = toJobRow(raw, index);
      if ("skipped" in row) warn(row.skipped);
      else jobs.push(row);
    });
    return jobs;
  }

  async agentsAdd(id: string, workspace: string): Promise<void> {
    await this.run(["agents", "add", id, "--workspace", workspace, "--non-interactive"]);
  }

  async setIdentity(
    agent: string,
    identity: { name: string; emoji?: string; avatar?: string; theme?: string },
  ): Promise<void> {
    await this.run([
      "agents",
      "set-identity",
      "--agent",
      agent,
      "--name",
      identity.name,
      ...(identity.emoji === undefined ? [] : ["--emoji", identity.emoji]),
      ...(identity.avatar === undefined ? [] : ["--avatar", identity.avatar]),
      ...(identity.theme === undefined ? [] : ["--theme", identity.theme]),
    ]);
  }

  /**
   * Adds a job; `args` are the flags after `add`. With `disabled`, a `cron` job is created
   * disabled (`--disabled`); an `automations` job cannot be, so the result's `disabled` says
   * whether the job already is or the caller still has to disable it. Returns the new job's id.
   *
   * `--message` and its value go last, after `--disabled` and `--json`: should the command line
   * ever be cut inside the message, every other flag has still been passed.
   */
  async automationsAdd(
    args: string[],
    opts: { disabled?: boolean } = {},
  ): Promise<{ id: string; disabled: boolean }> {
    const family = await this.jobCommand();
    const disabled = family === "cron" && opts.disabled === true;
    const command = `${family} add`;
    const at = args.indexOf("--message");
    const message = at === -1 ? [] : args.slice(at, at + 2);
    const flags = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
    const argv = [family, "add", ...flags, ...(disabled ? ["--disabled"] : []), "--json"];
    const json = parseJson(await this.run([...argv, ...message], false), command);
    const record = isRecord(json) ? json : {};
    const nested = [record, record.job, record.automation].find(
      (candidate) => isRecord(candidate) && idOf(candidate.id) !== undefined,
    ) as Record<string, unknown> | undefined;
    const id = nested === undefined ? undefined : idOf(nested.id);
    if (id === undefined) throw new Error(`openclaw ${command} printed no job id`);
    return { id, disabled };
  }

  /** `cron disable` takes no `--json`. */
  async automationsDisable(id: string): Promise<void> {
    if ((await this.jobCommand()) === "cron") await this.run(["cron", "disable", id], false);
    else await this.run(["automations", "disable", id]);
  }

  async automationsRemove(id: string): Promise<void> {
    const family = await this.jobCommand();
    await this.run([family, family === "cron" ? "rm" : "remove", id]);
  }

  /**
   * Whether the Gateway runs: `running: true`, or a `status` of `running` in any case. Throws
   * when the command fails or prints no JSON.
   */
  async gatewayStatus(): Promise<{ running: boolean }> {
    const json = parseJson(await this.run(["gateway", "status"]), "gateway status");
    const record = isRecord(json) ? json : {};
    const status = label(record.status)?.toLowerCase();
    return { running: record.running === true || status === "running" };
  }

  /**
   * Sets a config value. `false` when this OpenClaw has no such command; other failures throw.
   * Runs without `--json`, which `config set` may read as "parse the value as JSON5"; with
   * `strictJson` the value is passed as JSON (`--strict-json`).
   */
  async configSet(
    path: string,
    value: string,
    opts: { strictJson?: boolean } = {},
  ): Promise<boolean> {
    try {
      const flags = opts.strictJson === true ? ["--strict-json"] : [];
      await this.run(["config", "set", path, value, ...flags], false);
      return true;
    } catch (error) {
      if (UNKNOWN_COMMAND.test(errorOutput(error))) return false;
      throw error;
    }
  }

  /**
   * The version `openclaw --version` prints, or `undefined` when OpenClaw is not installed or the
   * command fails. Runs without `--json`.
   */
  async version(): Promise<string | undefined> {
    try {
      const text = firstLine(await this.run(["--version"], false, this.shortTimeout));
      return /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/.exec(text)?.[0] ?? label(text);
    } catch {
      return undefined;
    }
  }
}
