import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPORT_MESSAGES,
  type SkillMessages,
  claimSkillName,
  findSkillFolders,
  readSkillFiles,
  readSkillFolders,
} from "../../src/adapters/skill-files.js";

/** Whether this machine lets the tests create file symbolic links. */
const canSymlink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "openteleport-symlink-"));
  try {
    await writeFile(join(dir, "file"), "");
    await symlink(join(dir, "file"), join(dir, "file-link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

let root: string;
let skills: string;

/** Writes `text` at `path` below the skills folder, making the folders on the way. */
async function put(path: string, text = `${path}\n`): Promise<void> {
  const file = join(skills, ...path.split("/"));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

const paths = (files: { path: string }[]): string[] => files.map((file) => file.path);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-skill-files-"));
  skills = join(root, "skills");
  await mkdir(skills);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readSkillFolders", () => {
  it("reads every folder with a SKILL.md, in name order, with the files below it", async () => {
    await put("zeta/SKILL.md", "# Zeta\n");
    await put("alpha/SKILL.md", "# Alpha\n");
    await put("alpha/scripts/run.sh", "echo hi\n");
    await put("alpha/README.md", "readme\n");
    await put("alpha/references/deep/checklist.md", "- one\n");

    const { skills: found, warnings } = await readSkillFolders(skills);

    expect(found.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
    // SKILL.md first, then the other paths in code-unit order (capitals before small letters).
    expect(paths(found[0]?.files ?? [])).toEqual([
      "SKILL.md",
      "README.md",
      "references/deep/checklist.md",
      "scripts/run.sh",
    ]);
    expect(new TextDecoder().decode(found[0]?.files[3]?.bytes)).toBe("echo hi\n");
    expect(paths(found[1]?.files ?? [])).toEqual(["SKILL.md"]);
    expect(warnings).toEqual([]);
  });

  it("has no skills for a folder that is not there, or one that is a file", async () => {
    await writeFile(join(root, "a-file"), "");

    expect(await readSkillFolders(join(root, "nothing"))).toEqual({ skills: [], warnings: [] });
    expect(await readSkillFolders(join(root, "a-file"))).toEqual({ skills: [], warnings: [] });
  });

  it("passes over a folder without a SKILL.md, a folder whose SKILL.md is a folder, and loose files", async () => {
    await put("notes/readme.md");
    await put("odd/SKILL.md/inside.md");
    await put("loose-file.md");
    await put("real/SKILL.md");

    const { skills: found, warnings } = await readSkillFolders(skills);

    expect(found.map((skill) => skill.name)).toEqual(["real"]);
    expect(warnings).toEqual([]);
  });

  it("does not search inside a folder without a SKILL.md unless nested", async () => {
    await put("writing/release-notes/SKILL.md");

    expect((await readSkillFolders(skills)).skills).toEqual([]);
  });

  it("leaves forbidden paths out of a skill and names them", async () => {
    await put("web-brief/SKILL.md");
    await put("web-brief/.env", "TOKEN=1\n");
    await put("web-brief/.env.local", "TOKEN=2\n");
    await put("web-brief/node_modules/left-pad/index.js");
    await put("web-brief/vendor/bundle.zip", "PK");
    await put("web-brief/notes.md");

    const { skills: found, warnings } = await readSkillFolders(skills);

    expect(paths(found[0]?.files ?? [])).toEqual(["SKILL.md", "notes.md"]);
    expect(warnings).toEqual([
      "skill 'web-brief': left out '.env'",
      "skill 'web-brief': left out '.env.local'",
      "skill 'web-brief': left out 'node_modules'",
      "skill 'web-brief': left out 'vendor/bundle.zip'",
    ]);
  });

  describe("hidden folders", () => {
    beforeEach(async () => {
      await put(".system/skill-creator/SKILL.md");
      await put(".system/SKILL.md");
      await put(".hidden/SKILL.md");
      await put("visible/SKILL.md");
    });

    it("are skills like the others without skipHidden", async () => {
      const { skills: found } = await readSkillFolders(skills);

      expect(found.map((skill) => skill.name)).toEqual([".hidden", ".system", "visible"]);
    });

    it("are left alone with skipHidden", async () => {
      const { skills: found, warnings } = await readSkillFolders(skills, { skipHidden: true });

      expect(found.map((skill) => skill.name)).toEqual(["visible"]);
      expect(warnings).toEqual([]);
    });
  });

  describe("categories", () => {
    beforeEach(async () => {
      await put("old/SKILL.md");
      await put("writing/release-notes/SKILL.md");
      await put("writing/release-notes/references/style.md");
      await put("writing/drafts/outline/SKILL.md");
      await put("misc/empty/readme.md");
    });

    it("are searched for skills with nested, which are named after their folders", async () => {
      const { skills: found, warnings } = await readSkillFolders(skills, { nested: true });

      expect(found.map((skill) => skill.name)).toEqual(["old", "outline", "release-notes"]);
      expect(paths(found[2]?.files ?? [])).toEqual(["SKILL.md", "references/style.md"]);
      expect(warnings).toEqual([]);
    });

    it("do not hold more skills inside a skill", async () => {
      await put("writing/release-notes/nested/SKILL.md");

      const { skills: found } = await readSkillFolders(skills, { nested: true });

      expect(found.map((skill) => skill.name)).toEqual(["old", "outline", "release-notes"]);
      expect(paths(found[2]?.files ?? [])).toEqual([
        "SKILL.md",
        "nested/SKILL.md",
        "references/style.md",
      ]);
    });

    it("give a skill of a name that is taken a number, and say where it was", async () => {
      await put("tools/release-notes/SKILL.md");
      await put("zz/release-notes/SKILL.md");

      const { skills: found, warnings } = await readSkillFolders(skills, { nested: true });

      // The folders are walked in order: old, tools/..., writing/drafts/..., writing/..., zz/...
      expect(found.map((skill) => skill.name)).toEqual([
        "old",
        "release-notes",
        "outline",
        "release-notes-2",
        "release-notes-3",
      ]);
      expect(warnings).toEqual([
        "skill 'release-notes' appears more than once (writing/release-notes); exported as 'release-notes-2'",
        "skill 'release-notes' appears more than once (zz/release-notes); exported as 'release-notes-3'",
      ]);
    });

    it("keep the hidden state of an app out of the search with skipHidden", async () => {
      await put(".hub/index/SKILL.md");

      const { skills: found } = await readSkillFolders(skills, { nested: true, skipHidden: true });

      expect(found.map((skill) => skill.name)).toEqual(["old", "outline", "release-notes"]);
    });
  });

  describe("links", () => {
    /** A folder outside the skills that looks like a skill and holds a file not to export. */
    async function elsewhere(): Promise<string> {
      const dir = join(root, "elsewhere");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), "# Linked\n");
      await writeFile(join(dir, "secret.txt"), "not for export\n");
      return dir;
    }

    it("are not followed for a skill folder, which is named in a warning", async () => {
      await put("web-brief/SKILL.md");
      await symlink(await elsewhere(), join(skills, "linked"), "junction");

      const { skills: found, warnings } = await readSkillFolders(skills);

      expect(found.map((skill) => skill.name)).toEqual(["web-brief"]);
      expect(warnings).toEqual(["skill 'linked' is a symlink; not exported"]);
    });

    it("are not followed for a category with nested either", async () => {
      await put("web-brief/SKILL.md");
      await symlink(await elsewhere(), join(skills, "linked"), "junction");

      const { skills: found, warnings } = await readSkillFolders(skills, { nested: true });

      expect(found.map((skill) => skill.name)).toEqual(["web-brief"]);
      expect(warnings).toEqual(["skill 'linked' is a symlink; not exported"]);
    });

    it("are left out of a skill when they are folders", async () => {
      await put("web-brief/SKILL.md");
      await symlink(await elsewhere(), join(skills, "web-brief", "linked-dir"), "junction");

      const { skills: found, warnings } = await readSkillFolders(skills);

      expect(paths(found[0]?.files ?? [])).toEqual(["SKILL.md"]);
      expect(warnings).toEqual(["skill 'web-brief': 'linked-dir' is a symlink; not exported"]);
    });

    it.skipIf(!canSymlink)("are left out of a skill when they are files", async () => {
      await put("web-brief/SKILL.md");
      await symlink(
        join(await elsewhere(), "secret.txt"),
        join(skills, "web-brief", "linked.txt"),
        "file",
      );

      const { skills: found, warnings } = await readSkillFolders(skills);

      expect(paths(found[0]?.files ?? [])).toEqual(["SKILL.md"]);
      expect(warnings).toEqual(["skill 'web-brief': 'linked.txt' is a symlink; not exported"]);
    });

    it.skipIf(!canSymlink)("make a skill whose SKILL.md is one no skill at all", async () => {
      await put("web-brief/SKILL.md");
      await mkdir(join(skills, "borrowed"));
      await symlink(
        join(await elsewhere(), "SKILL.md"),
        join(skills, "borrowed", "SKILL.md"),
        "file",
      );
      await put("borrowed/notes.md");

      const { skills: found, warnings } = await readSkillFolders(skills);

      expect(found.map((skill) => skill.name)).toEqual(["web-brief"]);
      expect(warnings).toEqual(["skill 'borrowed': 'SKILL.md' is a symlink; not exported"]);
    });

    it.skipIf(!canSymlink)("make a folder with a linked SKILL.md one nothing is read from", async () => {
      await mkdir(join(skills, "borrowed"));
      await symlink(
        join(await elsewhere(), "SKILL.md"),
        join(skills, "borrowed", "SKILL.md"),
        "file",
      );
      await put("borrowed/inner/SKILL.md");

      const { skills: found, warnings } = await readSkillFolders(skills, { nested: true });

      expect(found).toEqual([]);
      expect(warnings).toEqual(["skill 'borrowed': 'SKILL.md' is a symlink; not exported"]);
    });

    it("are worded as the adapter wants", async () => {
      await put("web-brief/SKILL.md");
      await put("web-brief/.env");
      await symlink(await elsewhere(), join(skills, "linked"), "junction");
      await symlink(await elsewhere(), join(skills, "web-brief", "linked-dir"), "junction");
      const messages: SkillMessages = {
        ...EXPORT_MESSAGES,
        link: (skill, path) =>
          path === undefined
            ? `skill '${skill}' is a symbolic link; not read`
            : `skill '${skill}': '${path}' is a symbolic link; not read`,
      };

      const { warnings } = await readSkillFolders(skills, { messages });

      expect(warnings).toEqual([
        "skill 'linked' is a symbolic link; not read",
        "skill 'web-brief': left out '.env'",
        "skill 'web-brief': 'linked-dir' is a symbolic link; not read",
      ]);
    });
  });
});

describe("findSkillFolders", () => {
  it("gives the name, the path below the root and the folder of each skill", async () => {
    await put("old/SKILL.md");
    await put("writing/release-notes/SKILL.md");
    await put("writing/empty/readme.md");
    const warnings: string[] = [];

    const found = await findSkillFolders(skills, warnings, { nested: true });

    expect(found).toEqual([
      { name: "old", path: "old", dir: join(skills, "old") },
      {
        name: "release-notes",
        path: "writing/release-notes",
        dir: join(skills, "writing", "release-notes"),
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it("reads no file", async () => {
    await put("old/SKILL.md");
    await put("old/.env");
    const warnings: string[] = [];

    await findSkillFolders(skills, warnings);

    expect(warnings).toEqual([]);
  });
});

describe("readSkillFiles", () => {
  it("names the skill in what it says about a file it leaves out", async () => {
    await put("web-brief/SKILL.md");
    await put("web-brief/.git/config");
    const warnings: string[] = [];

    const files = await readSkillFiles(join(skills, "web-brief"), "briefing", warnings);

    expect(paths(files)).toEqual(["SKILL.md"]);
    expect(warnings).toEqual(["skill 'briefing': left out '.git'"]);
  });

  it("puts the words of the caller in what it says", async () => {
    await put("web-brief/SKILL.md");
    await put("web-brief/.env");
    const warnings: string[] = [];
    const messages: SkillMessages = {
      link: () => "link",
      leftOut: (skill, path, why) => `${skill}/${path}: ${why}`,
    };

    await readSkillFiles(join(skills, "web-brief"), "briefing", warnings, messages);

    expect(warnings).toEqual(["briefing/.env: forbidden"]);
  });
});

describe("claimSkillName", () => {
  it("gives the folder's name until it is taken, then the next free number", () => {
    const taken = new Set<string>();
    const warnings: string[] = [];
    const folder = (path: string) => ({
      name: path.split("/").at(-1) ?? "",
      path,
      dir: join("x", path),
    });

    expect(claimSkillName(folder("a/triage"), taken, warnings)).toBe("triage");
    expect(claimSkillName(folder("b/triage"), taken, warnings)).toBe("triage-2");
    expect(claimSkillName(folder("c/triage"), taken, warnings)).toBe("triage-3");
    expect(claimSkillName(folder("d/triage-2"), taken, warnings)).toBe("triage-2-2");
    expect([...taken]).toEqual(["triage", "triage-2", "triage-3", "triage-2-2"]);
    expect(warnings).toEqual([
      "skill 'triage' appears more than once (b/triage); exported as 'triage-2'",
      "skill 'triage' appears more than once (c/triage); exported as 'triage-3'",
      "skill 'triage-2' appears more than once (d/triage-2); exported as 'triage-2-2'",
    ]);
  });
});
