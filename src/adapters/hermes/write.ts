// Writes a Bundle into a Hermes install as a named profile, `profiles/<slug>/`, never as the
// default profile, which is the user's own. Files are written directly, as Hermes reads them:
// `SOUL.md`, `memories/MEMORY.md`, `cron/jobs.json` (every job paused), `skills/` and, for a new
// profile, `profile.yaml` and `config.yaml`. A marker in the profile (`.openteleport.json`)
// records the id of the agent and what was written, so that moving the agent again updates the
// profile in place and leaves what Hermes and the user added since.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { stringify } from "yaml";
import { isSafeArchivePath } from "../../core/paths.js";
import type { Item } from "../../core/report.js";
import { parseCron } from "../../core/schedule.js";
import type { Bundle, FileEntry, ModelPref, Routine, Skill } from "../../core/schema.js";
import { mergeInstructions, slugify } from "../../core/text.js";
import { freeSibling, isFree, isSafeName, lstatIfAny, replaceFile } from "../fs.js";
import { type Marker, readMarker, writeMarker } from "../marker.js";
import { readSkillFiles } from "../skill-files.js";
import { placeSkill } from "../skills.js";
import type { Ctx, WriteOpts, WriteResult } from "../types.js";
import { type HermesJob, newJobId, readJobsFile, routineToJob, writeJobsFile } from "./cron.js";
import { entryText, parseEntries, renderEntries } from "./memory.js";
import { type HermesConfig, hermesHome, hermesTimezone, readConfig } from "./paths.js";

type Items = WriteResult["items"];

/** The memory limit Hermes uses when `config.yaml` sets none (`memory_char_limit`). */
const DEFAULT_MEMORY_LIMIT = 2200;
/** How much of a fact the report quotes when it skips it. */
const PREVIEW_CHARS = 60;

const RESTART_WARNING =
  "Restart the Hermes gateway (if it is running) so it picks up the profile and its cron jobs";
const SCANNER_WARNING =
  "Hermes scans memory entries and cron prompts for prompt injection; " +
  "an entry it rejects is dropped on its side";

/** Names a profile cannot have, and why. */
const REFUSED_PROFILES: ReadonlyMap<string, string> = new Map([
  ["default", "it is the profile in the Hermes home itself, which OpenTeleport never overwrites"],
  ["profiles", "it is the folder the named profiles live in"],
]);

/**
 * Names Hermes will not take for a profile it is asked to use by name: `_RESERVED_NAMES` (without
 * `default`, which is refused above) and `_HERMES_SUBCOMMANDS` in `hermes_cli/profiles.py`
 * (https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/profiles.py). A profile of
 * one of these names is listed by Hermes but cannot be selected, so the agent is written under
 * the name with `-agent` after it.
 */
const HERMES_RESERVED_PROFILES: ReadonlySet<string> = new Set([
  // _RESERVED_NAMES
  "hermes",
  "test",
  "tmp",
  "root",
  "sudo",
  // _HERMES_SUBCOMMANDS
  "chat",
  "model",
  "gateway",
  "setup",
  "whatsapp",
  "login",
  "logout",
  "status",
  "cron",
  "doctor",
  "dump",
  "config",
  "pairing",
  "skills",
  "tools",
  "mcp",
  "connectors",
  "sessions",
  "insights",
  "version",
  "update",
  "uninstall",
  "profile",
  "plugins",
  "honcho",
  "acp",
]);

const RESERVED_SUFFIX = "-agent";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonBlank = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

// Plain code-unit order, so that the result does not depend on the locale.
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The number of characters as Python's `len` counts them, which is how Hermes keeps its limit. */
const charCount = (value: string): number => Array.from(value).length;

const preview = (value: string): string => Array.from(value).slice(0, PREVIEW_CHARS).join("");

/**
 * The profile id for an agent name, and the name Hermes reserves when that is what the id had to
 * be changed for (see `profileSlug`).
 */
function slugOf(name: string): { slug: string; reserved?: string } {
  const base = slugify(name, { deviceSuffix: "-r" });
  if (base === "") {
    throw new Error(
      `Cannot make a Hermes profile name from ${JSON.stringify(name)}: it has no letters or digits`,
    );
  }
  const refused = REFUSED_PROFILES.get(base);
  if (refused !== undefined) {
    throw new Error(
      `Cannot name a Hermes profile "${base}": the name is reserved, ${refused}. ` +
        "Rename the agent.",
    );
  }
  // A reserved name is short, so the suffix keeps the id within the 64 characters.
  if (HERMES_RESERVED_PROFILES.has(base)) {
    return { slug: `${base}${RESERVED_SUFFIX}`, reserved: base };
  }
  return { slug: base };
}

/**
 * The profile id for an agent name: lower case, every run of characters outside `a-z0-9` one `-`,
 * no `-` at either end, at most 64 characters (what Hermes accepts as a profile id). A Windows
 * device name such as `con` gets `-r`, since its folder could not be created there, and a name
 * Hermes reserves (`test`, `status`, `hermes`...) gets `-agent`. Throws for a name that leaves
 * nothing, and for `default` and `profiles`, which Hermes uses itself.
 */
export function profileSlug(name: string): string {
  return slugOf(name).slug;
}

/**
 * What identifies the files of a skill: the SHA-256 of `<path>\n<SHA-256 of the bytes>\n` for each
 * file, in path order. The marker keeps it, so that a later move can tell a skill folder it wrote
 * and nobody touched from one that changed.
 */
export function skillDigest(skill: Skill): string {
  const digest = createHash("sha256");
  for (const file of [...skill.files].sort((a, b) => byCodeUnit(a.path, b.path))) {
    const content = createHash("sha256").update(file.bytes).digest("hex");
    digest.update(`${file.path}\n${content}\n`);
  }
  return digest.digest("hex");
}

// -- Files inside the profile ------------------------------------------------------------------

/**
 * Why `rel` (`/`-separated) below `root` cannot be written, or `undefined` when it can. A link or
 * junction on the way is never written through, and only a regular file (`kind` "file") or a
 * folder (`kind` "directory") may be at the end of the path.
 */
async function blockedBy(
  root: string,
  rel: string,
  kind: "file" | "directory",
): Promise<string | undefined> {
  const segments = rel.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstatIfAny(current);
    if (info === undefined) return undefined; // nothing from here on is there to be a link
    const shown = segments.slice(0, index + 1).join("/");
    const last = index === segments.length - 1;
    if (info.isSymbolicLink()) return `${shown} is a symbolic link`;
    if (!last && !info.isDirectory()) return `${shown} is not a directory`;
    if (last && kind === "file" && !info.isFile()) return `${shown} is not a regular file`;
    if (last && kind === "directory" && !info.isDirectory()) return `${shown} is not a directory`;
  }
  return undefined;
}

/**
 * `replaceFile` for a file Hermes reads while it runs, which it never sees half written. The file
 * keeps its mode.
 */
async function replaceKeepingMode(file: string, content: string): Promise<void> {
  const existing = await lstatIfAny(file);
  await replaceFile(file, content, existing === undefined ? {} : { mode: existing.mode & 0o777 });
}

/**
 * `replaceKeepingMode` for `rel` below `root`. Returns why nothing was written (see `blockedBy`), or
 * `undefined` when the file was written.
 */
async function putFile(root: string, rel: string, content: string): Promise<string | undefined> {
  const blocked = await blockedBy(root, rel, "file");
  if (blocked !== undefined) return blocked;
  await replaceKeepingMode(join(root, ...rel.split("/")), content);
  return undefined;
}

// -- Where the profile goes --------------------------------------------------------------------

type Target = {
  id: string;
  dir: string;
  /** `update` writes into a profile that carries this agent's marker; the others start afresh. */
  mode: "new" | "update" | "replace";
  /** The marker of an `update`, for what an earlier move wrote. */
  marker?: Marker;
};

async function isEmptyDirectory(path: string): Promise<boolean> {
  return (await readdir(path)).length === 0;
}

/** The first free `<base>-2`, `<base>-3`... */
async function freeId(profiles: string, base: string): Promise<string> {
  return basename(await freeSibling(join(profiles, base)));
}

/**
 * The `<base>-N` profile (N from 2, in number order) that carries the marker of the agent with
 * manifest id `id`, as an earlier move may have left it. Only real folders count.
 */
async function ownCopy(profiles: string, base: string, id: string): Promise<Target | undefined> {
  if (id === "") return undefined;
  let names: string[];
  try {
    names = await readdir(profiles);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const copies = names
    .map((name) => ({ name, n: copyNumber(name, base) }))
    .filter(({ n }) => n !== undefined && n >= 2)
    .sort((a, b) => (a.n as number) - (b.n as number));
  for (const { name } of copies) {
    const dir = join(profiles, name);
    if (!(await lstatIfAny(dir))?.isDirectory()) continue;
    const marker = await readMarker(dir);
    if (marker?.id === id) return { id: name, dir, mode: "update", marker };
  }
  return undefined;
}

/**
 * Settles where the profile goes. A free `profiles/<base>` is taken. When it is taken, `copy` goes
 * to the first free `<base>-2`, `<base>-3`...; a link, or anything but a folder, is never written
 * through and gets a name of its own; `replace` removes the profile there, but only one that
 * carries a marker, which proves that OpenTeleport wrote it; and `update` writes in place only
 * over the profile that carries this agent's marker, or else over the `<base>-N` copy an earlier
 * move made. Any other profile of the name keeps its folder, and this one becomes a copy, with a
 * warning that says so.
 */
async function claimTarget(
  profiles: string,
  base: string,
  bundle: Bundle,
  onConflict: WriteOpts["onConflict"],
  warnings: string[],
): Promise<Target> {
  const wanted = join(profiles, base);
  const fresh = (id: string): Target => ({ id, dir: join(profiles, id), mode: "new" });
  if (await isFree(wanted)) return fresh(base);
  if (onConflict === "copy") return fresh(await freeId(profiles, base));

  const info = await lstatIfAny(wanted);
  if (info === undefined || !info.isDirectory()) {
    const what = info?.isSymbolicLink() === true ? "a symbolic link" : "not a folder";
    if (onConflict === "replace") {
      throw new Error(
        `Refusing to replace ${wanted}: it is ${what}. Delete it yourself if you mean it.`,
      );
    }
    const own = await ownCopy(profiles, base, bundle.manifest.id);
    if (own !== undefined) return own;
    const id = await freeId(profiles, base);
    warnings.push(
      info?.isSymbolicLink() === true
        ? `'${wanted}' is a symlink; not written through; written as '${id}'`
        : `'${wanted}' is not a folder; written as '${id}'`,
    );
    return fresh(id);
  }

  const marker = await readMarker(wanted);
  if (onConflict === "replace") {
    if (marker === undefined) {
      throw new Error(
        `Refusing to replace ${wanted}: it holds no .openteleport.json, so OpenTeleport did not ` +
          "write it. Use --copy to write next to it, or delete it yourself if you mean it.",
      );
    }
    return { id: base, dir: wanted, mode: "replace" };
  }
  const { id } = bundle.manifest;
  if (id !== "" && marker?.id === id) return { id: base, dir: wanted, mode: "update", marker };
  const own = await ownCopy(profiles, base, id);
  if (own !== undefined) return own;
  const copy = await freeId(profiles, base);
  warnings.push(`profile '${base}' already exists; written as '${copy}'`);
  return fresh(copy);
}

/**
 * Throws when the `profiles` folder is a link or not a folder: a profile is created below it, and
 * nothing is written through a link. A folder that is not there yet is fine.
 */
async function assertProfilesFolder(profiles: string): Promise<void> {
  const info = await lstatIfAny(profiles);
  if (info === undefined || info.isDirectory()) return;
  const what = info.isSymbolicLink()
    ? "a symbolic link, and OpenTeleport never writes through one"
    : "not a folder";
  throw new Error(
    `Refusing to write a profile into ${profiles}: it is ${what}. ` +
      "Make it a real folder yourself if you mean it.",
  );
}

// -- What an earlier move wrote ----------------------------------------------------------------

type Recorded = {
  cronJobIds: string[];
  memoryEntries: string[];
  skills: Record<string, string>;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** What the marker says an earlier move wrote; a part it lacks or has misshapen is empty. */
function recordedBy(marker: Marker | undefined): Recorded {
  const skills = isRecord(marker?.skills) ? marker.skills : {};
  return {
    cronJobIds: strings(marker?.cronJobIds),
    memoryEntries: strings(marker?.memoryEntries),
    skills: Object.fromEntries(
      Object.entries(skills).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

/** `x-hermes` of the manifest, when it is an object. */
function vendorOf(bundle: Bundle): Record<string, unknown> {
  const vendor = bundle.manifest["x-hermes"];
  return isRecord(vendor) ? vendor : {};
}

// -- Identity, model, persona ------------------------------------------------------------------

/** `profile.yaml` of a new profile: the name, and the title as the description. */
async function writeProfileMeta(dir: string, bundle: Bundle, items: Items): Promise<void> {
  const meta: Record<string, string> = { display_name: bundle.manifest.name };
  const description = nonBlank(bundle.manifest.title);
  if (description !== undefined) meta.description = description;
  const why = await putFile(dir, "profile.yaml", stringify(meta));
  if (why !== undefined) {
    items.warnings.push(`${why}; profile.yaml not written, so the profile has no display name`);
  }
}

const names = (pref: ModelPref): boolean => pref.provider !== undefined || pref.model !== undefined;

/**
 * Hermes holds one model, `model.default` with its `model.provider`, in `config.yaml`. A new
 * profile gets the first preference that names a model; a profile that is already there keeps its
 * own `config.yaml`, whatever the Bundle says.
 */
async function writeModel(
  dir: string,
  bundle: Bundle,
  isNew: boolean,
  items: Items,
): Promise<void> {
  const prefs = bundle.manifest.models;
  const chosen = prefs.find((pref) => nonBlank(pref.model) !== undefined);
  if (!isNew) {
    if (chosen !== undefined) {
      items.approximated.push({ field: "models", detail: "kept the profile's own model" });
    }
    return;
  }
  if (prefs.length === 0) return;
  if (chosen?.model === undefined) {
    items.approximated.push({
      field: "models",
      detail: "no preference names a model; Hermes's default applies",
    });
    return;
  }
  const others = prefs.filter((pref) => pref !== chosen && names(pref)).length;
  if (others > 0) {
    items.approximated.push({
      field: "models",
      detail:
        `Hermes holds one model; used ${chosen.model}, ` +
        `${others} other preference${others === 1 ? "" : "s"} not set`,
    });
  }
  const baseUrl = vendorOf(bundle).baseUrl;
  const model = {
    default: chosen.model,
    ...(nonBlank(chosen.provider) === undefined ? {} : { provider: nonBlank(chosen.provider) }),
    ...(typeof baseUrl === "string" && baseUrl.trim() !== "" ? { base_url: baseUrl.trim() } : {}),
  };
  const why = await putFile(dir, "config.yaml", stringify({ model }));
  if (why !== undefined) items.skipped.push({ field: "models", detail: `${why}; not written` });
}

/**
 * `SOUL.md` holds the persona and the instructions as `mergeInstructions` lays them out. Hermes
 * has no other place for instructions, so with both the report says they share a file; with only
 * a persona the file is the persona; with only instructions Hermes reads them as the persona.
 */
async function writeSoul(dir: string, bundle: Bundle, items: Items): Promise<void> {
  const persona = bundle.persona?.trim() ?? "";
  const hasInstructions = bundle.instructions.trim() !== "";
  if (persona === "" && !hasInstructions) return;

  let content: string;
  let approximated: string | undefined;
  if (persona !== "" && hasInstructions) {
    content = mergeInstructions(bundle.persona, bundle.instructions);
    approximated = "persona and instructions share one file (SOUL.md)";
  } else if (persona !== "") {
    content = `${persona}\n`;
  } else {
    content = bundle.instructions;
    approximated =
      "no persona to share SOUL.md with; Hermes reads all of SOUL.md as the persona";
  }
  const why = await putFile(dir, "SOUL.md", content);
  if (why === undefined) {
    if (approximated !== undefined) {
      items.approximated.push({ field: "instructions", detail: approximated });
    }
    return;
  }
  const detail = `${why}; not written`;
  if (persona !== "") items.skipped.push({ field: "persona", detail });
  if (hasInstructions) items.skipped.push({ field: "instructions", detail });
}

// -- Skills ------------------------------------------------------------------------------------

/**
 * The files of the real folder `dir`, or `undefined` when it is not one or holds a link, any
 * other special file or a path that never goes into an archive anywhere below it (`readSkillFiles`
 * would leave it out): such a folder is not one OpenTeleport wrote.
 */
async function readFolder(dir: string): Promise<FileEntry[] | undefined> {
  if (!(await lstatIfAny(dir))?.isDirectory()) return undefined;
  const leftOut: string[] = [];
  const files = await readSkillFiles(dir, "", leftOut);
  return leftOut.length === 0 ? files : undefined;
}

/** 1 for `name` itself, N for `<name>-N` (N from 2), `undefined` for any other folder name. */
function copyNumber(folder: string, name: string): number | undefined {
  if (folder === name) return 1;
  const n = folder.startsWith(`${name}-`) ? folder.slice(name.length + 1) : "";
  return /^[1-9]\d*$/.test(n) && Number(n) >= 2 ? Number(n) : undefined;
}

/**
 * The folder of `skill` that OpenTeleport wrote earlier and nobody has changed since: `<name>` or
 * a `<name>-N` copy, the first whose files still have the digest the marker recorded. With the
 * paths in it that the new skill no longer has.
 */
async function ownFolder(
  skillsDir: string,
  skill: Skill,
  recorded: Record<string, string>,
  claimed: ReadonlySet<string>,
  bundled: ReadonlySet<string>,
): Promise<{ name: string; stale: string[] } | undefined> {
  // A `<name>-N` folder is a copy of this skill only when no skill of the Bundle is called that:
  // with both `foo` and `foo-2` in the Bundle, `foo-2` is the folder of the second.
  const candidates = Object.keys(recorded)
    .map((name) => ({ name, n: copyNumber(name, skill.name) }))
    .filter(
      ({ name, n }) =>
        n !== undefined && !claimed.has(name) && (name === skill.name || !bundled.has(name)),
    )
    .sort((a, b) => (a.n as number) - (b.n as number));
  for (const { name } of candidates) {
    const files = await readFolder(join(skillsDir, name));
    if (files === undefined || skillDigest({ name, files }) !== recorded[name]) continue;
    const wanted = new Set(skill.files.map((file) => file.path));
    return { name, stale: files.map((file) => file.path).filter((path) => !wanted.has(path)) };
  }
  return undefined;
}

/** Removes `stale` files of a skill folder, and the folders they leave empty. */
async function removeStale(folder: string, stale: readonly string[]): Promise<void> {
  for (const path of stale) {
    await rm(join(folder, ...path.split("/")), { force: true });
    for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) {
      const absolute = join(folder, ...parent.split("/"));
      if (!(await isEmptyDirectory(absolute))) break;
      await rmdir(absolute);
    }
  }
}

/**
 * Writes each skill to `skills/<name>/`. A folder this adapter wrote earlier and that is still as
 * it left it (its digest in the marker matches) is written over in place, files it no longer has
 * removed; for any other skill the rule is the one for a folder shared with other tools
 * (`placeSkill`): the same content is reused, different content makes a `-N` copy. Returns the
 * digests the marker should hold: the ones it had, and one for each folder written now.
 */
async function writeProfileSkills(
  dir: string,
  skills: readonly Skill[],
  recorded: Record<string, string>,
  items: Items,
): Promise<Record<string, string>> {
  const digests = { ...recorded };
  if (skills.length === 0) return digests;
  const skillsDir = join(dir, "skills");
  const blocked = await blockedBy(dir, "skills", "directory");
  const claimed = new Set<string>();
  const bundled = new Set(skills.map((skill) => skill.name));
  for (const skill of skills) {
    const field = `skill:${skill.name}`;
    // A name with a leading dot is Hermes's own state (`.hub`).
    if (
      !isSafeName(skill.name) ||
      skill.name.startsWith(".") ||
      skill.files.some((file) => !isSafeArchivePath(file.path))
    ) {
      items.skipped.push({ field, detail: "its name or a file path is not safe to write" });
      continue;
    }
    if (blocked !== undefined) {
      items.skipped.push({ field, detail: `${blocked}; not written` });
      continue;
    }
    const own = await ownFolder(skillsDir, skill, recorded, claimed, bundled);
    const name = own?.name ?? (await placeSkill(skillsDir, skill, items));
    if (name === undefined) continue; // the same skill is already there
    claimed.add(name);
    if (own !== undefined) await removeStale(join(skillsDir, name), own.stale);
    for (const file of skill.files) {
      const path = join(skillsDir, name, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes);
    }
    digests[name] = skillDigest(skill);
  }
  return digests;
}

// -- Memory ------------------------------------------------------------------------------------

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Writes the facts as entries of `memories/MEMORY.md`. The entries this adapter wrote last time
 * (`recorded`) are taken out first; entries that are not ours stay, and the new ones come after
 * them. Hermes refuses a write over its limit, so the file as a whole is held to
 * `memory_char_limit`: a fact that does not fit is skipped as `fact:<n>`. A fact the file already
 * holds is not repeated. Returns the entries to record: the ones written now.
 */
async function writeMemory(
  dir: string,
  facts: readonly string[],
  recorded: readonly string[],
  limit: number,
  items: Items,
): Promise<string[]> {
  if (facts.length === 0 && recorded.length === 0) return [];
  const rel = "memories/MEMORY.md";
  const blocked = await blockedBy(dir, rel, "file");
  if (blocked !== undefined) {
    if (facts.length > 0) {
      items.skipped.push({ field: "memory.facts", detail: `${blocked}; not written` });
    }
    return [...recorded];
  }

  const current = await readText(join(dir, ...rel.split("/")));
  const existing = parseEntries(current ?? "");
  const kept = [...existing];
  for (const entry of recorded) {
    const index = kept.indexOf(entry);
    if (index !== -1) kept.splice(index, 1);
  }
  const added: string[] = [];
  for (const [index, fact] of facts.entries()) {
    const entry = entryText(fact);
    const skip = (reason: string): void => {
      const detail = `${preview(entry)}… (${reason})`;
      items.skipped.push({ field: `fact:${index + 1}`, detail });
    };
    if (entry === "") {
      skip("empty");
    } else if (kept.includes(entry) || added.includes(entry)) {
      continue;
    } else if (charCount(renderEntries([...kept, ...added, entry])) > limit) {
      skip(`Hermes memory limit: ${limit} chars`);
    } else {
      added.push(entry);
    }
  }

  const next = [...kept, ...added];
  const unchanged =
    next.length === existing.length && next.every((entry, i) => entry === existing[i]);
  if (current === undefined ? next.length > 0 : !unchanged) {
    await replaceKeepingMode(join(dir, ...rel.split("/")), renderEntries(next));
  }
  return added;
}

// -- Routines ----------------------------------------------------------------------------------

/** Why Hermes cannot take the routine, or `undefined`. */
function unwritable(routine: Routine, now: Date): string | undefined {
  const { schedule } = routine;
  if (schedule.kind === "at" && Date.parse(schedule.at) <= now.getTime()) {
    return "Hermes rejects past one-off jobs";
  }
  if (schedule.kind !== "cron") return undefined;
  const cron = parseCron(schedule.expression);
  if (!cron.ok) return `invalid cron expression: ${cron.reason}`;
  // Hermes reads cron with croniter, whose sixth field is seconds at the end, not at the start.
  if (cron.fields === 6) {
    return "Hermes cron takes five fields; this expression has a seconds field";
  }
  return undefined;
}

/** What `x-hermes.routines` keeps for the routine of this name, if it is an object. */
function extraFor(bundle: Bundle, name: string): Record<string, unknown> | undefined {
  const routines = vendorOf(bundle).routines;
  if (!isRecord(routines) || !Object.hasOwn(routines, name)) return undefined;
  const extra = routines[name];
  return isRecord(extra) ? extra : undefined;
}

/**
 * Writes one job per routine to `cron/jobs.json`, every one paused (`routineToJob`), after a copy
 * of the file as it was. The jobs this adapter wrote last time (`recorded`) are taken out first;
 * jobs that are not ours, and every other key of the file, stay. A routine Hermes cannot take, or
 * all of them when the file cannot be read or written, are skipped. Returns the ids to record.
 */
async function writeRoutines(
  ctx: Ctx,
  dir: string,
  bundle: Bundle,
  opts: WriteOpts,
  recorded: readonly string[],
  config: HermesConfig | undefined,
  now: Date,
  items: Items,
): Promise<string[]> {
  if (bundle.routines.length === 0 && recorded.length === 0) return [];
  const skipAll = (why: string): string[] => {
    for (const routine of bundle.routines) {
      items.skipped.push({ field: `routine:${routine.name}`, detail: `${why}; not written` });
    }
    if (recorded.length > 0) {
      items.warnings.push(`${why}; the cron jobs written earlier were left as they are`);
    }
    return [...recorded];
  };
  const blocked = await blockedBy(dir, "cron/jobs.json", "file");
  if (blocked !== undefined) return skipAll(blocked);
  const file = join(dir, "cron", "jobs.json");
  const read = await readJobsFile(file);
  if ("error" in read) return skipAll(read.error);

  const ours = new Set(recorded);
  const kept = read.jobs.filter((job) => !ours.has(job.id));
  const taken = new Set(kept.map((job) => job.id));
  const timezone = hermesTimezone(ctx, config);

  const skipped: Item[] = [];
  const approximated: Item[] = [];
  const created: { routine: Routine; job: HermesJob }[] = [];
  for (const routine of bundle.routines) {
    const field = `routine:${routine.name}`;
    const why = unwritable(routine, now);
    if (why !== undefined) {
      skipped.push({ field, detail: why });
      continue;
    }
    // Hermes reads one time zone for the whole profile; an interval and a point in time do not
    // depend on it, a cron expression does.
    if (routine.schedule.kind === "cron" && routine.timezone !== timezone) {
      approximated.push({
        field,
        detail:
          "Hermes has one time zone per profile; " +
          `this routine assumed ${timezone} instead of ${routine.timezone}`,
      });
    }
    let id = newJobId();
    while (taken.has(id)) id = newJobId();
    taken.add(id);
    created.push({ routine, job: routineToJob(routine, extraFor(bundle, routine.name), now, id) });
  }

  let failure: string | undefined;
  if (created.length > 0 || kept.length !== read.jobs.length) {
    const jobs = [...kept, ...read.ignored, ...created.map(({ job }) => job)];
    try {
      await writeJobsFile(file, jobs, read.rest, now);
    } catch (error) {
      failure = (error as Error).message;
    }
  }
  items.skipped.push(...skipped);
  if (failure !== undefined) {
    for (const { routine } of created) {
      items.skipped.push({ field: `routine:${routine.name}`, detail: `${failure}; not written` });
    }
    return [...recorded];
  }
  items.approximated.push(...approximated);
  if (opts.enableRoutines && created.length > 0) {
    for (const { routine, job } of created) {
      items.approximated.push({
        field: `routine:${routine.name}`,
        detail: `Hermes jobs are written paused; resume them with \`hermes cron resume ${job.id}\``,
      });
    }
    const commands = created.map(
      ({ routine, job }) => `hermes cron resume ${job.id} (${routine.name})`,
    );
    items.warnings.push(`To run the paused jobs: ${commands.join("; ")}`);
  }
  return created.map(({ job }) => job.id);
}

// -- The adapter's write -----------------------------------------------------------------------

async function finishWrite(
  ctx: Ctx,
  target: Target,
  bundle: Bundle,
  opts: WriteOpts,
  items: Items,
  now: Date,
): Promise<WriteResult> {
  const { dir } = target;
  const isNew = target.mode !== "update";
  const recorded = recordedBy(target.marker);

  // A profile that is already there has its own memory limit and time zone; a new one has none.
  let config: HermesConfig | undefined;
  if (!isNew) {
    try {
      config = (await readConfig(dir))?.config;
    } catch (error) {
      items.warnings.push(
        `${(error as Error).message}; the default memory limit of ${DEFAULT_MEMORY_LIMIT} ` +
          "characters and the time zone of the environment apply",
      );
    }
  }

  if (isNew) await writeProfileMeta(dir, bundle, items);
  await writeModel(dir, bundle, isNew, items);
  await writeSoul(dir, bundle, items);
  const skills = await writeProfileSkills(dir, bundle.skills, recorded.skills, items);
  const limit = config?.memory?.memory_char_limit ?? DEFAULT_MEMORY_LIMIT;
  const memoryEntries = await writeMemory(dir, bundle.facts, recorded.memoryEntries, limit, items);
  const cronJobIds = await writeRoutines(
    ctx,
    dir,
    bundle,
    opts,
    recorded.cronJobIds,
    config,
    now,
    items,
  );

  await writeMarker(dir, {
    ...target.marker,
    id: bundle.manifest.id,
    movedAt: now.toISOString(),
    cronJobIds,
    memoryEntries,
    skills,
  });
  items.warnings.push(RESTART_WARNING, SCANNER_WARNING);
  return { outcome: "done", targetAgentId: target.id, artifactPath: dir, items };
}

/**
 * Writes a Bundle into the Hermes home of `ctx` (its `targetDir`, else `HERMES_HOME`, else the
 * usual place) as the profile `profiles/<slug>/`, and says what it could not hold. The profile
 * is always a named one: `default` is the user's own. A name Hermes cannot use as a profile id
 * is refused before anything is written, and so is a `replace` of a profile that carries no
 * marker. `bundle` is not changed.
 */
export async function writeHermesProfile(
  ctx: Ctx,
  bundle: Bundle,
  opts: WriteOpts,
): Promise<WriteResult> {
  const items: Items = { approximated: [], skipped: [], warnings: [] };
  const profiles = join(hermesHome(ctx), "profiles");
  const { slug, reserved } = slugOf(bundle.manifest.name);
  await assertProfilesFolder(profiles);
  if (reserved !== undefined) {
    // Said on every move, not only the first: the profile is not the one the name suggests.
    items.warnings.push(`Hermes reserves the profile name '${reserved}'; written as '${slug}'`);
  }
  const target = await claimTarget(profiles, slug, bundle, opts.onConflict, items.warnings);
  const now = new Date();

  if (target.mode === "replace") await rm(target.dir, { recursive: true, force: true });
  await mkdir(target.dir, { recursive: true });
  const fresh = target.mode !== "update";
  if (fresh) {
    // The marker comes first, so that a write that fails half way leaves a profile that a retry
    // updates (or `--replace` replaces) instead of a stranger it has to copy next to.
    await writeMarker(target.dir, {
      id: bundle.manifest.id,
      movedAt: now.toISOString(),
      cronJobIds: [],
      memoryEntries: [],
      skills: {},
    });
  }
  try {
    return await finishWrite(ctx, target, bundle, opts, items, now);
  } catch (error) {
    if (!fresh) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`profile '${target.id}' was created in ${target.dir}; ${message}`, {
      cause: error,
    });
  }
}
