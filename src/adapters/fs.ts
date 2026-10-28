// Small file system checks every file-based adapter needs.
import { type Stats, constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ulid } from "ulid";
import { isSafeArchivePath } from "../core/paths.js";

/**
 * `lstat`, or `undefined` when nothing is there (the path is missing, or something on the way to
 * it is a file, not a folder). A symbolic link is not followed: it is what `lstat` answers for.
 * Any other error, such as a refused permission, is thrown.
 */
export async function lstatIfAny(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/**
 * Replaces `file` in one step: the content goes to a temporary sibling in the same folder, which
 * is then renamed over it. The file is never left half written, a reader of it sees the old
 * content or the new, and a link in its place is replaced rather than written through (the
 * temporary file is created exclusively, so a link at its name is not followed either). The
 * folder is made when it is not there; the temporary file is removed when anything fails.
 *
 * `mode` sets the permission bits exactly (what `writeFile` is given is narrowed by the umask);
 * without it the file gets the default ones.
 */
export async function replaceFile(
  file: string,
  content: string | Uint8Array,
  opts: { mode?: number } = {},
): Promise<void> {
  const temporary = `${file}.${ulid()}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, content, {
      flag: "wx",
      ...(opts.mode === undefined ? {} : { mode: opts.mode }),
    });
    if (opts.mode !== undefined) await chmod(temporary, opts.mode);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Copies `file` next to itself as `<file>.bak-<stamp>`, or `<file>.bak-<stamp>-2` and so on:
 * never over an earlier backup.
 */
export async function backUp(file: string, stamp: string): Promise<void> {
  for (let n = 1; ; n += 1) {
    const backup = `${file}.bak-${stamp}${n === 1 ? "" : `-${n}`}`;
    try {
      await copyFile(file, backup, constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** A name that is one safe path segment: it cannot reach outside the directory it is put in. */
export const isSafeName = (name: string): boolean =>
  isSafeArchivePath(name) && !name.includes("/");
