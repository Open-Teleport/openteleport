// Small file system checks every file-based adapter needs.
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
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

/** A name that is one safe path segment: it cannot reach outside the directory it is put in. */
export const isSafeName = (name: string): boolean =>
  isSafeArchivePath(name) && !name.includes("/");
