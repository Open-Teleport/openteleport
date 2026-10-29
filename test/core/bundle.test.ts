import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundleToEntries,
  entriesToBundle,
  readBundle,
  writeBundle,
} from "../../src/core/bundle.js";
import {
  MAX_ARCHIVE_BYTES,
  MAX_AVATAR_BYTES,
  MAX_FILES_BYTES,
  MAX_ROUTINES,
  MAX_SKILLS,
  MAX_TEXT_ENTRY_BYTES,
  isForbiddenPath,
  isReservedDeviceName,
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

/** A zip local file header followed by its data. */
function localEntry(name: string, method: 0 | 8, data: Uint8Array, size = data.length): Uint8Array {
  const nameBytes = encoder.encode(name);
  const out = new Uint8Array(30 + nameBytes.length + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, 0x0800, true); // flags: UTF-8 name
  view.setUint16(8, method, true);
  view.setUint16(12, 33, true); // date: 1980-01-01 (fflate does not check the CRC at 14)
  view.setUint32(18, data.length, true); // compressed size
  view.setUint32(22, size, true); // uncompressed size
  view.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  out.set(data, 30 + nameBytes.length);
  return out;
}

type RawRecord = {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  offset: number;
};

/** A zip written by hand: `body` (local entries) followed by the given central directory. */
function rawZip(body: Uint8Array, records: RawRecord[]): Uint8Array {
  const names = records.map(({ name }) => encoder.encode(name));
  const directorySize = names.reduce((sum, name) => sum + 46 + name.length, 0);
  const out = new Uint8Array(body.length + directorySize + 22);
  const view = new DataView(out.buffer);
  out.set(body);
  let at = body.length;
  records.forEach((record, i) => {
    const name = names[i] ?? new Uint8Array(0);
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true); // version made by
    view.setUint16(at + 6, 20, true); // version needed
    view.setUint16(at + 8, 0x0800, true); // flags: UTF-8 name
    view.setUint16(at + 10, record.method, true);
    view.setUint16(at + 14, 33, true); // date: 1980-01-01
    view.setUint32(at + 20, record.compressedSize, true);
    view.setUint32(at + 24, record.size, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, record.offset, true); // offset of the local header
    out.set(name, at + 46);
    at += 46 + name.length;
  });
  view.setUint32(at, 0x06054b50, true); // end of central directory
  view.setUint16(at + 8, records.length, true);
  view.setUint16(at + 10, records.length, true);
  view.setUint32(at + 12, directorySize, true);
  view.setUint32(at + 16, body.length, true);
  return out;
}

/** An honest zip of stored entries, written by hand. */
function storedZip(entries: FileEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const records: RawRecord[] = [];
  let offset = 0;
  for (const { path, bytes: data } of entries) {
    const local = localEntry(path, 0, data);
    records.push({ name: path, method: 0, compressedSize: data.length, size: data.length, offset });
    parts.push(local);
    offset += local.length;
  }
  const body = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return rawZip(body, records);
}

/**
 * Changes one entry of an archive without touching the rest: `claimedSize` is the uncompressed
 * size its central directory entry declares, and `breakData` damages its deflate stream so that
 * inflating it fails (block type 3 is reserved). Entries are found by name.
 */
function tamper(
  archive: Uint8Array,
  path: string,
  change: { claimedSize?: number; breakData?: boolean },
): Uint8Array {
  const data = archive.slice();
  const view = new DataView(data.buffer);
  const nameAt = (at: number, length: number) =>
    new TextDecoder().decode(data.subarray(at, at + length));
  for (let i = 0; i + 46 <= data.length; i += 1) {
    const signature = view.getUint32(i, true);
    // Central directory entry: uncompressed size at 24, name length at 28, name at 46.
    if (signature === 0x02014b50 && nameAt(i + 46, view.getUint16(i + 28, true)) === path) {
      if (change.claimedSize !== undefined) view.setUint32(i + 24, change.claimedSize, true);
    }
    // Local header: name length at 26, extra length at 28, name at 30, then the data.
    if (signature === 0x04034b50 && nameAt(i + 30, view.getUint16(i + 26, true)) === path) {
      if (change.breakData) {
        const dataAt = i + 30 + view.getUint16(i + 26, true) + view.getUint16(i + 28, true);
        data[dataAt] = 0xff;
      }
    }
  }
  return data;
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

  it("replaces the layout of a previous export and keeps every other file", async () => {
    const target = join(tmp, "ada");
    const ada = await readBundle(ADA_DIR);
    await writeBundle(ada, target, { asDirectory: true });
    await writeFile(join(target, "notes.txt"), "mine");
    await mkdir(join(target, "scratch"));
    await writeFile(join(target, "scratch", "todo.txt"), "also mine");
    expect((await readdir(target)).sort()).toEqual([
      "AGENTS.md",
      "MEMORY.md",
      "SOUL.md",
      "avatar.png",
      "jetpack.json",
      "memory",
      "notes.txt",
      "routines",
      "scratch",
      "skills",
    ]);

    const slimmer: Bundle = {
      ...ada,
      persona: undefined,
      skills: [],
      routines: [],
      notes: [],
      avatar: { name: "avatar.webp", bytes: new Uint8Array([1, 2, 3]) },
    };
    await writeBundle(slimmer, target, { asDirectory: true });

    // skills/, routines/, memory/, SOUL.md and avatar.png went away with the old export...
    expect((await readdir(target)).sort()).toEqual([
      "AGENTS.md",
      "MEMORY.md",
      "avatar.webp",
      "jetpack.json",
      "notes.txt",
      "scratch",
    ]);
    // ...and the files that were not part of the layout are untouched.
    expect(await readFile(join(target, "notes.txt"), "utf8")).toBe("mine");
    expect(await readFile(join(target, "scratch", "todo.txt"), "utf8")).toBe("also mine");

    const reread = await readBundle(target);
    expect(reread.skills).toEqual([]);
    expect(reread.routines).toEqual([]);
    expect(reread.unknownPaths).toEqual(["notes.txt", "scratch/todo.txt"]);
  });

  it("names each entry of the previous export that the new Bundle no longer has", async () => {
    const target = join(tmp, "ada");
    const ada: Bundle = {
      ...(await readBundle(ADA_DIR)),
      files: [
        { path: "data/table.csv", bytes: bytes("a,b\n") },
        { path: "readme.txt", bytes: bytes("hi\n") },
      ],
    };
    expect(await writeBundle(ada, target, { asDirectory: true })).toEqual({ removed: [] });

    const slimmer: Bundle = {
      ...ada,
      persona: undefined,
      skills: [],
      routines: [],
      notes: ada.notes.filter((note) => note.name === "MEMORY-prose"),
      files: [{ path: "readme.txt", bytes: bytes("hi again\n") }],
      avatar: undefined,
    };
    const { removed } = await writeBundle(slimmer, target, { asDirectory: true });

    // What is written again (AGENTS.md, MEMORY.md, files/readme.txt) is not named.
    expect(removed).toEqual([
      "SOUL.md",
      "avatar.png",
      "files/data",
      "memory/2026-10-20.md",
      "routines/morning-digest.json",
      "skills/web-brief",
    ]);
  });

  it("removes nothing from a zip target", async () => {
    expect(await writeBundle(sampleBundle(), join(tmp, "ada.jetpack"))).toEqual({ removed: [] });
  });

  it("leaves a previous export alone when the new Bundle is invalid", async () => {
    const target = join(tmp, "ada");
    await writeBundle(sampleBundle(), target, { asDirectory: true });

    const invalid = { ...sampleBundle(), facts: ["two\nlines"] };
    await expect(writeBundle(invalid, target, { asDirectory: true })).rejects.toThrow(/fact 1/);

    expect((await readBundle(target)).skills.map((skill) => skill.name)).toEqual(["web-brief"]);
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

  it("drops the .jetpack extension from the name of an archive", async () => {
    const archive = await writeZip("ada.jetpack", [text("AGENTS.md", "Be brief.")]);

    const bundle = await readBundle(archive, { requireManifest: false });

    expect(bundle.manifest.name).toBe("ada");
  });

  it("only drops a real .jetpack extension from the name", async () => {
    const archive = await writeZip("my-jetpack", [text("AGENTS.md", "Be brief.")]);

    const bundle = await readBundle(archive, { requireManifest: false });

    expect(bundle.manifest.name).toBe("my-jetpack");
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

  it("reads a folder that is a git repository, reporting what lies outside the layout", async () => {
    const folder = join(tmp, "agent");
    const put = async (path: string, content = "x"): Promise<void> => {
      await mkdir(join(folder, ...path.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(folder, ...path.split("/")), content);
    };
    await put(".git/HEAD", "ref: refs/heads/main\n");
    await put(".git/refs/heads/main", "0123456789abcdef\n");
    await put("node_modules/pkg/index.js");
    await put(".env", "KEY=value\n");
    await put(".github/workflows/ci.yml", "on: push\n");
    await put("backup.zip");
    await put("docs/guide.md", "Read me.\n");
    await put("docs/.DS_Store");
    await put("docs/drafts/old.tgz");
    await put("AGENTS.md", "Be brief.");

    const bundle = await readBundle(folder, { requireManifest: false });

    expect(bundle.instructions).toBe("Be brief.");
    // Forbidden and dot entries are named once, never descended into.
    expect(bundle.unknownPaths).toEqual([
      ".env",
      ".git",
      ".github",
      "backup.zip",
      "docs/.DS_Store",
      "docs/drafts/old.tgz",
      "docs/guide.md",
      "node_modules",
    ]);
  });

  it.each([
    ["files/.env", "files/.env"],
    ["files/node_modules/pkg/index.js", "files/node_modules"],
    ["skills/web-brief/.env.local", "skills/web-brief/.env.local"],
    ["memory/.git/HEAD", "memory/.git"],
    ["routines/backup.zip", "routines/backup.zip"],
  ])("still refuses %s inside the layout of a folder", async (path, forbidden) => {
    const folder = join(tmp, "agent");
    await mkdir(join(folder, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(folder, ...path.split("/")), "x");
    await writeFile(join(folder, "AGENTS.md"), "Be brief.");

    await expect(readBundle(folder, { requireManifest: false })).rejects.toThrow(
      `forbidden path: ${forbidden}`,
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

describe("isReservedDeviceName", () => {
  it.each(["con", "CON", "prn", "aux", "nul", "com1", "COM9", "lpt1", "Lpt9"])(
    "reserves %s",
    (name) => {
      expect(isReservedDeviceName(name)).toBe(true);
    },
  );

  it.each(["nul.txt", "aux.tar.gz", "con."])("reserves %s whatever the extension", (name) => {
    expect(isReservedDeviceName(name)).toBe(true);
  });

  it.each(["console", "conf", "auxiliary.md", "com0", "com10", "lpt0", "lpt10", "my.con", "nul-r"])(
    "does not reserve %s",
    (name) => {
      expect(isReservedDeviceName(name)).toBe(false);
    },
  );
});

describe("isSafeArchivePath", () => {
  it.each(["AGENTS.md", "files/a/b.txt", "skills/web-brief/SKILL.md", "files/console.md"])(
    "accepts %s",
    (path) => {
      expect(isSafeArchivePath(path)).toBe(true);
    },
  );

  it.each(["con", "files/NUL.txt", "files/aux.md", "skills/com1/SKILL.md", "memory/lpt9.md"])(
    "rejects the device name in %s",
    (path) => {
      expect(isSafeArchivePath(path)).toBe(false);
    },
  );

  it("rejects a device name inside an archive", async () => {
    const archive = await writeZip("device.jetpack", minimal(text("files/NUL.txt", "x")));

    await expect(readBundle(archive)).rejects.toThrow(/unsafe path: files\/NUL\.txt/);
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

  describe("from the central directory, before anything is inflated", () => {
    /** A valid archive plus one tiny, deliberately undecodable entry at `path`. */
    const withBrokenEntry = (path: string, claimedSize: number): Uint8Array => {
      const archive = zipOf(minimal({ path, bytes: new Uint8Array(1000) }));
      return tamper(archive, path, { claimedSize, breakData: true });
    };
    const readForged = async (name: string, data: Uint8Array) => {
      const file = join(tmp, name);
      await writeFile(file, data);
      return readBundle(file);
    };

    it("for files/", async () => {
      // The same broken data fails differently once it is inflated...
      const claimsTruth = withBrokenEntry("files/x.bin", 1000);
      await expect(readForged("honest.jetpack", claimsTruth)).rejects.toThrow(
        /not a valid zip archive/,
      );
      // ...so the size error shows that nothing was inflated.
      const claimsTooMuch = withBrokenEntry("files/x.bin", MAX_FILES_BYTES + 1);
      await expect(readForged("forged.jetpack", claimsTooMuch)).rejects.toThrow(
        /files\/ is 104857601 bytes/,
      );
    });

    it("for an entry outside files/ that belongs to the layout", async () => {
      const claimsTooMuch = withBrokenEntry("skills/x/big.bin", MAX_TEXT_ENTRY_BYTES + 1);

      await expect(readForged("skill.jetpack", claimsTooMuch)).rejects.toThrow(
        /skills\/x\/big\.bin is 2097153 bytes, over the 2097152 byte limit/,
      );
    });

    it("for a path outside the layout", async () => {
      const claimsTooMuch = withBrokenEntry("junk.bin", MAX_ARCHIVE_BYTES + 1);

      await expect(readForged("junk.jetpack", claimsTooMuch)).rejects.toThrow(
        /entries add up to \d+ bytes, over the 115343360 byte limit/,
      );
    });

    it("for many paths that only add up to too much", async () => {
      const half = Math.floor(MAX_ARCHIVE_BYTES / 2) + 1;
      let data = zipOf(
        minimal(
          { path: "one.bin", bytes: new Uint8Array(1000) },
          { path: "two.bin", bytes: new Uint8Array(1000) },
        ),
      );
      data = tamper(data, "one.bin", { claimedSize: half, breakData: true });
      data = tamper(data, "two.bin", { claimedSize: half, breakData: true });

      await expect(readForged("many.jetpack", data)).rejects.toThrow(/entries add up to/);
    });
  });

  it("rejects a well-compressed entry outside files/ over MAX_TEXT_ENTRY_BYTES", async () => {
    const archive = await writeZip(
      "bomb.jetpack",
      minimal({ path: "skills/x/big.bin", bytes: new Uint8Array(MAX_TEXT_ENTRY_BYTES + 1) }),
    );

    await expect(readBundle(archive)).rejects.toThrow(/skills\/x\/big\.bin is 2097153 bytes/);
  });

  it("accepts an entry of exactly MAX_TEXT_ENTRY_BYTES and holds every kind to it", () => {
    const big = (path: string, size = MAX_TEXT_ENTRY_BYTES + 1): FileEntry[] => [
      ...minimal().filter((entry) => entry.path !== path),
      { path, bytes: new Uint8Array(size) },
    ];
    // Not valid JSON or UTF-8 text, but the size check comes first.
    for (const path of [
      "AGENTS.md",
      "jetpack.json",
      "SOUL.md",
      "MEMORY.md",
      "memory/day.md",
      "routines/r.json",
      "skills/x/SKILL.md",
    ]) {
      expect(() => entriesToBundle(big(path))).toThrow(
        new RegExp(`${path.replace(".", "\\.")} is 2097153 bytes`),
      );
    }
    const atLimit = entriesToBundle([
      ...minimal().filter((entry) => entry.path !== "AGENTS.md"),
      { path: "AGENTS.md", bytes: new Uint8Array(MAX_TEXT_ENTRY_BYTES).fill(0x61) },
    ]);
    expect(atLimit.instructions).toHaveLength(MAX_TEXT_ENTRY_BYTES);
  });

  it("does not inflate paths outside the layout, only reports them", async () => {
    const junk = { path: "junk.bin", bytes: new Uint8Array(1000) };
    const archive = tamper(zipOf(minimal(junk)), "junk.bin", { breakData: true });
    const file = join(tmp, "junk.jetpack");
    await writeFile(file, archive);

    const bundle = await readBundle(file);

    expect(bundle.unknownPaths).toEqual(["junk.bin"]);
  });

  it("bounds all entries together, paths outside the layout included", () => {
    const filesAtLimit = { path: "files/big.bin", bytes: new Uint8Array(MAX_FILES_BYTES) };
    const unknown = (name: string, size: number): FileEntry => ({
      path: name,
      bytes: new Uint8Array(size),
    });
    const room = MAX_ARCHIVE_BYTES - MAX_FILES_BYTES;

    expect(entriesToBundle(minimal(filesAtLimit, unknown("a.bin", room / 2))).unknownPaths).toEqual(
      ["a.bin"],
    );
    expect(() =>
      entriesToBundle(minimal(filesAtLimit, unknown("a.bin", room), unknown("b.bin", room))),
    ).toThrow(/entries add up to \d+ bytes, over the 115343360 byte limit/);
  });

  it("refuses an archive file larger than MAX_ARCHIVE_BYTES before reading it", async () => {
    const file = join(tmp, "huge.jetpack");
    await writeFile(file, "");
    await truncate(file, MAX_ARCHIVE_BYTES + 1);

    await expect(readBundle(file)).rejects.toThrow(
      /huge\.jetpack is 115343361 bytes, over the 115343360 byte limit/,
    );
  });

  describe("compressed sizes declared by a zip", () => {
    const MiB = 1024 * 1024;
    const readRaw = async (name: string, data: Uint8Array) => {
      const file = join(tmp, name);
      await writeFile(file, data);
      return readBundle(file);
    };

    // 20 central directory records that all point at one local entry: the declared
    // uncompressed sizes add up to almost nothing, the compressed sizes to 20 MiB, and the
    // file is a little over 1 MiB. fflate would copy 20 MiB for them.
    it.each([
      ["declare a size of 1 byte (the probe)", 1],
      ["declare the stored size", MiB],
    ])("rejects stored records that overlap and %s", async (_label, declaredSize) => {
      const shared = localEntry("files/0", 0, new Uint8Array(MiB));
      const records = Array.from({ length: 20 }, (_, i) => ({
        name: `files/${i}`,
        method: 0 as const,
        compressedSize: MiB,
        size: declaredSize,
        offset: 0,
      }));

      await expect(readRaw("overlap.jetpack", rawZip(shared, records))).rejects.toThrow(
        /declares 20971520 bytes of compressed data in a file of \d+ bytes/,
      );
    });

    it("rejects overlapping deflate records too", async () => {
      const shared = localEntry("files/0", 8, new Uint8Array(MiB));
      const records = Array.from({ length: 20 }, (_, i) => ({
        name: `files/${i}`,
        method: 8 as const,
        compressedSize: MiB,
        size: 1000,
        offset: 0,
      }));

      await expect(readRaw("overlap8.jetpack", rawZip(shared, records))).rejects.toThrow(
        /declares 20971520 bytes of compressed data/,
      );
    });

    it.each([
      ["more than it stores", 100, 50],
      ["less than it stores", 100, 150],
    ])("rejects a stored entry that declares %s", async (_label, stored, declared) => {
      const body = localEntry("skills/x/SKILL.md", 0, new Uint8Array(stored).fill(0x61), declared);
      const record = {
        name: "skills/x/SKILL.md",
        method: 0 as const,
        compressedSize: stored,
        size: declared,
        offset: 0,
      };

      await expect(readRaw("stored.jetpack", rawZip(body, [record]))).rejects.toThrow(
        /skills\/x\/SKILL\.md is stored with \d+ bytes but declares a size of \d+ bytes/,
      );
    });

    it("rejects an entry of the layout outside files/ that is over 2 MiB compressed", async () => {
      const path = "skills/x/big.bin";
      const body = localEntry(path, 8, new Uint8Array(MAX_TEXT_ENTRY_BYTES + 1), 1000);
      const record = {
        name: path,
        method: 8 as const,
        compressedSize: MAX_TEXT_ENTRY_BYTES + 1,
        size: 1000,
        offset: 0,
      };

      await expect(readRaw("deflate.jetpack", rawZip(body, [record]))).rejects.toThrow(
        /skills\/x\/big\.bin is 2097153 bytes compressed, over the 2097152 byte limit/,
      );
    });

    it("still reads honest stored entries", async () => {
      const entries = minimal(text("files/notes.txt", "hello"), text("skills/x/SKILL.md", "x"));

      const written = await readRaw("stored.jetpack", storedZip(entries));
      const level0 = entries.map(({ path, bytes }) => [path, [bytes, { level: 0 }]]);
      const byFflate = await readRaw("level0.jetpack", zipSync(Object.fromEntries(level0)));

      expect(written.files.map((file) => file.path)).toEqual(["notes.txt"]);
      expect(written.skills.map((skill) => skill.name)).toEqual(["x"]);
      expect(byFflate).toEqual(written);
    });
  });

  describe("in a directory", () => {
    const agentFolder = async (): Promise<string> => {
      const folder = join(tmp, "agent");
      await mkdir(join(folder, "skills", "x"), { recursive: true });
      await writeFile(join(folder, "AGENTS.md"), "Be brief.");
      await writeFile(join(folder, "skills", "x", "SKILL.md"), "A skill.");
      return folder;
    };

    it("rejects a big entry that belongs to the layout", async () => {
      const folder = await agentFolder();
      const big = join(folder, "skills", "x", "big.bin");
      await writeFile(big, new Uint8Array(MAX_TEXT_ENTRY_BYTES + 1));

      await expect(readBundle(folder, { requireManifest: false })).rejects.toThrow(
        /skills\/x\/big\.bin is 2097153 bytes/,
      );
    });

    const grow = async (path: string, size: number): Promise<void> => {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "");
      await truncate(path, size);
    };

    it("does not count paths outside the layout toward the size limits", async () => {
      const folder = await agentFolder();
      await grow(join(folder, "junk.bin"), MAX_ARCHIVE_BYTES + 1);
      await grow(join(folder, "memory", "call.wav"), MAX_ARCHIVE_BYTES + 1);

      const bundle = await readBundle(folder, { requireManifest: false });

      expect(bundle.unknownPaths).toEqual(["junk.bin", "memory/call.wav"]);
    });

    it("names the five largest files when files/ is over the limit", async () => {
      const folder = await agentFolder();
      const MiB = 1024 * 1024;
      const sizes: [string, number][] = [
        ["e.bin", 15],
        ["a.bin", 30],
        ["g.bin", 5],
        ["c/d.bin", 20],
        ["b.bin", 25],
        ["f.bin", 10],
      ];
      for (const [path, size] of sizes) {
        await grow(join(folder, "files", ...path.split("/")), size * MiB);
      }

      const failure = readBundle(folder, { requireManifest: false });

      await expect(failure).rejects.toThrow(
        `files/ is ${105 * MiB} bytes, over the ${MAX_FILES_BYTES} byte limit; the largest: ` +
          `files/a.bin (${30 * MiB} bytes), files/b.bin (${25 * MiB} bytes), ` +
          `files/c/d.bin (${20 * MiB} bytes), files/e.bin (${15 * MiB} bytes), ` +
          `files/f.bin (${10 * MiB} bytes)`,
      );
      await expect(failure).rejects.not.toThrow(/g\.bin/);
    });

    it("rejects a folder whose layout entries add up to too much, judging by size alone", async () => {
      const folder = await agentFolder();
      await grow(join(folder, "files", "big.bin"), MAX_FILES_BYTES);
      for (let n = 1; n <= 6; n += 1) {
        await grow(join(folder, "memory", `note-${n}.md`), MAX_TEXT_ENTRY_BYTES);
      }

      await expect(readBundle(folder, { requireManifest: false })).rejects.toThrow(
        /entries add up to \d+ bytes/,
      );
    });

    it("reports a big path outside the layout", async () => {
      const folder = await agentFolder();
      await writeFile(join(folder, "notes.pdf"), new Uint8Array(MAX_TEXT_ENTRY_BYTES * 2));

      const bundle = await readBundle(folder, { requireManifest: false });

      expect(bundle.unknownPaths).toEqual(["notes.pdf"]);
    });

    it("never reads the content of a path outside the layout", async () => {
      const folder = await agentFolder();
      await writeFile(join(folder, "notes.txt"), "scratch");
      const reads: string[] = [];
      const readFileOnce = fsPromises.readFile;
      // bundle.ts imports readFile by name; syncBuiltinESMExports makes the spy visible to it.
      const spy = vi.spyOn(fsPromises, "readFile").mockImplementation(((...args: unknown[]) => {
        reads.push(basename(String(args[0])));
        return (readFileOnce as (...a: unknown[]) => unknown)(...args);
      }) as typeof fsPromises.readFile);
      syncBuiltinESMExports();
      try {
        await readBundle(folder, { requireManifest: false });
      } finally {
        spy.mockRestore();
        syncBuiltinESMExports();
      }

      expect(reads).toContain("AGENTS.md");
      expect(reads).not.toContain("notes.txt");
    });
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

describe("format limits", () => {
  const skillEntries = (count: number): FileEntry[] =>
    Array.from({ length: count }, (_, i) => text(`skills/skill-${i}/SKILL.md`, "x"));
  const routineEntries = (count: number): FileEntry[] =>
    Array.from({ length: count }, (_, i) =>
      text(`routines/routine-${i}.json`, JSON.stringify({ ...ROUTINE, name: `Routine ${i}` })),
    );
  const underFiles = (entry: FileEntry): FileEntry => ({ ...entry, path: `files/${entry.path}` });

  it("accepts MAX_SKILLS skills and rejects one more", () => {
    expect(entriesToBundle(minimal(...skillEntries(MAX_SKILLS))).skills).toHaveLength(32);
    expect(() => entriesToBundle(minimal(...skillEntries(MAX_SKILLS + 1)))).toThrow(
      /too many skills: 33 \(the limit is 32\)/,
    );
  });

  it("counts a skill once however many files it has", () => {
    const more = Array.from({ length: 5 }, (_, i) => text(`skills/big/file-${i}.md`, "x"));

    const bundle = entriesToBundle(minimal(text("skills/big/SKILL.md", "x"), ...more));

    expect(bundle.skills).toHaveLength(1);
  });

  it("accepts MAX_ROUTINES routines and rejects one more", () => {
    expect(entriesToBundle(minimal(...routineEntries(MAX_ROUTINES))).routines).toHaveLength(64);
    expect(() => entriesToBundle(minimal(...routineEntries(MAX_ROUTINES + 1)))).toThrow(
      /too many routines: 65 \(the limit is 64\)/,
    );
  });

  it("applies the same limits when writing", () => {
    const skills = (count: number): Bundle["skills"] =>
      Array.from({ length: count }, (_, i) => ({
        name: `skill-${i}`,
        files: [{ path: "SKILL.md", bytes: bytes("x") }],
      }));
    const routines = (count: number): Routine[] =>
      Array.from({ length: count }, (_, i) => ({ ...ROUTINE, name: `Routine ${i}` }));
    const write = (changes: Partial<Bundle>) => bundleToEntries({ ...sampleBundle(), ...changes });

    expect(write({ skills: skills(MAX_SKILLS) })).not.toHaveLength(0);
    expect(() => write({ skills: skills(MAX_SKILLS + 1) })).toThrow(
      /too many skills: 33 \(the limit is 32\)/,
    );
    expect(write({ routines: routines(MAX_ROUTINES) })).not.toHaveLength(0);
    expect(() => write({ routines: routines(MAX_ROUTINES + 1) })).toThrow(
      /too many routines: 65 \(the limit is 64\)/,
    );
  });

  it("rejects an archive with too many skills before reading its content", async () => {
    const archive = await writeZip("crowded.jetpack", minimal(...skillEntries(MAX_SKILLS + 1)));

    await expect(readBundle(archive)).rejects.toThrow(/too many skills: 33/);
  });

  it("does not count skills or routines kept under files/", () => {
    const entries = minimal(
      ...skillEntries(MAX_SKILLS + 1).map(underFiles),
      ...routineEntries(MAX_ROUTINES + 1).map(underFiles),
    );

    expect(entriesToBundle(entries).files).toHaveLength(MAX_SKILLS + 1 + MAX_ROUTINES + 1);
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

  it("makes routine file names ASCII", () => {
    const bundle = { ...sampleBundle(), routines: [{ ...ROUTINE, name: "Poranny przegląd" }] };

    expect(pathsOf(bundle)).toContain("routines/poranny-przegl-d.json");
  });

  it("cuts a routine file name to 64 characters without a dangling dash", () => {
    const routineFiles = (name: string) =>
      pathsOf({ ...sampleBundle(), routines: [{ ...ROUTINE, name }] }).filter((path) =>
        path.startsWith("routines/"),
      );

    expect(routineFiles("a".repeat(100))).toEqual([`routines/${"a".repeat(64)}.json`]);
    // The 64th character would be the dash between the words.
    expect(routineFiles(`${"a".repeat(63)} bbb`)).toEqual([`routines/${"a".repeat(63)}.json`]);
  });

  it("keeps Windows device names out of routine file names", () => {
    const named = (name: string): Routine => ({ ...ROUTINE, name });
    const bundle = {
      ...sampleBundle(),
      routines: ["CON", "aux", "Com1", "lpt9", "nul!", "console"].map(named),
    };

    expect(pathsOf(bundle).filter((path) => path.startsWith("routines/"))).toEqual([
      "routines/con-r.json",
      "routines/aux-r.json",
      "routines/com1-r.json",
      "routines/lpt9-r.json",
      "routines/nul-r.json",
      "routines/console.json",
    ]);
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
  it("rejects a symbolic link inside the layout of a folder", async (context) => {
    const folder = join(tmp, "agent");
    await mkdir(join(folder, "memory"), { recursive: true });
    await writeFile(join(folder, "AGENTS.md"), "Be brief.");
    await writeFile(join(tmp, "outside.md"), "secret");
    try {
      await symlink(join(tmp, "outside.md"), join(folder, "memory", "link.md"), "file");
    } catch {
      // Creating symbolic links needs a privilege that Windows accounts often lack.
      context.skip();
    }

    await expect(readBundle(folder, { requireManifest: false })).rejects.toThrow(/symbolic link/);
  });

  it("rejects a linked skill folder", async (context) => {
    const folder = join(tmp, "agent");
    await mkdir(join(folder, "skills"), { recursive: true });
    await writeFile(join(folder, "AGENTS.md"), "Be brief.");
    await mkdir(join(tmp, "elsewhere"));
    await writeFile(join(tmp, "elsewhere", "SKILL.md"), "A skill.");
    try {
      // A junction needs no privilege on Windows.
      await symlink(join(tmp, "elsewhere"), join(folder, "skills", "web-brief"), "junction");
    } catch {
      context.skip();
    }

    await expect(readBundle(folder, { requireManifest: false })).rejects.toThrow(/symbolic link/);
  });

  it("names a link outside the layout without following it", async (context) => {
    const folder = join(tmp, "agent");
    await mkdir(folder);
    await writeFile(join(folder, "AGENTS.md"), "Be brief.");
    await mkdir(join(tmp, "elsewhere"));
    await writeFile(join(tmp, "elsewhere", "SKILL.md"), "Not ours.");
    try {
      await symlink(join(tmp, "elsewhere"), join(folder, "shared"), "junction");
    } catch {
      context.skip();
    }

    const bundle = await readBundle(folder, { requireManifest: false });

    expect(bundle.unknownPaths).toEqual(["shared"]);
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

it("allows only one concurrent exclusive archive writer", async () => {
  const target = join(tmp, "exclusive.jetpack");
  const outcomes = await Promise.allSettled([
    writeBundle(sampleBundle(), target, { exclusiveArchive: true }),
    writeBundle(sampleBundle(), target, { exclusiveArchive: true }),
  ]);
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: "EEXIST" });
  expect((await readBundle(target)).manifest.name).toBe(sampleBundle().manifest.name);
});
