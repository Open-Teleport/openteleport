import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { zipSync } from "fflate";
import { ZodError } from "zod";
import {
  MAX_ARCHIVE_BYTES,
  MAX_AVATAR_BYTES,
  MAX_FACT_CHARS,
  MAX_FILES_BYTES,
  MAX_ROUTINES,
  MAX_SKILLS,
  MAX_TEXT_ENTRY_BYTES,
  isForbiddenPath,
  isSafeArchivePath,
} from "./paths.js";
import {
  type Bundle,
  type FileEntry,
  type Manifest,
  type Note,
  type Routine,
  RoutineSchema,
  type Skill,
  parseManifest,
} from "./schema.js";
import { byCodeUnit, slugify } from "./text.js";
import { type ZipPolicy, readZipEntries } from "./zip.js";

const MANIFEST_PATH = "jetpack.json";
const INSTRUCTIONS_PATH = "AGENTS.md";
const PERSONA_PATH = "SOUL.md";
const MEMORY_PATH = "MEMORY.md";
const SKILL_FILE = "SKILL.md";
const FILES_PREFIX = "files/";

/** The note that carries the lines of `MEMORY.md` that are not facts. */
const MEMORY_PROSE_NOTE = "MEMORY-prose";

const NOTE_PATTERN = /^memory\/([^/]+)\.md$/;
const ROUTINE_PATTERN = /^routines\/[^/]+\.json$/;
const SKILL_PATH_PATTERN = /^skills\/([^/]+)\/(.+)$/;
const AVATAR_PATTERN = /^avatar\.(png|jpe?g|webp)$/i;

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type ReadBundleOptions = {
  /** Fail when `jetpack.json` is missing (default `true`). Otherwise a manifest is synthesized. */
  requireManifest?: boolean;
};

export type WriteBundleOptions = {
  /** Write a directory tree instead of a zip archive. */
  asDirectory?: boolean;
  /** Create a new archive with an exclusive file open; existing entries, including symlinks, fail. */
  exclusiveArchive?: boolean;
};

export type EntriesToBundleOptions = {
  /** Fail when `jetpack.json` is missing (default `true`). */
  requireManifest?: boolean;
  /** `name` of the synthesized manifest when `jetpack.json` is missing and not required. */
  fallbackName?: string;
};

/** A path and its size, known before the content is read or inflated. */
type Listing = { path: string; size: number };

/** Where a path of the layout belongs; `unknown` is anything the layout does not mention. */
type Classified =
  | { kind: "manifest" | "instructions" | "persona" | "memory" | "routine" | "avatar" | "unknown" }
  | { kind: "note"; name: string }
  | { kind: "skill"; name: string; file: string }
  | { kind: "file"; file: string };

function classify(path: string): Classified {
  if (path === MANIFEST_PATH) return { kind: "manifest" };
  if (path === INSTRUCTIONS_PATH) return { kind: "instructions" };
  if (path === PERSONA_PATH) return { kind: "persona" };
  if (path === MEMORY_PATH) return { kind: "memory" };
  if (path.startsWith(FILES_PREFIX)) return { kind: "file", file: path.slice(FILES_PREFIX.length) };
  const note = NOTE_PATTERN.exec(path);
  if (note?.[1] !== undefined) return { kind: "note", name: note[1] };
  if (ROUTINE_PATTERN.test(path)) return { kind: "routine" };
  const skill = SKILL_PATH_PATTERN.exec(path);
  if (skill?.[1] !== undefined && skill[2] !== undefined) {
    return { kind: "skill", name: skill[1], file: skill[2] };
  }
  if (AVATAR_PATTERN.test(path)) return { kind: "avatar" };
  return { kind: "unknown" };
}

// -- Validation shared by reading and writing ------------------------------------------------

/**
 * Checks everything that can be decided from paths and sizes alone, so that an archive can be
 * rejected before any of it is inflated or read: unsafe and forbidden paths, duplicates, the
 * number of skills and routines, and the sizes.
 *
 * Sizes are bounded three ways. An entry outside `files/` that belongs to the layout is at most
 * `MAX_TEXT_ENTRY_BYTES` (the avatar has its own, smaller limit), `files/` as a whole is at most
 * `MAX_FILES_BYTES`, and all entries together, paths outside the layout included, are at most
 * `MAX_ARCHIVE_BYTES`. Paths outside the layout are never inflated or read, so only that total
 * bounds them.
 */
function validateListing(listing: readonly Listing[]): void {
  const seen = new Set<string>();
  const skillNames = new Set<string>();
  const files: Listing[] = [];
  let routineCount = 0;
  let filesBytes = 0;
  let totalBytes = 0;
  for (const { path, size } of listing) {
    if (!isSafeArchivePath(path)) throw new Error(`unsafe path: ${path}`);
    if (isForbiddenPath(path)) throw new Error(`forbidden path: ${path}`);
    if (seen.has(path)) throw new Error(`duplicate path: ${path}`);
    seen.add(path);
    totalBytes += size;

    const found = classify(path);
    if (found.kind === "file") {
      filesBytes += size;
      files.push({ path, size });
    } else if (found.kind === "avatar") {
      if (size > MAX_AVATAR_BYTES) {
        throw new Error(`${path} is ${size} bytes, over the ${MAX_AVATAR_BYTES} byte limit`);
      }
    } else if (found.kind !== "unknown") {
      if (size > MAX_TEXT_ENTRY_BYTES) {
        throw new Error(
          `${path} is ${size} bytes, over the ${MAX_TEXT_ENTRY_BYTES} byte limit for entries ` +
            "outside files/",
        );
      }
      if (found.kind === "routine") routineCount += 1;
      if (found.kind === "skill") skillNames.add(found.name);
    }
  }
  if (skillNames.size > MAX_SKILLS) {
    throw new Error(`too many skills: ${skillNames.size} (the limit is ${MAX_SKILLS})`);
  }
  if (routineCount > MAX_ROUTINES) {
    throw new Error(`too many routines: ${routineCount} (the limit is ${MAX_ROUTINES})`);
  }
  if (filesBytes > MAX_FILES_BYTES) {
    // What to delete first: the five largest files, the largest first.
    const largest = files
      .sort((a, b) => b.size - a.size || byCodeUnit(a.path, b.path))
      .slice(0, 5)
      .map(({ path, size }) => `${path} (${size} bytes)`)
      .join(", ");
    throw new Error(
      `files/ is ${filesBytes} bytes, over the ${MAX_FILES_BYTES} byte limit; the largest: ` +
        largest,
    );
  }
  if (totalBytes > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `entries add up to ${totalBytes} bytes, over the ${MAX_ARCHIVE_BYTES} byte limit`,
    );
  }
}

function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Runs a schema parser and turns its `ZodError` into an error that names `label`. */
function validated<T>(label: string, value: unknown, parse: (value: unknown) => T): T {
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`${label} is invalid: ${formatIssues(error)}`, { cause: error });
    }
    throw error;
  }
}

function assertSingleSegment(value: string, label: string): void {
  if (value === "" || value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} must be a single path segment: ${JSON.stringify(value)}`);
  }
}

// -- Archive entries -> Bundle ---------------------------------------------------------------

function decodeText({ path, bytes }: FileEntry): string {
  try {
    return utf8.decode(bytes);
  } catch (error) {
    throw new Error(`${path} is not valid UTF-8`, { cause: error });
  }
}

function parseJsonEntry<T>(entry: FileEntry, parse: (json: unknown) => T): T {
  const source = decodeText(entry);
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    throw new Error(`${entry.path} is not valid JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return validated(entry.path, json, parse);
}

/** Lines starting with `- ` are facts; every other non-empty line is prose. */
function parseMemory(source: string): { facts: string[]; prose: string[] } {
  const facts: string[] = [];
  const prose: string[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    if (!trimmed.startsWith("- ")) {
      prose.push(line.trimEnd());
      return;
    }
    const fact = trimmed.slice(2).trim();
    if (fact.length > MAX_FACT_CHARS) {
      throw new Error(
        `${MEMORY_PATH} line ${index + 1}: fact is ${fact.length} characters, ` +
          `the limit is ${MAX_FACT_CHARS}`,
      );
    }
    facts.push(fact);
  });
  return { facts, prose };
}

// Plain code-unit order, so that the result does not depend on the locale.
const byPath = (a: FileEntry, b: FileEntry): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Builds a Bundle from the files of an archive. Pure: no disk access. Files, skills, notes and
 * routines come out ordered by path; paths outside the layout are listed in `unknownPaths`, and
 * the bytes of such an entry are never looked at (a reader may pass them empty).
 */
export function entriesToBundle(
  entries: readonly FileEntry[],
  opts: EntriesToBundleOptions = {},
): Bundle {
  const { requireManifest = true, fallbackName = "" } = opts;
  validateListing(entries.map(({ path, bytes }) => ({ path, size: bytes.length })));

  let manifestEntry: FileEntry | undefined;
  let instructionsEntry: FileEntry | undefined;
  let personaEntry: FileEntry | undefined;
  let memoryEntry: FileEntry | undefined;
  const noteEntries: { name: string; entry: FileEntry }[] = [];
  const routineEntries: FileEntry[] = [];
  const skillEntries = new Map<string, FileEntry[]>();
  const files: FileEntry[] = [];
  const avatarEntries: FileEntry[] = [];
  const unknownPaths: string[] = [];

  for (const entry of [...entries].sort(byPath)) {
    const found = classify(entry.path);
    switch (found.kind) {
      case "manifest":
        manifestEntry = entry;
        break;
      case "instructions":
        instructionsEntry = entry;
        break;
      case "persona":
        personaEntry = entry;
        break;
      case "memory":
        memoryEntry = entry;
        break;
      case "note":
        noteEntries.push({ name: found.name, entry });
        break;
      case "routine":
        routineEntries.push(entry);
        break;
      case "skill": {
        const group = skillEntries.get(found.name) ?? [];
        group.push({ path: found.file, bytes: entry.bytes });
        skillEntries.set(found.name, group);
        break;
      }
      case "file":
        files.push({ path: found.file, bytes: entry.bytes });
        break;
      case "avatar":
        avatarEntries.push(entry);
        break;
      case "unknown":
        unknownPaths.push(entry.path);
        break;
    }
  }

  const manifestMissing = requireManifest && !manifestEntry;
  if (manifestMissing || !instructionsEntry) {
    const missing = [manifestMissing && MANIFEST_PATH, !instructionsEntry && INSTRUCTIONS_PATH];
    throw new Error(`missing ${missing.filter(Boolean).join(" and ")}`);
  }

  const manifest: Manifest = manifestEntry
    ? parseJsonEntry(manifestEntry, parseManifest)
    : // The id stays empty: the first export assigns it, and an empty id is not a valid ULID.
      {
        schemaVersion: "0.1",
        id: "",
        name: fallbackName || "agent",
        models: [],
        capabilities: [],
      };
  if (avatarEntries.length > 1) {
    throw new Error(`more than one avatar: ${avatarEntries.map(({ path }) => path).join(", ")}`);
  }

  const notes: Note[] = noteEntries.map(({ name, entry }) => ({ name, text: decodeText(entry) }));
  const { facts, prose } = memoryEntry
    ? parseMemory(decodeText(memoryEntry))
    : { facts: [], prose: [] };
  if (prose.length > 0) {
    if (notes.some((note) => note.name === MEMORY_PROSE_NOTE)) {
      throw new Error(
        `memory/${MEMORY_PROSE_NOTE}.md clashes with the prose lines of ${MEMORY_PATH}`,
      );
    }
    notes.push({ name: MEMORY_PROSE_NOTE, text: prose.join("\n") });
  }

  const skills: Skill[] = [];
  for (const [name, skillFiles] of skillEntries) {
    const main = skillFiles.find(({ path }) => path === SKILL_FILE);
    if (!main) throw new Error(`skill directory skills/${name} has no ${SKILL_FILE}`);
    skills.push({ name, files: [main, ...skillFiles.filter((file) => file !== main)] });
  }

  const routines: Routine[] = routineEntries.map((entry) =>
    parseJsonEntry(entry, (json) => RoutineSchema.parse(json)),
  );

  const bundle: Bundle = {
    manifest,
    instructions: decodeText(instructionsEntry),
    skills,
    routines,
    facts,
    notes,
    files,
    unknownPaths,
  };
  if (personaEntry) bundle.persona = decodeText(personaEntry);
  const [avatar] = avatarEntries;
  if (avatar) bundle.avatar = { name: avatar.path, bytes: avatar.bytes };
  return bundle;
}

// -- Bundle -> archive entries ---------------------------------------------------------------

/**
 * A slug of a routine name (see `slugify`). A name with nothing usable, or one that would make a
 * forbidden file name, becomes `routine`; a Windows device name such as `con` gets `-r`.
 */
function routineSlug(name: string): string {
  const slug = slugify(name, { deviceSuffix: "-r" });
  return slug === "" || isForbiddenPath(`${slug}.json`) ? "routine" : slug;
}

/** `base`, then `base-2`, `base-3`... for the names that collapse to the same slug. */
function uniqueSlug(name: string, taken: Set<string>): string {
  const base = routineSlug(name);
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

function renderMemory(facts: readonly string[], prose: string | undefined): string | undefined {
  const lines = facts.map((fact, index) => {
    const text = fact.trim();
    if (text === "" || /[\r\n]/.test(text)) {
      throw new Error(`fact ${index + 1} must be a single non-empty line`);
    }
    if (text.length > MAX_FACT_CHARS) {
      throw new Error(
        `fact ${index + 1} is ${text.length} characters, the limit is ${MAX_FACT_CHARS}`,
      );
    }
    return `- ${text}`;
  });

  const sections: string[] = [];
  if (prose !== undefined && prose.trim() !== "") sections.push(prose.trimEnd());
  if (lines.length > 0) sections.push(lines.join("\n"));
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : undefined;
}

/**
 * Lays a Bundle out as the files of an archive. Pure: no disk access. Refuses a Bundle that
 * `entriesToBundle` would reject, so what gets written can always be read back. `unknownPaths`
 * is not written.
 */
export function bundleToEntries(bundle: Bundle): FileEntry[] {
  const entries: FileEntry[] = [];
  const addText = (path: string, content: string): void => {
    entries.push({ path, bytes: encoder.encode(content) });
  };
  const addJson = (path: string, value: unknown): void => {
    addText(path, `${JSON.stringify(value, null, 2)}\n`);
  };

  addJson(MANIFEST_PATH, validated("manifest", bundle.manifest, parseManifest));
  addText(INSTRUCTIONS_PATH, bundle.instructions);
  if (bundle.persona !== undefined) addText(PERSONA_PATH, bundle.persona);

  const proseNote = bundle.notes.find((note) => note.name === MEMORY_PROSE_NOTE);
  const memory = renderMemory(bundle.facts, proseNote?.text);
  if (memory !== undefined) addText(MEMORY_PATH, memory);
  for (const note of bundle.notes) {
    if (note.name === MEMORY_PROSE_NOTE) continue;
    assertSingleSegment(note.name, "note name");
    addText(`memory/${note.name}.md`, note.text);
  }

  const slugs = new Set<string>();
  for (const routine of bundle.routines) {
    const valid = validated(`routine "${routine.name}"`, routine, (value) =>
      RoutineSchema.parse(value),
    );
    addJson(`routines/${uniqueSlug(routine.name, slugs)}.json`, valid);
  }

  for (const skill of bundle.skills) {
    assertSingleSegment(skill.name, "skill name");
    if (!skill.files.some(({ path }) => path === SKILL_FILE)) {
      throw new Error(`skill ${skill.name} has no ${SKILL_FILE}`);
    }
    for (const file of skill.files) {
      entries.push({ path: `skills/${skill.name}/${file.path}`, bytes: file.bytes });
    }
  }

  for (const file of bundle.files) {
    entries.push({ path: `${FILES_PREFIX}${file.path}`, bytes: file.bytes });
  }

  if (bundle.avatar) {
    if (!AVATAR_PATTERN.test(bundle.avatar.name)) {
      throw new Error(
        "avatar file name must be avatar.png, avatar.jpg, avatar.jpeg or avatar.webp, " +
          `not ${JSON.stringify(bundle.avatar.name)}`,
      );
    }
    entries.push({ path: bundle.avatar.name, bytes: bundle.avatar.bytes });
  }

  validateListing(entries.map(({ path, bytes }) => ({ path, size: bytes.length })));
  return entries;
}

// -- Disk -----------------------------------------------------------------------------------

/** Views a Node buffer as a plain `Uint8Array` without copying it. */
const toBytes = (buffer: Buffer): Uint8Array =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

type DiskFile = Listing & { absolute: string };

/** The top-level names of the layout: its files, the avatar and its directories. */
const isLayoutName = (name: string): boolean =>
  LAYOUT_NAMES.has(name) || name === MANIFEST_PATH || AVATAR_PATTERN.test(name);

/** A name outside the layout that is named but never descended into. */
const isHiddenName = (name: string): boolean => name.startsWith(".") || isForbiddenPath(name);

type DirentLike = { name: string; isDirectory(): boolean; isFile(): boolean };

/**
 * Lists the files of an agent folder with `/`-separated relative paths. Below a top-level name
 * of the layout (`AGENTS.md`, `skills/`, `files/`...) every file is listed, and a forbidden path,
 * a link or a special file is an error. Anything else is outside the layout: it is only named in
 * `outside`, never read, so that an agent kept in a git repository or a project can be read. A
 * forbidden name, a name that starts with a dot and a link are named once there and never
 * descended into, so a `.git` or a `node_modules` is not walked.
 */
async function listDirectory(root: string): Promise<{ layout: DiskFile[]; outside: string[] }> {
  const layout: DiskFile[] = [];
  const outside: string[] = [];

  async function visitLayout(absolute: string, path: string, dirent: DirentLike): Promise<void> {
    if (isForbiddenPath(path)) throw new Error(`forbidden path: ${path}`);
    if (dirent.isDirectory()) {
      for (const child of await readdir(absolute, { withFileTypes: true })) {
        await visitLayout(join(absolute, child.name), `${path}/${child.name}`, child);
      }
    } else if (dirent.isFile()) {
      layout.push({ path, absolute, size: (await stat(absolute)).size });
    } else {
      throw new Error(`unsupported file type (symbolic link or special file): ${path}`);
    }
  }

  async function visitOutside(absolute: string, path: string, dirent: DirentLike): Promise<void> {
    // Dirent types come from lstat, so a link is never a directory here.
    if (isHiddenName(dirent.name) || !dirent.isDirectory()) {
      outside.push(path);
      return;
    }
    for (const child of await readdir(absolute, { withFileTypes: true })) {
      await visitOutside(join(absolute, child.name), `${path}/${child.name}`, child);
    }
  }

  for (const dirent of await readdir(root, { withFileTypes: true })) {
    const visit = isLayoutName(dirent.name) ? visitLayout : visitOutside;
    await visit(join(root, dirent.name), dirent.name, dirent);
  }
  return { layout, outside };
}

/** Content of a path outside the layout: it is only reported, so it is not read or inflated. */
const unreadBytes = (): Uint8Array => new Uint8Array(0);

/**
 * The entries of an agent folder's layout, read once their paths and sizes pass the limits, and
 * the paths outside the layout. Only a path the layout gives a meaning to counts toward the
 * sizes: an unknown file under `memory/` or `skills/` is listed, but neither read nor counted.
 */
async function readDirectoryEntries(
  root: string,
): Promise<{ entries: FileEntry[]; outside: string[] }> {
  const { layout, outside } = await listDirectory(root);
  const known = (path: string): boolean => classify(path).kind !== "unknown";
  validateListing(layout.map(({ path, size }) => ({ path, size: known(path) ? size : 0 })));
  const entries: FileEntry[] = [];
  for (const { path, absolute } of layout) {
    entries.push({ path, bytes: known(path) ? toBytes(await readFile(absolute)) : unreadBytes() });
  }
  return { entries, outside };
}

/** The zip reader's view of the layout: where a path belongs decides if it is read at all. */
const ZIP_POLICY: ZipPolicy = {
  kindOf: (path) => {
    const { kind } = classify(path);
    return kind === "file" ? "file" : kind === "unknown" ? "unknown" : "text";
  },
  validate: validateListing,
};

/**
 * Reads a `.jetpack` zip archive or an agent directory.
 *
 * Without `jetpack.json` and with `requireManifest: false` the manifest is synthesized from the
 * name of `source` (without a trailing `.jetpack`), with an empty `id` for the caller to fill in.
 *
 * In an archive a forbidden path (`.git`, `node_modules`, `.env*`, a nested archive) anywhere is
 * an error. A directory is often a git repository or a project too, so there only the layout is
 * held to that rule; what lies outside it is listed in `unknownPaths` (see `listDirectory`).
 */
export async function readBundle(source: string, opts: ReadBundleOptions = {}): Promise<Bundle> {
  const info = await stat(source);
  const toBundle = (entries: FileEntry[]): Bundle =>
    entriesToBundle(entries, {
      requireManifest: opts.requireManifest,
      fallbackName: basename(resolve(source)).replace(/\.jetpack$/i, ""),
    });
  if (!info.isDirectory()) return toBundle(await readZipEntries(source, info.size, ZIP_POLICY));

  const { entries, outside } = await readDirectoryEntries(source);
  const bundle = toBundle(entries);
  bundle.unknownPaths = [...bundle.unknownPaths, ...outside].sort(byCodeUnit);
  return bundle;
}

/** What an export puts at the top of a directory besides `jetpack.json` and the avatar. */
const LAYOUT_NAMES: ReadonlySet<string> = new Set([
  INSTRUCTIONS_PATH,
  PERSONA_PATH,
  MEMORY_PATH,
  "memory",
  "skills",
  "routines",
  "files",
]);

/**
 * What a previous export holds under the top-level names `layout` and `entries` do not write
 * again, collapsed to the highest path that goes: `skills/web-brief` for a whole skill. A
 * directory of the layout itself is never named, only what goes from inside it.
 */
async function staleEntries(
  directory: string,
  layout: readonly string[],
  entries: readonly FileEntry[],
): Promise<string[]> {
  // Every path written, and every directory on the way to one.
  const written = new Set<string>();
  for (const { path } of entries) {
    const segments = path.split("/");
    for (let n = 1; n <= segments.length; n += 1) written.add(segments.slice(0, n).join("/"));
  }
  const stale: string[] = [];
  async function collect(absolute: string, prefix: string): Promise<void> {
    // Dirent types come from lstat: a link is named, never followed.
    for (const dirent of await readdir(absolute, { withFileTypes: true })) {
      const path = `${prefix}/${dirent.name}`;
      if (!written.has(path)) stale.push(path);
      else if (dirent.isDirectory()) await collect(join(absolute, dirent.name), path);
    }
  }
  for (const name of layout) {
    const absolute = join(directory, name);
    if ((await lstat(absolute)).isDirectory()) await collect(absolute, name);
    else if (!written.has(name)) stale.push(name);
  }
  return stale.sort(byCodeUnit);
}

/**
 * Makes room for an export. A missing or empty directory needs nothing. A directory with a
 * `jetpack.json` is a previous export: the parts of the layout are removed so that nothing the
 * new Bundle dropped lingers, and every other file stays. Any other directory is refused.
 * Returns what was removed and is not written again (see `staleEntries`).
 */
async function prepareDirectory(
  directory: string,
  entries: readonly FileEntry[],
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (names.length === 0) return [];
  if (!names.includes(MANIFEST_PATH)) {
    throw new Error(
      `${directory} is not empty and holds no ${MANIFEST_PATH}, so it is not a previous export`,
    );
  }
  const layout = names.filter((name) => LAYOUT_NAMES.has(name) || AVATAR_PATTERN.test(name));
  const removed = await staleEntries(directory, layout, entries);
  for (const name of layout) await rm(join(directory, name), { recursive: true, force: true });
  return removed;
}

/**
 * Writes a Bundle as a zip archive at `target`, or with `asDirectory` as a directory tree. A
 * directory that already has content is only written into when it holds a `jetpack.json`; the
 * layout of that earlier export is replaced and any other file in it is left alone. `removed`
 * names, with `/` separators, what that earlier export held and the new one does not (`SOUL.md`,
 * `skills/web-brief`, `memory/2026-10-20.md`...); it is empty for an archive.
 */
export async function writeBundle(
  bundle: Bundle,
  target: string,
  opts: WriteBundleOptions = {},
): Promise<{ removed: string[] }> {
  if (opts.asDirectory && opts.exclusiveArchive) throw new Error("exclusiveArchive requires an archive output");
  const entries = bundleToEntries(bundle);

  if (!opts.asDirectory) {
    const files = Object.fromEntries(entries.map(({ path, bytes }) => [path, bytes]));
    await writeFile(target, zipSync(files), { flag: opts.exclusiveArchive ? "wx" : "w" });
    return { removed: [] };
  }

  const removed = await prepareDirectory(target, entries);
  for (const { path, bytes } of entries) {
    const file = join(target, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  return { removed };
}
