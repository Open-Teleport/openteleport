// Reads a Hermes profile as a Bundle. Hermes keeps the persona in `SOUL.md`, memory as entries in
// `memories/*.md`, jobs in `cron/jobs.json` and skills below `skills/`, all inside the profile
// directory; nothing is read from a running Hermes, and nothing is changed.
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import {
  MAX_FACT_CHARS,
  MAX_ROUTINES,
  MAX_SKILLS,
  MAX_TEXT_ENTRY_BYTES,
  isForbiddenPath,
} from "../../core/paths.js";
import {
  type Bundle,
  type FileEntry,
  type Manifest,
  type ModelPref,
  type Note,
  type Routine,
  type Skill,
  ULID_PATTERN,
} from "../../core/schema.js";
import { splitInstructions } from "../../core/text.js";
import { lstatIfAny } from "../fs.js";
import { readMarker } from "../marker.js";
import type { AgentRef, Ctx } from "../types.js";
import { jobToRoutine, readJobsFile } from "./cron.js";
import { parseEntries } from "./memory.js";
import {
  DEFAULT_PROFILE,
  type HermesConfig,
  hermesHome,
  hermesTimezone,
  isProfile,
  parseYaml,
  profileDir,
  readConfig,
} from "./paths.js";

const APP = "hermes";
const MAX_NAME_CHARS = 80;
const MAX_TITLE_CHARS = 120;
const SKILL_FILE = "SKILL.md";
const MANIFEST_FILE = ".bundled_manifest";
/** What Hermes accepts as the id of a named profile (`PROFILE_ID_RE` in `hermes_constants.py`). */
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** How many names a warning lists before it says "and N more". */
const LISTED_NAMES = 10;

const MEBIBYTE = 1024 * 1024;

/** Cuts `text` to `max` characters, the last one an ellipsis. */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

// Plain code-unit order, so that the result does not depend on the locale.
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const plural = (n: number, noun: string, many = `${noun}s`): string =>
  `${n} ${n === 1 ? noun : many}`;

const named = (names: readonly string[]): string =>
  names.length <= LISTED_NAMES
    ? names.join(", ")
    : `${names.slice(0, LISTED_NAMES).join(", ")} and ${names.length - LISTED_NAMES} more`;

/** The entries of `dir` with their types, or none when it does not exist. */
async function entriesOf(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Whether `path` is a directory, a link to one included. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * A text file of the profile without its byte order mark, or `undefined` when it is not there, is
 * not a file or is over the size a text file may have in a bundle (then with a warning). A link
 * is followed: Hermes does the same with its own files.
 */
async function readText(
  path: string,
  label: string,
  warnings: string[],
): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!info.isFile()) return undefined;
  if (info.size > MAX_TEXT_ENTRY_BYTES) {
    warnings.push(`${label} is over ${MAX_TEXT_ENTRY_BYTES / MEBIBYTE} MiB; not exported`);
    return undefined;
  }
  const text = await readFile(path, "utf8");
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

// -- Profiles ----------------------------------------------------------------------------------

type Located = { id: string; dir: string };

/** `default` when the Hermes home is a profile, then the profiles below `profiles/` by name. */
async function locateProfiles(home: string): Promise<Located[]> {
  const found: Located[] = [];
  if (await isProfile(home)) found.push({ id: DEFAULT_PROFILE, dir: home });
  const profiles = join(home, "profiles");
  const names = (await entriesOf(profiles))
    .map((entry) => entry.name)
    .filter((name) => PROFILE_ID_PATTERN.test(name))
    .sort(byCodeUnit);
  for (const id of names) {
    const dir = join(profiles, id);
    if ((await isDirectory(dir)) && (await isProfile(dir))) found.push({ id, dir });
  }
  return found;
}

type ProfileMeta = { displayName?: string; description?: string };

/** `display_name` and `description` of `profile.yaml`; an error says why they are not there. */
async function readProfileMeta(dir: string): Promise<{ meta: ProfileMeta } | { error: string }> {
  const file = join(dir, "profile.yaml");
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    return isMissing(error)
      ? { meta: {} }
      : { error: `${file} could not be read (${(error as Error).message})` };
  }
  let data: unknown;
  try {
    data = parseYaml(file, source);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  const meta: ProfileMeta = {};
  const displayName = isRecord(data) ? text(data.display_name) : undefined;
  const description = isRecord(data) ? text(data.description) : undefined;
  if (displayName !== undefined) meta.displayName = displayName;
  if (description !== undefined) meta.description = description;
  return { meta };
}

/** The profiles of the Hermes home: `default`, then the named ones. */
export async function listHermesProfiles(ctx: Ctx): Promise<AgentRef[]> {
  const refs: AgentRef[] = [];
  for (const { id, dir } of await locateProfiles(hermesHome(ctx))) {
    const read = await readProfileMeta(dir);
    // Listing is for discovery: a broken profile.yaml is reported by `read`, not here.
    const meta = "meta" in read ? read.meta : {};
    refs.push({
      id,
      name: meta.displayName ?? id,
      ...(meta.description === undefined ? {} : { title: meta.description }),
      location: dir,
    });
  }
  return refs;
}

/**
 * What tells this profile apart from the same-named profile of another Hermes home: the real path
 * of its directory (`default` is a different agent in every `HERMES_HOME`).
 */
export async function hermesCacheIdentity(ctx: Ctx, agent: string): Promise<string> {
  return realpath(profileDir(hermesHome(ctx), agent));
}

// -- Skills ------------------------------------------------------------------------------------

/**
 * The names `skills/.bundled_manifest` lists: the skills that ship with Hermes. One line per skill,
 * `name:hash` or just `name` (`_read_manifest` in `tools/skills_sync.py`). `undefined` when the
 * file is there but cannot be read, which leaves every skill in place.
 */
async function bundledNames(
  skillsDir: string,
  warnings: string[],
): Promise<ReadonlySet<string> | undefined> {
  const file = join(skillsDir, MANIFEST_FILE);
  if ((await lstatIfAny(file)) === undefined) return new Set();
  let text: string | undefined;
  try {
    text = await readText(file, `skills/${MANIFEST_FILE}`, warnings);
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    warnings.push(`skills/${MANIFEST_FILE} could not be read; no skill was left behind as bundled`);
    return undefined;
  }
  const names = text
    .split(/\r?\n/)
    .map((line) => line.split(":")[0]?.trim() ?? "")
    .filter((name) => name !== "");
  return new Set(names);
}

/** The `name` in the frontmatter of a `SKILL.md`, which is how Hermes names a skill. */
function frontmatterName(markdown: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)?.[1];
  if (block === undefined) return undefined;
  try {
    const data: unknown = parse(block);
    const name = isRecord(data) ? data.name : undefined;
    return typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

const linkWarning = (skill: string, path?: string): string =>
  path === undefined
    ? `skill '${skill}' is a symlink; not exported`
    : `skill '${skill}': '${path}' is a symlink; not exported`;

/**
 * Files below `dir` as `/`-separated paths. Links (symbolic links and junctions) are never
 * followed; they, forbidden paths and special files are left out and named.
 */
async function skillFiles(dir: string, skill: string, warnings: string[]): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    // Dirent types come from lstat, so a link is neither a file nor a directory here.
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(linkWarning(skill, path));
      } else if (isForbiddenPath(path) || !(entry.isDirectory() || entry.isFile())) {
        warnings.push(`skill '${skill}': left out '${path}'`);
      } else if (entry.isDirectory()) {
        await walk(absolute, path);
      } else {
        files.push({ path, bytes: new Uint8Array(await readFile(absolute)) });
      }
    }
  }
  await walk(dir, "");
  // SKILL.md first, then the others in code-unit order.
  return files.sort((a, b) =>
    a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : byCodeUnit(a.path, b.path),
  );
}

type SkillFolder = { path: string; dir: string };

/**
 * The folders below `skillsDir` that hold a real `SKILL.md`, by path. A folder without one is a
 * category and is searched; one with it is a skill and is not searched further. Names that start
 * with a dot (`.hub`, `.bundled_manifest`) are Hermes's own state. A link is never followed: it
 * is named in a warning instead.
 */
async function findSkillFolders(skillsDir: string, warnings: string[]): Promise<SkillFolder[]> {
  const found: SkillFolder[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = (await entriesOf(dir)).sort((a, b) => byCodeUnit(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(linkWarning(entry.name));
        continue;
      }
      if (!entry.isDirectory()) continue;
      const skillFile = await lstatIfAny(join(absolute, SKILL_FILE));
      if (skillFile?.isSymbolicLink()) {
        warnings.push(linkWarning(entry.name, SKILL_FILE));
      } else if (skillFile?.isFile()) {
        found.push({ path, dir: absolute });
      } else {
        await walk(absolute, path);
      }
    }
  }
  await walk(skillsDir, "");
  return found;
}

/**
 * Every skill of the profile, without the ones that ship with Hermes (`.bundled_manifest`) and
 * the state of the skills hub. Categories are flattened: a skill is named after its folder, and
 * a second skill of the same name gets `-2`, `-3`... with a warning. At most `MAX_SKILLS` come
 * back.
 */
async function readSkills(dir: string, warnings: string[]): Promise<Skill[]> {
  const skillsDir = join(dir, "skills");
  const folders = await findSkillFolders(skillsDir, warnings);
  const bundled =
    folders.length === 0 ? new Set<string>() : await bundledNames(skillsDir, warnings);

  const skills: Skill[] = [];
  const taken = new Set<string>();
  const dropped: string[] = [];
  let leftBehind = 0;
  for (const folder of folders) {
    const folderName = folder.path.split("/").at(-1) as string;
    if (bundled !== undefined && bundled.size > 0) {
      const skillName =
        bundled.has(folderName)
          ? folderName
          : frontmatterName(await readFile(join(folder.dir, SKILL_FILE), "utf8"));
      if (skillName !== undefined && bundled.has(skillName)) {
        leftBehind += 1;
        continue;
      }
    }
    let name = folderName;
    for (let n = 2; taken.has(name); n += 1) name = `${folderName}-${n}`;
    if (name !== folderName) {
      warnings.push(
        `skill '${folderName}' appears more than once (${folder.path}); exported as '${name}'`,
      );
    }
    taken.add(name);
    if (skills.length >= MAX_SKILLS) {
      dropped.push(name);
      continue;
    }
    skills.push({ name, files: await skillFiles(folder.dir, name, warnings) });
  }
  if (leftBehind > 0) {
    warnings.push(`${plural(leftBehind, "bundled Hermes skill")} left behind`);
  }
  if (dropped.length > 0) {
    warnings.push(
      `${plural(dropped.length, "skill")} over the limit of ${MAX_SKILLS} not exported: ` +
        named(dropped),
    );
  }
  return skills;
}

// -- Memory ------------------------------------------------------------------------------------

/**
 * The entries of `MEMORY.md`, then those of `USER.md`. An entry of up to 500 characters is a fact;
 * a longer one is kept whole as the note `memory-<n>` or `user-<n>`, `n` being its place in the
 * file, counted from 1.
 */
async function readMemory(
  dir: string,
  warnings: string[],
): Promise<{ facts: string[]; notes: Note[] }> {
  const facts: string[] = [];
  const notes: Note[] = [];
  for (const [file, prefix] of [
    ["MEMORY.md", "memory"],
    ["USER.md", "user"],
  ] as const) {
    const text = await readText(join(dir, "memories", file), `memories/${file}`, warnings);
    for (const [index, entry] of parseEntries(text ?? "").entries()) {
      if (entry.length > MAX_FACT_CHARS) {
        notes.push({ name: `${prefix}-${index + 1}`, text: entry });
      } else {
        facts.push(entry);
      }
    }
  }
  if (notes.length > 0) {
    const one = notes.length === 1;
    warnings.push(
      `${plural(notes.length, "memory entry", "memory entries")} over ${MAX_FACT_CHARS} ` +
        `characters ${one ? "was" : "were"} kept as ${one ? "the note" : "the notes"} ` +
        notes.map((note) => note.name).join(", "),
    );
  }
  return { facts, notes };
}

// -- Cron jobs ---------------------------------------------------------------------------------

/** The routines of `cron/jobs.json` and, by routine name, what they have that a routine has not. */
async function readRoutines(
  dir: string,
  timezone: string,
  warnings: string[],
): Promise<{ routines: Routine[]; extras: Record<string, Record<string, unknown>> }> {
  const routines: Routine[] = [];
  const extras: Record<string, Record<string, unknown>> = {};
  const file = join(dir, "cron", "jobs.json");
  if ((await lstatIfAny(file)) === undefined) return { routines, extras };
  const read = await readJobsFile(file);
  if ("error" in read) {
    warnings.push(`${read.error}; no routines exported`);
    return { routines, extras };
  }
  if (read.ignored.length > 0) {
    warnings.push(
      `${plural(read.ignored.length, "entry", "entries")} of cron/jobs.json ` +
        `${read.ignored.length === 1 ? "is" : "are"} not a job OpenTeleport can read; left out`,
    );
  }
  const names = new Set<string>();
  for (const job of read.jobs) {
    const entry = jobToRoutine(job, timezone);
    if (entry === null) {
      warnings.push(
        `cron job '${job.name.trim() || job.id}' has no prompt or a schedule OpenTeleport ` +
          "cannot express; not exported",
      );
      continue;
    }
    if (routines.length >= MAX_ROUTINES) {
      warnings.push(
        `cron job '${entry.routine.name}' is over the limit of ${MAX_ROUTINES} routines; ` +
          "not exported",
      );
      continue;
    }
    let name = entry.routine.name;
    for (let n = 2; names.has(name); n += 1) name = `${entry.routine.name} (${n})`;
    if (name !== entry.routine.name) {
      warnings.push(
        `cron job '${entry.routine.name}' appears more than once; exported as '${name}'`,
      );
    }
    names.add(name);
    routines.push({ ...entry.routine, name });
    if (Object.keys(entry.extra).length > 0) extras[name] = entry.extra;
  }
  return { routines, extras };
}

// -- The profile -------------------------------------------------------------------------------

/** The model preference of `config.yaml`; none without a model name. */
function modelsOf(config: HermesConfig | undefined): ModelPref[] {
  const model = config?.model;
  if (model?.default === undefined) return [];
  const { provider } = model;
  return [{ ...(provider === undefined ? {} : { provider }), model: model.default }];
}

/** The id an earlier move recorded in the profile, so that the profile keeps it on its way out. */
async function recordedId(dir: string): Promise<string> {
  try {
    const id = (await readMarker(dir))?.id;
    return id !== undefined && ULID_PATTERN.test(id) ? id : "";
  } catch {
    // A marker that cannot be read only costs a new id.
    return "";
  }
}

/**
 * Reads the profile `agent` (an id from `listHermesProfiles`) as a Bundle. `SOUL.md` is the
 * persona, or the persona and the instructions when it has the layout `mergeInstructions` writes;
 * without that layout the instructions are the `agent.system_prompt` of `config.yaml`, if any. The
 * id is the one an earlier move recorded in the profile, else empty for the engine to fill in.
 */
export async function readHermesProfile(
  ctx: Ctx,
  agent: string,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const home = hermesHome(ctx);
  const profiles = await locateProfiles(home);
  const located = profiles.find(({ id }) => id === agent);
  if (located === undefined) {
    throw new Error(
      profiles.length === 0
        ? `Hermes has no profile "${agent}": there are no profiles in ${home}`
        : `Hermes has no profile "${agent}". Available: ${profiles.map(({ id }) => id).join(", ")}`,
    );
  }
  const { id, dir } = located;
  const warnings: string[] = [];

  const profileFile = await readProfileMeta(dir);
  if ("error" in profileFile) warnings.push(`${profileFile.error}; the profile id is its name`);
  const meta = "meta" in profileFile ? profileFile.meta : {};

  let config: HermesConfig | undefined;
  try {
    config = (await readConfig(dir))?.config;
  } catch (error) {
    warnings.push(`${(error as Error).message}; its model and time zone are not used`);
  }

  const soul = await readText(join(dir, "SOUL.md"), "SOUL.md", warnings);
  let persona: string | undefined;
  let instructions = config?.agent?.system_prompt ?? "";
  if (soul !== undefined) {
    const parts = splitInstructions(soul);
    // Text that is not in the layout comes back unchanged as the instructions; in Hermes all of
    // `SOUL.md` is then the persona.
    if (parts.persona !== undefined || parts.instructions !== soul) {
      persona = parts.persona;
      instructions = parts.instructions;
    } else if (soul.trim() !== "") {
      persona = soul;
    }
  }

  const skills = await readSkills(dir, warnings);
  const { facts, notes } = await readMemory(dir, warnings);
  const timezone = hermesTimezone(ctx, config);
  const { routines, extras } = await readRoutines(dir, timezone, warnings);

  const description = meta.description;
  const title = description === undefined ? undefined : truncate(description, MAX_TITLE_CHARS);
  const manifest: Manifest = {
    schemaVersion: "0.1",
    id: await recordedId(dir),
    name: truncate(meta.displayName ?? id, MAX_NAME_CHARS),
    ...(title === undefined ? {} : { title }),
    // A description the title had to cut is kept whole, so nothing of it is lost.
    ...(description !== undefined && description !== title ? { description } : {}),
    models: modelsOf(config),
    capabilities: [],
    origin: { app: APP, exportedAt: new Date().toISOString() },
    "x-hermes": {
      profile: id,
      ...(config?.model?.base_url === undefined ? {} : { baseUrl: config.model.base_url }),
      ...(routines.length === 0 ? {} : { timezone }),
      routines: extras,
    },
  };

  return {
    bundle: {
      manifest,
      ...(persona === undefined ? {} : { persona }),
      instructions,
      skills,
      routines,
      facts,
      notes,
      files: [],
      unknownPaths: [],
    },
    warnings,
  };
}
