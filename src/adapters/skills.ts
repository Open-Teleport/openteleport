// Writing a Bundle's skills into the skills folder of a file-based app. Skills belong to the
// whole folder, shared by every agent that uses it, so one already there is reused rather than
// written again, and a folder that differs is never removed or written through.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSafeArchivePath } from "../core/paths.js";
import type { Skill } from "../core/schema.js";
import { isSafeName, lstatIfAny } from "./fs.js";
import type { WriteResult } from "./types.js";

/**
 * True when the real directory `dir` holds exactly the files of `skill`, byte for byte. A link
 * anywhere below it, or any other special file, makes it different: links are never followed.
 */
export async function holdsSkill(dir: string, skill: Skill): Promise<boolean> {
  const found = new Map<string, string>();
  async function walk(current: string, prefix: string): Promise<boolean> {
    // Dirent types come from lstat, so a link is neither a file nor a directory here.
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(absolute, path))) return false;
      } else if (entry.isFile()) {
        found.set(path, absolute);
      } else {
        return false;
      }
    }
    return true;
  }
  if (!(await walk(dir, "")) || found.size !== skill.files.length) return false;
  for (const file of skill.files) {
    const absolute = found.get(file.path);
    if (absolute === undefined || !(await readFile(absolute)).equals(file.bytes)) return false;
  }
  return true;
}

/**
 * The folder name to write `skill` under, or `undefined` to reuse a folder that already holds
 * it. `<name>`, then `<name>-2`, `<name>-3`... are tried in order: the first real folder with the
 * same files and bytes is reused, else the first free name is returned, with a warning when it
 * is not `<name>`. Skills belong to the whole folder, so a folder that differs is never
 * removed, whatever the conflict mode: `replace` only replaces the agent. A link (symbolic link
 * or junction) is never followed: it counts as a taken name that differs.
 */
export async function placeSkill(
  dir: string,
  skill: Skill,
  items: { warnings: string[] },
): Promise<string | undefined> {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? skill.name : `${skill.name}-${n}`;
    const path = join(dir, name);
    const existing = await lstatIfAny(path);
    if (existing === undefined) {
      if (name !== skill.name) {
        items.warnings.push(
          `skill '${skill.name}' already exists with different content; written as '${name}'`,
        );
      }
      return name;
    }
    // lstat: a symbolic link or junction is never a directory here.
    if (!existing.isDirectory()) continue;
    if (await holdsSkill(path, skill)) return undefined;
  }
}

/**
 * Writes each skill to `<dir>/<name>/`, where everything that uses `dir` shares them, so one
 * that is already there is reused rather than written again (see `placeSkill`). A skill whose
 * name or a file path is not safe to write is skipped and reported as `skill:<name>`.
 */
export async function writeSkills(
  dir: string,
  skills: readonly Skill[],
  items: WriteResult["items"],
): Promise<void> {
  for (const skill of skills) {
    if (!isSafeName(skill.name) || skill.files.some((file) => !isSafeArchivePath(file.path))) {
      items.skipped.push({
        field: `skill:${skill.name}`,
        detail: "its name or a file path is not safe to write",
      });
      continue;
    }
    const name = await placeSkill(dir, skill, items);
    if (name === undefined) continue;
    for (const file of skill.files) {
      const path = join(dir, name, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes);
    }
  }
}
