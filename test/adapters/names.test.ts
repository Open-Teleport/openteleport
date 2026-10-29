import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeMarker } from "../../src/adapters/marker.js";
import { claimFolder, freeName, recordedCopy } from "../../src/adapters/names.js";
import type { Bundle } from "../../src/core/schema.js";

const ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
const OTHER_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2V";
const MOVED_AT = "2026-10-27T09:15:00.000Z";

/** Whether this machine lets the tests create directory symbolic links. */
const canSymlink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "openteleport-symlink-"));
  try {
    await mkdir(join(dir, "target"));
    await symlink(join(dir, "target"), join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-names-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("freeName", () => {
  it("is the base when nothing of that name is there", async () => {
    expect(await freeName(root, "ada", ".md")).toBe("ada");
  });

  it("counts up from -2 to the first name that is free", async () => {
    await writeFile(join(root, "ada.md"), "");
    expect(await freeName(root, "ada", ".md")).toBe("ada-2");
    await writeFile(join(root, "ada-2.md"), "");
    await writeFile(join(root, "ada-4.md"), "");
    expect(await freeName(root, "ada", ".md")).toBe("ada-3");
  });

  it("looks for the extension it is given and no other", async () => {
    await writeFile(join(root, "ada.md"), "");

    expect(await freeName(root, "ada", ".toml")).toBe("ada");
    expect(await freeName(root, "ada", ".md")).toBe("ada-2");
  });

  it("takes a folder of that name as taken too", async () => {
    await mkdir(join(root, "ada.md"));

    expect(await freeName(root, "ada", ".md")).toBe("ada-2");
  });

  it.skipIf(!canSymlink)("takes a link, even a broken one, as taken", async () => {
    await symlink(join(root, "nowhere"), join(root, "ada.md"), "dir");

    expect(await freeName(root, "ada", ".md")).toBe("ada-2");
  });

  it("is the base when the folder is not there at all", async () => {
    expect(await freeName(join(root, "nothing"), "ada", ".md")).toBe("ada");
  });
});

describe("recordedCopy", () => {
  it("is the lowest -N the ids record for the agent, when its file is there", async () => {
    await writeFile(join(root, "ada-2.md"), "");
    await writeFile(join(root, "ada-3.md"), "");
    await writeFile(join(root, "ada-10.md"), "");
    const ids = { ada: OTHER_ID, "ada-10": ID, "ada-3": ID, "ada-2": OTHER_ID };

    expect(await recordedCopy(root, "ada", ".md", ID, ids)).toBe("ada-3");
  });

  it("orders the numbers as numbers", async () => {
    await writeFile(join(root, "ada-9.md"), "");
    await writeFile(join(root, "ada-10.md"), "");

    expect(await recordedCopy(root, "ada", ".md", ID, { "ada-10": ID, "ada-9": ID })).toBe("ada-9");
  });

  it("is undefined when no copy is recorded for the agent", async () => {
    await writeFile(join(root, "ada-2.md"), "");

    expect(await recordedCopy(root, "ada", ".md", ID, { "ada-2": OTHER_ID })).toBeUndefined();
    expect(await recordedCopy(root, "ada", ".md", ID, {})).toBeUndefined();
  });

  it("does not take the base itself, a stem that only starts with it, or a number below 2", async () => {
    for (const stem of ["ada", "ada-1", "ada-02", "ada-x", "adam-2", "ada-2-2"]) {
      await writeFile(join(root, `${stem}.md`), "");
    }
    const ids = Object.fromEntries(
      ["ada", "ada-1", "ada-02", "ada-x", "adam-2", "ada-2-2"].map((stem) => [stem, ID]),
    );

    expect(await recordedCopy(root, "ada", ".md", ID, ids)).toBeUndefined();
  });

  it("skips a recorded copy whose file is gone or is not a regular file", async () => {
    await mkdir(join(root, "ada-2.md"));
    await writeFile(join(root, "ada-4.md"), "");
    const ids = { "ada-2": ID, "ada-3": ID, "ada-4": ID };

    expect(await recordedCopy(root, "ada", ".md", ID, ids)).toBe("ada-4");
  });

  it.skipIf(!canSymlink)("skips a recorded copy whose file is a link", async () => {
    await symlink(join(root, "nowhere"), join(root, "ada-2.md"), "dir");
    await writeFile(join(root, "ada-3.md"), "");

    expect(await recordedCopy(root, "ada", ".md", ID, { "ada-2": ID, "ada-3": ID })).toBe("ada-3");
  });

  it("looks at the extension it is given", async () => {
    await writeFile(join(root, "ada-2.toml"), "");
    const ids = { "ada-2": ID };

    expect(await recordedCopy(root, "ada", ".toml", ID, ids)).toBe("ada-2");
    expect(await recordedCopy(root, "ada", ".md", ID, ids)).toBeUndefined();
  });
});

describe("claimFolder", () => {
  const bundleWith = (id: string): Bundle => ({ manifest: { id } }) as unknown as Bundle;
  const wanted = (): string => join(root, "ada-for-bot");

  async function markedFolder(path: string, id: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await writeMarker(path, { id, movedAt: MOVED_AT });
  }

  it("takes a folder that is not there, or an empty one", async () => {
    const warnings: string[] = [];
    expect(await claimFolder(wanted(), bundleWith(ID), "update", warnings)).toEqual({
      dir: wanted(),
      owned: false,
    });

    await mkdir(wanted());
    expect(await claimFolder(wanted(), bundleWith(ID), "replace", warnings)).toEqual({
      dir: wanted(),
      owned: false,
    });
    expect(warnings).toEqual([]);
  });

  describe("copy", () => {
    it("goes to the first free -N and says nothing", async () => {
      await markedFolder(wanted(), ID);
      await markedFolder(`${wanted()}-2`, ID);
      await mkdir(`${wanted()}-3`);
      const warnings: string[] = [];

      expect(await claimFolder(wanted(), bundleWith(ID), "copy", warnings)).toEqual({
        dir: `${wanted()}-3`,
        owned: false,
      });
      expect(warnings).toEqual([]);
    });
  });

  describe("replace", () => {
    it("writes over a folder that holds a marker, whoever's it is", async () => {
      await markedFolder(wanted(), OTHER_ID);

      expect(await claimFolder(wanted(), bundleWith(ID), "replace", [])).toEqual({
        dir: wanted(),
        owned: true,
      });
    });

    it("refuses a folder without a marker", async () => {
      await mkdir(wanted());
      await writeFile(join(wanted(), "notes.txt"), "mine");

      await expect(claimFolder(wanted(), bundleWith(ID), "replace", [])).rejects.toThrow(
        `Refusing to replace ${wanted()}: it holds no .openteleport.json, so it is not a folder OpenTeleport wrote. Delete it yourself if you mean it.`,
      );
    });

    it("refuses a file", async () => {
      await writeFile(wanted(), "");

      await expect(claimFolder(wanted(), bundleWith(ID), "replace", [])).rejects.toThrow(
        `Refusing to replace ${wanted()}: it is not a folder. Delete it yourself if you mean it.`,
      );
    });

    it.skipIf(!canSymlink)("refuses a link", async () => {
      await mkdir(join(root, "elsewhere"));
      await symlink(join(root, "elsewhere"), wanted(), "dir");

      await expect(claimFolder(wanted(), bundleWith(ID), "replace", [])).rejects.toThrow(
        `Refusing to replace ${wanted()}: it is a symbolic link. Delete it yourself if you mean it.`,
      );
    });
  });

  describe("update", () => {
    it("writes over the folder that carries this agent's marker", async () => {
      await markedFolder(wanted(), ID);
      const warnings: string[] = [];

      expect(await claimFolder(wanted(), bundleWith(ID), "update", warnings)).toEqual({
        dir: wanted(),
        owned: true,
      });
      expect(warnings).toEqual([]);
    });

    it("writes over the -N folder an earlier move gave this agent, the lowest first", async () => {
      await markedFolder(wanted(), OTHER_ID);
      await markedFolder(`${wanted()}-2`, OTHER_ID);
      await markedFolder(`${wanted()}-5`, ID);
      await markedFolder(`${wanted()}-3`, ID);
      const warnings: string[] = [];

      expect(await claimFolder(wanted(), bundleWith(ID), "update", warnings)).toEqual({
        dir: `${wanted()}-3`,
        owned: true,
      });
      expect(warnings).toEqual([]);
    });

    it("leaves a folder of another agent alone, goes to the first free -N and says why", async () => {
      await markedFolder(wanted(), OTHER_ID);
      const warnings: string[] = [];

      expect(await claimFolder(wanted(), bundleWith(ID), "update", warnings)).toEqual({
        dir: `${wanted()}-2`,
        owned: false,
      });
      expect(warnings).toEqual([`${wanted()} holds a different agent; written as ${wanted()}-2`]);
    });

    it("leaves a folder without a marker alone and says so", async () => {
      await mkdir(wanted());
      await writeFile(join(wanted(), "notes.txt"), "mine");
      const warnings: string[] = [];

      expect(await claimFolder(wanted(), bundleWith(ID), "update", warnings)).toEqual({
        dir: `${wanted()}-2`,
        owned: false,
      });
      expect(warnings).toEqual([
        `${wanted()} holds no .openteleport.json of this agent; written as ${wanted()}-2`,
      ]);
    });

    it("proves nothing from an empty id: the folder is not this agent's", async () => {
      await markedFolder(wanted(), "");
      await markedFolder(`${wanted()}-2`, "");
      const warnings: string[] = [];

      expect(await claimFolder(wanted(), bundleWith(""), "update", warnings)).toEqual({
        dir: `${wanted()}-3`,
        owned: false,
      });
      expect(warnings).toHaveLength(1);
    });

    it("does not count a -N file or a -N folder without the marker", async () => {
      await markedFolder(wanted(), OTHER_ID);
      await writeFile(`${wanted()}-2`, "");
      await mkdir(`${wanted()}-3`);
      const warnings: string[] = [];

      expect((await claimFolder(wanted(), bundleWith(ID), "update", warnings)).owned).toBe(false);
    });

    it.skipIf(!canSymlink)("never writes through a link: the agent gets a folder of its own", async () => {
      await markedFolder(join(root, "elsewhere"), ID);
      await symlink(join(root, "elsewhere"), wanted(), "dir");
      const warnings: string[] = [];

      expect(await claimFolder(wanted(), bundleWith(ID), "update", warnings)).toEqual({
        dir: `${wanted()}-2`,
        owned: false,
      });
      expect(warnings).toEqual([
        `${wanted()} is a symbolic link, which is not written through; written as ${wanted()}-2`,
      ]);
    });
  });
});
