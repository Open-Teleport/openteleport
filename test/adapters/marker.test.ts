import { mkdir, mkdtemp, lstat, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MARKER_FILE,
  carriesMarker,
  readIds,
  readMarker,
  recordId,
  renderMarker,
  writeMarker,
} from "../../src/adapters/marker.js";

const ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
const OTHER_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2V";
const MOVED_AT = "2026-10-27T09:15:00.000Z";

/** Whether this machine lets the tests create file symbolic links. */
const canSymlink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "openteleport-symlink-"));
  try {
    await writeFile(join(dir, "file"), "");
    await symlink(join(dir, "file"), join(dir, "file-link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-marker-"));
  dir = join(root, "workspace");
  await mkdir(dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const markerFile = (): string => join(dir, MARKER_FILE);
const text = (path: string): Promise<string> => readFile(path, "utf8");

describe("MARKER_FILE", () => {
  it("is the name every adapter has used since v0.1", () => {
    expect(MARKER_FILE).toBe(".openteleport.json");
  });
});

describe("readMarker", () => {
  it("returns the id and the time of a marker", async () => {
    await writeFile(markerFile(), JSON.stringify({ id: ID, movedAt: MOVED_AT }));

    expect(await readMarker(dir)).toEqual({ id: ID, movedAt: MOVED_AT });
  });

  it("keeps what else the marker holds", async () => {
    await writeFile(markerFile(), JSON.stringify({ id: ID, movedAt: MOVED_AT, slug: "ada" }));

    expect(await readMarker(dir)).toEqual({ id: ID, movedAt: MOVED_AT, slug: "ada" });
  });

  it("gives an empty time to a marker that has none", async () => {
    await writeFile(markerFile(), JSON.stringify({ id: ID }));

    expect(await readMarker(dir)).toEqual({ id: ID, movedAt: "" });
  });

  it("is undefined without a marker", async () => {
    expect(await readMarker(dir)).toBeUndefined();
  });

  it("is undefined when the folder itself is not there", async () => {
    expect(await readMarker(join(root, "nowhere"))).toBeUndefined();
  });

  it.each([
    ["is not JSON", "not json"],
    ["has a number for its id", JSON.stringify({ id: 5 })],
    ["has no id", JSON.stringify({ movedAt: MOVED_AT })],
    ["is an array", JSON.stringify([ID])],
    ["is null", "null"],
    ["is empty", ""],
  ])("is undefined for a marker that %s", async (_why, content) => {
    await writeFile(markerFile(), content);

    expect(await readMarker(dir)).toBeUndefined();
  });

  it("is undefined when a folder is where the marker should be", async () => {
    await mkdir(markerFile());

    expect(await readMarker(dir)).toBeUndefined();
  });

  it.skipIf(!canSymlink)("never reads a marker through a symbolic link", async () => {
    const real = join(root, "elsewhere.json");
    await writeFile(real, JSON.stringify({ id: ID, movedAt: MOVED_AT }));
    await symlink(real, markerFile(), "file");

    expect(await readMarker(dir)).toBeUndefined();
  });
});

describe("carriesMarker", () => {
  it("is true when the marker holds this id", async () => {
    await writeFile(markerFile(), renderMarker({ id: ID, movedAt: MOVED_AT }));

    expect(await carriesMarker(dir, ID)).toBe(true);
  });

  it("is false for the marker of another agent", async () => {
    await writeFile(markerFile(), renderMarker({ id: OTHER_ID, movedAt: MOVED_AT }));

    expect(await carriesMarker(dir, ID)).toBe(false);
  });

  it("is false without a marker", async () => {
    expect(await carriesMarker(dir, ID)).toBe(false);
  });

  it("is false for an empty id, even when the marker holds an empty one", async () => {
    await writeFile(markerFile(), JSON.stringify({ id: "", movedAt: MOVED_AT }));

    expect(await carriesMarker(dir, "")).toBe(false);
  });

  it.skipIf(!canSymlink)("is false for a marker behind a symbolic link", async () => {
    const real = join(root, "elsewhere.json");
    await writeFile(real, renderMarker({ id: ID, movedAt: MOVED_AT }));
    await symlink(real, markerFile(), "file");

    expect(await carriesMarker(dir, ID)).toBe(false);
  });
});

describe("renderMarker", () => {
  it("is JSON indented by two spaces with a final line break", () => {
    expect(renderMarker({ id: ID, movedAt: MOVED_AT })).toBe(
      `{\n  "id": "${ID}",\n  "movedAt": "${MOVED_AT}"\n}\n`,
    );
  });
});

describe("writeMarker", () => {
  it("writes the marker as renderMarker has it and leaves no other file", async () => {
    const marker = { id: ID, movedAt: MOVED_AT };

    await writeMarker(dir, marker);

    expect(await text(markerFile())).toBe(renderMarker(marker));
    expect(await readdir(dir)).toEqual([MARKER_FILE]);
  });

  it("replaces the marker of an earlier move in one file", async () => {
    await writeMarker(dir, { id: OTHER_ID, movedAt: "2026-01-01T00:00:00.000Z" });

    await writeMarker(dir, { id: ID, movedAt: MOVED_AT });

    expect(await readMarker(dir)).toEqual({ id: ID, movedAt: MOVED_AT });
    expect(await readdir(dir)).toEqual([MARKER_FILE]);
  });

  it("creates the folder when it is not there yet", async () => {
    const fresh = join(root, "fresh", "workspace");

    await writeMarker(fresh, { id: ID, movedAt: MOVED_AT });

    expect(await readMarker(fresh)).toEqual({ id: ID, movedAt: MOVED_AT });
  });

  it("refuses to write where a folder is, and leaves it as it was", async () => {
    await mkdir(markerFile());

    await expect(writeMarker(dir, { id: ID, movedAt: MOVED_AT })).rejects.toThrow(
      "is not a regular file",
    );

    expect((await lstat(markerFile())).isDirectory()).toBe(true);
    expect(await readdir(dir)).toEqual([MARKER_FILE]);
  });

  it.skipIf(!canSymlink)("never writes through a symbolic link", async () => {
    const real = join(root, "elsewhere.json");
    await writeFile(real, "KEEP\n");
    await symlink(real, markerFile(), "file");

    await expect(writeMarker(dir, { id: ID, movedAt: MOVED_AT })).rejects.toThrow(
      "is not a regular file",
    );

    expect(await text(real)).toBe("KEEP\n");
    expect((await lstat(markerFile())).isSymbolicLink()).toBe(true);
  });
});

describe("readIds", () => {
  const idsFile = (): string => join(root, "ids.json");

  it("reads the ids recorded in a file", async () => {
    await writeFile(idsFile(), JSON.stringify({ ada: ID, grace: OTHER_ID }));

    expect(await readIds(idsFile())).toEqual({ ada: ID, grace: OTHER_ID });
  });

  it("records none for a missing file", async () => {
    expect(await readIds(idsFile())).toEqual({});
  });

  it.each([
    ["is not JSON", "{ not json"],
    ["is an array", JSON.stringify([ID])],
    ["is null", "null"],
    ["is a string", JSON.stringify(ID)],
  ])("records none for a file that %s", async (_why, content) => {
    await writeFile(idsFile(), content);

    expect(await readIds(idsFile())).toEqual({});
  });

  it("leaves out entries that are not a non-empty string", async () => {
    await writeFile(idsFile(), JSON.stringify({ ada: ID, empty: "", number: 5, nested: {} }));

    expect(await readIds(idsFile())).toEqual({ ada: ID });
  });

  it("throws any other read error", async () => {
    await mkdir(idsFile());

    await expect(readIds(idsFile())).rejects.toThrow();
  });
});

describe("recordId", () => {
  const idsFile = (): string => join(root, "project", "ids.json");
  const items = (): { warnings: string[] } => ({ warnings: [] });

  it("records the id under the slug, creating the folder and the file", async () => {
    const result = items();

    await recordId(idsFile(), "ada", ID, result);

    expect(JSON.parse(await text(idsFile()))).toEqual({ ada: ID });
    expect(await text(idsFile())).toBe(`{\n  "ada": "${ID}"\n}\n`);
    expect(result.warnings).toEqual([]);
  });

  it("keeps what was recorded for the other slugs", async () => {
    await recordId(idsFile(), "ada", ID, items());
    await recordId(idsFile(), "grace", OTHER_ID, items());

    expect(await readIds(idsFile())).toEqual({ ada: ID, grace: OTHER_ID });
  });

  it("replaces the id of a slug that is moved in again", async () => {
    await recordId(idsFile(), "ada", ID, items());
    await recordId(idsFile(), "ada", OTHER_ID, items());

    expect(await readIds(idsFile())).toEqual({ ada: OTHER_ID });
  });

  it("starts over from a file that is not JSON", async () => {
    await mkdir(join(root, "project"));
    await writeFile(idsFile(), "{ not json");

    await recordId(idsFile(), "ada", ID, items());

    expect(await readIds(idsFile())).toEqual({ ada: ID });
  });

  it("records nothing for an empty id, not even the file", async () => {
    const result = items();

    await recordId(idsFile(), "ada", "", result);

    await expect(lstat(idsFile())).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.warnings).toEqual([]);
  });

  it("replaces the file in one step and leaves no temporary file", async () => {
    await recordId(idsFile(), "ada", ID, items());
    await recordId(idsFile(), "grace", OTHER_ID, items());

    expect(await readdir(join(root, "project"))).toEqual(["ids.json"]);
  });

  it.skipIf(!canSymlink)("replaces a symbolic link instead of writing through it", async () => {
    const real = join(root, "elsewhere.json");
    await writeFile(real, "KEEP\n");
    await mkdir(join(root, "project"));
    await symlink(real, idsFile(), "file");

    await recordId(idsFile(), "ada", ID, items());

    expect(await text(real)).toBe("KEEP\n");
    expect((await lstat(idsFile())).isFile()).toBe(true);
    expect(await readIds(idsFile())).toEqual({ ada: ID });
  });

  it("says so, instead of failing, when the id cannot be recorded", async () => {
    // A file where the folder should be.
    await writeFile(join(root, "project"), "");
    const result = items();

    await recordId(idsFile(), "ada", ID, result);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`could not record the agent's id in ${idsFile()}`);
    expect(result.warnings[0]).toContain("a later move will write a copy instead of updating it");
    expect(await readdir(root)).toEqual(["project", "workspace"]);
  });
});
