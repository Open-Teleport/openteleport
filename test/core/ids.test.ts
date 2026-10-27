import fsPromises, {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureId } from "../../src/core/ids.js";
import type { Bundle } from "../../src/core/schema.js";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const KNOWN_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";

const bundleWithId = (id: string): Bundle => ({
  manifest: { schemaVersion: "0.1", id, name: "Ada", models: [], capabilities: [] },
  instructions: "Be brief.\n",
  skills: [],
  routines: [],
  facts: [],
  notes: [],
  files: [],
  unknownPaths: [],
});

let home: string;
let cachePath: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "openteleport-ids-"));
  cachePath = join(home, ".openteleport", "ids.json");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const readCache = async (): Promise<unknown> => JSON.parse(await readFile(cachePath, "utf8"));

const writeCache = async (content: string): Promise<void> => {
  await mkdir(join(home, ".openteleport"), { recursive: true });
  await writeFile(cachePath, content);
};

const cacheDirEntries = async (): Promise<string[]> =>
  (await readdir(join(home, ".openteleport"))).sort();

const errnoError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: simulated`), { code });

/**
 * Runs `body` while `fsPromises[name]` fails with `code` for paths under the cache directory.
 * ids.ts imports these functions by name; syncBuiltinESMExports makes the spy visible to it.
 */
async function failing<T>(
  name: "readFile" | "rename",
  code: string,
  body: () => Promise<T>,
): Promise<T> {
  const original = fsPromises[name] as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(fsPromises, name).mockImplementation(((...args: unknown[]) =>
    String(args[0]).includes(".openteleport")
      ? Promise.reject(errnoError(code))
      : original(...args)) as never);
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
}

describe("ensureId", () => {
  it("gives the same key the same id", async () => {
    const key = { app: "src", agentId: "ada" };
    const first = await ensureId(bundleWithId(""), key, home);
    const second = await ensureId(bundleWithId(""), key, home);

    expect(first.manifest.id).toMatch(ULID);
    expect(second.manifest.id).toBe(first.manifest.id);
    expect(await readCache()).toEqual({ "src/ada": first.manifest.id });
  });

  it("gives different keys different ids", async () => {
    const ada = await ensureId(bundleWithId(""), { app: "src", agentId: "ada" }, home);
    const bob = await ensureId(bundleWithId(""), { app: "src", agentId: "bob" }, home);
    const otherApp = await ensureId(bundleWithId(""), { app: "dst", agentId: "ada" }, home);

    expect(new Set([ada.manifest.id, bob.manifest.id, otherApp.manifest.id]).size).toBe(3);
    expect(await readCache()).toEqual({
      "src/ada": ada.manifest.id,
      "src/bob": bob.manifest.id,
      "dst/ada": otherApp.manifest.id,
    });
    expect(await cacheDirEntries()).toEqual(["ids.json"]);
  });

  it("records every id when called concurrently", async () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const bundles = await Promise.all(
      names.map((agentId) => ensureId(bundleWithId(""), { app: "src", agentId }, home)),
    );

    expect(await readCache()).toEqual(
      Object.fromEntries(names.map((agentId, i) => [`src/${agentId}`, bundles[i]!.manifest.id])),
    );
  });

  it("uses an id recorded earlier", async () => {
    await writeCache(JSON.stringify({ "src/ada": KNOWN_ID }));
    const bundle = await ensureId(bundleWithId(""), { app: "src", agentId: "ada" }, home);
    expect(bundle.manifest.id).toBe(KNOWN_ID);
  });

  it("returns a new bundle and leaves its argument alone", async () => {
    const original = bundleWithId("");
    const result = await ensureId(original, { app: "src", agentId: "ada" }, home);

    expect(result).not.toBe(original);
    expect(original.manifest.id).toBe("");
    expect(result).toEqual({
      ...original,
      manifest: { ...original.manifest, id: result.manifest.id },
    });
  });

  it("keeps an id the bundle already has and does not touch the cache", async () => {
    const original = bundleWithId(KNOWN_ID);
    const result = await ensureId(original, { app: "src", agentId: "ada" }, home);

    expect(result.manifest.id).toBe(KNOWN_ID);
    await expect(stat(cachePath)).rejects.toThrow();
  });

  it.each([
    ["broken JSON", "{not json"],
    ["an array", "[]"],
    ["a string", '"ids"'],
    ["null", "null"],
  ])("moves a cache holding %s aside and starts a new one", async (_label, content) => {
    await writeCache(content);

    const bundle = await ensureId(bundleWithId(""), { app: "src", agentId: "ada" }, home);

    expect(bundle.manifest.id).toMatch(ULID);
    expect(await readCache()).toEqual({ "src/ada": bundle.manifest.id });
    const entries = await cacheDirEntries();
    expect(entries).toHaveLength(2);
    const aside = entries.find((name) => name.startsWith("ids.json.corrupt-"));
    expect(aside).toBeDefined();
    expect(await readFile(join(home, ".openteleport", aside!), "utf8")).toBe(content);
  });

  it("surfaces a read error other than a missing file and keeps the cache", async () => {
    await writeCache(JSON.stringify({ "src/bob": KNOWN_ID }));

    await expect(
      failing("readFile", "EACCES", () =>
        ensureId(bundleWithId(""), { app: "src", agentId: "ada" }, home),
      ),
    ).rejects.toMatchObject({ code: "EACCES" });

    expect(await readCache()).toEqual({ "src/bob": KNOWN_ID });
    expect(await cacheDirEntries()).toEqual(["ids.json"]);
  });

  it("leaves the cache whole when replacing it fails", async () => {
    await writeCache(JSON.stringify({ "src/bob": KNOWN_ID }));

    await expect(
      failing("rename", "EIO", () =>
        ensureId(bundleWithId(""), { app: "src", agentId: "ada" }, home),
      ),
    ).rejects.toMatchObject({ code: "EIO" });

    expect(await readCache()).toEqual({ "src/bob": KNOWN_ID });
    expect(await cacheDirEntries()).toEqual(["ids.json"]);
  });

  it("drops entries that are not ULIDs and keeps the rest", async () => {
    await writeCache(JSON.stringify({ "src/ada": "not-an-id", "src/bob": KNOWN_ID }));

    const bundle = await ensureId(bundleWithId(""), { app: "src", agentId: "ada" }, home);

    expect(bundle.manifest.id).toMatch(ULID);
    expect(await readCache()).toEqual({ "src/bob": KNOWN_ID, "src/ada": bundle.manifest.id });
  });

  it.skipIf(process.platform === "win32")("creates the cache for its owner only", async () => {
    await ensureId(bundleWithId(""), { app: "src", agentId: "ada" }, home);
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("makes a replaced cache owner-only", async () => {
    await writeCache(JSON.stringify({ "src/bob": KNOWN_ID }));
    await chmod(cachePath, 0o644);

    await ensureId(bundleWithId(""), { app: "src", agentId: "ada" }, home);

    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });
});
