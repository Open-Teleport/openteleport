// Track each agent's imported skills without collecting unrelated global skills.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_TEXT_ENTRY_BYTES, isSafeArchivePath } from "../../core/paths.js";
import type { Skill } from "../../core/schema.js";
import { isRecord } from "../../core/values.js";
import { isSafeName, lstatIfAny, replaceFile } from "../fs.js";
import { readSkillFiles } from "../skill-files.js";
import { holdsSkill, writeSkills } from "../skills.js";
import type { Ctx, WriteResult } from "../types.js";
import { userSkillsDir } from "./paths.js";

const METADATA_DIR = "openteleport-skills";
type Association = { name: string; folder: string };
const metadataPath = (home: string, slug: string): string =>
  join(home, METADATA_DIR, slug + ".json");

/** Check before writes; neither metadata directory nor file may redirect elsewhere. */
export async function checkSkillMetadata(home: string, slug: string): Promise<void> {
  const dir = join(home, METADATA_DIR);
  const parent = await lstatIfAny(dir);
  if (parent !== undefined && !parent.isDirectory()) {
    throw new Error("Refusing skill metadata directory " + dir + ": not a regular directory");
  }
  const file = metadataPath(home, slug);
  const info = await lstatIfAny(file);
  if (info !== undefined && (!info.isFile() || info.size > MAX_TEXT_ENTRY_BYTES)) {
    throw new Error("Refusing skill metadata file " + file + ": not a regular file within the size limit");
  }
}

/** Resolve actual created/reused folders after applying the shared write policy. */
export async function writeAssociatedSkills(
  ctx: Ctx,
  skills: readonly Skill[],
  items: WriteResult["items"],
): Promise<Association[]> {
  const dir = userSkillsDir(ctx);
  await writeSkills(dir, skills, items);
  const associations: Association[] = [];
  for (const skill of skills) {
    if (!isSafeName(skill.name) || skill.files.some((file) => !isSafeArchivePath(file.path))) continue;
    for (let n = 1; ; n += 1) {
      const folder = n === 1 ? skill.name : skill.name + "-" + n;
      const location = join(dir, folder);
      const info = await lstatIfAny(location);
      if (info === undefined) {
        throw new Error("Written skill '" + skill.name + "' could not be located for export metadata");
      }
      if (info.isDirectory() && (await holdsSkill(location, skill))) {
        associations.push({ name: skill.name, folder });
        break;
      }
    }
  }
  return associations;
}

export async function recordSkills(
  home: string,
  slug: string,
  id: string,
  skills: Association[],
): Promise<void> {
  await checkSkillMetadata(home, slug);
  await replaceFile(metadataPath(home, slug), JSON.stringify({ version: 1, id, skills }, null, 2) + "\n");
}

/** Legacy/invalid metadata is an explicit limitation, never "all global skills". */
export async function readAssociatedSkills(
  ctx: Ctx,
  home: string,
  slug: string,
  id: string,
  warnings: string[],
): Promise<Skill[]> {
  let associations: Association[];
  try {
    await checkSkillMetadata(home, slug);
    const raw: unknown = JSON.parse(await readFile(metadataPath(home, slug), "utf8"));
    if (!isRecord(raw) || raw.version !== 1 || raw.id !== id || !Array.isArray(raw.skills) ||
        !raw.skills.every((entry: unknown) => isRecord(entry) &&
          typeof entry.name === "string" && isSafeName(entry.name) &&
          typeof entry.folder === "string" && isSafeName(entry.folder))) {
      throw new Error("invalid or stale metadata");
    }
    associations = raw.skills as Association[];
    if (new Set(associations.map(({ name }) => name)).size !== associations.length) {
      throw new Error("duplicate skill names");
    }
  } catch {
    warnings.push(
      `skills for agent '${slug}' not exported: no valid OpenTeleport skill associations; ` +
        "shared skills are not included automatically",
    );
    return [];
  }
  const skills: Skill[] = [];
  const root = userSkillsDir(ctx);
  for (const { name, folder } of associations) {
    const dir = join(root, folder);
    if (!(await lstatIfAny(join(ctx.home, ".agents")))?.isDirectory() ||
        !(await lstatIfAny(root))?.isDirectory() ||
        !(await lstatIfAny(dir))?.isDirectory() ||
        !(await lstatIfAny(join(dir, "SKILL.md")))?.isFile()) {
      warnings.push(`associated skill '${name}' (${folder}) is missing or linked; not exported`);
      continue;
    }
    skills.push({ name, files: await readSkillFiles(dir, name, warnings) });
  }
  return skills;
}
