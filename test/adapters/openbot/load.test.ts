// How `loadSqlite` imports `node:sqlite`: what it holds back while it does, what it restores, and
// what it does when there is no such module. The module is mocked here, so each test gets a copy
// of `db.ts` with a fresh state (`vi.resetModules`) and decides what the import does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSqliteNotice } from "../../../src/adapters/openbot/db.js";

type Db = typeof import("../../../src/adapters/openbot/db.js");

const NOT_AVAILABLE = "node:sqlite is not available; use Node 24 or pass --source-dir <export.zip>";
const NOTICE = "SQLite is an experimental feature and might change at any time";

/** A copy of `db.ts` that has not loaded anything yet. */
async function freshDb(): Promise<Db> {
  vi.resetModules();
  return import("../../../src/adapters/openbot/db.js");
}

afterEach(() => {
  vi.doUnmock("node:sqlite");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("isSqliteNotice", () => {
  it("knows Node's notice, in each way a warning can be emitted", () => {
    expect(isSqliteNotice(NOTICE, ["ExperimentalWarning"])).toBe(true);
    expect(isSqliteNotice(NOTICE, [{ type: "ExperimentalWarning" }])).toBe(true);
    const error = new Error(NOTICE);
    error.name = "ExperimentalWarning";
    expect(isSqliteNotice(error, [])).toBe(true);
  });

  it("lets anything else through", () => {
    // The same text under another type, another feature under the same type, and no type at all.
    expect(isSqliteNotice(NOTICE, ["DeprecationWarning"])).toBe(false);
    expect(isSqliteNotice(NOTICE, [])).toBe(false);
    expect(isSqliteNotice(NOTICE, [{ code: "X" }])).toBe(false);
    expect(isSqliteNotice("Fetch is an experimental feature", ["ExperimentalWarning"])).toBe(false);
    expect(isSqliteNotice("Fetch is an experimental feature", [{ type: "ExperimentalWarning" }])).toBe(
      false,
    );
    expect(isSqliteNotice(new Error("something else"), [])).toBe(false);
  });
});

describe("loadSqlite", () => {
  it("holds back Node's notice while the module loads, passes other warnings on and restores emitWarning", async () => {
    const passedOn: unknown[] = [];
    const original = vi.spyOn(process, "emitWarning").mockImplementation((warning: unknown) => {
      passedOn.push(warning);
    });
    vi.doMock("node:sqlite", () => {
      // What Node does while it loads the module, and an unrelated warning at the same time.
      process.emitWarning(NOTICE, "ExperimentalWarning");
      process.emitWarning("something else is going on", "Warning");
      return { DatabaseSync: class {} };
    });
    const { loadSqlite } = await freshDb();

    const sqlite = await loadSqlite();

    expect(typeof sqlite.DatabaseSync).toBe("function");
    expect(passedOn).toEqual(["something else is going on"]);
    // The function that stood there before is back, not the filter.
    expect(process.emitWarning).toBe(original);
  });

  it("imports once for callers that ask at the same time", async () => {
    let imports = 0;
    vi.doMock("node:sqlite", () => {
      imports += 1;
      return { DatabaseSync: class {} };
    });
    const { loadSqlite } = await freshDb();

    const [first, second] = await Promise.all([loadSqlite(), loadSqlite()]);

    expect(second).toBe(first);
    expect(imports).toBe(1);
  });

  it("says node:sqlite is not available when the import fails, and restores emitWarning", async () => {
    const cause = new Error("No such built-in module: node:sqlite");
    vi.doMock("node:sqlite", () => {
      throw cause;
    });
    const { loadSqlite } = await freshDb();
    const before = process.emitWarning;

    const failure = await loadSqlite().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(NOT_AVAILABLE);
    expect(process.emitWarning).toBe(before);
  });

  it("forgets a failed import, so that a later call tries again", async () => {
    vi.doMock("node:sqlite", () => {
      throw new Error("No such built-in module: node:sqlite");
    });
    const { loadSqlite } = await freshDb();
    await expect(loadSqlite()).rejects.toThrow(NOT_AVAILABLE);

    // The module is there after all: a cached failure would answer the same again.
    vi.doUnmock("node:sqlite");
    vi.doMock("node:sqlite", () => ({ DatabaseSync: class {} }));
    const sqlite = await loadSqlite();

    expect(typeof sqlite.DatabaseSync).toBe("function");
  });
});
