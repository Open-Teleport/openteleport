// Reading OpenBot's database. The file is never opened where the app keeps it: it is copied (with
// its `-wal` and `-shm`, which hold what the app has not yet written into the main file) to a
// temporary folder and opened there, read-only, with the `node:sqlite` module that comes with Node.
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DB_FILE } from "./paths.js";

type Sqlite = typeof import("node:sqlite");

/** One routine of an agent, with the schedule OpenBot keeps for it as it is stored. */
export type OpenBotDbRoutine = {
  id: string;
  name: string;
  instruction: string;
  active: boolean;
  timezone: string;
  /** The parsed `schedule_json`; `undefined` when the routine has no trigger. */
  schedule: unknown;
  limitPolicy?: unknown;
  missedPolicy?: unknown;
};

/** An agent as the projection tables hold it: `agent_json` (an `AgentSummary`) plus its rows. */
export type OpenBotDbAgent = {
  id: string;
  name: string;
  title?: string;
  description?: string;
  /** What OpenBot calls the provider is the program that runs the agent, a runtime. */
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  avatarSeed?: unknown;
  avatarHue?: unknown;
  /** The agent's own `avatar`, else its `avatarUrl`. */
  avatar?: string;
  workspacePath?: string;
  notifications?: unknown;
  memories: string[];
  routines: OpenBotDbRoutine[];
};

const NOT_AVAILABLE = "node:sqlite is not available; use Node 24 or pass --source-dir <export.zip>";
const NOT_RECOGNISED =
  "OpenBot database schema not recognised; export from the app and pass --source-dir <zip>";

/** The columns this adapter reads. Anything else a table has is none of its business. */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  projection_agents: ["agent_id", "model", "agent_json"],
  projection_agent_memories: ["agent_id", "text"],
  projection_agent_routines: ["routine_id", "agent_id", "name", "instruction", "active", "timezone"],
  projection_routine_triggers: ["routine_id", "schedule_json"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed, non-blank string, or `undefined`. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// -- Loading the module -----------------------------------------------------------------------

/** Whether a call of `process.emitWarning` is Node's notice that `node:sqlite` is experimental. */
function isSqliteNotice(warning: string | Error, rest: readonly unknown[]): boolean {
  const [first] = rest;
  const name =
    warning instanceof Error
      ? warning.name
      : typeof first === "string"
        ? first
        : isRecord(first) && typeof first.type === "string"
          ? first.type
          : "Warning";
  const message = warning instanceof Error ? warning.message : warning;
  return name === "ExperimentalWarning" && /SQLite/.test(message);
}

async function importQuietly(): Promise<Sqlite> {
  const original = process.emitWarning;
  // Node prints the notice on stderr, which would turn up in every `list` and `read` of a user
  // who has done nothing wrong. Only that one notice is held back, and only while the module loads.
  process.emitWarning = (warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteNotice(warning, rest)) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new Error(NOT_AVAILABLE, { cause: error });
  } finally {
    process.emitWarning = original;
  }
}

let loading: Promise<Sqlite> | undefined;

/**
 * `node:sqlite`, imported when first asked for (a move that does not touch the database never
 * loads it) and without Node's notice that the module is experimental. Throws when this Node
 * has no such module.
 */
export function loadSqlite(): Promise<Sqlite> {
  // One import at a time, so that two callers cannot restore `process.emitWarning` out of order.
  loading ??= importQuietly().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}

// -- The copy ---------------------------------------------------------------------------------

async function copyIfThere(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Runs `fn` on a read-only connection to a copy of the database in `userData`. The copy is made
 * with its `-wal` and `-shm` files when they exist, lives in a temporary folder and is removed
 * when `fn` is done, whatever happens. The original is only read: never opened as a database.
 * `fn` must finish its reading before it returns; the connection is closed after it.
 */
export async function withDatabaseCopy<T>(
  userData: string,
  fn: (db: DatabaseSync) => T,
): Promise<T> {
  const original = join(userData, DB_FILE);
  const present = await stat(original).then(
    (info) => info.isFile(),
    (error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    },
  );
  if (!present) {
    throw new Error(
      `OpenBot has no database at ${original}. Install OpenBot, or pass --source-dir <export.zip>`,
    );
  }
  const { DatabaseSync: Database } = await loadSqlite();
  const folder = await mkdtemp(join(tmpdir(), "openteleport-openbot-"));
  let db: DatabaseSync | undefined;
  try {
    const copy = join(folder, DB_FILE);
    await copyFile(original, copy);
    await copyIfThere(`${original}-wal`, `${copy}-wal`);
    await copyIfThere(`${original}-shm`, `${copy}-shm`);
    db = new Database(copy, { readOnly: true });
    return fn(db);
  } finally {
    // The connection first: Windows does not remove a file that is open.
    db?.close();
    await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// -- The schema -------------------------------------------------------------------------------

/** The names of the columns of `table` (a name from `REQUIRED_COLUMNS`); none when it is missing. */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const names = new Set<string>();
  for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
    if (typeof row.name === "string") names.add(row.name);
  }
  return names;
}

/** The newest migration the database records; 0 when it records none. */
export function schemaVersion(db: DatabaseSync): number {
  if (!tableColumns(db, "schema_migrations").has("version")) return 0;
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  return typeof row?.version === "number" ? row.version : 0;
}

/** Throws when a table or a column this adapter reads is not there. */
export function assertSchema(db: DatabaseSync): void {
  let missing: string | undefined;
  try {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const present = tableColumns(db, table);
      if (present.size === 0) {
        missing = `no table ${table}`;
      } else {
        const absent = columns.find((column) => !present.has(column));
        if (absent !== undefined) missing = `no column ${absent} in ${table}`;
      }
      if (missing !== undefined) break;
    }
  } catch (error) {
    // A file that is not a database at all fails on the first question.
    missing = (error as Error).message;
  }
  if (missing !== undefined) throw new Error(`${NOT_RECOGNISED} (${missing})`);
}

// -- The agents -------------------------------------------------------------------------------

function parseObject(json: unknown): Record<string, unknown> {
  const parsed = parseValue(json);
  return isRecord(parsed) ? parsed : {};
}

function parseValue(json: unknown): unknown {
  if (typeof json !== "string") return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Sets `key` of `into` to `value`, unless it is missing or `null`. */
function keep<K extends keyof OpenBotDbAgent>(
  into: OpenBotDbAgent,
  key: K,
  value: OpenBotDbAgent[K] | null | undefined,
): void {
  if (value !== undefined && value !== null) into[key] = value;
}

/**
 * Every agent of the projection tables, in the order the rows were stored, with its memories and
 * routines. The schema has to be one `assertSchema` accepts. The columns a routine got in later
 * versions (`limit_policy`, `missed_policy`) are read when the database has them.
 */
export function readDbAgents(db: DatabaseSync): OpenBotDbAgent[] {
  const memories = new Map<string, string[]>();
  const memoryRows = db
    .prepare("SELECT agent_id, text FROM projection_agent_memories ORDER BY rowid")
    .all();
  for (const row of memoryRows) {
    if (typeof row.agent_id !== "string" || typeof row.text !== "string") continue;
    memories.set(row.agent_id, [...(memories.get(row.agent_id) ?? []), row.text]);
  }

  const routineColumns = tableColumns(db, "projection_agent_routines");
  const columns = [
    "r.routine_id AS routine_id",
    "r.agent_id AS agent_id",
    "r.name AS name",
    "r.instruction AS instruction",
    "r.active AS active",
    "r.timezone AS timezone",
    ...["limit_policy", "missed_policy"]
      .filter((column) => routineColumns.has(column))
      .map((column) => `r.${column} AS ${column}`),
    "t.schedule_json AS schedule_json",
  ];
  const routineRows = db
    .prepare(
      `SELECT ${columns.join(", ")} FROM projection_agent_routines r ` +
        "LEFT JOIN projection_routine_triggers t ON t.routine_id = r.routine_id " +
        "ORDER BY r.rowid",
    )
    .all();
  const routines = new Map<string, OpenBotDbRoutine[]>();
  for (const row of routineRows) {
    if (
      typeof row.routine_id !== "string" ||
      typeof row.agent_id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.instruction !== "string" ||
      typeof row.timezone !== "string"
    ) {
      continue;
    }
    const routine: OpenBotDbRoutine = {
      id: row.routine_id,
      name: row.name,
      instruction: row.instruction,
      active: row.active === 1,
      timezone: row.timezone,
      schedule: parseValue(row.schedule_json),
    };
    if (row.limit_policy !== undefined && row.limit_policy !== null) {
      routine.limitPolicy = row.limit_policy;
    }
    if (row.missed_policy !== undefined && row.missed_policy !== null) {
      routine.missedPolicy = row.missed_policy;
    }
    routines.set(row.agent_id, [...(routines.get(row.agent_id) ?? []), routine]);
  }

  const agents: OpenBotDbAgent[] = [];
  const agentRows = db
    .prepare("SELECT agent_id, model, agent_json FROM projection_agents ORDER BY rowid")
    .all();
  for (const row of agentRows) {
    if (typeof row.agent_id !== "string") continue;
    const json = parseObject(row.agent_json);
    const agent: OpenBotDbAgent = {
      id: row.agent_id,
      name: text(json.name) ?? row.agent_id,
      memories: memories.get(row.agent_id) ?? [],
      routines: routines.get(row.agent_id) ?? [],
    };
    keep(agent, "title", text(json.title));
    keep(agent, "description", typeof json.description === "string" ? json.description : undefined);
    keep(agent, "provider", text(json.provider));
    keep(agent, "model", text(json.model) ?? text(row.model));
    keep(agent, "reasoningEffort", text(json.reasoningEffort));
    keep(agent, "avatarSeed", json.avatarSeed);
    keep(agent, "avatarHue", json.avatarHue);
    keep(agent, "avatar", text(json.avatar) ?? text(json.avatarUrl));
    keep(agent, "workspacePath", text(json.workspacePath));
    keep(agent, "notifications", json.notifications);
    agents.push(agent);
  }
  return agents;
}
