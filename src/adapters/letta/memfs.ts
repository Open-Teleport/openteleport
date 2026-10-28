// Letta Code's MemFS: the memory folder of an agent, a directory of Markdown files that is also
// a git repository [L10]. Files in its root are core memory, loaded on every turn; `reference/`
// has an index of its own and stays out of context until needed; `skills/<name>/SKILL.md` holds
// the agent's skills [L13]. Reading it never touches the folder.
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { isForbiddenPath, isSafeArchivePath } from "../../core/paths.js";
import type { Item } from "../../core/report.js";
import type { Bundle, FileEntry, Note, Skill } from "../../core/schema.js";
import { factsToProse } from "../../core/text.js";
import { isSafeName, lstatIfAny } from "../fs.js";

/** The files of the memory root that mean something of their own; any other `*.md` is a note. */
export const RESERVED_ROOT = ["MEMORY.md", "persona.md", "human.md", "instructions.md"] as const;

export type MemFs = {
  /** `persona.md`: the frontmatter fields (when it has them) and the text after it. */
  persona?: { name?: string; description?: string; body: string };
  /** `instructions.md`, the file this adapter writes the instructions to. */
  instructions?: string;
  /** `human.md` as text, bullets and prose together. */
  human?: string;
  /** Every other `*.md` file in the root of the memory folder. */
  rootNotes: Note[];
  /** The `*.md` files of `reference/`, apart from its `MEMORY.md` index. */
  referenceNotes: Note[];
  skills: Skill[];
  warnings: string[];
};

const INDEX_FILE = "MEMORY.md";
const REFERENCE_DIR = "reference";
const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";
/** What a note read from `reference/` is called, so it cannot be mistaken for a root note. */
export const REFERENCE_PREFIX = "reference--";
const PERSONA_DESCRIPTION = "Who the agent is and how it behaves";
const MAX_DESCRIPTION_CHARS = 120;

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
// The opening fence must be the first line; the closing one is the next line that is only `---`.
const FRONTMATTER = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

const encoder = new TextEncoder();

/** Plain code-unit order, so that the result does not depend on the locale. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const withoutMark = (text: string): string =>
  text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;

/** One line of text: every run of whitespace and control characters becomes one space. */
export const oneLine = (text: string): string => text.replace(/[\p{Cc}\s]+/gu, " ").trim();

/** Cuts `text` to `max` characters, the last one an ellipsis. */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Splits a Markdown file into its YAML frontmatter (between `---` lines at the top) and the
 * text after it. A byte order mark is dropped and line endings become `\n`. A file that does not
 * open with a `---` line has no frontmatter: all of it is the body. Throws when the frontmatter
 * is not YAML or not a mapping of keys to values. (The Claude Code adapter's parser knows the
 * fields of a subagent file only, so MemFS has its own.)
 */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const source = withoutMark(text).replace(/\r\n?/g, "\n");
  const match = FRONTMATTER.exec(source);
  if (match === null) return { data: {}, body: source };
  let data: unknown;
  try {
    data = parse(match[1] ?? "");
  } catch (error) {
    // The parser's message goes on to quote the source; its first line is the reason.
    const reason = (error as Error).message.split("\n")[0]?.replace(/:$/, "") ?? "";
    throw new Error(`invalid frontmatter: ${reason}`, { cause: error });
  }
  data ??= {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("invalid frontmatter: expected key: value pairs");
  }
  return {
    data: data as Record<string, unknown>,
    body: source.slice(match[0].length).replace(/^\n+/, ""),
  };
}

/** A file with YAML frontmatter holding `data`, then `body`. */
export function renderFrontmatter(data: Record<string, string>, body: string): string {
  // lineWidth 0: never fold a long description onto several lines.
  return `---\n${stringify(data, { lineWidth: 0 })}---\n${body}`;
}

/** A frontmatter field as text; anything but a non-blank string or number is absent. */
function field(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/** The entries of `dir` in name order, or none when it does not exist. */
async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => byCodeUnit(a.name, b.name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

const isReserved = (name: string): boolean => (RESERVED_ROOT as readonly string[]).includes(name);

/** Hidden entries (`.git`, `.DS_Store`) are not memory. */
const isHidden = (name: string): boolean => name.startsWith(".");

const linkWarning = (shown: string): string => `'${shown}' is a symbolic link; not read`;

/** A note is kept as the file has it, apart from the byte order mark. */
async function readNote(dir: string, fileName: string): Promise<Note> {
  const text = withoutMark(await readFile(join(dir, fileName), "utf8"));
  return { name: fileName.slice(0, -".md".length), text };
}

/** The `*.md` files of `reference/` as notes, apart from its index. */
async function readReference(dir: string, warnings: string[]): Promise<Note[]> {
  const notes: Note[] = [];
  for (const entry of await entriesOf(dir)) {
    if (isHidden(entry.name)) continue;
    const shown = `${REFERENCE_DIR}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      warnings.push(linkWarning(shown));
    } else if (entry.isDirectory()) {
      warnings.push(`folder '${shown}/' is not read; notes are read from ${REFERENCE_DIR}/ only`);
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== INDEX_FILE) {
      notes.push(await readNote(dir, entry.name));
    }
  }
  return notes;
}

/**
 * Files below `dir` as `/`-separated paths, `SKILL.md` first. Links are never followed; they,
 * forbidden paths and special files are left out and named.
 */
async function skillFiles(dir: string, skill: string, warnings: string[]): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await entriesOf(current)) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(`skill '${skill}': '${path}' is a symbolic link; not read`);
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
  return files.sort((a, b) =>
    a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : byCodeUnit(a.path, b.path),
  );
}

/** Every real folder of `skills/` that holds a real `SKILL.md`, in name order. */
async function readSkills(dir: string, warnings: string[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const entry of await entriesOf(dir)) {
    if (isHidden(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      warnings.push(`skill '${entry.name}' is a symbolic link; not read`);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const skillFile = await lstatIfAny(join(dir, entry.name, SKILL_FILE));
    if (skillFile?.isSymbolicLink()) {
      warnings.push(`skill '${entry.name}': '${SKILL_FILE}' is a symbolic link; not read`);
    } else if (skillFile?.isFile()) {
      skills.push({
        name: entry.name,
        files: await skillFiles(join(dir, entry.name), entry.name, warnings),
      });
    }
  }
  return skills;
}

/** The text of a memory file without its frontmatter; a frontmatter that is no YAML stays text. */
function bodyOf(text: string): string {
  try {
    return parseFrontmatter(text).body;
  } catch {
    return withoutMark(text).replace(/\r\n?/g, "\n");
  }
}

export async function readPersona(
  file: string,
  warnings: string[],
): Promise<NonNullable<MemFs["persona"]>> {
  const text = await readFile(file, "utf8");
  try {
    const { data, body } = parseFrontmatter(text);
    const name = field(data, "name");
    const description = field(data, "description");
    return {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      body,
    };
  } catch (error) {
    warnings.push(`persona.md: ${(error as Error).message}; kept as text`);
    return { body: bodyOf(text) };
  }
}

/**
 * Reads the memory folder `dir`. A folder that is not there reads as an empty memory. Core
 * memory files lose their frontmatter and have their line endings made `\n`; notes are kept as
 * the file has them. Hidden entries (the MemFS repository's `.git`) are ignored, links are never
 * followed, and folders other than `reference/` and `skills/` are named in `warnings`.
 */
export async function readMemFs(dir: string): Promise<MemFs> {
  const warnings: string[] = [];
  const memfs: MemFs = { rootNotes: [], referenceNotes: [], skills: [], warnings };

  for (const entry of await entriesOf(dir)) {
    if (isHidden(entry.name)) continue;
    const file = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      warnings.push(linkWarning(entry.name));
    } else if (entry.isDirectory()) {
      if (entry.name === REFERENCE_DIR) {
        memfs.referenceNotes = await readReference(file, warnings);
      } else if (entry.name === SKILLS_DIR) {
        memfs.skills = await readSkills(file, warnings);
      } else {
        warnings.push(
          `folder '${entry.name}/' is not read; only ${REFERENCE_DIR}/ and ${SKILLS_DIR}/ are`,
        );
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      if (!isReserved(entry.name)) {
        memfs.rootNotes.push(await readNote(dir, entry.name));
      } else if (entry.name === "persona.md") {
        memfs.persona = await readPersona(file, warnings);
      } else if (entry.name === "instructions.md") {
        memfs.instructions = bodyOf(await readFile(file, "utf8"));
      } else if (entry.name === "human.md") {
        memfs.human = bodyOf(await readFile(file, "utf8"));
      }
      // MEMORY.md is the table of contents, not content.
    }
  }
  return memfs;
}

// -- Bundle -> MemFS -------------------------------------------------------------------------------

/** The name of a note read from `reference/`, with the prefix that marks it taken off. */
const unprefixed = (name: string): string =>
  name.startsWith(REFERENCE_PREFIX) ? name.slice(REFERENCE_PREFIX.length) : name;

/** The first line of a note that says something, as a one-line description of it. */
function describeNote(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => oneLine(line.replace(/^\s*(?:#+|[-*])\s*/, "")))
    .find((line) => line !== "");
  return first === undefined ? "(no description)" : truncate(first, 100);
}

/** A `# <title>` heading, then one `- <file>: <description>` line per entry. */
function renderIndex(title: string, entries: readonly (readonly [string, string])[]): string {
  return `# ${title}\n\n${entries.map(([file, text]) => `- ${file}: ${text}`).join("\n")}\n`;
}

/**
 * The files of a MemFS version 2 folder for `bundle`, with paths relative to the folder:
 *
 * - `MEMORY.md`, the index: one line per file or folder below, each with a description;
 * - `persona.md`, with `name` and `description` frontmatter (always, because it carries the
 *   agent's name);
 * - `instructions.md` and `human.md` (the facts as bullets), each only when there is something
 *   to put in it;
 * - `reference/<note>.md` for each note, with `reference/MEMORY.md` as its index;
 * - `skills/<name>/<files>`.
 *
 * A note that was read from `reference/` (see `REFERENCE_PREFIX`) goes back there under its own
 * name. A note whose name cannot be a file in `reference/`, and a skill whose name or a file
 * path is not safe to write, are left out and added to `skipped` as `note:<name>` and
 * `skill:<name>`.
 */
export function renderMemFs(bundle: Bundle, skipped: Item[] = []): FileEntry[] {
  const files: FileEntry[] = [];
  const put = (path: string, text: string): void => {
    files.push({ path, bytes: encoder.encode(text) });
  };
  const rootIndex: [string, string][] = [["persona.md", PERSONA_DESCRIPTION]];

  const { manifest } = bundle;
  const described = oneLine(manifest.title ?? manifest.description ?? "");
  const persona = bundle.persona?.trim() ?? "";
  put(
    "persona.md",
    renderFrontmatter(
      {
        name: oneLine(manifest.name),
        description:
          described === "" ? PERSONA_DESCRIPTION : truncate(described, MAX_DESCRIPTION_CHARS),
      },
      persona === "" ? "" : `${persona}\n`,
    ),
  );

  if (bundle.instructions.trim() !== "") {
    put("instructions.md", `${bundle.instructions.trim()}\n`);
    rootIndex.push(["instructions.md", "Standing instructions for every turn"]);
  }
  const facts = factsToProse(bundle.facts);
  if (facts !== "") {
    put("human.md", `${facts}\n`);
    rootIndex.push(["human.md", "What is known about the user"]);
  }

  // `MEMORY` is the name of the folder's own index.
  const taken = new Set<string>(["memory"]);
  const references: [string, string][] = [];
  for (const note of bundle.notes) {
    // A name that was read from reference/ has its prefix taken off, unless that name is taken.
    const name = [unprefixed(note.name), note.name].find(
      (candidate) => !taken.has(candidate.toLowerCase()),
    );
    if (name === undefined || !isSafeName(`${name}.md`)) {
      skipped.push({
        field: `note:${note.name}`,
        detail: "its name cannot be a file in reference/; not written",
      });
      continue;
    }
    taken.add(name.toLowerCase());
    put(`${REFERENCE_DIR}/${name}.md`, note.text);
    references.push([`${name}.md`, describeNote(note.text)]);
  }
  if (references.length > 0) {
    put(`${REFERENCE_DIR}/${INDEX_FILE}`, renderIndex("Reference", references));
    rootIndex.push([`${REFERENCE_DIR}/`, "Longer notes; open reference/MEMORY.md for the list"]);
  }

  for (const skill of bundle.skills) {
    if (!isSafeName(skill.name) || skill.files.some((file) => !isSafeArchivePath(file.path))) {
      skipped.push({
        field: `skill:${skill.name}`,
        detail: "its name or a file path is not safe to write; not written",
      });
      continue;
    }
    for (const file of skill.files) {
      files.push({ path: `${SKILLS_DIR}/${skill.name}/${file.path}`, bytes: file.bytes });
    }
  }

  return [{ path: INDEX_FILE, bytes: encoder.encode(renderIndex("Memory", rootIndex)) }, ...files];
}
