import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ulid } from "ulid";
import type { Bundle } from "./schema.js";

/** Same rule as the manifest `id` in `schema.ts`. */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Where an agent comes from: the app and that app's own id or name for it. */
export type IdKey = { app: string; agentId: string };

const cachePath = (home: string): string => resolve(join(home, ".openteleport", "ids.json"));

/** `entries` maps `"<app>/<agentId>"` to a ULID; `corrupt` marks a file that holds no cache. */
type Cache = { entries: Map<string, string>; corrupt: boolean };

/**
 * Reads the cache. A missing file is an empty cache. A file that is not JSON, or is JSON but not
 * an object, is corrupt: also empty, and moved aside before it is replaced. Any other read error
 * (permissions, a Windows lock, too many open files) is thrown, so a cache that exists but cannot
 * be read right now is never overwritten. An entry whose value is not a ULID is dropped.
 */
async function readCache(path: string): Promise<Cache> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: new Map(), corrupt: false };
    }
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error) {
    if (error instanceof SyntaxError) return { entries: new Map(), corrupt: true };
    throw error;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { entries: new Map(), corrupt: true };
  }
  const entries = Object.entries(json).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && ULID_PATTERN.test(entry[1]),
  );
  return { entries: new Map(entries), corrupt: false };
}

/** Keeps a corrupt cache as `ids.json.corrupt-<time>` next to it instead of destroying it. */
async function moveAside(path: string): Promise<void> {
  await rename(path, `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`);
}

/**
 * Replaces the cache file in one step: the new content goes to a sibling temporary file created
 * owner-only (`0o600`; Windows ignores the mode), which is then renamed over `ids.json`. A crash
 * or a full disk leaves either the old file or the new one, never a truncated one, and the
 * rename carries the owner-only mode over an older, wider one.
 */
async function replaceCache(path: string, entries: Map<string, string>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${ulid()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The last queued update of each cache file in this process; see `serialized`. */
const queues = new Map<string, Promise<void>>();

/**
 * Runs `task` after every earlier task queued for `path` has settled, so read-modify-write
 * updates of one cache never interleave inside this process. Separate processes are not locked
 * against each other: the last write wins, which can lose only ids first assigned while both
 * were running.
 */
function serialized<T>(path: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(path) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(path, settled);
  void settled.then(() => {
    if (queues.get(path) === settled) queues.delete(path);
  });
  return run;
}

/**
 * Returns a copy of `bundle` whose manifest has an `id`. A bundle that already has one keeps it
 * and the cache is not touched. Otherwise the id comes from `<home>/.openteleport/ids.json` under
 * `"<app>/<agentId>"`, and a new ULID is recorded there the first time a key is seen, so the
 * same agent of the same app gets the same id on every export.
 */
export async function ensureId(bundle: Bundle, key: IdKey, home: string): Promise<Bundle> {
  if (bundle.manifest.id !== "") return { ...bundle, manifest: { ...bundle.manifest } };

  const path = cachePath(home);
  const id = await serialized(path, async () => {
    const cache = await readCache(path);
    const cacheKey = `${key.app}/${key.agentId}`;
    const known = cache.entries.get(cacheKey);
    if (known !== undefined) return known;

    const fresh = ulid();
    cache.entries.set(cacheKey, fresh);
    if (cache.corrupt) await moveAside(path);
    await replaceCache(path, cache.entries);
    return fresh;
  });
  return { ...bundle, manifest: { ...bundle.manifest, id } };
}
