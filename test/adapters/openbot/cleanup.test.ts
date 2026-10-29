// The copy of the database is removed on a best effort: a folder that cannot be removed is left
// to the system, and neither hides the result of a read that worked nor the error of one that
// did not. `rm` is made to fail here; every other file operation is the real one.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenBotDatabase } from "../../helpers/openbot-db.js";

type Db = typeof import("../../../src/adapters/openbot/db.js");

let root: string;
let userData: string;
let leftBehind: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-openbot-cleanup-"));
  userData = join(root, "OpenBot");
  leftBehind = [];
  await buildOpenBotDatabase(userData);
});
afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  for (const folder of [root, ...leftBehind]) {
    await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

/**
 * The real paths of `paths`: SQLite reports the resolved path of the copy (on macOS
 * `/private/var/...`), `tmpdir()` the one that goes through a link (`/var/...`). The folders are
 * still there, since their removal failed.
 */
const real = (paths: readonly string[]): Promise<string[]> =>
  Promise.all(paths.map((path) => realpath(path)));

/** A copy of `db.ts` whose `rm` always fails with `EBUSY`. */
async function dbWithFailingRm(): Promise<{ db: Db; removals: string[] }> {
  const removals: string[] = [];
  vi.resetModules();
  vi.doMock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
      ...actual,
      rm: async (path: string) => {
        removals.push(path);
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), {
          code: "EBUSY",
        });
      },
    };
  });
  return { db: await import("../../../src/adapters/openbot/db.js"), removals };
}

describe("withDatabaseCopy when the copy cannot be removed", () => {
  it("still returns what was read", async () => {
    const { db, removals } = await dbWithFailingRm();
    const agents = await db.withDatabaseCopy(userData, (connection) => {
      leftBehind.push(dirname(connection.location() ?? root));
      return db.readDbAgents(connection);
    });

    expect(agents.map(({ id }) => id)).toEqual(["ada", "min"]);
    // It did try to remove the folder of the copy, and nothing else.
    expect(removals).toHaveLength(1);
    expect(await real(removals)).toEqual(await real(leftBehind));
  });

  it("still reports the error of a read that failed, not the one of the removal", async () => {
    const { db, removals } = await dbWithFailingRm();
    await expect(
      db.withDatabaseCopy(userData, (connection) => {
        leftBehind.push(dirname(connection.location() ?? root));
        throw new Error("reading failed");
      }),
    ).rejects.toThrow("reading failed");
    expect(removals).toHaveLength(1);
    expect(await real(removals)).toEqual(await real(leftBehind));
  });
});
