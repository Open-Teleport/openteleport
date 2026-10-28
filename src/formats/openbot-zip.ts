// Reading and writing the zip archives that carry agents in and out of OpenBot.
//
// Two formats are read. An agent import (`openbot-import.json`, `openbot-agent-import` v1) is what
// the Grok Bot export skill makes and what OpenBot takes under Server settings, Import. An
// instance transfer (`openbot-transfer.json`, `openbot-instance-transfer` v1) is what OpenBot
// writes to move itself to another computer. Only the first is written: it is the one a person
// can hand to OpenBot, and the one Grok Bot can make.
//
// The layouts and limits come from OpenBot's own source (`agent-import-manifest.ts`,
// `instance-transfer-manifest.ts`, `ipc-routines.ts`) and from the Grok Bot export skill. A zip is
// read the way a `.jetpack` is: the central directory first, so that unsafe names and sizes over
// the limits are refused before anything is inflated.
import { stat } from "node:fs/promises";
import { zipSync } from "fflate";
import { isSafeName } from "../adapters/fs.js";
import type { WriteResult } from "../adapters/types.js";
import {
  MAX_ARCHIVE_BYTES,
  MAX_AVATAR_BYTES,
  MAX_FACT_CHARS,
  MAX_FILES_BYTES,
  MAX_ROUTINES,
  MAX_SKILLS,
  MAX_TEXT_ENTRY_BYTES,
  isForbiddenPath,
  isReservedDeviceName,
  isSafeArchivePath,
} from "../core/paths.js";
import { FrontmatterError, hasFrontmatter, splitFrontmatter } from "../core/frontmatter.js";
import {
  OPENBOT_MIN_INTERVAL_MINUTES,
  type OpenBotSchedule,
  everyToMs,
  fromOpenBotSchedule,
  toOpenBotSchedule,
  toOpenBotWireSchedule,
} from "../core/schedule.js";
import {
  type Bundle,
  type FileEntry,
  type Manifest,
  type ModelPref,
  type Routine,
  RoutineSchema,
  type Skill,
  ULID_PATTERN,
} from "../core/schema.js";
import { type ZipPolicy, readZipEntries } from "../core/zip.js";

export const OPENBOT_IMPORT_MANIFEST = "openbot-import.json";
export const OPENBOT_TRANSFER_MANIFEST = "openbot-transfer.json";

export type OpenBotZipFormat = "openbot-agent-import" | "openbot-instance-transfer";

/** An agent of an archive: `key` is the folder name OpenBot gave it (`agents/<key>/`). */
export type OpenBotZipAgent = { key: string; bundle: Bundle };

const FORMATS: Record<OpenBotZipFormat, { manifest: string; noun: string }> = {
  "openbot-agent-import": { manifest: OPENBOT_IMPORT_MANIFEST, noun: "agent import" },
  "openbot-instance-transfer": { manifest: OPENBOT_TRANSFER_MANIFEST, noun: "instance transfer" },
};

// What OpenBot's decoders hold an agent to.
const KEY_PATTERN = /^[a-z0-9-]{1,64}$/;
const MAX_KEY_CHARS = 64;
const MAX_NAME_CHARS = 80;
const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_MEMORIES = 64;
const MAX_ROUTINE_NAME_CHARS = 80;
const MAX_ROUTINE_INSTRUCTION_CHARS = 100_000;
const MAX_SKILL_FILES = 200;
const MAX_SKILL_BYTES = 10 * 1024 * 1024;

const AVATAR_EXTENSION = /\.(png|jpe?g|webp)$/i;
const AGENT_ENTRY = /^agents\/([^/]+)\/(.+)$/;
const FILES_PREFIX = "files/";
const INSTRUCTIONS_FILE = "INSTRUCTIONS.md";
/** Where an agent's `files/` folder keeps the full instructions, relative to the agent. */
const FULL_INSTRUCTIONS = `${FILES_PREFIX}${INSTRUCTIONS_FILE}`;
/** OpenBot takes this many files in an archive (the Grok Bot export skill). */
const MAX_ARCHIVE_ENTRIES = 5000;
const SKILL_FILE = "SKILL.md";
const MAX_SKILL_NAME_CHARS = 80;
const MAX_SKILL_DESCRIPTION_CHARS = 1024;

const ROUTINE_LIMIT_POLICIES = ["wait", "skip"];
const ROUTINE_MISSED_POLICIES = ["skip", "run-once"];
const MEMORY_INCLUSIONS = ["essential", "searchable"] as const;
/** What a transfer file knows about an agent that a bundle has no field for. */
const VENDOR_FIELDS = [
  "reasoningEffort",
  "avatarSeed",
  "avatarHue",
  "notifications",
  "busyMessageMode",
  "taskLimit",
];

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const ulidOrEmpty = (value: unknown): string =>
  typeof value === "string" && ULID_PATTERN.test(value) ? value : "";

const plural = (count: number, one: string, many: string): string =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

// -- Model -------------------------------------------------------------------------------------

// OpenBot calls the program that runs an agent its provider. That is a runtime, not the company
// that serves the model, so it becomes the runtime of the preference; the four that have one
// company behind them also name it. The others (opencode, cursor, cline) take any provider.
const RUNTIMES = new Map<string, ModelPref>([
  ["claude", { runtime: "claude-code", provider: "anthropic" }],
  ["codex", { runtime: "codex", provider: "openai" }],
  ["gemini", { runtime: "gemini-cli", provider: "google" }],
  ["grok", { runtime: "grok", provider: "xai" }],
]);

/**
 * The model preference of an OpenBot agent, from its `provider` (a runtime, see above) and its
 * `model`. Anything that is not a non-empty string is left out; `undefined` when nothing is left.
 */
export function openBotModelPref(provider: unknown, model: unknown): ModelPref | undefined {
  const runtime =
    typeof provider === "string" && provider !== ""
      ? (RUNTIMES.get(provider) ?? { runtime: provider })
      : undefined;
  const named = typeof model === "string" && model !== "" ? { model } : undefined;
  return runtime === undefined && named === undefined ? undefined : { ...runtime, ...named };
}

// -- Reading: the archive ----------------------------------------------------------------------

const isManifestPath = (path: string): boolean =>
  path === OPENBOT_IMPORT_MANIFEST || path === OPENBOT_TRANSFER_MANIFEST;

function agentEntry(path: string): { key: string; rest: string } | undefined {
  const match = AGENT_ENTRY.exec(path);
  return match ? { key: match[1], rest: match[2] } : undefined;
}

/**
 * A forbidden path (a secret, `.git`, `node_modules`, a nested archive) in the workspace of an
 * agent or in `shared/`: content OpenTeleport does not carry, which the archive may hold all the
 * same, so it is left out and never inflated. Anywhere else such a path is an error.
 */
function isLeftOut(path: string): boolean {
  if (!isForbiddenPath(path)) return false;
  return path.startsWith("shared/") || agentEntry(path)?.rest.startsWith(FILES_PREFIX) === true;
}

/**
 * Everything that can be decided from paths and sizes alone, so that an archive is refused before
 * any of it is inflated: unsafe paths, forbidden paths (but see `isLeftOut`, whose paths are
 * added to `leftOut`), duplicates, a folder under `agents/` that no agent key names, and the
 * sizes. A text entry (a manifest, an entry of an agent outside `files/`, and the full
 * instructions in `files/`) is at most `MAX_TEXT_ENTRY_BYTES`, `files/` of all agents together
 * at most `MAX_FILES_BYTES`, and all entries together, `shared/` and the rest included, at most
 * `MAX_ARCHIVE_BYTES`. What is left out counts toward the sizes: it is in the archive.
 */
function validateListing(
  listing: readonly { path: string; size: number }[],
  leftOut: string[],
): void {
  const seen = new Set<string>();
  let filesBytes = 0;
  let totalBytes = 0;
  for (const { path, size } of listing) {
    if (!isSafeArchivePath(path)) throw new Error(`unsafe path: ${path}`);
    if (seen.has(path)) throw new Error(`duplicate path: ${path}`);
    seen.add(path);
    totalBytes += size;

    let isText = isManifestPath(path);
    if (path.startsWith("agents/")) {
      const entry = agentEntry(path);
      if (entry === undefined || !KEY_PATTERN.test(entry.key)) {
        throw new Error(`invalid agent key in path: ${path}`);
      }
      if (entry.rest.startsWith(FILES_PREFIX)) {
        filesBytes += size;
        isText = entry.rest === FULL_INSTRUCTIONS;
      } else {
        isText = true;
      }
    }
    if (isForbiddenPath(path)) {
      if (!isLeftOut(path)) throw new Error(`forbidden path: ${path}`);
      leftOut.push(path);
      continue;
    }
    if (isText && size > MAX_TEXT_ENTRY_BYTES) {
      throw new Error(
        `${path} is ${size} bytes, over the ${MAX_TEXT_ENTRY_BYTES} byte limit for text entries`,
      );
    }
  }
  if (filesBytes > MAX_FILES_BYTES) {
    throw new Error(`files/ is ${filesBytes} bytes, over the ${MAX_FILES_BYTES} byte limit`);
  }
  if (totalBytes > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `entries add up to ${totalBytes} bytes, over the ${MAX_ARCHIVE_BYTES} byte limit`,
    );
  }
}

/**
 * The zip reader's view of the layout. The manifests and everything of an agent but its workspace
 * are text. The workspace (`files/`) is only inflated when it is asked for, except the one file
 * that can hold the full instructions (a text entry too, so it has the limit of one). Whatever
 * lies outside `agents/` (`shared/` of a transfer) is listed and checked, never inflated, and
 * neither is a path that is left out. `leftOut` is filled by `validate`, with those paths.
 */
function zipPolicy(includeFiles: boolean, leftOut: string[]): ZipPolicy {
  return {
    kindOf: (path) => {
      if (isManifestPath(path)) return "text";
      const entry = agentEntry(path);
      if (entry === undefined || isLeftOut(path)) return "unknown";
      if (!entry.rest.startsWith(FILES_PREFIX)) return "text";
      if (includeFiles) return "file";
      return entry.rest === FULL_INSTRUCTIONS ? "text" : "unknown";
    },
    validate: (listing) => validateListing(listing, leftOut),
  };
}

function decodeText(path: string, bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch (error) {
    throw new Error(`${path} is not valid UTF-8`, { cause: error });
  }
}

/** What reading one archive shares between its agents. */
type Reading = {
  manifestName: string;
  entries: ReadonlyMap<string, Uint8Array>;
  includeFiles: boolean;
  warnings: string[];
  origin: Manifest["origin"];
  /** The id the archive carries when it was written for a single agent, else empty. */
  archiveId: string;
};

/** One warning for the paths that were left out, in code unit order, the first five named. */
function leftOutWarning(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const named = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 5);
  const more = paths.length > named.length ? ` and ${paths.length - named.length} more` : "";
  const subject = paths.length === 1 ? "1 entry was" : `${paths.length} entries were`;
  const reason = paths.length === 1 ? "its path is" : "their paths are";
  return [`${subject} left out because ${reason} forbidden: ${named.join(", ")}${more}.`];
}

function parseJson(manifestName: string, bytes: Uint8Array): unknown {
  const text = decodeText(manifestName, bytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${manifestName} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function readOrigin(manifest: Json): Manifest["origin"] {
  const source = isRecord(manifest.source) ? manifest.source : {};
  const exportedAt = source.exportedAt;
  // The schema wants a time; OpenBot itself reads a missing or unreadable one as "unknown".
  if (typeof exportedAt !== "string" || Number.isNaN(Date.parse(exportedAt))) return undefined;
  const app = nonBlank(source.app) ?? "openbot";
  const version = nonBlank(source.appVersion);
  return version === undefined ? { app, exportedAt } : { app, version, exportedAt };
}

/**
 * Reads an OpenBot archive: an agent import or an instance transfer, told apart by the manifest
 * at its root. `includeFiles` reads the files of each agent's workspace as well. Throws when the
 * archive is not a valid zip, breaks a limit or a path rule, or has a manifest OpenBot would
 * refuse; what is only left out (a routine that cannot be carried, an avatar of the wrong kind,
 * a forbidden path in a workspace or in `shared/`, which is never inflated) is named in
 * `warnings`, with what the archive holds that is not moved (channels, settings).
 */
export async function readOpenBotZip(
  file: string,
  opts: { includeFiles?: boolean } = {},
): Promise<{ format: OpenBotZipFormat; agents: OpenBotZipAgent[]; warnings: string[] }> {
  const includeFiles = opts.includeFiles === true;
  const { size } = await stat(file);
  const leftOut: string[] = [];
  const listed = await readZipEntries(file, size, zipPolicy(includeFiles, leftOut));
  const dropped = new Set(leftOut);
  const entries = new Map(
    listed
      .filter(({ path }) => !dropped.has(path))
      .map(({ path, bytes }) => [path, bytes] as const),
  );

  const hasImport = entries.has(OPENBOT_IMPORT_MANIFEST);
  const hasTransfer = entries.has(OPENBOT_TRANSFER_MANIFEST);
  if (hasImport && hasTransfer) {
    throw new Error(
      `${file} holds both ${OPENBOT_IMPORT_MANIFEST} and ${OPENBOT_TRANSFER_MANIFEST}; ` +
        "an archive is one or the other",
    );
  }
  if (!hasImport && !hasTransfer) {
    throw new Error(
      `${file} holds no ${OPENBOT_IMPORT_MANIFEST} or ${OPENBOT_TRANSFER_MANIFEST} at its ` +
        "root, so it is not an OpenBot archive",
    );
  }
  const format: OpenBotZipFormat = hasImport ? "openbot-agent-import" : "openbot-instance-transfer";
  const { manifest: manifestName, noun } = FORMATS[format];

  const manifest = parseJson(manifestName, entries.get(manifestName) ?? new Uint8Array(0));
  if (!isRecord(manifest) || manifest.format !== format) {
    throw new Error(`${manifestName} is not an ${noun}: its format must be "${format}"`);
  }
  if (manifest.version !== 1) {
    throw new Error(
      typeof manifest.version === "number" && manifest.version > 1
        ? `${manifestName} was made by a newer version of OpenBot than OpenTeleport reads ` +
            `(version ${manifest.version})`
        : `${manifestName} has no version 1`,
    );
  }
  const list = manifest.agents;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${manifestName} lists no agents`);
  }

  const archive = manifest["x-openteleport"];
  const reading: Reading = {
    manifestName,
    entries,
    includeFiles,
    warnings: leftOutWarning(leftOut),
    origin: readOrigin(manifest),
    archiveId: list.length === 1 && isRecord(archive) ? ulidOrEmpty(archive.id) : "",
  };
  const agents: OpenBotZipAgent[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of list.entries()) {
    const agent = readAgent(raw, index, reading);
    if (keys.has(agent.key)) {
      throw new Error(`${manifestName} is invalid: two agents use the key "${agent.key}"`);
    }
    keys.add(agent.key);
    agents.push(agent);
  }

  const { warnings } = reading;
  if (format === "openbot-agent-import") {
    const channels = Array.isArray(manifest.channels) ? manifest.channels.length : 0;
    if (channels > 0) {
      const s = channels === 1 ? "" : "s";
      warnings.push(
        `The archive holds ${channels} channel${s} (group chat${s}); channels are not moved.`,
      );
    }
  } else {
    if (manifest.settings !== undefined && manifest.settings !== null) {
      warnings.push(
        "The OpenBot settings in the transfer file (MCP servers, providers and the like) " +
          "are not moved.",
      );
    }
    if (manifest.shared !== undefined && manifest.shared !== null) {
      warnings.push("The shared files of the OpenBot instance (shared/) are not moved.");
    }
    if (Array.isArray(manifest.signedIn) && manifest.signedIn.length > 0) {
      warnings.push("The providers OpenBot was signed in to are not moved; sign in again.");
    }
  }
  return { format, agents, warnings };
}

// -- Reading: one agent ------------------------------------------------------------------------

function readAgent(raw: unknown, index: number, reading: Reading): OpenBotZipAgent {
  const invalid = (what: string): Error =>
    new Error(`${reading.manifestName} is invalid: ${what}`);
  if (!isRecord(raw)) throw invalid(`agent ${index + 1} is not an object`);
  const key = raw.key;
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw invalid(`agent ${index + 1} has an invalid key`);
  }
  const bad = (field: string): Error => invalid(`agent "${key}" has an invalid ${field}`);

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name === "" || name.length > MAX_NAME_CHARS) throw bad("name");
  const title = raw.title === undefined || raw.title === null ? "" : raw.title;
  if (typeof title !== "string" || title.length > MAX_TITLE_CHARS) throw bad("title");
  const description = raw.description;
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_CHARS) {
    throw bad("description");
  }

  // A path the manifest names belongs to this agent: inside `agents/<key>/`, safe, and (for what
  // is read as a whole outside the workspace) not inside `files/`, which is only read on request.
  const prefix = `agents/${key}/`;
  const folder = (value: unknown, what: string, inFiles: boolean): string | undefined => {
    if (value === undefined || value === null) return undefined;
    const path = typeof value === "string" ? value.replace(/\/+$/, "") : "";
    if (
      !path.startsWith(prefix) ||
      !isSafeArchivePath(path) ||
      isForbiddenPath(path) ||
      (!inFiles && `${path}/`.startsWith(`${prefix}${FILES_PREFIX}`))
    ) {
      throw bad(`${what} path${typeof value === "string" ? ` "${value}"` : ""}`);
    }
    return path;
  };
  const list = (value: unknown, what: string): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw bad(`${what} list`);
    return value;
  };

  const skillValues = list(raw.skills, "skill");
  if (skillValues.length > MAX_SKILLS) throw bad("skill list");
  const skillPaths = skillValues.map((value) => {
    const path = folder(value, "skill", false);
    if (path === undefined) throw bad("skill path");
    return path;
  });
  const avatarPath = folder(raw.avatar, "avatar", false);
  const filesPath = folder(raw.files, "files", true);
  const routineValues = [...list(raw.routines, "routine"), ...list(raw.oneTimeRoutines, "routine")];
  const memoryValues = list(raw.memories, "memory");

  const instructionsPath = `${prefix}${FULL_INSTRUCTIONS}`;
  const fullInstructions = reading.entries.get(instructionsPath);
  const instructions =
    fullInstructions === undefined ? description : decodeText(instructionsPath, fullInstructions);

  const { routines, extras } = readRoutines(routineValues, name, reading);
  const { facts, inclusions } = readMemories(memoryValues, name, reading.warnings);
  const pref = openBotModelPref(raw.provider, raw.model);
  const avatar = readAvatar(avatarPath, name, reading);

  const vendor: Json = {};
  for (const field of VENDOR_FIELDS) if (raw[field] !== undefined) vendor[field] = raw[field];
  if (extras.size > 0) vendor.routines = Object.fromEntries(extras);
  if (inclusions.length > 0) vendor.memories = inclusions;

  const own = raw["x-openteleport"];
  const manifest: Manifest = {
    schemaVersion: "0.1",
    id: ulidOrEmpty(isRecord(own) ? own.id : undefined) || reading.archiveId,
    name,
    models: pref === undefined ? [] : [pref],
    capabilities: [],
  };
  if (title.trim() !== "") manifest.title = title.trim();
  if (reading.origin !== undefined) manifest.origin = reading.origin;
  if (Object.keys(vendor).length > 0) manifest["x-openbot"] = vendor;

  const bundle: Bundle = {
    manifest,
    instructions,
    skills: readSkills(skillPaths, name, reading),
    routines,
    facts,
    notes: [],
    files: readFiles(
      filesPath,
      reading,
      key,
      fullInstructions === undefined ? undefined : instructionsPath,
    ),
    unknownPaths: [],
  };
  if (avatar !== undefined) bundle.avatar = avatar;
  return { key, bundle };
}

function readSkills(paths: readonly string[], owner: string, reading: Reading): Skill[] {
  const skills: Skill[] = [];
  const names = new Set<string>();
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (names.has(name)) {
      reading.warnings.push(
        `${owner}: the skill "${name}" is named twice; the second is left out.`,
      );
      continue;
    }
    const files: FileEntry[] = [];
    for (const [entry, bytes] of reading.entries) {
      if (entry.startsWith(`${path}/`)) files.push({ path: entry.slice(path.length + 1), bytes });
    }
    const main = files.find((file) => file.path === SKILL_FILE);
    if (main === undefined) {
      reading.warnings.push(
        `${owner}: the skill "${name}" is left out because it has no SKILL.md.`,
      );
      continue;
    }
    names.add(name);
    skills.push({ name, files: [main, ...byPath(files.filter((file) => file !== main))] });
  }
  return skills;
}

// Plain code-unit order, so that the result does not depend on the locale.
const byPath = (files: FileEntry[]): FileEntry[] =>
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

function readAvatar(
  path: string | undefined,
  owner: string,
  reading: Reading,
): Bundle["avatar"] {
  if (path === undefined) return undefined;
  const extension = AVATAR_EXTENSION.exec(path)?.[1]?.toLowerCase();
  const bytes = reading.entries.get(path);
  const problem =
    extension === undefined
      ? "it is not a PNG, JPEG or WebP image"
      : bytes === undefined
        ? "the archive does not hold it"
        : bytes.length > MAX_AVATAR_BYTES
          ? `it is over ${MAX_AVATAR_BYTES / 1024} KB`
          : undefined;
  if (problem !== undefined || extension === undefined || bytes === undefined) {
    reading.warnings.push(`${owner}: the avatar is left out because ${problem}.`);
    return undefined;
  }
  return { name: `avatar.${extension}`, bytes };
}

/** The files of the workspace, when asked for; the file of the full instructions is not one. */
function readFiles(
  path: string | undefined,
  reading: Reading,
  key: string,
  instructionsPath: string | undefined,
): FileEntry[] {
  if (path === undefined || !reading.includeFiles) return [];
  const files: FileEntry[] = [];
  let total = 0;
  for (const [entry, bytes] of reading.entries) {
    if (!entry.startsWith(`${path}/`) || entry === instructionsPath) continue;
    total += bytes.length;
    files.push({ path: entry.slice(path.length + 1), bytes });
  }
  if (total > MAX_FILES_BYTES) {
    throw new Error(
      `${reading.manifestName} is invalid: the files of agent "${key}" are ${total} bytes, ` +
        `over the ${MAX_FILES_BYTES} byte limit`,
    );
  }
  return byPath(files);
}

type Inclusion = { text: string; inclusion: (typeof MEMORY_INCLUSIONS)[number] };

/**
 * An import lists memories as strings, a transfer as `{ text, inclusion? }`; both are read
 * either way. A memory is one line (a bundle keeps a fact on one line). `inclusions` lists the
 * ones that carry the choice of how OpenBot keeps them.
 */
function readMemories(
  values: readonly unknown[],
  owner: string,
  warnings: string[],
): { facts: string[]; inclusions: Inclusion[] } {
  const kept: { text: string; inclusion?: Inclusion["inclusion"] }[] = [];
  let tooLong = 0;
  for (const value of values) {
    const raw = isRecord(value) ? value.text : value;
    if (typeof raw !== "string") continue;
    const text = raw.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (text === "") continue;
    if (text.length > MAX_FACT_CHARS) {
      tooLong += 1;
      continue;
    }
    const inclusion = MEMORY_INCLUSIONS.find(
      (candidate) => isRecord(value) && value.inclusion === candidate,
    );
    kept.push(inclusion === undefined ? { text } : { text, inclusion });
  }
  if (tooLong > 0) {
    warnings.push(
      `${owner}: ${plural(tooLong, "memory is", "memories are")} left out because ` +
        `${tooLong === 1 ? "it is" : "they are"} over ${MAX_FACT_CHARS} characters.`,
    );
  }
  if (kept.length > MAX_MEMORIES) {
    warnings.push(
      `${owner}: ${plural(kept.length - MAX_MEMORIES, "memory is", "memories are")} left out ` +
        `because OpenBot keeps at most ${MAX_MEMORIES}.`,
    );
    kept.length = MAX_MEMORIES;
  }
  const inclusions: Inclusion[] = [];
  for (const { text, inclusion } of kept) if (inclusion) inclusions.push({ text, inclusion });
  return { facts: kept.map(({ text }) => text), inclusions };
}

/**
 * The routines of an agent as a bundle holds them. What the bundle has no field for (the policy
 * of a routine, the start of an interval) comes back in `extras`, by routine name. A routine that
 * cannot be carried is left out with a warning.
 */
function readRoutines(
  values: readonly unknown[],
  owner: string,
  reading: Reading,
): { routines: Routine[]; extras: Map<string, Json> } {
  const routines: Routine[] = [];
  const extras = new Map<string, Json>();
  for (const [index, value] of values.entries()) {
    if (routines.length >= MAX_ROUTINES) {
      reading.warnings.push(
        `${owner}: the routines after the first ${MAX_ROUTINES} are left out.`,
      );
      break;
    }
    const name = isRecord(value) ? nonBlank(value.name) : undefined;
    const leave = (reason: string): void => {
      const label = name === undefined ? `number ${index + 1}` : `"${name}"`;
      reading.warnings.push(`${owner}: the routine ${label} is left out because ${reason}.`);
    };
    if (!isRecord(value)) {
      leave("it is not an object");
      continue;
    }
    if (name === undefined) {
      leave("it has no name");
      continue;
    }
    if (nonBlank(value.instruction) === undefined || typeof value.instruction !== "string") {
      leave("it has no instruction");
      continue;
    }
    if (typeof value.timezone !== "string" || value.timezone === "") {
      leave("it has no time zone");
      continue;
    }
    if (!RoutineSchema.shape.timezone.safeParse(value.timezone).success) {
      leave(`"${value.timezone}" is not a time zone`);
      continue;
    }
    const schedule = fromOpenBotSchedule(value.schedule, value.timezone);
    if (schedule === null) {
      leave("its schedule cannot be carried over");
      continue;
    }
    routines.push({
      name,
      instruction: value.instruction,
      enabled: typeof value.active === "boolean" ? value.active : true,
      timezone: value.timezone,
      schedule: schedule.schedule,
    });
    const extra: Json = { ...schedule.extra };
    if (
      typeof value.limitPolicy === "string" &&
      ROUTINE_LIMIT_POLICIES.includes(value.limitPolicy)
    ) {
      extra.limitPolicy = value.limitPolicy;
    }
    if (
      typeof value.missedPolicy === "string" &&
      ROUTINE_MISSED_POLICIES.includes(value.missedPolicy)
    ) {
      extra.missedPolicy = value.missedPolicy;
    }
    if (Object.keys(extra).length > 0) extras.set(name, extra);
  }
  return { routines, extras };
}

// -- Writing -----------------------------------------------------------------------------------

/** `text` cut to `max` characters, without leaving half of a surrogate pair at the end. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** The folder name of an agent: a slug of its name, not taken by another agent of the archive. */
function agentKey(name: string, taken: Set<string>): string {
  let base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "");
  base = cut(base, MAX_KEY_CHARS).replace(/-+$/, "");
  // A folder of that name must not be refused by the reader here or by a Windows disk.
  if (base === "" || isReservedDeviceName(base) || isForbiddenPath(base)) base = "agent";
  let key = base;
  for (let n = 2; taken.has(key); n += 1) {
    const suffix = `-${n}`;
    key = `${cut(base, MAX_KEY_CHARS - suffix.length).replace(/-+$/, "")}${suffix}`;
  }
  taken.add(key);
  return key;
}

/**
 * The text of the description: the persona and the instructions with an empty line between, as
 * one text, since OpenBot has no separate persona.
 */
function instructionText(bundle: Bundle): { text: string; joinedPersona: boolean } {
  const persona = bundle.persona?.trim() ?? "";
  if (persona === "") return { text: bundle.instructions, joinedPersona: false };
  const instructions = bundle.instructions.trim();
  const text = instructions === "" ? persona : `${persona}\n\n${instructions}`;
  return { text, joinedPersona: true };
}

/** The first 2000 characters of `text`, cut back to the end of the last full line. */
function descriptionOf(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const head = cut(text, MAX_DESCRIPTION_CHARS);
  const whole = head.endsWith("\n") || text[head.length] === "\n";
  const end = whole ? head.length : head.lastIndexOf("\n");
  return (end > 0 ? head.slice(0, end) : head).trimEnd();
}

/**
 * OpenBot reads the name and the description of a skill from the frontmatter of its SKILL.md, and
 * refuses the whole agent when a skill has none, so a skill without them is left out instead.
 */
function frontmatterProblem(main: FileEntry): string | undefined {
  let text: string;
  try {
    text = utf8.decode(main.bytes);
  } catch {
    return `its ${SKILL_FILE} is not valid UTF-8`;
  }
  if (!hasFrontmatter(text)) return `its ${SKILL_FILE} has no frontmatter, which OpenBot needs`;
  let metadata: Json = {};
  try {
    metadata = splitFrontmatter(text).data;
  } catch (error) {
    // YAML that is no mapping has no name, which is said below.
    if (!(error instanceof FrontmatterError && error.kind === "shape")) {
      return `the frontmatter of its ${SKILL_FILE} is not valid YAML`;
    }
  }
  const name = nonBlank(metadata.name);
  const description = nonBlank(metadata.description);
  if (
    name === undefined ||
    name.length > MAX_SKILL_NAME_CHARS ||
    description === undefined ||
    description.length > MAX_SKILL_DESCRIPTION_CHARS
  ) {
    return (
      `the frontmatter of its ${SKILL_FILE} needs a name of at most ${MAX_SKILL_NAME_CHARS} ` +
      `characters and a description of at most ${MAX_SKILL_DESCRIPTION_CHARS}`
    );
  }
  return undefined;
}

function skillProblem(skill: Skill, taken: ReadonlySet<string>, kept: number): string | undefined {
  if (kept >= MAX_SKILLS) return `OpenBot takes at most ${MAX_SKILLS} skills per agent`;
  if (!isSafeName(skill.name) || isForbiddenPath(skill.name)) {
    return "its name is not safe to write";
  }
  if (taken.has(skill.name)) return "another skill of this name is already written";
  const main = skill.files.find(({ path }) => path === SKILL_FILE);
  if (main === undefined) return `it has no ${SKILL_FILE}`;
  // OpenBot refuses the whole archive for such a path, so the skill does not go.
  const refused = skill.files.find(
    ({ path }) => !isSafeArchivePath(path) || isForbiddenPath(path),
  );
  if (refused !== undefined) return `OpenBot refuses the path ${refused.path}`;
  const frontmatter = frontmatterProblem(main);
  if (frontmatter !== undefined) return frontmatter;
  if (skill.files.length > MAX_SKILL_FILES) {
    return `OpenBot takes at most ${MAX_SKILL_FILES} files in a skill`;
  }
  const bytes = skill.files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (bytes > MAX_SKILL_BYTES) {
    return `OpenBot takes at most ${MAX_SKILL_BYTES / 1024 / 1024} MB in a skill`;
  }
  return undefined;
}

function scheduleProblem(routine: Routine): string {
  if (routine.schedule.kind === "at") {
    return "the OpenBot import format has no one-time schedule";
  }
  if (routine.schedule.kind === "every" && isBelowMinimumInterval(routine.schedule.every)) {
    return `OpenBot runs a routine at most every ${OPENBOT_MIN_INTERVAL_MINUTES} minutes`;
  }
  return "OpenBot cannot hold this schedule";
}

/** True for an interval under what OpenBot runs a routine at; false for any other text. */
function isBelowMinimumInterval(every: string): boolean {
  try {
    return everyToMs(every) < OPENBOT_MIN_INTERVAL_MINUTES * 60_000;
  } catch {
    return false;
  }
}

/** `shape` with the start of its interval, when it is an interval and the start is known. */
function withAnchor(
  shape: Exclude<OpenBotSchedule, { kind: "once" }>,
  anchorAt: string | undefined,
): OpenBotSchedule {
  return shape.kind === "interval" && anchorAt !== undefined ? { ...shape, anchorAt } : shape;
}

/** Where the interval of a routine started counting, if the bundle remembers it. */
function anchorOf(manifest: Manifest, routineName: string): string | undefined {
  const vendor = manifest["x-openbot"];
  const routines = isRecord(vendor) ? vendor.routines : undefined;
  const extra = isRecord(routines) ? routines[routineName] : undefined;
  const anchorAt = isRecord(extra) ? extra.anchorAt : undefined;
  return typeof anchorAt === "string" && !Number.isNaN(Date.parse(anchorAt)) ? anchorAt : undefined;
}

type Items = WriteResult["items"];

function writeAgent(
  bundle: Bundle,
  key: string,
  files: Record<string, Uint8Array>,
  items: Items,
  includeFiles: boolean,
): Json {
  const prefix = `agents/${key}/`;
  const skip = (field: string, detail: string): void => {
    items.skipped.push({ field, detail });
  };
  const approximate = (field: string, detail: string): void => {
    items.approximated.push({ field, detail });
  };

  const rawName = bundle.manifest.name.trim() || key;
  const name = cut(rawName, MAX_NAME_CHARS);
  if (name !== rawName) {
    approximate("name", `cut to the ${MAX_NAME_CHARS} characters OpenBot takes`);
  }
  const rawTitle = bundle.manifest.title?.trim() ?? "";
  const title = cut(rawTitle, MAX_TITLE_CHARS);
  if (title !== rawTitle) {
    approximate("title", `cut to the ${MAX_TITLE_CHARS} characters OpenBot takes`);
  }

  const { text, joinedPersona } = instructionText(bundle);
  if (joinedPersona) {
    approximate(
      "persona",
      "OpenBot has no persona field; it is joined with the instructions in the description",
    );
  }
  const description = descriptionOf(text);
  const overflows = text.length > MAX_DESCRIPTION_CHARS;
  if (overflows) {
    // The reader inflates this file whatever it is asked for, so it holds it to the limit of a
    // text entry; a text over it would make an archive the reader refuses.
    const whole = encoder.encode(text);
    if (whole.length <= MAX_TEXT_ENTRY_BYTES) {
      approximate(
        "instructions",
        `over the ${MAX_DESCRIPTION_CHARS} characters OpenBot takes in a description: the ` +
          `description holds the first lines, the whole text is in ${FULL_INSTRUCTIONS}`,
      );
      files[`${prefix}${FULL_INSTRUCTIONS}`] = whole;
    } else {
      approximate(
        "instructions",
        `over the ${MAX_DESCRIPTION_CHARS} characters OpenBot takes in a description and over ` +
          `the ${MAX_TEXT_ENTRY_BYTES} bytes OpenTeleport reads back from ${FULL_INSTRUCTIONS}: ` +
          "the description holds the first lines and the rest is left out",
      );
    }
  }

  let avatar: string | null = null;
  if (bundle.avatar !== undefined) {
    const extension = AVATAR_EXTENSION.exec(bundle.avatar.name)?.[1]?.toLowerCase();
    if (extension === undefined) {
      skip("avatar", "OpenBot takes PNG, JPEG or WebP avatars");
    } else if (bundle.avatar.bytes.length > MAX_AVATAR_BYTES) {
      skip("avatar", `OpenBot takes avatars of at most ${MAX_AVATAR_BYTES / 1024} KB`);
    } else {
      avatar = `${prefix}avatar.${extension}`;
      files[avatar] = bundle.avatar.bytes;
    }
  }

  const skills: string[] = [];
  const skillNames = new Set<string>();
  for (const skill of bundle.skills) {
    const problem = skillProblem(skill, skillNames, skills.length);
    if (problem !== undefined) {
      skip(`skill:${skill.name}`, problem);
      continue;
    }
    skillNames.add(skill.name);
    skills.push(`${prefix}skills/${skill.name}`);
    for (const file of skill.files) {
      files[`${prefix}skills/${skill.name}/${file.path}`] = file.bytes;
    }
  }

  const routines: Json[] = [];
  for (const routine of bundle.routines) {
    const field = `routine:${routine.name}`;
    if (routines.length >= MAX_ROUTINES) {
      skip(field, `OpenBot takes at most ${MAX_ROUTINES} routines per agent`);
      continue;
    }
    const shape = toOpenBotSchedule(routine.schedule);
    if (shape === null) {
      skip(field, scheduleProblem(routine));
      continue;
    }
    if (routine.instruction.length > MAX_ROUTINE_INSTRUCTION_CHARS) {
      skip(
        field,
        `the instruction is over the ${MAX_ROUTINE_INSTRUCTION_CHARS} characters OpenBot takes`,
      );
      continue;
    }
    const routineName = cut(routine.name, MAX_ROUTINE_NAME_CHARS);
    if (routineName !== routine.name) {
      approximate(field, `name cut to the ${MAX_ROUTINE_NAME_CHARS} characters OpenBot takes`);
    }
    routines.push({
      name: routineName,
      instruction: routine.instruction,
      active: routine.enabled,
      timezone: routine.timezone,
      schedule: toOpenBotWireSchedule(withAnchor(shape, anchorOf(bundle.manifest, routine.name))),
    });
  }

  const memories: string[] = [];
  for (const [index, fact] of bundle.facts.entries()) {
    const text = fact.trim();
    const reason =
      text === ""
        ? "empty"
        : text.length > MAX_FACT_CHARS
          ? `OpenBot memory limit: ${MAX_FACT_CHARS} chars`
          : memories.length >= MAX_MEMORIES
            ? `OpenBot memory limit: ${MAX_MEMORIES} facts`
            : undefined;
    if (reason === undefined) memories.push(text);
    else skip(`fact:${index + 1}`, `${[...text].slice(0, 60).join("")}… (${reason})`);
  }

  if (includeFiles) {
    for (const file of bundle.files) {
      const field = `file:${file.path}`;
      if (!isSafeArchivePath(file.path) || isForbiddenPath(file.path)) {
        skip(field, "OpenBot refuses this path");
      } else if (overflows && file.path === INSTRUCTIONS_FILE) {
        skip(field, "this name is kept for the full instructions");
      } else {
        files[`${prefix}${FILES_PREFIX}${file.path}`] = file.bytes;
      }
    }
  }
  const hasFiles = Object.keys(files).some((path) => path.startsWith(`${prefix}${FILES_PREFIX}`));

  return {
    key,
    name,
    title,
    description,
    avatar,
    skills,
    routines,
    memories,
    files: hasFiles ? `${prefix}files` : null,
  };
}

/**
 * Refuses an archive that OpenBot or the reader of this module would refuse: more entries than
 * OpenBot takes, more than `MAX_FILES_BYTES` in the workspaces, more than `MAX_ARCHIVE_BYTES` in
 * all. Better here, with the limit named, than a move that cannot read its own artifact back.
 */
function assertWithinArchiveLimits(entries: Readonly<Record<string, Uint8Array>>): void {
  const paths = Object.keys(entries);
  if (paths.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `the archive would hold ${paths.length} entries, over the ${MAX_ARCHIVE_ENTRIES} OpenBot ` +
        "takes; leave out the files of the workspace",
    );
  }
  let filesBytes = 0;
  let totalBytes = 0;
  for (const path of paths) {
    const size = (entries[path] as Uint8Array).length;
    totalBytes += size;
    if (agentEntry(path)?.rest.startsWith(FILES_PREFIX) === true) filesBytes += size;
  }
  if (filesBytes > MAX_FILES_BYTES) {
    throw new Error(
      `the files of the workspace would be ${filesBytes} bytes, over the ${MAX_FILES_BYTES} ` +
        "byte limit; leave them out",
    );
  }
  if (totalBytes > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `the archive would be ${totalBytes} bytes, over the ${MAX_ARCHIVE_BYTES} byte limit`,
    );
  }
}

/**
 * Writes bundles as an `openbot-agent-import` v1 archive. What OpenBot's import does not take is
 * left out and named in `items.skipped` (a one-time routine, a routine that runs more often than
 * every 3 minutes, what is over the limits of an agent: 32 skills, 64 routines, 64 memories of
 * 500 characters, an avatar of 512 KB); what is changed to fit is named in `items.approximated`
 * (instructions over 2000 characters, whose whole text goes to `files/INSTRUCTIONS.md`, and a
 * persona, which is joined with the instructions). A fact is named `fact:<n>`, counted from 1.
 * The files of the workspace are written only with `includeFiles`. The manifest carries the
 * jetpack id (`x-openteleport`) so that a later move can tell the same agent again: at the top
 * for one agent, on each agent for several.
 */
export function writeOpenBotImportZip(
  bundles: readonly Bundle[],
  opts: { app: string; version: string; includeFiles: boolean },
): { bytes: Uint8Array; items: WriteResult["items"] } {
  if (bundles.length === 0) throw new Error("nothing to write: no agent was given");
  const files: Record<string, Uint8Array> = {};
  const items: Items = { approximated: [], skipped: [], warnings: [] };
  const taken = new Set<string>();
  const agents = bundles.map((bundle) => {
    const key = agentKey(bundle.manifest.name, taken);
    const agent = writeAgent(bundle, key, files, items, opts.includeFiles);
    if (bundles.length > 1 && ulidOrEmpty(bundle.manifest.id) !== "") {
      agent["x-openteleport"] = { id: bundle.manifest.id };
    }
    return agent;
  });

  const marker: Json = { version: opts.version };
  const [only] = bundles;
  if (bundles.length === 1 && only !== undefined && ulidOrEmpty(only.manifest.id) !== "") {
    marker.id = only.manifest.id;
  }
  const manifest = {
    format: "openbot-agent-import",
    version: 1,
    source: { app: opts.app, exportedAt: new Date().toISOString() },
    agents,
    "x-openteleport": marker,
  };
  const entries = {
    [OPENBOT_IMPORT_MANIFEST]: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    ...files,
  };
  assertWithinArchiveLimits(entries);
  return { bytes: zipSync(entries), items };
}
