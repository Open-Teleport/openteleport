import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bundleToEntries,
  entriesToBundle,
  readBundle,
  writeBundle,
} from "../../src/core/bundle.js";
import {
  MAX_AVATAR_BYTES,
  MAX_FILES_BYTES,
  isForbiddenPath,
  isSafeArchivePath,
} from "../../src/core/paths.js";
import { type Bundle, type FileEntry, type Routine, parseManifest } from "../../src/core/schema.js";

const ADA_DIR = fileURLToPath(new URL("../fixtures/jetpack/ada", import.meta.url));

const encoder = new TextEncoder();
const bytes = (content: string): Uint8Array => encoder.encode(content);
const text = (path: string, content: string): FileEntry => ({ path, bytes: bytes(content) });

const MANIFEST_JSON = JSON.stringify({
  schemaVersion: "0.1",
  id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T",
  name: "Ada",
  models: [],
  capabilities: [],
});

/** The smallest valid archive content: a manifest and instructions. */
const minimal = (...extra: FileEntry[]): FileEntry[] => [
  text("jetpack.json", MANIFEST_JSON),
  text("AGENTS.md", "Be brief.\n"),
  ...extra,
];

const ROUTINE: Routine = {
  name: "Morning digest",
  instruction: "Summarise my inbox.",
  enabled: true,
  timezone: "Europe/Warsaw",
  schedule: { kind: "cron", expression: "30 8 * * 1-5" },
};

function sampleBundle(): Bundle {
  return {
    manifest: parseManifest(JSON.parse(MANIFEST_JSON)),
    persona: "Calm and curious.",
    instructions: "Be brief.\n",
    skills: [
      {
        name: "web-brief",
        files: [
          { path: "SKILL.md", bytes: bytes("---\nname: web-brief\n---\n") },
          { path: "scripts/run.sh", bytes: bytes("echo hi\n") },
        ],
      },
    ],
    routines: [ROUTINE],
    facts: ["Likes tea."],
    notes: [
      { name: "journal", text: "Day one.\n" },
      { name: "MEMORY-prose", text: "Some prose." },
    ],
    files: [{ path: "docs/readme.txt", bytes: bytes("hello") }],
    avatar: { name: "avatar.webp", bytes: new Uint8Array([1, 2, 3]) },
    unknownPaths: [],
  };
}

function zipOf(entries: FileEntry[]): Uint8Array {
  return zipSync(Object.fromEntries(entries.map((entry) => [entry.path, entry.bytes])));
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "openteleport-bundle-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeZip(name: string, entries: FileEntry[]): Promise<string> {
  const file = join(tmp, name);
  await writeFile(file, zipOf(entries));
  return file;
}

describe("round trips", () => {
  it("round-trips directory -> Bundle -> zip -> Bundle", async () => {
    const fromDirectory = await readBundle(ADA_DIR);

    expect(fromDirectory.manifest).toEqual(
      JSON.parse(await readFile(join(ADA_DIR, "jetpack.json"), "utf8")),
    );
    expect(fromDirectory.facts).toEqual([
      "Prefers answers in Polish unless the source is in English.",
      "Reads the digest on a phone, so keep it under five lines.",
    ]);
    expect(fromDirectory.notes.map((note) => note.name)).toEqual(["2026-10-20", "MEMORY-prose"]);
    expect(fromDirectory.notes[1]?.text).toBe(
      "Ada keeps long-form notes in memory/ and only distils stable facts into this file.",
    );
    expect(fromDirectory.skills.map((skill) => skill.name)).toEqual(["web-brief"]);
    expect(fromDirectory.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(fromDirectory.routines[0]?.schedule.kind).toBe("cron");
    expect(fromDirectory.persona).toContain("Ada is a calm, curious research assistant");
    expect(fromDirectory.instructions).toContain("Read the sources before summarising them.");
    expect(fromDirectory.avatar?.name).toBe("avatar.png");
    expect(fromDirectory.unknownPaths).toEqual([]);

    const archive = join(tmp, "ada.jetpack");
    await writeBundle(fromDirectory, archive);

    expect(await readBundle(archive)).toEqual(fromDirectory);
  });

  it("writes the documented layout with forward slashes", async () => {
    const archive = join(tmp, "ada.jetpack");
    await writeBundle(await readBundle(ADA_DIR), archive);

    const names = Object.keys(unzipSync(new Uint8Array(await readFile(archive))));
    expect(names.sort()).toEqual([
      "AGENTS.md",
      "MEMORY.md",
      "SOUL.md",
      "avatar.png",
      "jetpack.json",
      "memory/2026-10-20.md",
      "routines/morning-digest.json",
      "skills/web-brief/SKILL.md",
    ]);
  });

  it("round-trips directory -> Bundle -> directory -> Bundle", async () => {
    const fromDirectory = await readBundle(ADA_DIR);
    const target = join(tmp, "copy");

    await writeBundle(fromDirectory, target, { asDirectory: true });

    expect(await readBundle(target)).toEqual(fromDirectory);
    // The prose collected from MEMORY.md goes back into MEMORY.md, not into memory/.
    expect(await readdir(join(target, "memory"))).toEqual(["2026-10-20.md"]);
  });

  it("round-trips an in-memory Bundle through entries", () => {
    const bundle = sampleBundle();

    expect(entriesToBundle(bundleToEntries(bundle))).toEqual(bundle);
  });
});

describe("writeBundle into a directory", () => {
  it("writes into an empty existing directory", async () => {
    const target = join(tmp, "empty");
    await mkdir(target);

    await writeBundle(sampleBundle(), target, { asDirectory: true });

    expect(await readdir(target)).toContain("jetpack.json");
  });

  it("refuses a non-empty directory that holds no previous export", async () => {
    const target = join(tmp, "somebody-elses-folder");
    await mkdir(target);
    await writeFile(join(target, "thesis.docx"), "precious");

    await expect(writeBundle(sampleBundle(), target, { asDirectory: true })).rejects.toThrow(
      /not empty/,
    );
    expect(await readdir(target)).toEqual(["thesis.docx"]);
  });

  it("writes over a previous export", async () => {
    const target = join(tmp, "ada");
    await writeBundle(sampleBundle(), target, { asDirectory: true });

    const updated = { ...sampleBundle(), instructions: "Be even briefer.\n" };
    await writeBundle(updated, target, { asDirectory: true });

    expect((await readBundle(target)).instructions).toBe("Be even briefer.\n");
  });
});

describe("readBundle without a manifest", () => {
  async function copyOfAdaWithoutManifest(name: string): Promise<string> {
    const folder = join(tmp, name);
    await writeBundle(await readBundle(ADA_DIR), folder, { asDirectory: true });
    await rm(join(folder, "jetpack.json"));
    return folder;
  }

  it("reads a folder without manifest when requireManifest is false", async () => {
    const folder = await copyOfAdaWithoutManifest("wanderer");

    const bundle = await readBundle(folder, { requireManifest: false });

    expect(bundle.manifest).toEqual({
      schemaVersion: "0.1",
      id: "",
      name: "wanderer",
      models: [],
      capabilities: [],
    });
    expect(bundle.facts).toHaveLength(2);
    expect(bundle.skills.map((skill) => skill.name)).toEqual(["web-brief"]);
  });

  it("requires jetpack.json by default", async () => {
    const folder = await copyOfAdaWithoutManifest("wanderer");

    await expect(readBundle(folder)).rejects.toThrow(/jetpack\.json/);
  });

  it("still validates a manifest that is present", async () => {
    const archive = await writeZip(
      "broken.jetpack",
      minimal().map((entry) => (entry.path === "jetpack.json" ? text(entry.path, "{}") : entry)),
    );

    await expect(readBundle(archive, { requireManifest: false })).rejects.toThrow(
      /jetpack\.json is invalid/,
    );
  });
});

describe("forbidden and unsafe paths", () => {
  it("rejects forbidden paths inside the archive", async () => {
    const archive = await writeZip("secrets.jetpack", minimal(text("files/.env", "KEY=value")));

    await expect(readBundle(archive)).rejects.toThrow(/forbidden path: files\/\.env/);
  });

  it.each([
    "files/backup.zip",
    "files/backup.tar.gz",
    "files/backup.tgz",
    "files/backup.7z",
    "files/backup.rar",
    ".git/config",
    "files/node_modules/left-pad/index.js",
    "skills/web-brief/.env.local",
    "files/server-private-key.pem",
  ])("rejects %s", async (path) => {
    const archive = await writeZip("bad.jetpack", minimal(text(path, "x")));

    await expect(readBundle(archive)).rejects.toThrow(`forbidden path: ${path}`);
  });

  it("rejects a forbidden path in a directory before reading the rest", async () => {
    const folder = join(tmp, "agent");
    await mkdir(join(folder, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(folder, "node_modules", "pkg", "index.js"), "x");
    await writeFile(join(folder, "AGENTS.md"), "Be brief.");

    await expect(readBundle(folder, { requireManifest: false })).rejects.toThrow(
      /forbidden path: node_modules/,
    );
  });

  it.each(["../evil.md", "/etc/passwd", "files/../../evil.md", "files\\evil.txt", "C:/evil.txt"])(
    "rejects the unsafe path %s",
    async (path) => {
      const archive = await writeZip("slip.jetpack", minimal(text(path, "x")));

      await expect(readBundle(archive)).rejects.toThrow(/unsafe path/);
    },
  );

  it("rejects the same path appearing twice", () => {
    expect(() => entriesToBundle(minimal(text("AGENTS.md", "again")))).toThrow(
      /duplicate path: AGENTS\.md/,
    );
  });
});

describe("isForbiddenPath", () => {
  it.each([
    ".env",
    ".env.production",
    "files/.envrc",
    "files/.ENV",
    "files/PRIVATE_KEY",
    "files/my-private-key.pem",
    "keys/privatekey.txt",
    ".git",
    ".git/HEAD",
    "files/.git/config",
    "node_modules/x/index.js",
    "a.zip",
    "a.TAR",
    "a.gz",
    "a.tgz",
    "a.7z",
    "a.rar",
  ])("forbids %s", (path) => {
    expect(isForbiddenPath(path)).toBe(true);
  });

  it.each([
    "AGENTS.md",
    "jetpack.json",
    "skills/web-brief/SKILL.md",
    "files/.gitignore",
    "files/.github/workflows/ci.yml",
    "files/environment.md",
    "files/private.txt",
    "files/keys.txt",
    "files/archive.md",
    "files/zip.md",
  ])("allows %s", (path) => {
    expect(isForbiddenPath(path)).toBe(false);
  });
});

describe("isSafeArchivePath", () => {
  it.each(["AGENTS.md", "files/a/b.txt", "skills/web-brief/SKILL.md"])("accepts %s", (path) => {
    expect(isSafeArchivePath(path)).toBe(true);
  });

  const NUL = String.fromCharCode(0);

  it.each(["", "/abs", "a/../b", "..", "./a", "a//b", "a/", "a\\b", "C:/a", "c:a", `a${NUL}b`])(
    "rejects %j",
    (path) => {
      expect(isSafeArchivePath(path)).toBe(false);
    },
  );
});

describe("size limits", () => {
  it("rejects files/ over MAX_FILES_BYTES and avatar over MAX_AVATAR_BYTES", () => {
    const filesAtLimit = minimal({ path: "files/big.bin", bytes: new Uint8Array(MAX_FILES_BYTES) });
    expect(entriesToBundle(filesAtLimit).files).toHaveLength(1);

    const filesOverLimit = minimal({
      path: "files/big.bin",
      bytes: new Uint8Array(MAX_FILES_BYTES + 1),
    });
    expect(() => entriesToBundle(filesOverLimit)).toThrow(
      /files\/ is \d+ bytes, over the 104857600 byte limit/,
    );

    const avatarAtLimit = minimal({ path: "avatar.png", bytes: new Uint8Array(MAX_AVATAR_BYTES) });
    expect(entriesToBundle(avatarAtLimit).avatar?.name).toBe("avatar.png");

    const avatarOverLimit = minimal({
      path: "avatar.png",
      bytes: new Uint8Array(MAX_AVATAR_BYTES + 1),
    });
    expect(() => entriesToBundle(avatarOverLimit)).toThrow(
      /avatar\.png is \d+ bytes, over the 524288 byte limit/,
    );
  });

  it("counts every file under files/ towards one total", () => {
    const half = new Uint8Array(MAX_FILES_BYTES / 2 + 1);
    const entries = minimal(
      { path: "files/a.bin", bytes: half },
      { path: "files/nested/b.bin", bytes: half },
    );

    expect(() => entriesToBundle(entries)).toThrow(/files\/ is \d+ bytes/);
  });

  it("limits what an archive expands to, not its compressed size", async () => {
    // 100 MB + 1 of zeros deflates to a few hundred KB.
    const archive = await writeZip(
      "bomb.jetpack",
      minimal({ path: "files/zeros.bin", bytes: new Uint8Array(MAX_FILES_BYTES + 1) }),
    );

    await expect(readBundle(archive)).rejects.toThrow(/files\/ is \d+ bytes/);
  }, 30_000);

  it("checks the sizes in the central directory before inflating anything", async () => {
    const forged = (claimedSize: number): Uint8Array => {
      const data = zipSync({ "files/x.bin": new Uint8Array(1000) });
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let i = 0; i + 46 <= data.length; i += 1) {
        // A central directory entry holds the uncompressed size at offset 24.
        if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, claimedSize, true);
      }
      // Break the deflate stream: block type 3 is reserved, so inflating it must fail.
      data[30 + view.getUint16(26, true) + view.getUint16(28, true)] = 0xff;
      return data;
    };
    const claimsTooMuch = join(tmp, "claims-too-much.jetpack");
    const claimsLittle = join(tmp, "claims-little.jetpack");
    await writeFile(claimsTooMuch, forged(MAX_FILES_BYTES + 1));
    await writeFile(claimsLittle, forged(1000));

    // The same broken data fails differently once it is inflated...
    await expect(readBundle(claimsLittle)).rejects.toThrow(/not a valid zip archive/);
    // ...so the size error shows that nothing was inflated.
    await expect(readBundle(claimsTooMuch)).rejects.toThrow(/files\/ is 104857601 bytes/);
  });

  it("rejects an oversized avatar in an archive", async () => {
    const archive = await writeZip(
      "avatar.jetpack",
      minimal({ path: "avatar.jpg", bytes: new Uint8Array(MAX_AVATAR_BYTES + 1) }),
    );

    await expect(readBundle(archive)).rejects.toThrow(/avatar\.jpg is \d+ bytes/);
  });

  it("refuses to write a Bundle that the limits would reject on reading", () => {
    const bundle = sampleBundle();
    bundle.files = [{ path: "big.bin", bytes: new Uint8Array(MAX_FILES_BYTES + 1) }];

    expect(() => bundleToEntries(bundle)).toThrow(/files\/ is \d+ bytes/);
  });
});

describe("required content", () => {
  it("fails on missing AGENTS.md", async () => {
    const archive = await writeZip("no-agents.jetpack", [text("jetpack.json", MANIFEST_JSON)]);

    await expect(readBundle(archive)).rejects.toThrow(/missing AGENTS\.md/);
  });

  it("fails on missing jetpack.json", async () => {
    const archive = await writeZip("no-manifest.jetpack", [text("AGENTS.md", "Be brief.")]);

    await expect(readBundle(archive)).rejects.toThrow(/missing jetpack\.json/);
  });

  it("lists everything that is missing at once", () => {
    expect(() => entriesToBundle([])).toThrow(/missing jetpack\.json and AGENTS\.md/);
    expect(() => entriesToBundle([], { requireManifest: false })).toThrow(/missing AGENTS\.md$/);
  });

  it("names the file when a routine does not validate", () => {
    const bad = JSON.stringify({ ...ROUTINE, timezone: "Mars/Olympus" });

    expect(() => entriesToBundle(minimal(text("routines/bad.json", bad)))).toThrow(
      /routines\/bad\.json is invalid: .*timezone/,
    );
  });

  it("names the file when a routine is not JSON", () => {
    expect(() => entriesToBundle(minimal(text("routines/bad.json", "{nope")))).toThrow(
      /routines\/bad\.json is not valid JSON/,
    );
  });

  it("names the directory of a skill that has no SKILL.md", () => {
    const entries = minimal(text("skills/broken/notes.md", "no skill here"));

    expect(() => entriesToBundle(entries)).toThrow(/skills\/broken has no SKILL\.md/);
  });

  it("names the file that is not valid UTF-8", () => {
    const entries = [
      text("jetpack.json", MANIFEST_JSON),
      { path: "AGENTS.md", bytes: new Uint8Array([0xff, 0xfe, 0x41]) },
    ];

    expect(() => entriesToBundle(entries)).toThrow(/AGENTS\.md is not valid UTF-8/);
  });

  it("reports a file that is not a zip archive", async () => {
    const file = join(tmp, "plain.jetpack");
    await writeFile(file, "this is not a zip file");

    await expect(readBundle(file)).rejects.toThrow(/plain\.jetpack is not a valid zip archive/);
  });
});

describe("unknownPaths", () => {
  it("reports unknown top-level files in unknownPaths", async () => {
    const archive = await writeZip(
      "extras.jetpack",
      minimal(
        text("notes.txt", "scratch"),
        text("memory/todo.txt", "not a markdown note"),
        text("skills/README.md", "not inside a skill directory"),
        text("routines/nested/x.json", "{}"),
        text("docs/guide.md", "outside the layout"),
        text("memory/day.md", "a note"),
      ),
    );

    const bundle = await readBundle(archive);

    expect(bundle.unknownPaths).toEqual([
      "docs/guide.md",
      "memory/todo.txt",
      "notes.txt",
      "routines/nested/x.json",
      "skills/README.md",
    ]);
    expect(bundle.notes.map((note) => note.name)).toEqual(["day"]);
  });

  it("reports unknown files of a folder too", async () => {
    const folder = join(tmp, "agent");
    await mkdir(folder);
    await writeFile(join(folder, "AGENTS.md"), "Be brief.");
    await writeFile(join(folder, "notes.txt"), "scratch");

    const bundle = await readBundle(folder, { requireManifest: false });

    expect(bundle.unknownPaths).toEqual(["notes.txt"]);
  });

  it("does not write unknown paths back", () => {
    const bundle = { ...sampleBundle(), unknownPaths: ["notes.txt"] };

    expect(bundleToEntries(bundle).map((entry) => entry.path)).not.toContain("notes.txt");
  });

  it("rejects two avatar files", () => {
    const entries = minimal(text("avatar.png", "a"), text("avatar.webp", "b"));

    expect(() => entriesToBundle(entries)).toThrow(/more than one avatar/);
  });
});

describe("MEMORY.md mapping", () => {
  const memory = (content: string): Bundle => entriesToBundle(minimal(text("MEMORY.md", content)));

  it("maps '- ' lines to facts and everything else to the MEMORY-prose note", () => {
    const bundle = memory(
      "# Memory\n\n  - Likes tea.\n- Drinks it black.\nNot a bullet.\n-no space\n\n* star bullet\n",
    );

    expect(bundle.facts).toEqual(["Likes tea.", "Drinks it black."]);
    expect(bundle.notes).toEqual([
      { name: "MEMORY-prose", text: "# Memory\nNot a bullet.\n-no space\n* star bullet" },
    ]);
  });

  it("reads Windows line endings", () => {
    const bundle = memory("- One\r\n\r\nProse line.\r\n- Two\r\n");

    expect(bundle.facts).toEqual(["One", "Two"]);
    expect(bundle.notes).toEqual([{ name: "MEMORY-prose", text: "Prose line." }]);
  });

  it("creates no note when MEMORY.md has only facts", () => {
    expect(memory("- One\n").notes).toEqual([]);
  });

  it("has no facts and no notes without MEMORY.md", () => {
    const bundle = entriesToBundle(minimal());

    expect(bundle.facts).toEqual([]);
    expect(bundle.notes).toEqual([]);
    expect(bundle.persona).toBeUndefined();
    expect(bundle.avatar).toBeUndefined();
  });

  it("accepts a fact of exactly 500 characters", () => {
    expect(memory(`- ${"a".repeat(500)}\n`).facts).toEqual(["a".repeat(500)]);
  });

  it("names the line of a fact over 500 characters", () => {
    expect(() => memory(`- fine\n\n- ${"a".repeat(501)}\n`)).toThrow(
      /MEMORY\.md line 3: fact is 501 characters, the limit is 500/,
    );
  });

  it("refuses a note that collides with the prose from MEMORY.md", () => {
    const entries = minimal(
      text("MEMORY.md", "Some prose.\n"),
      text("memory/MEMORY-prose.md", "x"),
    );

    expect(() => entriesToBundle(entries)).toThrow(/memory\/MEMORY-prose\.md/);
  });

  it("writes facts and prose back into MEMORY.md", () => {
    const bundle = sampleBundle();
    bundle.facts = ["One", "Two"];

    const entry = bundleToEntries(bundle).find(({ path }) => path === "MEMORY.md");

    expect(new TextDecoder().decode(entry?.bytes)).toBe("Some prose.\n\n- One\n- Two\n");
  });

  it("writes no MEMORY.md without facts and prose", () => {
    const bundle = { ...sampleBundle(), facts: [], notes: [] };

    expect(bundleToEntries(bundle).map((entry) => entry.path)).not.toContain("MEMORY.md");
  });

  it("refuses to write a fact the reader would reject or split", () => {
    const write = (fact: string) => bundleToEntries({ ...sampleBundle(), facts: [fact] });

    expect(() => write("a".repeat(501))).toThrow(/fact 1 is 501 characters, the limit is 500/);
    expect(() => write("two\nlines")).toThrow(/fact 1 must be a single non-empty line/);
    expect(() => write("   ")).toThrow(/fact 1 must be a single non-empty line/);
  });
});

describe("writing entries", () => {
  const pathsOf = (bundle: Bundle) => bundleToEntries(bundle).map((entry) => entry.path);

  it("names routine files after the routine and numbers collisions", () => {
    const named = (name: string): Routine => ({ ...ROUTINE, name });
    const bundle = {
      ...sampleBundle(),
      routines: [
        named("Morning digest"),
        named("  morning   DIGEST!! "),
        named("Morning-Digest"),
        named("Weekly: review (Fri)"),
      ],
    };

    expect(pathsOf(bundle).filter((path) => path.startsWith("routines/"))).toEqual([
      "routines/morning-digest.json",
      "routines/morning-digest-2.json",
      "routines/morning-digest-3.json",
      "routines/weekly-review-fri.json",
    ]);
  });

  it("falls back to 'routine' when a name has no usable characters", () => {
    const named = (name: string): Routine => ({ ...ROUTINE, name });
    const bundle = { ...sampleBundle(), routines: [named("!!!"), named("???")] };

    expect(pathsOf(bundle).filter((path) => path.startsWith("routines/"))).toEqual([
      "routines/routine.json",
      "routines/routine-2.json",
    ]);
  });

  it("keeps letters outside ASCII in routine file names", () => {
    const bundle = { ...sampleBundle(), routines: [{ ...ROUTINE, name: "Poranny przegląd" }] };

    expect(pathsOf(bundle)).toContain("routines/poranny-przegląd.json");
  });

  it("does not turn a routine name into a forbidden file name", () => {
    const bundle = { ...sampleBundle(), routines: [{ ...ROUTINE, name: "Rotate private key" }] };

    expect(pathsOf(bundle)).toContain("routines/routine.json");
  });

  it("writes skill files under skills/<name>/ and keeps nested paths", () => {
    expect(pathsOf(sampleBundle())).toEqual(
      expect.arrayContaining(["skills/web-brief/SKILL.md", "skills/web-brief/scripts/run.sh"]),
    );
  });

  it("writes the manifest with its vendor extensions", () => {
    const bundle = sampleBundle();
    bundle.manifest = { ...bundle.manifest, "x-acme": { pinned: true } };

    const entry = bundleToEntries(bundle).find(({ path }) => path === "jetpack.json");

    expect(JSON.parse(new TextDecoder().decode(entry?.bytes))).toMatchObject({
      id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T",
      "x-acme": { pinned: true },
    });
  });

  it("refuses a manifest without a real id", () => {
    const bundle = sampleBundle();
    bundle.manifest = { ...bundle.manifest, id: "" };

    expect(() => bundleToEntries(bundle)).toThrow(/manifest is invalid: id:/);
  });

  it("refuses a routine that would not validate on reading", () => {
    const bundle = { ...sampleBundle(), routines: [{ ...ROUTINE, timezone: "Mars/Olympus" }] };

    expect(() => bundleToEntries(bundle)).toThrow(/routine "Morning digest" is invalid/);
  });

  it("refuses names that would escape their directory", () => {
    const withSkill = (name: string): Bundle => ({
      ...sampleBundle(),
      skills: [{ name, files: [{ path: "SKILL.md", bytes: bytes("x") }] }],
    });
    const withNote = (name: string): Bundle => ({
      ...sampleBundle(),
      notes: [{ name, text: "x" }],
    });

    expect(() => bundleToEntries(withSkill("a/b"))).toThrow(/skill name/);
    expect(() => bundleToEntries(withSkill(".."))).toThrow(/unsafe path/);
    expect(() => bundleToEntries(withNote("a/b"))).toThrow(/note name/);
  });

  it("refuses a skill without SKILL.md", () => {
    const bundle = {
      ...sampleBundle(),
      skills: [{ name: "empty", files: [{ path: "notes.md", bytes: bytes("x") }] }],
    };

    expect(() => bundleToEntries(bundle)).toThrow(/skill empty has no SKILL\.md/);
  });

  it("refuses an avatar that is not avatar.<png|jpg|jpeg|webp>", () => {
    const withAvatar = (name: string): Bundle => ({
      ...sampleBundle(),
      avatar: { name, bytes: new Uint8Array(1) },
    });

    expect(() => bundleToEntries(withAvatar("photo.png"))).toThrow(/avatar file name/);
    expect(() => bundleToEntries(withAvatar("avatar.gif"))).toThrow(/avatar file name/);
    expect(pathsOf(withAvatar("avatar.jpeg"))).toContain("avatar.jpeg");
  });

  it("refuses forbidden paths when writing", () => {
    const bundle = {
      ...sampleBundle(),
      files: [{ path: ".env", bytes: bytes("KEY=value") }],
    };

    expect(() => bundleToEntries(bundle)).toThrow(/forbidden path: files\/\.env/);
  });
});

describe("special directory entries", () => {
  it("rejects a symbolic link in a folder", async (context) => {
    const folder = join(tmp, "agent");
    await mkdir(folder);
    await writeFile(join(folder, "AGENTS.md"), "Be brief.");
    await writeFile(join(tmp, "outside.md"), "secret");
    try {
      await symlink(join(tmp, "outside.md"), join(folder, "link.md"), "file");
    } catch {
      // Creating symbolic links needs a privilege that Windows accounts often lack.
      context.skip();
    }

    await expect(readBundle(folder, { requireManifest: false })).rejects.toThrow(/symbolic link/);
  });

  it("ignores directory entries inside a zip", async () => {
    const files = {
      "jetpack.json": bytes(MANIFEST_JSON),
      "AGENTS.md": bytes("Be brief."),
      "skills/": new Uint8Array(0),
      "files/": new Uint8Array(0),
    };
    const archive = join(tmp, "dirs.jetpack");
    await writeFile(archive, zipSync(files));

    const bundle = await readBundle(archive);

    expect(bundle.skills).toEqual([]);
    expect(bundle.files).toEqual([]);
    expect(bundle.unknownPaths).toEqual([]);
  });
});
