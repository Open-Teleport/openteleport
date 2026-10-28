// Reading a zip archive without trusting it. The central directory is read first, so that unsafe
// names and sizes over the limits are rejected before any content is inflated; what counts as a
// safe listing, and which entries are worth inflating at all, is the caller's `ZipPolicy`.
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { MAX_ARCHIVE_BYTES, MAX_TEXT_ENTRY_BYTES } from "./paths.js";
import type { FileEntry } from "./schema.js";

/**
 * What an entry is to the reader: `text` is read and is small (at most `MAX_TEXT_ENTRY_BYTES`
 * compressed), `file` is read and may be large, `unknown` is listed but never inflated.
 */
export type ZipEntryKind = "text" | "file" | "unknown";

export type ZipPolicy = {
  kindOf(path: string): ZipEntryKind;
  /**
   * Called with every entry the archive lists (directory entries left out) and the size it
   * declares, before anything is inflated. Throws to reject the archive.
   */
  validate(listing: readonly { path: string; size: number }[]): void;
};

/** Runs `run`, which unzips `source`, and says which archive it was when that fails. */
export function unzipOrThrow<T>(source: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new Error(`${source} is not a valid zip archive: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

const isDirectoryEntry = (name: string): boolean => name.endsWith("/");

/** What the central directory of a zip says about a file: sizes are declared, not verified. */
type ZipRecord = {
  path: string;
  size: number;
  compressedSize: number;
  stored: boolean;
  kind: ZipEntryKind;
};

/**
 * Checks the compressed sizes a zip declares, which a policy's `validate` does not see. They
 * cannot be trusted: records may point at the same data, and fflate copies the compressed size
 * of a stored entry whatever uncompressed size is declared. So the compressed sizes together are
 * at most the file, a stored entry's size equals its declared size, and an entry of the kind
 * `text` is at most `MAX_TEXT_ENTRY_BYTES` compressed, which also bounds the time spent
 * inflating it.
 */
function validateZipRecords(
  source: string,
  records: readonly ZipRecord[],
  archiveBytes: number,
): void {
  const compressedBytes = records.reduce((sum, record) => sum + record.compressedSize, 0);
  if (compressedBytes > archiveBytes) {
    throw new Error(
      `${source} declares ${compressedBytes} bytes of compressed data in a file of ` +
        `${archiveBytes} bytes`,
    );
  }
  for (const { path, size, compressedSize, stored, kind } of records) {
    if (stored && compressedSize !== size) {
      throw new Error(
        `${path} is stored with ${compressedSize} bytes but declares a size of ${size} bytes`,
      );
    }
    if (kind === "text" && compressedSize > MAX_TEXT_ENTRY_BYTES) {
      throw new Error(
        `${path} is ${compressedSize} bytes compressed, over the ${MAX_TEXT_ENTRY_BYTES} byte ` +
          "limit for entries outside files/",
      );
    }
  }
}

/** Content of an entry that is only listed: it is not inflated, so it has no bytes. */
const unreadBytes = (): Uint8Array => new Uint8Array(0);

/**
 * The entries of the zip archive `source`, which is `archiveBytes` long. The central directory
 * is read first and checked (`policy.validate` and the compressed sizes); then the entries the
 * policy does not call `unknown` are inflated, and the others are returned with empty bytes.
 * Throws for an archive over `MAX_ARCHIVE_BYTES`, one the policy rejects, and one that is not
 * a valid zip.
 */
export async function readZipEntries(
  source: string,
  archiveBytes: number,
  policy: ZipPolicy,
): Promise<FileEntry[]> {
  if (archiveBytes > MAX_ARCHIVE_BYTES) {
    throw new Error(`${source} is ${archiveBytes} bytes, over the ${MAX_ARCHIVE_BYTES} byte limit`);
  }
  const archive = await readFile(source);

  // First pass: read the central directory only, so that unsafe names and sizes that are over
  // the limits are rejected before any of the content is inflated.
  const declared: Omit<ZipRecord, "kind">[] = [];
  unzipOrThrow(source, () =>
    unzipSync(archive, {
      filter: ({ name, size, originalSize, compression }) => {
        if (!isDirectoryEntry(name)) {
          declared.push({
            path: name,
            size: originalSize,
            compressedSize: size,
            stored: compression === 0,
          });
        }
        return false;
      },
    }),
  );
  const records: ZipRecord[] = declared.map((record) => ({
    ...record,
    kind: policy.kindOf(record.path),
  }));
  policy.validate(records.map(({ path, size }) => ({ path, size })));
  validateZipRecords(source, records, archiveBytes);

  // Second pass: inflate the entries the policy wants. What the first pass bounded is what
  // fflate works from: the declared uncompressed size, which sizes its buffer for a deflated
  // entry; the compressed size, which is how much it copies for a stored entry (equal to the
  // declared size) and how much it inflates otherwise (at most the file, and at most 2 MB for
  // an entry of the kind `text`).
  const wanted = new Set(records.filter(({ kind }) => kind !== "unknown").map(({ path }) => path));
  const inflated = unzipOrThrow(source, () =>
    unzipSync(archive, { filter: ({ name }) => wanted.has(name) }),
  );
  const entries: FileEntry[] = Object.entries(inflated).map(([path, bytes]) => ({ path, bytes }));
  for (const { path, kind } of records) {
    if (kind === "unknown") entries.push({ path, bytes: unreadBytes() });
  }
  return entries;
}
