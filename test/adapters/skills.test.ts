import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdsSkill, placeSkill, writeSkills } from "../../src/adapters/skills.js";
import type { WriteResult } from "../../src/adapters/types.js";
import type { Skill } from "../../src/core/schema.js";

const encoder = new TextEncoder();
const bytes = (content: string): Uint8Array => encoder.encode(content);

const WEB_BRIEF: Skill = {
  name: "web-brief",
  files: [
    { path: "SKILL.md", bytes: bytes("# Web brief\n") },
    { path: "scripts/fetch.sh", bytes: bytes("curl $1\n") },
  ],
};

/** A skill of one file, for the folders a test sets up beforehand. */
const single = (name: string, content: string): Skill => ({
  name,
  files: [{ path: "SKILL.md", bytes: bytes(content) }],
});

const items = (): WriteResult["items"] => ({ approximated: [], skipped: [], warnings: [] });

let root: string;
let skills: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-skills-"));
  skills = join(root, "skills");
  await mkdir(skills);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file below `dir` with its content, keyed by `/`-separated relative path. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path).split("\\").join("/")] = await readFile(path, "utf8");
  }
  return out;
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Writes the files of `skill` into a folder called `name` below the skills folder. */
async function lay(skill: Skill, name = skill.name): Promise<string> {
  const dir = join(skills, name);
  for (const file of skill.files) {
    const path = join(dir, ...file.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.bytes);
  }
  return dir;
}

/** Whether this machine lets the tests create directory links (junctions on Windows). */
const canLink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "openteleport-symlink-"));
  try {
    await mkdir(join(dir, "dir"));
    await symlink(join(dir, "dir"), join(dir, "dir-link"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

describe("holdsSkill", () => {
  it("is true for a folder with exactly the files and bytes of the skill", async () => {
    expect(await holdsSkill(await lay(WEB_BRIEF), WEB_BRIEF)).toBe(true);
  });

  it("is false when a file's bytes differ", async () => {
    const dir = await lay(WEB_BRIEF);
    await writeFile(join(dir, "SKILL.md"), "# Something else\n");

    expect(await holdsSkill(dir, WEB_BRIEF)).toBe(false);
  });

  it("is false when a file is missing", async () => {
    const dir = await lay(WEB_BRIEF);
    await rm(join(dir, "scripts", "fetch.sh"));

    expect(await holdsSkill(dir, WEB_BRIEF)).toBe(false);
  });

  it("is false when the folder holds a file the skill does not", async () => {
    const dir = await lay(WEB_BRIEF);
    await writeFile(join(dir, "extra.md"), "Extra.\n");

    expect(await holdsSkill(dir, WEB_BRIEF)).toBe(false);
  });

  it.skipIf(!canLink)("is false when a link sits anywhere below the folder", async () => {
    const dir = await lay(WEB_BRIEF);
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(dir, "linked"), "junction");

    expect(await holdsSkill(dir, WEB_BRIEF)).toBe(false);
  });
});

describe("placeSkill", () => {
  it("gives the skill's own name to a free one, without a warning", async () => {
    const result = items();

    expect(await placeSkill(skills, WEB_BRIEF, result)).toBe("web-brief");
    expect(result.warnings).toEqual([]);
  });

  it("reuses a folder that holds the same files, saying nothing", async () => {
    await lay(WEB_BRIEF);
    const result = items();

    expect(await placeSkill(skills, WEB_BRIEF, result)).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("puts a skill whose name is taken by another one under <name>-2, and says so", async () => {
    await lay(single("web-brief", "Not yours.\n"));
    const result = items();

    expect(await placeSkill(skills, WEB_BRIEF, result)).toBe("web-brief-2");
    expect(result.warnings).toEqual([
      "skill 'web-brief' already exists with different content; written as 'web-brief-2'",
    ]);
  });

  it("skips a <name>-N that differs and reuses a later one that holds the skill", async () => {
    await lay(single("web-brief", "One.\n"));
    await lay(single("web-brief", "Two.\n"), "web-brief-2");
    await lay(WEB_BRIEF, "web-brief-3");
    const result = items();

    expect(await placeSkill(skills, WEB_BRIEF, result)).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("counts a file in the place of the folder as a taken name", async () => {
    await writeFile(join(skills, "web-brief"), "A file.\n");
    const result = items();

    expect(await placeSkill(skills, WEB_BRIEF, result)).toBe("web-brief-2");
    expect(result.warnings).toHaveLength(1);
  });

  it.skipIf(!canLink)("counts a link as a taken name, even to a folder with the same files", async () => {
    const outside = join(root, "outside-skill");
    for (const file of WEB_BRIEF.files) {
      const path = join(outside, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes);
    }
    await symlink(outside, join(skills, "web-brief"), "junction");
    const result = items();

    expect(await placeSkill(skills, WEB_BRIEF, result)).toBe("web-brief-2");
    expect(result.warnings).toEqual([
      "skill 'web-brief' already exists with different content; written as 'web-brief-2'",
    ]);
  });
});

describe("writeSkills", () => {
  it("writes every file of a skill, nested ones included", async () => {
    const result = items();

    await writeSkills(skills, [WEB_BRIEF], result);

    expect(await snapshot(join(skills, "web-brief"))).toEqual({
      "SKILL.md": "# Web brief\n",
      "scripts/fetch.sh": "curl $1\n",
    });
    expect(result).toEqual(items());
  });

  it("writes nothing for a skill that is already there", async () => {
    const dir = await lay(WEB_BRIEF);
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(join(dir, "SKILL.md"), old, old);

    await writeSkills(skills, [WEB_BRIEF], items());

    expect((await stat(join(dir, "SKILL.md"))).mtimeMs).toBe(old.getTime());
    expect(await exists(join(skills, "web-brief-2"))).toBe(false);
  });

  it("writes a skill that differs from the one there as <name>-2, leaving the first alone", async () => {
    await lay(single("web-brief", "Not yours.\n"));
    const result = items();

    await writeSkills(skills, [WEB_BRIEF], result);

    expect(await snapshot(join(skills, "web-brief"))).toEqual({ "SKILL.md": "Not yours.\n" });
    expect(await snapshot(join(skills, "web-brief-2"))).toHaveProperty("SKILL.md", "# Web brief\n");
    expect(result.warnings).toEqual([
      "skill 'web-brief' already exists with different content; written as 'web-brief-2'",
    ]);
  });

  it("writes the skills of a list one after the other", async () => {
    await writeSkills(skills, [WEB_BRIEF, single("summarise", "# S\n")], items());

    expect((await readdir(skills)).sort()).toEqual(["summarise", "web-brief"]);
  });

  it.each([
    ["a name that leaves the folder", single("../escape", "x")],
    ["a name with a separator", single("a/b", "x")],
    ["a file path that leaves the folder", { name: "evil", files: [{ path: "../x.md", bytes: bytes("x") }] }],
  ] satisfies [string, Skill][])("skips a skill with %s, and writes the others", async (_why, bad) => {
    const result = items();

    await writeSkills(skills, [bad, WEB_BRIEF], result);

    expect(result.skipped).toEqual([
      { field: `skill:${bad.name}`, detail: "its name or a file path is not safe to write" },
    ]);
    expect(await exists(join(root, "x.md"))).toBe(false);
    expect(await exists(join(root, "escape"))).toBe(false);
    expect(await readdir(skills)).toEqual(["web-brief"]);
  });

  it.skipIf(!canLink)("never writes through a linked skill folder", async () => {
    const outside = join(root, "outside-skill");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "ORIGINAL\n");
    await symlink(outside, join(skills, "web-brief"), "junction");

    await writeSkills(skills, [WEB_BRIEF], items());

    expect(await snapshot(outside)).toEqual({ "SKILL.md": "ORIGINAL\n" });
    expect((await lstat(join(skills, "web-brief"))).isSymbolicLink()).toBe(true);
    expect(await snapshot(join(skills, "web-brief-2"))).toHaveProperty("SKILL.md", "# Web brief\n");
  });
});
