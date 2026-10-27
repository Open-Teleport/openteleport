// The OpenClaw command line, as the adapter drives it.
//
// Since 2026.6 OpenClaw keeps automations (cron jobs) in its state database, so they are read and
// written through the CLI rather than through files. Its JSON output is not documented. What this
// module assumes, to be confirmed or corrected against a real install (Task 13):
//
// - `openclaw automations list --all --json` prints the jobs as a bare array or under `jobs` or
//   `automations`, one row per job:
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
// - `openclaw automations add ... --json` prints the new job's id as `id`, `job.id` or
//   `automation.id`.
// - Output may start with log lines; the JSON document is the rest, from the first line that
//   opens an array or an object.
// - `--json` asks a command for JSON output. `config set` is the exception: there `--json` may
//   mean "parse the value as JSON5", so `configSet` runs without it and passes the value as
//   written.
// - A command this OpenClaw does not have fails with "unknown command" on stderr.
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

/**
 * Runs `openclaw` for one install. Every command runs with `OPENCLAW_STATE_DIR` set to that
 * install's state directory, on top of `ctx.env`, and gets `--json` unless noted otherwise.
 */
export class OpenClawCli {
  private readonly ctx: Ctx;
  private readonly stateDir: string;

  constructor(ctx: Ctx, stateDir: string) {
    this.ctx = ctx;
    this.stateDir = stateDir;
  }

  private async run(args: readonly string[], json = true): Promise<string> {
    const argv = json ? [...args, "--json"] : [...args];
    const { stdout } = await this.ctx.exec("openclaw", argv, { env: this.env() });
    return stdout;
  }

  private env(): NodeJS.ProcessEnv {
    return { ...this.ctx.env, OPENCLAW_STATE_DIR: this.stateDir };
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
    const command = "automations list";
    const json = parseJson(await this.run(["automations", "list", "--all"]), command);
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
    identity: { name: string; emoji?: string; avatar?: string },
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
    ]);
  }

  /** Adds a job; `args` are the flags after `automations add`. Returns the new job's id. */
  async automationsAdd(args: string[]): Promise<{ id: string }> {
    const command = "automations add";
    const json = parseJson(await this.run(["automations", "add", ...args]), command);
    const record = isRecord(json) ? json : {};
    const nested = [record, record.job, record.automation].find(
      (candidate) => isRecord(candidate) && idOf(candidate.id) !== undefined,
    ) as Record<string, unknown> | undefined;
    const id = nested === undefined ? undefined : idOf(nested.id);
    if (id === undefined) throw new Error(`openclaw ${command} printed no job id`);
    return { id };
  }

  async automationsDisable(id: string): Promise<void> {
    await this.run(["automations", "disable", id]);
  }

  /**
   * Sets a config value. `false` when this OpenClaw has no such command; other failures throw.
   * Runs without `--json`, which `config set` may read as "parse the value as JSON5".
   */
  async configSet(path: string, value: string): Promise<boolean> {
    try {
      await this.run(["config", "set", path, value], false);
      return true;
    } catch (error) {
      const { message, stderr } = error as { message?: unknown; stderr?: unknown };
      if (UNKNOWN_COMMAND.test(`${String(stderr ?? "")}\n${String(message ?? "")}`)) return false;
      throw error;
    }
  }

  /**
   * The version `openclaw --version` prints, or `undefined` when OpenClaw is not installed or the
   * command fails. Runs without `--json`.
   */
  async version(): Promise<string | undefined> {
    try {
      const { stdout } = await this.ctx.exec("openclaw", ["--version"], { env: this.env() });
      const text = firstLine(stdout);
      return /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/.exec(text)?.[0] ?? label(text);
    } catch {
      return undefined;
    }
  }
}
