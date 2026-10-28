// Reading OpenBot agents: from a copy of the app's database, or from an export archive that
// `--source-dir` names (the agent import the Grok Bot skill makes, or an instance transfer).
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_AVATAR_BYTES,
  MAX_FACT_CHARS,
  MAX_FILES_BYTES,
  MAX_ROUTINES,
  isForbiddenPath,
  isSafeArchivePath,
} from "../../core/paths.js";
import { fromOpenBotSchedule } from "../../core/schedule.js";
import {
  type Bundle,
  type FileEntry,
  type Manifest,
  type Note,
  type Routine,
  RoutineSchema,
} from "../../core/schema.js";
import { openBotModelPref, readOpenBotZip } from "../../formats/openbot-zip.js";
import { lstatIfAny } from "../fs.js";
import type { AgentRef, Ctx } from "../types.js";
import {
  type OpenBotDbAgent,
  type OpenBotDbRoutine,
  assertSchema,
  readDbAgents,
  schemaVersion,
  withDatabaseCopy,
} from "./db.js";
import { DB_FILE, KNOWN_SCHEMA_VERSION, openBotUserData, zipSource } from "./paths.js";

const APP = "openbot";
const MAX_NAME_CHARS = 80;
const MAX_TITLE_CHARS = 120;
const IMAGE_EXTENSION = /\.(png|jpe?g|webp)$/i;
const LIMIT_POLICIES = ["wait", "skip"];
const MISSED_POLICIES = ["skip", "run-once"];

const HINT =
  "Install OpenBot, or pass --source-dir <export.zip> " +
  "(OpenBot: Server settings, Export; Grok Bot: the OpenBot export skill)";
const SKILLS_WARNING =
  "skills are not readable from the OpenBot database; export from the app (a transfer zip) carries them";

type Json = Record<string, unknown>;

/** One line of text: every run of whitespace and control characters becomes one space. */
const oneLine = (value: string): string => value.replace(/[\p{Cc}\s]+/gu, " ").trim();

/** Cuts `value` to `max` characters, the last one an ellipsis. */
const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const plural = (count: number, one: string, many: string): string =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

// -- Finding the source -----------------------------------------------------------------------

/** Found when `--source-dir` names an export archive, or the database file is there. Runs nothing. */
export async function detectOpenBot(
  ctx: Ctx,
): Promise<{ found: boolean; location?: string; hint?: string }> {
  const zip = await zipSource(ctx);
  if (zip !== undefined) return { found: true, location: zip };
  const userData = openBotUserData(ctx);
  const found = await stat(join(userData, DB_FILE)).then(
    (info) => info.isFile(),
    () => false,
  );
  return found ? { found, location: userData } : { found, location: userData, hint: HINT };
}

type Named = { id: string; name: string };

const describeAgent = ({ id, name }: Named): string => (name === id ? id : `${id} (${name})`);

/** The agent `wanted` names: the one with that id, else the only one of that name in any case. */
function pickAgent<T extends Named>(agents: readonly T[], wanted: string): T {
  const byId = agents.find(({ id }) => id === wanted);
  if (byId !== undefined) return byId;
  const lower = wanted.toLowerCase();
  const byName = agents.filter(({ name }) => name.toLowerCase() === lower);
  const [only, ...more] = byName;
  if (only !== undefined && more.length === 0) return only;
  if (only !== undefined) {
    throw new Error(
      `Several OpenBot agents are called "${wanted}": ${byName.map(describeAgent).join(", ")}. ` +
        "Pass the id.",
    );
  }
  throw new Error(
    `OpenBot has no agent "${wanted}". Available: ` +
      `${agents.length === 0 ? "(none)" : agents.map(describeAgent).join(", ")}`,
  );
}

async function loadDatabase(ctx: Ctx): Promise<{ agents: OpenBotDbAgent[]; version: number }> {
  return withDatabaseCopy(openBotUserData(ctx), (db) => {
    assertSchema(db);
    return { agents: readDbAgents(db), version: schemaVersion(db) };
  });
}

// -- list -------------------------------------------------------------------------------------

/** The agents of the export archive `--source-dir` names, else those of the database. */
export async function listOpenBotAgents(ctx: Ctx): Promise<AgentRef[]> {
  const zip = await zipSource(ctx);
  if (zip !== undefined) {
    const { agents } = await readOpenBotZip(zip);
    return agents.map(({ key, bundle }) => ({
      id: key,
      name: bundle.manifest.name,
      ...(bundle.manifest.title === undefined ? {} : { title: bundle.manifest.title }),
      location: `${zip}#${key}`,
    }));
  }
  const database = join(openBotUserData(ctx), DB_FILE);
  const { agents } = await loadDatabase(ctx);
  return agents.map(({ id, name, title }) => ({
    id,
    name: truncate(oneLine(name), MAX_NAME_CHARS) || id,
    ...(title === undefined ? {} : { title: truncate(oneLine(title), MAX_TITLE_CHARS) }),
    location: `${database}#${id}`,
  }));
}

/**
 * What tells this agent apart from every other: the real path of the data folder and the agent's
 * id for the database (as `list` shows it), and `zip:<format>:<key>` for an archive, so that
 * exporting the same bot again and moving it again updates what was written instead of
 * starting another.
 */
export async function openBotCacheIdentity(ctx: Ctx, agent: string): Promise<string> {
  const zip = await zipSource(ctx);
  if (zip !== undefined) {
    const { format, agents } = await readOpenBotZip(zip);
    const found = pickAgent(
      agents.map(({ key, bundle }) => ({ id: key, name: bundle.manifest.name })),
      agent,
    );
    return `zip:${format}:${found.id}`;
  }
  const userData = openBotUserData(ctx);
  const real = await realpath(userData).catch(() => resolve(userData));
  return `${real}#${agent}`;
}

// -- read: the database -----------------------------------------------------------------------

/**
 * Memories as facts (one line of at most 500 characters) and, for those too long, notes named
 * `memory-<n>` after their place among the agent's memories, counted from 1.
 */
function splitMemories(
  memories: readonly string[],
  warnings: string[],
): { facts: string[]; notes: Note[] } {
  const facts: string[] = [];
  const notes: Note[] = [];
  for (const [index, memory] of memories.entries()) {
    const line = memory.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (line === "") continue;
    if (line.length <= MAX_FACT_CHARS) {
      facts.push(line);
    } else {
      notes.push({ name: `memory-${index + 1}`, text: `${memory.trim()}\n` });
    }
  }
  if (notes.length > 0) {
    warnings.push(
      `${plural(notes.length, "memory is", "memories are")} over ${MAX_FACT_CHARS} characters ` +
        `and ${notes.length === 1 ? "is" : "are"} kept as ${notes.length === 1 ? "a note" : "notes"}: ` +
        notes.map(({ name }) => name).join(", "),
    );
  }
  return { facts, notes };
}

/**
 * The routines of an agent as a bundle holds them; what the bundle has no field for (the
 * policies, the start of an interval) comes back in `extras`, by routine name. A routine that
 * cannot be carried is left out with a warning.
 */
function readRoutines(
  rows: readonly OpenBotDbRoutine[],
  warnings: string[],
): { routines: Routine[]; extras: Record<string, Json> } {
  const routines: Routine[] = [];
  const extras: Record<string, Json> = {};
  for (const [index, row] of rows.entries()) {
    if (routines.length >= MAX_ROUTINES) {
      warnings.push(`the routines after the first ${MAX_ROUTINES} are left out.`);
      break;
    }
    const name = row.name.trim();
    const leave = (reason: string): void => {
      const label = name === "" ? `number ${index + 1}` : `"${name}"`;
      warnings.push(`the routine ${label} is left out because ${reason}.`);
    };
    if (name === "") {
      leave("it has no name");
      continue;
    }
    if (row.instruction.trim() === "") {
      leave("it has no instruction");
      continue;
    }
    if (!RoutineSchema.shape.timezone.safeParse(row.timezone).success) {
      leave(row.timezone === "" ? "it has no time zone" : `"${row.timezone}" is not a time zone`);
      continue;
    }
    if (row.schedule === undefined) {
      leave("it has no schedule");
      continue;
    }
    const schedule = fromOpenBotSchedule(row.schedule, row.timezone);
    if (schedule === null) {
      leave("its schedule cannot be carried over");
      continue;
    }
    routines.push({
      name,
      instruction: row.instruction,
      enabled: row.active,
      timezone: row.timezone,
      schedule: schedule.schedule,
    });
    const extra: Json = { ...schedule.extra };
    if (typeof row.limitPolicy === "string" && LIMIT_POLICIES.includes(row.limitPolicy)) {
      extra.limitPolicy = row.limitPolicy;
    }
    if (typeof row.missedPolicy === "string" && MISSED_POLICIES.includes(row.missedPolicy)) {
      extra.missedPolicy = row.missedPolicy;
    }
    if (Object.keys(extra).length > 0) extras[name] = extra;
  }
  return { routines, extras };
}

/** The file an avatar value names: a path or a `file:` URL. A web address names none. */
function avatarFile(reference: string): string | undefined {
  if (/^file:/i.test(reference)) {
    try {
      return fileURLToPath(reference);
    } catch {
      return undefined;
    }
  }
  return isAbsolute(reference) ? reference : undefined;
}

/** The avatar, when it is a file of a PNG, JPEG or WebP image of at most 512 KB. */
async function readAvatar(reference: string, warnings: string[]): Promise<Bundle["avatar"]> {
  const path = avatarFile(reference);
  if (path === undefined) return undefined;
  const leave = (reason: string): undefined => {
    warnings.push(`the avatar is left out because ${reason}.`);
    return undefined;
  };
  const extension = IMAGE_EXTENSION.exec(path)?.[1]?.toLowerCase();
  if (extension === undefined) return leave("it is not a PNG, JPEG or WebP image");
  try {
    const info = await lstatIfAny(path);
    if (info === undefined) return leave("the file is not there");
    if (!info.isFile()) return leave("it is not a regular file");
    if (info.size > MAX_AVATAR_BYTES) return leave(`it is over ${MAX_AVATAR_BYTES / 1024} KB`);
    return { name: `avatar.${extension}`, bytes: new Uint8Array(await readFile(path)) };
  } catch (error) {
    return leave(`it could not be read (${(error as Error).message})`);
  }
}

/** Raised by the walk of a workspace that holds more than a bundle may carry. */
class OverLimit extends Error {}

const named = (paths: readonly string[]): string => {
  const first = [...paths].sort(byCodeUnit).slice(0, 5);
  const more = paths.length > first.length ? ` and ${paths.length - first.length} more` : "";
  return `${first.join(", ")}${more}`;
};

/**
 * The files below an agent's workspace, as `/`-separated paths in code unit order. What a bundle
 * never carries (a secret, `.git`, `node_modules`, a nested archive), a link and a special file
 * are left out and named. A workspace over 100 MB is not read at all. Nothing here fails the
 * read: whatever cannot be read is a warning and no files.
 */
async function readWorkspace(path: string, warnings: string[]): Promise<FileEntry[]> {
  const skip = (reason: string): FileEntry[] => {
    warnings.push(`the workspace ${path} ${reason}, so no files were read`);
    return [];
  };
  if (!isAbsolute(path)) return skip("is not an absolute path");
  try {
    const info = await lstatIfAny(path);
    if (info === undefined) return skip("is not there");
    if (!info.isDirectory()) return skip("is not a real folder");

    const found: { path: string; absolute: string }[] = [];
    const forbidden: string[] = [];
    const unusable: string[] = [];
    let total = 0;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const absolute = join(dir, entry.name);
        if (isForbiddenPath(entry.name)) {
          forbidden.push(relative);
        } else if (
          entry.isSymbolicLink() ||
          !(entry.isFile() || entry.isDirectory()) ||
          !isSafeArchivePath(relative)
        ) {
          unusable.push(relative);
        } else if (entry.isDirectory()) {
          await walk(absolute, relative);
        } else {
          total += (await lstat(absolute)).size;
          if (total > MAX_FILES_BYTES) throw new OverLimit();
          found.push({ path: relative, absolute });
        }
      }
    };
    await walk(path, "");

    const files: FileEntry[] = [];
    for (const { path: relative, absolute } of found) {
      try {
        files.push({ path: relative, bytes: new Uint8Array(await readFile(absolute)) });
      } catch {
        // Gone or refused since the walk: left out like a file that is not a regular one.
        unusable.push(relative);
      }
    }
    if (forbidden.length > 0) {
      warnings.push(
        `${plural(forbidden.length, "entry of the workspace was", "entries of the workspace were")} ` +
          `left out because ${forbidden.length === 1 ? "its path is" : "their paths are"} ` +
          `forbidden: ${named(forbidden)}.`,
      );
    }
    if (unusable.length > 0) {
      warnings.push(
        `${plural(unusable.length, "entry of the workspace was", "entries of the workspace were")} ` +
          "left out because it cannot be carried (a link, a special file, an unusable name or " +
          `one that could not be read): ${named(unusable)}.`,
      );
    }
    return files.sort((a, b) => byCodeUnit(a.path, b.path));
  } catch (error) {
    if (error instanceof OverLimit) return skip(`is over the ${MAX_FILES_BYTES} byte limit`);
    return skip(`could not be read (${(error as Error).message})`);
  }
}

async function databaseBundle(
  agent: OpenBotDbAgent,
  version: number,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const warnings: string[] = [];
  if (version > KNOWN_SCHEMA_VERSION) {
    warnings.push(
      `OpenBot database is newer (schema ${version}) than this adapter knows ` +
        `(${KNOWN_SCHEMA_VERSION}); check the result`,
    );
  }
  warnings.push(SKILLS_WARNING);

  const { facts, notes } = splitMemories(agent.memories, warnings);
  const { routines, extras } = readRoutines(agent.routines, warnings);
  const avatar =
    agent.avatar === undefined ? undefined : await readAvatar(agent.avatar, warnings);
  const files =
    agent.workspacePath === undefined ? [] : await readWorkspace(agent.workspacePath, warnings);

  // What a bundle has no field for goes to the manifest under the app's name.
  const vendor: Json = {};
  for (const [key, value] of [
    ["reasoningEffort", agent.reasoningEffort],
    ["avatarSeed", agent.avatarSeed],
    ["avatarHue", agent.avatarHue],
    ["notifications", agent.notifications],
    ["workspacePath", agent.workspacePath],
  ] as const) {
    if (value !== undefined) vendor[key] = value;
  }
  if (Object.keys(extras).length > 0) vendor.routines = extras;

  const pref = openBotModelPref(agent.provider, agent.model);
  const title = agent.title === undefined ? "" : truncate(oneLine(agent.title), MAX_TITLE_CHARS);
  const manifest: Manifest = {
    schemaVersion: "0.1",
    id: "",
    name: truncate(oneLine(agent.name), MAX_NAME_CHARS) || agent.id,
    ...(title === "" ? {} : { title }),
    models: pref === undefined ? [] : [pref],
    capabilities: [],
    origin: { app: APP, exportedAt: new Date().toISOString() },
  };
  if (Object.keys(vendor).length > 0) manifest["x-openbot"] = vendor;

  const bundle: Bundle = {
    manifest,
    instructions: agent.description ?? "",
    skills: [],
    routines,
    facts,
    notes,
    files,
    unknownPaths: [],
  };
  if (avatar !== undefined) bundle.avatar = avatar;
  return { bundle, warnings };
}

// -- read -------------------------------------------------------------------------------------

/**
 * Reads an agent as a Bundle. `agent` is an id from `listOpenBotAgents` (the key of an archive
 * agent), or the name of the only agent called that. From the database the id is left empty:
 * nothing in it records one. The files of the workspace (or of the archive) are read whether or
 * not the move carries them; the engine leaves them out unless it is asked to bring them.
 */
export async function readOpenBotAgent(
  ctx: Ctx,
  agent: string,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const zip = await zipSource(ctx);
  if (zip !== undefined) {
    const { agents, warnings } = await readOpenBotZip(zip, { includeFiles: true });
    const found = pickAgent(
      agents.map(({ key, bundle }) => ({ id: key, name: bundle.manifest.name, bundle })),
      agent,
    );
    return { bundle: found.bundle, warnings };
  }
  const { agents, version } = await loadDatabase(ctx);
  return databaseBundle(pickAgent(agents, agent), version);
}
