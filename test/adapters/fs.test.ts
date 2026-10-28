import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backUp, isSafeName, lstatIfAny, replaceFile } from "../../src/adapters/fs.js";

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

describe("replaceFile", () => {
  it("writes text and bytes, and creates the folders on the way", async () => {
    const text = join(root, "deep", "er", "note.txt");
    const bytes = join(root, "deep", "avatar.bin");

    await replaceFile(text, "naïve\n");
    await replaceFile(bytes, new Uint8Array([0, 255, 7]));

    expect(await readFile(text, "utf8")).toBe("naïve\n");
    expect([...(await readFile(bytes))]).toEqual([0, 255, 7]);
  });

  it("replaces what is there in one file and leaves no temporary file", async () => {
    const file = join(root, "ids.json");
    await writeFile(file, "OLD\n");

    await replaceFile(file, "NEW\n");
    await replaceFile(file, "NEWER\n");

    expect(await readFile(file, "utf8")).toBe("NEWER\n");
    expect(await readdir(root)).toEqual(["ids.json"]);
  });

  it.skipIf(!canSymlink)("replaces a symbolic link instead of writing through it", async () => {
    const real = join(root, "elsewhere.json");
    await writeFile(real, "KEEP\n");
    await symlink(real, join(root, "ids.json"), "file");

    await replaceFile(join(root, "ids.json"), "NEW\n");

    expect(await readFile(real, "utf8")).toBe("KEEP\n");
    expect((await lstat(join(root, "ids.json"))).isFile()).toBe(true);
    expect(await readFile(join(root, "ids.json"), "utf8")).toBe("NEW\n");
  });

  it("removes its temporary file and throws when the file cannot be replaced", async () => {
    // A folder where the file should be: the rename fails after the content was written.
    await mkdir(join(root, "taken"));
    await writeFile(join(root, "taken", "inside"), "x");

    await expect(replaceFile(join(root, "taken"), "NEW\n")).rejects.toThrow();

    expect(await readdir(root)).toEqual(["taken"]);
    expect(await readdir(join(root, "taken"))).toEqual(["inside"]);
  });

  it("throws when a file is where the folder should be", async () => {
    await writeFile(join(root, "project"), "");

    await expect(replaceFile(join(root, "project", "ids.json"), "x")).rejects.toThrow();

    expect(await readdir(root)).toEqual(["project"]);
  });

  it.skipIf(process.platform === "win32")("sets the mode exactly when given one", async () => {
    const file = join(root, "openclaw.json");
    await writeFile(file, "OLD\n", { mode: 0o644 });

    await replaceFile(file, "NEW\n", { mode: 0o600 });

    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("backUp", () => {
  it("copies the file next to itself as <file>.bak-<stamp>", async () => {
    const file = join(root, "jobs.json");
    await writeFile(file, "ONE\n");

    await backUp(file, "2026-10-28T10-00-00.000Z");

    expect(await readFile(`${file}.bak-2026-10-28T10-00-00.000Z`, "utf8")).toBe("ONE\n");
  });

  it("never goes over an earlier backup of the same stamp", async () => {
    const file = join(root, "jobs.json");
    await writeFile(file, "ONE\n");
    await backUp(file, "stamp");
    await writeFile(file, "TWO\n");
    await backUp(file, "stamp");
    await writeFile(file, "THREE\n");
    await backUp(file, "stamp");

    expect(await readFile(`${file}.bak-stamp`, "utf8")).toBe("ONE\n");
    expect(await readFile(`${file}.bak-stamp-2`, "utf8")).toBe("TWO\n");
    expect(await readFile(`${file}.bak-stamp-3`, "utf8")).toBe("THREE\n");
  });

  it("throws when there is nothing to copy", async () => {
    await expect(backUp(join(root, "nothing.json"), "stamp")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
