import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";
import type { Bundle } from "./schema.js";

/** Same rule as the manifest `id` in `schema.ts`. */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Where an agent comes from: the app and that app's own id or name for it. */
export type IdKey = { app: string; agentId: string };

const cachePath = (home: string): string => join(home, ".openteleport", "ids.json");

/**
 * The cache as a map of `"<app>/<agentId>"` to ULID. A missing, unreadable or malformed file is
 * an empty cache, and an entry whose value is not a ULID is dropped: losing an id only means the
 * next export assigns a new one, while a broken cache must never stop a move.
 */
async function readCache(home: string): Promise<Map<string, string>> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(cachePath(home), "utf8"));
  } catch {
    return new Map();
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return new Map();
  return new Map(
    Object.entries(json).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && ULID_PATTERN.test(entry[1]),
    ),
  );
}

async function writeCache(home: string, cache: Map<string, string>): Promise<void> {
  await mkdir(join(home, ".openteleport"), { recursive: true });
  // The mode applies when the file is created; Windows ignores it.
  await writeFile(cachePath(home), `${JSON.stringify(Object.fromEntries(cache), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * Returns a copy of `bundle` whose manifest has an `id`. A bundle that already has one keeps it
 * and the cache is not touched. Otherwise the id comes from `<home>/.openteleport/ids.json` under
 * `"<app>/<agentId>"`, and a new ULID is recorded there the first time a key is seen, so the
 * same agent of the same app gets the same id on every export.
 */
export async function ensureId(bundle: Bundle, key: IdKey, home: string): Promise<Bundle> {
  if (bundle.manifest.id !== "") return { ...bundle, manifest: { ...bundle.manifest } };

  const cache = await readCache(home);
  const cacheKey = `${key.app}/${key.agentId}`;
  let id = cache.get(cacheKey);
  if (id === undefined) {
    id = ulid();
    cache.set(cacheKey, id);
    await writeCache(home, cache);
  }
  return { ...bundle, manifest: { ...bundle.manifest, id } };
}
