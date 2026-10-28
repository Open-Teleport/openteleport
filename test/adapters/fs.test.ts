import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSafeName, lstatIfAny } from "../../src/adapters/fs.js";

/** An error the file system is made to give, for the test that needs one a machine cannot give. */
const injected = vi.hoisted(() => ({ lstat: undefined as Error | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (path: string) =>
      injected.lstat === undefined ? actual.lstat(path) : Promise.reject(injected.lstat),
  };
});

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-fs-"));
});

afterEach(async () => {
  injected.lstat = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("lstatIfAny", () => {
  it("is undefined for a path that is not there", async () => {
    expect(await lstatIfAny(join(root, "nothing"))).toBeUndefined();
  });

  it("is undefined when a file is on the way to the path", async () => {
    await writeFile(join(root, "a-file"), "");

    expect(await lstatIfAny(join(root, "a-file", "inside"))).toBeUndefined();
  });

  it("gives the Stats of a file", async () => {
    await writeFile(join(root, "a-file"), "x");

    const info = await lstatIfAny(join(root, "a-file"));

    expect(info?.isFile()).toBe(true);
    expect(info?.size).toBe(1);
  });

  it("gives the Stats of a folder", async () => {
    await mkdir(join(root, "a-folder"));

    expect((await lstatIfAny(join(root, "a-folder")))?.isDirectory()).toBe(true);
  });

  it.skipIf(!canSymlink)("gives the Stats of a link, not of what it points at", async () => {
    await writeFile(join(root, "real"), "x");
    await symlink(join(root, "real"), join(root, "link"), "file");

    expect((await lstatIfAny(join(root, "link")))?.isSymbolicLink()).toBe(true);
  });

  it.skipIf(!canSymlink)("gives the Stats of a link that points at nothing", async () => {
    await symlink(join(root, "nowhere"), join(root, "broken"), "file");

    expect((await lstatIfAny(join(root, "broken")))?.isSymbolicLink()).toBe(true);
  });

  it.each(["EACCES", "EIO", "ELOOP"])("throws %s", async (code) => {
    injected.lstat = Object.assign(new Error(`${code}: injected`), { code });

    await expect(lstatIfAny(join(root, "anything"))).rejects.toMatchObject({ code });
  });
});

describe("isSafeName", () => {
  it.each([
    "web-brief",
    "Ada",
    "SKILL.md",
    "a.b.c",
    "web-brief-2",
    "2026-10-20",
    "naïve",
    "with space",
  ])("accepts %j", (name) => {
    expect(isSafeName(name)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["a dot", "."],
    ["two dots", ".."],
    ["a way out of the folder", "../escape"],
    ["a slash", "a/b"],
    ["a leading slash", "/etc"],
    ["a trailing slash", "a/"],
    ["a backslash", "a\\b"],
    ["a drive", "C:evil"],
    ["a control character", "bad\u0000name"],
    ["a line break", "bad\nname"],
    ["a Windows device name", "con"],
    ["a Windows device name in capitals", "NUL"],
    ["a Windows device name with an extension", "com1.txt"],
  ])("refuses %s", (_what, name) => {
    expect(isSafeName(name)).toBe(false);
  });
});
