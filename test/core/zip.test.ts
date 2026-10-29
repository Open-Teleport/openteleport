import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ARCHIVE_BYTES, MAX_TEXT_ENTRY_BYTES } from "../../src/core/paths.js";
import {
  type ZipEntryKind,
  type ZipPolicy,
  readZipEntries,
  unzipOrThrow,
} from "../../src/core/zip.js";
import { zipDirectory, zipDirectoryToFile } from "../helpers/zip.js";

const ADA_DIR = fileURLToPath(new URL("../fixtures/jetpack/ada", import.meta.url));

const encoder = new TextEncoder();
const bytes = (content: string): Uint8Array => encoder.encode(content);
const decoder = new TextDecoder();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-zip-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Listing = { path: string; size: number };

/**
 * A policy that sorts paths by the `kinds` table (`unknown` for any path not in it) and keeps
 * what it was asked: every path `kindOf` saw and every listing `validate` got.
 */
function policyOf(kinds: Record<string, ZipEntryKind>, validate?: (listing: Listing[]) => void) {
  const asked: string[] = [];
  const listings: Listing[][] = [];
  const policy: ZipPolicy = {
    kindOf: (path) => {
      asked.push(path);
      return kinds[path] ?? "unknown";
    },
    validate: (listing) => {
      listings.push(listing.map(({ path, size }) => ({ path, size })));
      validate?.(listings.at(-1) ?? []);
    },
  };
  return { policy, asked, listings };
}

/** Writes `archive` to a file of the temp folder; resolves to its path. */
async function archiveFile(archive: Uint8Array, name = "x.zip"): Promise<string> {
  const file = join(root, name);
  await writeFile(file, archive);
  return file;
}

async function read(archive: Uint8Array, policy: ZipPolicy) {
  return readZipEntries(await archiveFile(archive), archive.length, policy);
}

/**
 * Damages the deflate stream of the first entry of `archive` (a block of the reserved type), so
 * that inflating it fails and nothing else about the archive changes.
 */
function breakFirstEntry(archive: Uint8Array): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  const dataAt = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const broken = archive.slice();
  broken[dataAt] = 0x07;
  return broken;
}

/** A well-compressible entry, so that the archive deflates it. */
const filler = (): Uint8Array => bytes("lorem ipsum ".repeat(400));

const byPath = (entries: { path: string }[]): string[] => entries.map(({ path }) => path).sort();

describe("readZipEntries", () => {
  it("returns the entries of the kinds text and file with their content", async () => {
    const archive = zipSync({ "a.md": bytes("Alpha\n"), "files/b.csv": bytes("b\n") });
    const { policy } = policyOf({ "a.md": "text", "files/b.csv": "file" });

    const entries = await read(archive, policy);

    expect(byPath(entries)).toEqual(["a.md", "files/b.csv"]);
    expect(decoder.decode(entries.find(({ path }) => path === "a.md")?.bytes)).toBe("Alpha\n");
    expect(decoder.decode(entries.find(({ path }) => path === "files/b.csv")?.bytes)).toBe("b\n");
  });

  it("gives an entry of the kind unknown empty bytes without inflating it", async () => {
    // The first entry's deflate stream is damaged: inflating it would fail.
    const archive = breakFirstEntry(
      zipSync({ "other/blob.bin": [filler(), { level: 6 }], "a.md": bytes("Alpha\n") }),
    );
    const { policy } = policyOf({ "a.md": "text" });

    const entries = await read(archive, policy);

    expect(entries.find(({ path }) => path === "other/blob.bin")?.bytes).toEqual(
      new Uint8Array(0),
    );
    expect(decoder.decode(entries.find(({ path }) => path === "a.md")?.bytes)).toBe("Alpha\n");
    expect(entries).toHaveLength(2);
  });

  it("does inflate the same damaged entry when the policy has a use for it", async () => {
    const archive = breakFirstEntry(zipSync({ "other/blob.bin": [filler(), { level: 6 }] }));
    const { policy } = policyOf({ "other/blob.bin": "text" });

    await expect(read(archive, policy)).rejects.toThrow(/x\.zip is not a valid zip archive: /);
  });

  it("asks the policy about each path once", async () => {
    const archive = zipSync({
      "a.md": bytes("a"),
      "files/b.csv": bytes("b"),
      "other/c.bin": bytes("c"),
    });
    const { policy, asked } = policyOf({ "a.md": "text", "files/b.csv": "file" });

    await read(archive, policy);

    expect([...asked].sort()).toEqual(["a.md", "files/b.csv", "other/c.bin"]);
  });

  it("leaves directory entries out of the listing and of the result", async () => {
    const archive = zipSync({ "dir/": new Uint8Array(0), "dir/a.md": bytes("a") });
    const { policy, listings } = policyOf({ "dir/a.md": "text" });

    const entries = await read(archive, policy);

    expect(byPath(entries)).toEqual(["dir/a.md"]);
    expect(listings).toEqual([[{ path: "dir/a.md", size: 1 }]]);
  });

  it("gives the policy the whole listing, with the sizes the archive declares", async () => {
    const archive = zipSync({
      "a.md": bytes("Alpha\n"),
      "files/b.csv": bytes("b"),
      "other/c.bin": filler(),
    });
    const { policy, listings } = policyOf({ "a.md": "text", "files/b.csv": "file" });

    await read(archive, policy);

    expect(listings).toHaveLength(1);
    expect([...(listings[0] ?? [])].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "a.md", size: 6 },
      { path: "files/b.csv", size: 1 },
      { path: "other/c.bin", size: filler().length },
    ]);
  });

  it("stops at what the policy throws, before anything is inflated", async () => {
    // Inflating the first entry would fail with another message.
    const archive = breakFirstEntry(zipSync({ "a.md": [filler(), { level: 6 }] }));
    const { policy } = policyOf({ "a.md": "text" }, () => {
      throw new Error("too many things");
    });

    await expect(read(archive, policy)).rejects.toThrow(/^too many things$/);
  });

  it("refuses an entry of the kind text over MAX_TEXT_ENTRY_BYTES compressed", async () => {
    // Random bytes do not compress, so the stream is as large as the entry.
    const archive = zipSync({ "big.md": randomBytes(MAX_TEXT_ENTRY_BYTES + 1024) });
    const { policy } = policyOf({ "big.md": "text" });

    await expect(read(archive, policy)).rejects.toThrow(
      /^big\.md is \d+ bytes compressed, over the 2097152 byte limit for entries outside files\/$/,
    );
  });

  it("lets an entry of the kind file be as large compressed", async () => {
    const data = randomBytes(MAX_TEXT_ENTRY_BYTES + 1024);
    const archive = zipSync({ "files/big.bin": data });
    const { policy } = policyOf({ "files/big.bin": "file" });

    const entries = await read(archive, policy);

    expect(entries).toHaveLength(1);
    expect(Buffer.from(entries[0]?.bytes ?? new Uint8Array(0)).equals(data)).toBe(true);
  });

  it("refuses a stored entry that declares a size other than its own", async () => {
    const archive = zipSync({ "a.md": [bytes("x".repeat(100)), { level: 0 }] });
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let central = -1;
    for (let at = 0; at + 4 <= archive.length; at += 1) {
      if (view.getUint32(at, true) === 0x02014b50) central = at;
    }
    expect(central).toBeGreaterThan(0);
    view.setUint32(central + 24, 5, true); // the size the central directory declares
    const { policy } = policyOf({ "a.md": "text" });

    await expect(read(archive, policy)).rejects.toThrow(
      /^a\.md is stored with 100 bytes but declares a size of 5 bytes$/,
    );
  });

  it("refuses an archive file over MAX_ARCHIVE_BYTES without reading it", async () => {
    const { policy, listings, asked } = policyOf({});

    await expect(
      readZipEntries(join(root, "never-read.zip"), MAX_ARCHIVE_BYTES + 1, policy),
    ).rejects.toThrow(
      `${join(root, "never-read.zip")} is ${MAX_ARCHIVE_BYTES + 1} bytes, over the ${MAX_ARCHIVE_BYTES} byte limit`,
    );
    expect(listings).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("names the file when it is not a zip", async () => {
    const file = await archiveFile(bytes("this is not a zip file"), "plain.zip");
    const { policy } = policyOf({});

    await expect(readZipEntries(file, 22, policy)).rejects.toThrow(
      `${file} is not a valid zip archive: `,
    );
  });
});

describe("unzipOrThrow", () => {
  it("names the archive and the reason when unzipping fails", () => {
    expect(() =>
      unzipOrThrow("x.zip", () => {
        throw new Error("bad");
      }),
    ).toThrow("x.zip is not a valid zip archive: bad");
  });

  it("keeps the failure as the cause", () => {
    const failure = new Error("bad");
    let thrown: unknown;
    try {
      unzipOrThrow("x.zip", () => {
        throw failure;
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).cause).toBe(failure);
  });

  it("returns what the function returns", () => {
    expect(unzipOrThrow("x.zip", () => 42)).toBe(42);
  });
});

describe("zipDirectory (test helper)", () => {
  it("zips the files of a folder under their `/`-separated paths, without folder entries", async () => {
    const dir = join(root, "tree");
    await mkdir(join(dir, "skills", "web-brief"), { recursive: true });
    await writeFile(join(dir, "AGENTS.md"), "Hello\n");
    await writeFile(join(dir, "skills", "web-brief", "SKILL.md"), "# Web brief\n");

    const entries = unzipSync(await zipDirectory(dir));

    expect(Object.keys(entries).sort()).toEqual(["AGENTS.md", "skills/web-brief/SKILL.md"]);
    expect(decoder.decode(entries["skills/web-brief/SKILL.md"])).toBe("# Web brief\n");
  });

  it("gives the same bytes for the same tree", async () => {
    const dir = join(root, "tree");
    await mkdir(dir);
    await writeFile(join(dir, "b.md"), "B\n");
    await writeFile(join(dir, "a.md"), "A\n");

    expect(await zipDirectory(dir)).toEqual(await zipDirectory(dir));
  });

  it("writes the archive to a file and says where", async () => {
    const dir = join(root, "tree");
    await mkdir(dir);
    await writeFile(join(dir, "a.md"), "A\n");
    const file = join(root, "tree.jetpack");

    expect(await zipDirectoryToFile(dir, file)).toBe(file);
    expect(Object.keys(unzipSync(new Uint8Array(await readFile(file))))).toEqual(["a.md"]);
  });

  it("zips a fixture so that readZipEntries gives its files back", async () => {
    const file = await zipDirectoryToFile(ADA_DIR, join(root, "ada.zip"));
    const everything: ZipPolicy = { kindOf: () => "text", validate: () => undefined };

    const entries = await readZipEntries(file, (await readFile(file)).length, everything);

    expect(byPath(entries)).toContain("jetpack.json");
    const instructions = entries.find(({ path }) => path === "AGENTS.md");
    expect(Buffer.from(instructions?.bytes ?? new Uint8Array(0)).equals(
      await readFile(join(ADA_DIR, "AGENTS.md")),
    )).toBe(true);
  });
});
