import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESERVED_ROOT,
  parseFrontmatter,
  readMemFs,
  renderFrontmatter,
  renderMemFs,
} from "../../../src/adapters/letta/memfs.js";
import type { Item } from "../../../src/core/report.js";
import type { Bundle, FileEntry } from "../../../src/core/schema.js";
import { proseToFacts } from "../../../src/core/text.js";
import { adaBundle, bytes } from "./ada.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/letta/home/.letta", import.meta.url));
const LOCAL_MEMORY = join(FIXTURE, "lc-local-backend", "memfs", "agent-local-1111", "memory");
const CLOUD_MEMORY = join(FIXTURE, "agents", "agent-cloud-2222", "memory");
const BOM = String.fromCharCode(0xfeff);

/** Whether this machine lets the tests create directory symbolic links. */
const canSymlink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "openteleport-symlink-"));
  try {
    await mkdir(join(dir, "target"));
    await symlink(join(dir, "target"), join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-letta-memfs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Writes the entries of `renderMemFs` below `dir`. */
async function writeEntries(dir: string, entries: FileEntry[]): Promise<void> {
  for (const { path, bytes: content } of entries) {
    const file = join(dir, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

const paths = (entries: FileEntry[]): string[] => entries.map(({ path }) => path).sort();
/** The text of the entry at `path`; fails the test when there is none. */
function textOf(entries: FileEntry[], path: string): string {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no entry ${path}`);
  return new TextDecoder().decode(entry.bytes);
}

describe("parseFrontmatter", () => {
  it("reads the fields and the body, dropping a byte order mark and CRLF line endings", () => {
    const text = `${BOM}---\r\nname: Reviewer\r\ndescription: Reviews PRs\r\n---\r\nCalm.\r\nShort.\r\n`;
    expect(parseFrontmatter(text)).toEqual({
      data: { name: "Reviewer", description: "Reviews PRs" },
      body: "Calm.\nShort.\n",
    });
  });

  it("treats a file that does not open with --- as all body", () => {
    expect(parseFrontmatter("Hello\n---\nnot: frontmatter\n---\n")).toEqual({
      data: {},
      body: "Hello\n---\nnot: frontmatter\n---\n",
    });
  });

  it("reads an empty frontmatter as no fields", () => {
    expect(parseFrontmatter("---\n---\nBody\n")).toEqual({ data: {}, body: "Body\n" });
  });

  it("throws for a frontmatter that is not YAML or not a mapping", () => {
    expect(() => parseFrontmatter("---\nname: [unclosed\n---\nBody\n")).toThrow(
      /invalid frontmatter/,
    );
    expect(() => parseFrontmatter("---\njust text\n---\nBody\n")).toThrow(/key: value pairs/);
  });
});

describe("renderFrontmatter", () => {
  it("round-trips values that YAML would otherwise read as something else", () => {
    const data = { name: 'Ada: the "second"', description: "yes" };
    expect(parseFrontmatter(renderFrontmatter(data, "Body\n"))).toEqual({ data, body: "Body\n" });
  });

  it("keeps a long description on one line", () => {
    const description = "word ".repeat(60).trim();
    const text = renderFrontmatter({ name: "Ada", description }, "");
    expect(text.split("\n")).toHaveLength(5);
    expect(parseFrontmatter(text).data.description).toBe(description);
  });
});

describe("readMemFs", () => {
  it("reads the local fixture: persona without the byte order mark, notes, skills", async () => {
    const memfs = await readMemFs(LOCAL_MEMORY);
    // `name` in the frontmatter is the label of the memory, not the agent's name.
    expect(memfs.persona?.name).toBe("persona");
    expect(memfs.persona?.description).toBe("Reviews pull requests");
    expect(memfs.persona?.body.startsWith(BOM)).toBe(false);
    expect(memfs.persona?.body.trim()).toBe(
      "Calm, direct and short. Reviews code like a colleague who has to maintain it.",
    );
    expect(memfs.human).toContain("- Prefers small pull requests");
    expect(memfs.human).toContain("Ada leads the platform team");
    expect(memfs.instructions).toBeUndefined();
    expect(memfs.rootNotes.map((note) => note.name)).toEqual(["notes"]);
    expect(memfs.referenceNotes.map((note) => note.name)).toEqual(["style"]);
    expect(memfs.skills.map((skill) => skill.name)).toEqual(["triage"]);
    expect(memfs.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(memfs.warnings).toEqual([]);
  });

  it("reads the Cloud fixture: a persona without frontmatter and an empty human.md", async () => {
    const memfs = await readMemFs(CLOUD_MEMORY);
    expect(memfs.persona).toEqual({ body: "A helpful assistant that keeps answers short.\n" });
    expect(memfs.human).toBe("");
    expect(memfs.rootNotes).toEqual([]);
    expect(memfs.referenceNotes).toEqual([]);
    expect(memfs.skills).toEqual([]);
  });

  it("reads the same text from a file with a byte order mark and CRLF line endings", async () => {
    const dir = join(root, "memory");
    await mkdir(dir);
    await writeFile(
      join(dir, "persona.md"),
      `${BOM}---\r\nname: Reviewer\r\ndescription: Reviews PRs\r\n---\r\nCalm.\r\n\r\nShort.\r\n`,
    );
    await writeFile(join(dir, "human.md"), `${BOM}- one\r\n- two\r\n\r\nProse.\r\n`);
    await writeFile(join(dir, "instructions.md"), "Do it.\r\nTwice.\r\n");

    const memfs = await readMemFs(dir);
    expect(memfs.persona).toEqual({
      name: "Reviewer",
      description: "Reviews PRs",
      body: "Calm.\n\nShort.\n",
    });
    expect(memfs.human).toBe("- one\n- two\n\nProse.\n");
    expect(memfs.instructions).toBe("Do it.\nTwice.\n");
  });

  it("strips frontmatter from core memory files and keeps notes as the file has them", async () => {
    const dir = join(root, "memory");
    await mkdir(dir);
    await writeFile(
      join(dir, "human.md"),
      "---\nname: human\ndescription: The user\n---\n- likes tea\n",
    );
    await writeFile(join(dir, "scratch.md"), `${BOM}---\ndescription: Scratch\n---\nText\n`);

    const memfs = await readMemFs(dir);
    expect(memfs.human).toBe("- likes tea\n");
    expect(memfs.rootNotes).toEqual([
      { name: "scratch", text: "---\ndescription: Scratch\n---\nText\n" },
    ]);
  });

  it("keeps a persona whose frontmatter is not YAML as text, with a warning", async () => {
    const dir = join(root, "memory");
    await mkdir(dir);
    await writeFile(join(dir, "persona.md"), "---\nname: [oops\n---\nCalm.\n");

    const memfs = await readMemFs(dir);
    expect(memfs.persona).toEqual({ body: "---\nname: [oops\n---\nCalm.\n" });
    expect(memfs.warnings).toHaveLength(1);
    // One line, without the parser's quote of the source.
    expect(memfs.warnings[0]).toMatch(/^persona\.md: invalid frontmatter: [^\n]+; kept as text$/);
  });

  it("never reads the reserved files as notes", async () => {
    const dir = join(root, "memory");
    await mkdir(dir);
    for (const name of [...RESERVED_ROOT, "other.md", "readme.txt"]) {
      await writeFile(join(dir, name), `${name}\n`);
    }
    expect((await readMemFs(dir)).rootNotes.map((note) => note.name)).toEqual(["other"]);
  });

  it("ignores the repository folder and hidden files, and names other folders", async () => {
    const dir = join(root, "memory");
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, "projects"));
    await mkdir(join(dir, "reference", "deep"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "x");
    await writeFile(join(dir, ".hidden.md"), "x");
    await writeFile(join(dir, "projects", "a.md"), "x");
    await writeFile(join(dir, "reference", "deep", "b.md"), "x");
    await writeFile(join(dir, "reference", "MEMORY.md"), "- index\n");

    const memfs = await readMemFs(dir);
    expect(memfs.rootNotes).toEqual([]);
    expect(memfs.referenceNotes).toEqual([]);
    expect(memfs.warnings).toEqual([
      "folder 'projects/' is not read; only reference/ and skills/ are",
      "folder 'reference/deep/' is not read; notes are read from reference/ only",
    ]);
  });

  it("reads a folder that is not there as an empty memory", async () => {
    expect(await readMemFs(join(root, "nothing"))).toEqual({
      rootNotes: [],
      referenceNotes: [],
      skills: [],
      warnings: [],
    });
  });

  it.skipIf(!canSymlink)("never follows a link, and names it", async () => {
    const outside = join(root, "outside");
    await mkdir(join(outside, "skill"), { recursive: true });
    await writeFile(join(outside, "secret.md"), "secret\n");
    await writeFile(join(outside, "skill", "SKILL.md"), "x");
    const dir = join(root, "memory");
    await mkdir(join(dir, "skills"), { recursive: true });
    await symlink(outside, join(dir, "reference"), "dir");
    await symlink(join(outside, "skill"), join(dir, "skills", "linked"), "dir");

    const memfs = await readMemFs(dir);
    expect(memfs.referenceNotes).toEqual([]);
    expect(memfs.skills).toEqual([]);
    expect(memfs.warnings).toEqual([
      "'reference' is a symbolic link; not read",
      "skill 'linked' is a symbolic link; not read",
    ]);
  });

  it("leaves a forbidden file out of a skill and says so", async () => {
    const dir = join(root, "memory");
    await mkdir(join(dir, "skills", "x"), { recursive: true });
    await writeFile(join(dir, "skills", "x", "SKILL.md"), "# x\n");
    await writeFile(join(dir, "skills", "x", ".env"), "KEY=1\n");

    const memfs = await readMemFs(dir);
    expect(memfs.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(memfs.warnings).toEqual(["skill 'x': left out '.env'"]);
  });

  it("does not modify the folder it reads", async () => {
    const before = (await readdir(LOCAL_MEMORY, { recursive: true })).sort();
    await readMemFs(LOCAL_MEMORY);
    expect((await readdir(LOCAL_MEMORY, { recursive: true })).sort()).toEqual(before);
  });
});

describe("renderMemFs", () => {
  it("lays out a MemFS version 2 folder", () => {
    const entries = renderMemFs(adaBundle());
    expect(paths(entries)).toEqual([
      "MEMORY.md",
      "human.md",
      "instructions.md",
      "persona.md",
      "reference/MEMORY.md",
      "reference/diary.md",
      "reference/sources.md",
      "skills/web-brief/SKILL.md",
      "skills/web-brief/references/checklist.md",
    ]);
    expect(textOf(entries, "persona.md")).toBe(
      "---\nname: persona\ndescription: Research assistant\n---\nCurious, precise and brief.\n",
    );
    expect(textOf(entries, "instructions.md")).toBe("Read the papers first.\nThen summarise them.\n");
    expect(textOf(entries, "human.md")).toBe(
      "- Prefers short answers\n- Works in Europe/Warsaw\n- Reads papers on Fridays\n",
    );
    expect(textOf(entries, "reference/diary.md")).toBe("# Diary\n\nWrote the first brief.\n");
    const index = textOf(entries, "MEMORY.md");
    expect(index.startsWith("# Memory\n")).toBe(true);
    for (const name of ["persona.md", "instructions.md", "human.md", "reference/"]) {
      expect(index).toContain(`- ${name}: `);
    }
    expect(textOf(entries, "reference/MEMORY.md")).toBe(
      "# Reference\n\n- diary.md: Diary\n- sources.md: Sources\n",
    );
  });

  it("writes only what there is: no instructions, facts or notes, and no index of them", () => {
    const bundle: Bundle = { ...adaBundle(), instructions: " \n", facts: [], notes: [], skills: [] };
    delete bundle.persona;
    const entries = renderMemFs(bundle);
    expect(paths(entries)).toEqual(["MEMORY.md", "persona.md"]);
    expect(textOf(entries, "persona.md")).toBe(
      "---\nname: persona\ndescription: Research assistant\n---\n",
    );
    expect(textOf(entries, "MEMORY.md")).not.toContain("instructions.md");
    expect(textOf(entries, "MEMORY.md")).not.toContain("reference/");
  });

  it("labels the persona memory 'persona', never with the agent's name", () => {
    expect(parseFrontmatter(textOf(renderMemFs(adaBundle()), "persona.md")).data).toEqual({
      name: "persona",
      description: "Research assistant",
    });
  });

  it("describes the persona as that of the agent when the agent has no title", () => {
    const bundle = adaBundle();
    delete bundle.manifest.title;
    expect(parseFrontmatter(textOf(renderMemFs(bundle), "persona.md")).data).toEqual({
      name: "persona",
      description: "Persona of Ada",
    });
  });

  it("does not take the long description of the agent for the persona's", () => {
    const bundle = adaBundle();
    delete bundle.manifest.title;
    bundle.manifest.description = "Reads papers and web pages.";
    expect(parseFrontmatter(textOf(renderMemFs(bundle), "persona.md")).data.description).toBe(
      "Persona of Ada",
    );
  });

  it("puts a note that was read from reference/ back there under its own name", () => {
    const bundle: Bundle = {
      ...adaBundle(),
      notes: [
        { name: "reference--style", text: "# Style\n" },
        { name: "notes", text: "# Notes\n" },
      ],
    };
    expect(paths(renderMemFs(bundle)).filter((path) => path.startsWith("reference/"))).toEqual([
      "reference/MEMORY.md",
      "reference/notes.md",
      "reference/style.md",
    ]);
  });

  it("keeps the prefix when the name without it is taken by another note", () => {
    const bundle: Bundle = {
      ...adaBundle(),
      notes: [
        { name: "style", text: "root style\n" },
        { name: "reference--style", text: "reference style\n" },
      ],
    };
    const entries = renderMemFs(bundle);
    expect(paths(entries).filter((path) => path.startsWith("reference/"))).toEqual([
      "reference/MEMORY.md",
      "reference/reference--style.md",
      "reference/style.md",
    ]);
    expect(textOf(entries, "reference/style.md")).toBe("root style\n");
  });

  it("leaves out and reports a note that cannot be a file in reference/ and an unsafe skill", () => {
    const bundle: Bundle = {
      ...adaBundle(),
      notes: [
        { name: "MEMORY", text: "would replace the index\n" },
        { name: "../escape", text: "x" },
        { name: "con", text: "x" },
        { name: "ok", text: "fine\n" },
      ],
      skills: [
        { name: "../bad", files: [{ path: "SKILL.md", bytes: bytes("x") }] },
        { name: "worse", files: [{ path: "../SKILL.md", bytes: bytes("x") }] },
        { name: "good", files: [{ path: "SKILL.md", bytes: bytes("x") }] },
      ],
    };
    const skipped: Item[] = [];
    const entries = renderMemFs(bundle, skipped);
    expect(skipped.map((item) => item.field)).toEqual([
      "note:MEMORY",
      "note:../escape",
      "note:con",
      "skill:../bad",
      "skill:worse",
    ]);
    expect(paths(entries).filter((path) => /^(reference|skills)\//.test(path))).toEqual([
      "reference/MEMORY.md",
      "reference/ok.md",
      "skills/good/SKILL.md",
    ]);
    expect(textOf(entries, "reference/MEMORY.md")).toBe("# Reference\n\n- ok.md: fine\n");
  });

  it("keeps the agent's name on one line of the frontmatter", () => {
    const bundle = adaBundle();
    delete bundle.manifest.title;
    bundle.manifest.name = "Ada\nname: Eve";
    const { data } = parseFrontmatter(textOf(renderMemFs(bundle), "persona.md"));
    expect(data).toEqual({ name: "persona", description: "Persona of Ada name: Eve" });
  });

  it("reads back as what was put in: persona, instructions, facts, notes and skills", async () => {
    const bundle = adaBundle();
    const dir = join(root, "memory");
    await writeEntries(dir, renderMemFs(bundle));

    const memfs = await readMemFs(dir);
    expect(memfs.warnings).toEqual([]);
    expect(memfs.persona).toEqual({
      name: "persona",
      description: "Research assistant",
      body: "Curious, precise and brief.\n",
    });
    expect(memfs.instructions?.trim()).toBe(bundle.instructions);
    expect(proseToFacts(memfs.human ?? "").facts).toEqual(bundle.facts);
    expect(memfs.rootNotes).toEqual([]);
    expect(memfs.referenceNotes).toEqual(bundle.notes);
    expect(memfs.skills).toEqual(bundle.skills);
    expect(await readFile(join(dir, "reference", "MEMORY.md"), "utf8")).toContain("diary.md");
  });
});
