// Reading the skills of an app from its skills folder: every folder that holds a `SKILL.md` is a
// skill, and the files below it are its files. Links (symbolic links and junctions) are never
// followed, since a link can point anywhere on disk; they are named in a warning instead.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isForbiddenPath } from "../core/paths.js";
import type { FileEntry, Skill } from "../core/schema.js";
import { byCodeUnit } from "../core/text.js";
import { entriesOf, lstatIfAny } from "./fs.js";

const SKILL_FILE = "SKILL.md";

/** How the warnings about what is not read are worded; an adapter may keep its own words. */
export type SkillMessages = {
  /** A skill folder (no `path`), its `SKILL.md` or a file or folder below it is a link. */
  link: (skill: string, path?: string) => string;
  /**
   * `path` below the skill is left out: its name never goes into an archive (`forbidden`), or it
   * is neither a file nor a folder (`special`).
   */
  leftOut: (skill: string, path: string, why: "forbidden" | "special") => string;
};

/** The words of the adapters that export what they read. */
export const EXPORT_MESSAGES: SkillMessages = {
  link: (skill, path) =>
    path === undefined
      ? `skill '${skill}' is a symlink; not exported`
      : `skill '${skill}': '${path}' is a symlink; not exported`,
  leftOut: (skill, path) => `skill '${skill}': left out '${path}'`,
};

export type SkillScan = {
  /** Leave out folders whose name starts with a dot (an app's own state: `.system`, `.hub`). */
  skipHidden?: boolean;
  /**
   * A folder without a `SKILL.md` is a category and is searched for skills; a folder with one is a
   * skill and is not searched further. Without it, only the folders directly below the root are
   * looked at.
   */
  nested?: boolean;
  messages?: SkillMessages;
};

/** A folder that holds a `SKILL.md`: its name, its `/`-separated path below the root and where it is. */
export type SkillFolder = { name: string; path: string; dir: string };

/**
 * The folders below `root` that hold a real `SKILL.md`, in name order. A linked folder or
 * `SKILL.md` is named in `warnings` and left out; so is nothing else: a folder without a
 * `SKILL.md`, and anything that is not a folder, is passed over silently. A `root` that is not
 * there has no skills.
 */
export async function findSkillFolders(
  root: string,
  warnings: string[],
  scan: SkillScan = {},
): Promise<SkillFolder[]> {
  const messages = scan.messages ?? EXPORT_MESSAGES;
  const found: SkillFolder[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await entriesOf(dir)) {
      if (scan.skipHidden === true && entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) {
        warnings.push(messages.link(entry.name));
        continue;
      }
      if (!entry.isDirectory()) continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(dir, entry.name);
      const skillFile = await lstatIfAny(join(absolute, SKILL_FILE));
      if (skillFile?.isSymbolicLink()) {
        warnings.push(messages.link(entry.name, SKILL_FILE));
      } else if (skillFile?.isFile()) {
        found.push({ name: entry.name, path, dir: absolute });
      } else if (scan.nested === true) {
        await walk(absolute, path);
      }
    }
  }
  await walk(root, "");
  return found;
}

/**
 * The files below `dir` as `/`-separated paths, `SKILL.md` first and the others in code-unit
 * order. Links, paths that never go into an archive (`.env*`, `node_modules`, `.git`, nested
 * archives) and special files are left out and named in `warnings` as files of `skill`.
 */
export async function readSkillFiles(
  dir: string,
  skill: string,
  warnings: string[],
  messages: SkillMessages = EXPORT_MESSAGES,
): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    // Dirent types are the entry's own, so a link is neither a file nor a directory here.
    for (const entry of await entriesOf(current)) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(messages.link(skill, path));
      } else if (isForbiddenPath(path)) {
        warnings.push(messages.leftOut(skill, path, "forbidden"));
      } else if (entry.isDirectory()) {
        await walk(absolute, path);
      } else if (entry.isFile()) {
        files.push({ path, bytes: new Uint8Array(await readFile(absolute)) });
      } else {
        warnings.push(messages.leftOut(skill, path, "special"));
      }
    }
  }
  await walk(dir, "");
  return files.sort((a, b) =>
    a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : byCodeUnit(a.path, b.path),
  );
}

/**
 * The name a nested skill gets: its folder's name, or `<name>-2`, `<name>-3`... when a skill of
 * that name has been taken (with a warning naming the folder). Records the name in `taken`.
 */
export function claimSkillName(folder: SkillFolder, taken: Set<string>, warnings: string[]): string {
  let name = folder.name;
  for (let n = 2; taken.has(name); n += 1) name = `${folder.name}-${n}`;
  if (name !== folder.name) {
    warnings.push(
      `skill '${folder.name}' appears more than once (${folder.path}); exported as '${name}'`,
    );
  }
  taken.add(name);
  return name;
}

/**
 * Every skill of the folder `dir` with its files, in name order (`findSkillFolders` and
 * `readSkillFiles`). A skill is named after its folder; with `nested`, categories are searched
 * and skills of the same name get `-2`, `-3`... (`claimSkillName`). A folder that is not there
 * has no skills. An adapter that decides which skills it keeps before it reads their files uses
 * the two functions itself.
 */
export async function readSkillFolders(
  dir: string,
  scan: SkillScan = {},
): Promise<{ skills: Skill[]; warnings: string[] }> {
  const warnings: string[] = [];
  const skills: Skill[] = [];
  const taken = new Set<string>();
  for (const folder of await findSkillFolders(dir, warnings, scan)) {
    const name = scan.nested === true ? claimSkillName(folder, taken, warnings) : folder.name;
    skills.push({ name, files: await readSkillFiles(folder.dir, name, warnings, scan.messages) });
  }
  return { skills, warnings };
}
