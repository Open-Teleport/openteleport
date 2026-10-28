// Zips a folder the way a `.jetpack` is zipped, for tests that need an archive of a fixture or of
// a tree they built: `/`-separated paths, files only (no entry for a folder), and a fixed time
// so that the same tree always gives the same bytes.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

const MTIME = new Date("2026-01-01T00:00:00.000Z");

/** Every file below `dir`, in path order, zipped. Links and other special files are left out. */
export async function zipDirectory(dir: string): Promise<Uint8Array> {
  const paths: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) paths.push(relative(dir, join(entry.parentPath, entry.name)));
  }
  const files: Record<string, Uint8Array> = {};
  for (const path of paths.sort()) {
    files[path.split(sep).join("/")] = new Uint8Array(await readFile(join(dir, path)));
  }
  return zipSync(files, { mtime: MTIME });
}

/** `zipDirectory(dir)` written to `file`; resolves to `file`. */
export async function zipDirectoryToFile(dir: string, file: string): Promise<string> {
  await writeFile(file, await zipDirectory(dir));
  return file;
}
