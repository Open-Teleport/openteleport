import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { ZodError } from "zod";
import {
  MAX_AVATAR_BYTES,
  MAX_FACT_CHARS,
  MAX_FILES_BYTES,
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
};

export type EntriesToBundleOptions = {
  /** Fail when `jetpack.json` is missing (default `true`). */
  requireManifest?: boolean;
  /** `name` of the synthesized manifest when `jetpack.json` is missing and not required. */
  fallbackName?: string;
};

/** A path and its size, known before the content is read or inflated. */
type Listing = { path: string; size: number };

// -- Validation shared by reading and writing ------------------------------------------------

/**
 * Checks everything that can be decided from paths and sizes alone, so that an archive can be
 * rejected before it is inflated: unsafe and forbidden paths, duplicates and the size limits.
 */
function validateListing(listing: readonly Listing[]): void {
  const seen = new Set<string>();
  let filesBytes = 0;
  for (const { path, size } of listing) {
    if (!isSafeArchivePath(path)) throw new Error(`unsafe path: ${path}`);
    if (isForbiddenPath(path)) throw new Error(`forbidden path: ${path}`);
    if (seen.has(path)) throw new Error(`duplicate path: ${path}`);
    seen.add(path);

    if (path.startsWith(FILES_PREFIX)) {
      filesBytes += size;
    } else if (AVATAR_PATTERN.test(path) && size > MAX_AVATAR_BYTES) {
      throw new Error(`${path} is ${size} bytes, over the ${MAX_AVATAR_BYTES} byte limit`);
    }
  }
  if (filesBytes > MAX_FILES_BYTES) {
    throw new Error(`files/ is ${filesBytes} bytes, over the ${MAX_FILES_BYTES} byte limit`);
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
 * routines come out ordered by path; paths outside the layout are listed in `unknownPaths`.
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
    const { path } = entry;
    const note = NOTE_PATTERN.exec(path);
    const skillPath = SKILL_PATH_PATTERN.exec(path);
    if (path === MANIFEST_PATH) {
      manifestEntry = entry;
    } else if (path === INSTRUCTIONS_PATH) {
      instructionsEntry = entry;
    } else if (path === PERSONA_PATH) {
      personaEntry = entry;
    } else if (path === MEMORY_PATH) {
      memoryEntry = entry;
    } else if (note?.[1] !== undefined) {
      noteEntries.push({ name: note[1], entry });
    } else if (ROUTINE_PATTERN.test(path)) {
      routineEntries.push(entry);
    } else if (skillPath?.[1] !== undefined) {
      const group = skillEntries.get(skillPath[1]) ?? [];
      group.push(entry);
      skillEntries.set(skillPath[1], group);
    } else if (path.startsWith(FILES_PREFIX)) {
      files.push({ path: path.slice(FILES_PREFIX.length), bytes: entry.bytes });
    } else if (AVATAR_PATTERN.test(path)) {
      avatarEntries.push(entry);
    } else {
      unknownPaths.push(path);
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
  for (const [name, group] of skillEntries) {
    const prefix = `skills/${name}/`;
    const skillFiles = group.map(({ path, bytes }) => ({ path: path.slice(prefix.length), bytes }));
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
 * Lowercases a routine name and turns every run of characters that are not letters or digits
 * into one `-`. Letters outside ASCII are kept. Names with nothing usable, and names that would
 * make a forbidden file name, become `routine`.
 */
function routineSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
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

/**
 * Lists every file below `root` with `/`-separated relative paths. A forbidden path stops the
 * walk at once, so a stray `node_modules` is never descended into.
 */
async function listDirectory(root: string): Promise<DiskFile[]> {
  const found: DiskFile[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const dirent of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
      if (isForbiddenPath(path)) throw new Error(`forbidden path: ${path}`);
      const absolute = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolute, path);
      } else if (dirent.isFile()) {
        found.push({ path, absolute, size: (await stat(absolute)).size });
      } else {
        throw new Error(`unsupported file type (symbolic link or special file): ${path}`);
      }
    }
  }
  await walk(root, "");
  return found;
}

async function readDirectoryEntries(root: string): Promise<FileEntry[]> {
  const found = await listDirectory(root);
  validateListing(found);
  const entries: FileEntry[] = [];
  for (const { path, absolute } of found) {
    entries.push({ path, bytes: toBytes(await readFile(absolute)) });
  }
  return entries;
}

function unzip<T>(source: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new Error(`${source} is not a valid zip archive: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

const isDirectoryEntry = (name: string): boolean => name.endsWith("/");

async function readZipEntries(source: string): Promise<FileEntry[]> {
  const archive = await readFile(source);

  // First pass: read the central directory only, so that unsafe names and sizes that are over
  // the limits are rejected before any of the content is inflated.
  const listing: Listing[] = [];
  unzip(source, () =>
    unzipSync(archive, {
      filter: ({ name, originalSize }) => {
        if (!isDirectoryEntry(name)) listing.push({ path: name, size: originalSize });
        return false;
      },
    }),
  );
  validateListing(listing);

  const inflated = unzip(source, () =>
    unzipSync(archive, { filter: ({ name }) => !isDirectoryEntry(name) }),
  );
  return Object.entries(inflated).map(([path, bytes]) => ({ path, bytes }));
}

/**
 * Reads a `.jetpack` zip archive or an agent directory.
 *
 * Without `jetpack.json` and with `requireManifest: false` the manifest is synthesized from the
 * name of `source`, with an empty `id` for the caller to fill in.
 */
export async function readBundle(source: string, opts: ReadBundleOptions = {}): Promise<Bundle> {
  const entries = (await stat(source)).isDirectory()
    ? await readDirectoryEntries(source)
    : await readZipEntries(source);
  return entriesToBundle(entries, {
    requireManifest: opts.requireManifest,
    fallbackName: basename(resolve(source)),
  });
}

/** Refuses a directory with content unless that content is a previous export. */
async function assertCanWriteInto(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (names.length > 0 && !names.includes(MANIFEST_PATH)) {
    throw new Error(
      `${directory} is not empty and holds no ${MANIFEST_PATH}, so it is not a previous export`,
    );
  }
}

/**
 * Writes a Bundle as a zip archive at `target`, or with `asDirectory` as a directory tree. A
 * directory that already has content is only written into when it holds a `jetpack.json`.
 * Files from an earlier export that the Bundle no longer has are left in place.
 */
export async function writeBundle(
  bundle: Bundle,
  target: string,
  opts: WriteBundleOptions = {},
): Promise<void> {
  const entries = bundleToEntries(bundle);

  if (!opts.asDirectory) {
    const files = Object.fromEntries(entries.map(({ path, bytes }) => [path, bytes]));
    await writeFile(target, zipSync(files));
    return;
  }

  await assertCanWriteInto(target);
  for (const { path, bytes } of entries) {
    const file = join(target, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}
