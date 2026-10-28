// Letta Code's MemFS: the memory folder of an agent, a directory of Markdown files that is also
// a git repository [L10]. Files in its root are core memory, loaded on every turn; `reference/`
// has an index of its own and stays out of context until needed; `skills/<name>/SKILL.md` holds
// the agent's skills [L13]. Reading it never touches the folder.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { splitFrontmatter } from "../../core/frontmatter.js";
import { isSafeArchivePath } from "../../core/paths.js";
import type { Item } from "../../core/report.js";
import type { Bundle, FileEntry, Note, Skill } from "../../core/schema.js";
import { factsToProse, oneLine, truncate, withoutMark } from "../../core/text.js";
import { entriesOf, isSafeName } from "../fs.js";
import { EXPORT_MESSAGES, type SkillMessages, readSkillFolders } from "../skill-files.js";

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
/** What a note read from `reference/` is called, so it cannot be mistaken for a root note. */
export const REFERENCE_PREFIX = "reference--";
/** The `name` in the frontmatter of `persona.md`: in MemFS that is the label of the memory. */
const PERSONA_LABEL = "persona";
const MAX_DESCRIPTION_CHARS = 120;

const encoder = new TextEncoder();

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

const isReserved = (name: string): boolean => (RESERVED_ROOT as readonly string[]).includes(name);

/** Hidden entries (`.git`, `.DS_Store`) are not memory. */
const isHidden = (name: string): boolean => name.startsWith(".");

const linkWarning = (shown: string): string => `'${shown}' is a symbolic link; not read`;

/** The words for what is not read of a skill: Letta's, not the exporting adapters'. */
const SKILL_MESSAGES: SkillMessages = {
  ...EXPORT_MESSAGES,
  link: (skill, path) =>
    path === undefined
      ? `skill '${skill}' is a symbolic link; not read`
      : `skill '${skill}': '${path}' is a symbolic link; not read`,
};

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

/** The text of a memory file without its frontmatter; a frontmatter that is no YAML stays text. */
function bodyOf(text: string): string {
  try {
    return splitFrontmatter(text).body;
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
    const { data, body } = splitFrontmatter(text);
    const name = field(data, "name");
    const description = field(data, "description");
    return {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      body,
    };
  } catch (error) {
    // The parser's message goes on to quote the source; its first line is the reason.
    const reason = (error as Error).message.split("\n")[0]?.replace(/:$/, "") ?? "";
    warnings.push(`persona.md: ${reason}; kept as text`);
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
        const found = await readSkillFolders(file, { skipHidden: true, messages: SKILL_MESSAGES });
        memfs.skills = found.skills;
        warnings.push(...found.warnings);
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

// -- Bundle -> MemFS --------------------------------------------------------------------------

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
 *   agent's title). The `name` is the label of the memory, `persona`, not the agent's name; the
 *   `description` is the title, else "Persona of <agent name>";
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
  const rootIndex: [string, string][] = [
    ["persona.md", "Who the agent is and how it behaves"],
  ];

  const { manifest } = bundle;
  const title = oneLine(manifest.title ?? "");
  const persona = bundle.persona?.trim() ?? "";
  put(
    "persona.md",
    renderFrontmatter(
      {
        name: PERSONA_LABEL,
        description: truncate(
          title === "" ? `Persona of ${oneLine(manifest.name)}` : title,
          MAX_DESCRIPTION_CHARS,
        ),
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
