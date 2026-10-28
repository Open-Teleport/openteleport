import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
import { isAbsolute, join, parse, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import folderAdapter, { folderAdapter as namedExport } from "../../src/adapters/folder/index.js";
import type { Ctx, WriteOpts } from "../../src/adapters/types.js";
import { readBundle } from "../../src/core/bundle.js";
import type { Bundle, Routine } from "../../src/core/schema.js";

// Replacing removes folders, so every removal in this suite goes through a check that it stays
// inside the temp tree the suite builds: a regression in the adapter's guard has to fail a test,
// not delete a real folder.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

/** Whether this machine lets the suite make a symbolic link (a junction on Windows). */
function canLink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "openteleport-folder-probe-"));
  try {
    mkdirSync(join(probe, "a"));
    symlinkSync(join(probe, "a"), join(probe, "b"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const LINKS_WORK = canLink();

const ADA_DIR = fileURLToPath(new URL("../fixtures/jetpack/ada", import.meta.url));
const NO_MANIFEST_DIR = fileURLToPath(new URL("../fixtures/folder/no-manifest", import.meta.url));
const ADA_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
/** Another agent that is also called Ada. */
const OTHER_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2V";
const ROUTINES_WARNING = "routines are stored in the folder; no app runs them from here yet";

const encoder = new TextEncoder();

const WRITE: WriteOpts = { enableRoutines: false, includeFiles: true, onConflict: "update" };

let root: string;
let ctx: Ctx;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-folder-"));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(rm).mockImplementation(async (path, options) => {
    const way = relative(root, String(path));
    if (way.startsWith("..") || isAbsolute(way)) {
      throw new Error(`test safety net: rm outside the temp tree: ${String(path)}`);
    }
    return actual.rm(path, options);
  });
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  await mkdir(home);
  await mkdir(cwd);
  const exec = (() => {
    throw new Error("the folder adapter runs no commands");
  }) as unknown as typeof execa;
  ctx = { home, cwd, env: {}, exec, logger: () => {} };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content = "x\n"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const text = (path: string): Promise<string> => readFile(path, "utf8");

/** Ada as the `.jetpack` fixture holds her, with a real id. */
const ada = (): Promise<Bundle> => readBundle(ADA_DIR);

const withName = (bundle: Bundle, name: string): Bundle => ({
  ...bundle,
  manifest: { ...bundle.manifest, name },
});

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  name: "Nightly",
  instruction: "Tidy up.",
  enabled: true,
  timezone: "UTC",
  schedule: { kind: "cron", expression: "0 3 * * *" },
  ...overrides,
});

describe("folder adapter: identity", () => {
  it("is named folder and exported both ways", () => {
    expect(folderAdapter.name).toBe("folder");
    expect(folderAdapter.displayName).toBe("Folder");
    expect(namedExport).toBe(folderAdapter);
  });

  it("supports everything", () => {
    expect(folderAdapter.capabilities).toEqual({
      persona: true,
      instructions: true,
      skills: true,
      routines: true,
      facts: true,
      notes: true,
      files: true,
      avatar: true,
      models: true,
      schedules: ["cron", "every", "at"],
    });
  });
});

describe("folder adapter: detect", () => {
  const hint = "Pass --source-dir <folder> with an AGENTS.md inside";

  it("finds an AGENTS.md in the folder itself", async () => {
    const dir = join(root, "agent");
    await put(join(dir, "AGENTS.md"));
    expect(await folderAdapter.detect({ ...ctx, sourceDir: dir })).toEqual({
      found: true,
      location: dir,
    });
  });

  it("finds an AGENTS.md one level down", async () => {
    const dir = join(root, "agents");
    await put(join(dir, "ada", "AGENTS.md"));
    await mkdir(join(dir, "empty"));
    expect(await folderAdapter.detect({ ...ctx, sourceDir: dir })).toEqual({
      found: true,
      location: dir,
    });
  });

  it("reports a hint when there is no AGENTS.md", async () => {
    const dir = join(root, "nothing");
    await put(join(dir, "README.md"));
    await put(join(dir, "deep", "inner", "AGENTS.md"));
    expect(await folderAdapter.detect({ ...ctx, sourceDir: dir })).toEqual({
      found: false,
      location: dir,
      hint,
    });
  });

  it("reports a folder that does not exist as not found", async () => {
    const dir = join(root, "missing");
    expect(await folderAdapter.detect({ ...ctx, sourceDir: dir })).toEqual({
      found: false,
      location: dir,
      hint,
    });
  });

  it("looks at sourceDir, then targetDir, then cwd", async () => {
    const source = join(root, "source");
    const target = join(root, "target");
    await put(join(source, "AGENTS.md"));
    await put(join(target, "AGENTS.md"));
    await put(join(ctx.cwd, "AGENTS.md"));

    expect((await folderAdapter.detect({ ...ctx, sourceDir: source, targetDir: target })).location)
      .toBe(source);
    expect((await folderAdapter.detect({ ...ctx, targetDir: target })).location).toBe(target);
    expect((await folderAdapter.detect(ctx)).location).toBe(ctx.cwd);
  });

  it("ignores node_modules and dot folders", async () => {
    const dir = join(root, "agents");
    await put(join(dir, "node_modules", "AGENTS.md"));
    await put(join(dir, ".hidden", "AGENTS.md"));
    await put(join(dir, ".git", "AGENTS.md"));
    expect((await folderAdapter.detect({ ...ctx, sourceDir: dir })).found).toBe(false);
  });

  it("does not take a directory named AGENTS.md for the file", async () => {
    const dir = join(root, "agents");
    await mkdir(join(dir, "AGENTS.md"), { recursive: true });
    expect((await folderAdapter.detect({ ...ctx, sourceDir: dir })).found).toBe(false);
  });
});

describe("folder adapter: list", () => {
  it("lists a folder with an AGENTS.md as one agent named after the folder", async () => {
    const dir = join(root, "my-agent");
    await put(join(dir, "AGENTS.md"));
    expect(await folderAdapter.list({ ...ctx, sourceDir: dir })).toEqual([
      { id: ".", name: "my-agent", location: dir },
    ]);
  });

  it("takes the name from jetpack.json when there is one", async () => {
    const dir = join(root, "my-agent");
    await put(join(dir, "AGENTS.md"));
    await put(join(dir, "jetpack.json"), JSON.stringify({ name: "Ada" }));
    expect(await folderAdapter.list({ ...ctx, sourceDir: dir })).toEqual([
      { id: ".", name: "Ada", location: dir },
    ]);
  });

  it("falls back to the folder name when jetpack.json is not usable", async () => {
    const dir = join(root, "my-agent");
    await put(join(dir, "AGENTS.md"));
    await put(join(dir, "jetpack.json"), "{ not json");
    expect(await folderAdapter.list({ ...ctx, sourceDir: dir })).toEqual([
      { id: ".", name: "my-agent", location: dir },
    ]);
  });

  it("lists every subfolder with an AGENTS.md, sorted by id", async () => {
    const dir = join(root, "agents");
    await put(join(dir, "zed", "AGENTS.md"));
    await put(join(dir, "ada", "AGENTS.md"));
    await put(join(dir, "ada", "jetpack.json"), JSON.stringify({ name: "Ada Lovelace" }));
    await put(join(dir, "no-agent", "README.md"));
    await put(join(dir, "stray-file.md"));
    await put(join(dir, "node_modules", "AGENTS.md"));
    await put(join(dir, ".git", "AGENTS.md"));
    await put(join(dir, ".hidden", "AGENTS.md"));

    expect(await folderAdapter.list({ ...ctx, sourceDir: dir })).toEqual([
      { id: "ada", name: "Ada Lovelace", location: join(dir, "ada") },
      { id: "zed", name: "zed", location: join(dir, "zed") },
    ]);
  });

  it("lists two agents in a folder of two subfolders", async () => {
    const dir = join(root, "agents");
    await put(join(dir, "one", "AGENTS.md"));
    await put(join(dir, "two", "AGENTS.md"));
    const agents = await folderAdapter.list({ ...ctx, sourceDir: dir });
    expect(agents.map((agent) => agent.id)).toEqual(["one", "two"]);
  });

  it("prefers the folder's own AGENTS.md over its subfolders", async () => {
    const dir = join(root, "agent");
    await put(join(dir, "AGENTS.md"));
    await put(join(dir, "child", "AGENTS.md"));
    expect(await folderAdapter.list({ ...ctx, sourceDir: dir })).toEqual([
      { id: ".", name: "agent", location: dir },
    ]);
  });

  it("lists nothing for a folder that is empty or missing", async () => {
    const empty = join(root, "empty");
    await mkdir(empty);
    expect(await folderAdapter.list({ ...ctx, sourceDir: empty })).toEqual([]);
    expect(await folderAdapter.list({ ...ctx, sourceDir: join(root, "missing") })).toEqual([]);
  });

  it("lists from cwd when no directory is given", async () => {
    await put(join(ctx.cwd, "solo", "AGENTS.md"));
    expect(await folderAdapter.list(ctx)).toEqual([
      { id: "solo", name: "solo", location: join(ctx.cwd, "solo") },
    ]);
  });
});

describe("folder adapter: read", () => {
  it("reads a folder without a manifest, warning about the missing SOUL.md", async () => {
    const { bundle, warnings } = await folderAdapter.read(
      { ...ctx, sourceDir: NO_MANIFEST_DIR },
      ".",
    );
    expect(bundle.manifest.name).toBe("no-manifest");
    expect(bundle.manifest.id).toBe("");
    expect(bundle.facts).toHaveLength(1);
    expect(bundle.skills.map((skill) => skill.name)).toEqual(["web-brief"]);
    expect(bundle.persona).toBeUndefined();
    expect(warnings).toContain("SOUL.md not found");
    expect(warnings).not.toContain("MEMORY.md not found");
  });

  it("warns about a missing MEMORY.md as well", async () => {
    const dir = join(root, "bare");
    await put(join(dir, "AGENTS.md"), "Be brief.\n");
    const { bundle, warnings } = await folderAdapter.read({ ...ctx, sourceDir: dir }, ".");
    expect(bundle.instructions).toBe("Be brief.\n");
    expect(warnings).toEqual(["SOUL.md not found", "MEMORY.md not found"]);
  });

  it("has no warnings for a complete agent", async () => {
    const { bundle, warnings } = await folderAdapter.read({ ...ctx, sourceDir: ADA_DIR }, ".");
    expect(bundle.manifest.id).toBe(ADA_ID);
    expect(bundle.manifest.name).toBe("Ada");
    expect(warnings).toEqual([]);
  });

  it("reads a subfolder by its id", async () => {
    const dir = join(root, "agents");
    await put(join(dir, "scout", "AGENTS.md"), "Scout ahead.\n");
    await put(join(dir, "other", "AGENTS.md"), "Not this one.\n");
    const { bundle } = await folderAdapter.read({ ...ctx, sourceDir: dir }, "scout");
    expect(bundle.manifest.name).toBe("scout");
    expect(bundle.instructions).toBe("Scout ahead.\n");
  });

  it("reads what list reports", async () => {
    const dir = join(root, "agents");
    await put(join(dir, "scout", "AGENTS.md"), "Scout ahead.\n");
    const [agent] = await folderAdapter.list({ ...ctx, sourceDir: dir });
    const { bundle } = await folderAdapter.read({ ...ctx, sourceDir: dir }, agent?.id ?? "");
    expect(bundle.instructions).toBe("Scout ahead.\n");
  });

  it.each([
    ["an empty id", ""],
    ["a parent reference", ".."],
    ["a path going up", "../agents"],
    ["a nested path", "scout/inner"],
    ["a Windows separator", "scout\\inner"],
    ["an absolute path", join(tmpdir(), "somewhere")],
    ["a drive-relative path", "C:scout"],
  ])("rejects %s as an agent id", async (_label, id) => {
    const dir = join(root, "agents");
    await put(join(dir, "scout", "AGENTS.md"));
    await expect(folderAdapter.read({ ...ctx, sourceDir: dir }, id)).rejects.toThrow(
      /agent id|single folder name/i,
    );
  });

  it("fails when the folder has no AGENTS.md", async () => {
    const dir = join(root, "agents");
    await put(join(dir, "scout", "README.md"));
    await expect(folderAdapter.read({ ...ctx, sourceDir: dir }, "scout")).rejects.toThrow(
      /AGENTS\.md/,
    );
  });

  it("fails clearly when the folder does not exist", async () => {
    await expect(
      folderAdapter.read({ ...ctx, sourceDir: join(root, "missing") }, "."),
    ).rejects.toThrow(/not a folder|does not exist|not found/i);
  });
});

describe("folder adapter: write", () => {
  it("writes Ada into an empty folder", async () => {
    const target = join(root, "out");
    await mkdir(target);
    const result = await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), WRITE);

    expect(result).toEqual({
      outcome: "done",
      targetAgentId: target,
      items: { approximated: [], skipped: [], warnings: [ROUTINES_WARNING] },
    });
    for (const file of [
      "AGENTS.md",
      "SOUL.md",
      "MEMORY.md",
      "jetpack.json",
      "avatar.png",
      "memory/2026-10-20.md",
      "skills/web-brief/SKILL.md",
      "routines/morning-digest.json",
    ]) {
      expect(await exists(join(target, ...file.split("/"))), file).toBe(true);
    }
    expect(JSON.parse(await text(join(target, "jetpack.json"))).id).toBe(ADA_ID);
    const written = JSON.parse(await text(join(target, "routines", "morning-digest.json")));
    expect(written.enabled).toBe(false);
  });

  it("reads back what it wrote", async () => {
    const target = join(root, "out");
    const source = await ada();
    await folderAdapter.write({ ...ctx, targetDir: target }, source, {
      ...WRITE,
      enableRoutines: true,
    });
    const { bundle, warnings } = await folderAdapter.read({ ...ctx, sourceDir: target }, ".");
    expect(warnings).toEqual([]);
    expect(bundle).toEqual({ ...source, unknownPaths: [] });
  });

  it("creates the target folder and its parents", async () => {
    const target = join(root, "deep", "er", "out");
    await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), WRITE);
    expect(await exists(join(target, "AGENTS.md"))).toBe(true);
  });

  it("writes into cwd under the slug of the agent's name when no target is given", async () => {
    const result = await folderAdapter.write(ctx, await ada(), WRITE);
    const expected = join(ctx.cwd, "ada");
    expect(result.targetAgentId).toBe(expected);
    expect(await exists(join(expected, "AGENTS.md"))).toBe(true);
  });

  it.each([
    ["Ada", "ada"],
    ["Ada Lovelace's Notes!", "ada-lovelace-s-notes"],
    ["  --Ünïcode & co--  ", "n-code-co"],
    ["!!!", "agent"],
    ["con", "con-r"],
    ["a".repeat(63) + " b", "a".repeat(63)],
    ["b".repeat(80), "b".repeat(64)],
  ])("names the folder for %j %j", async (name, slug) => {
    const result = await folderAdapter.write(ctx, withName(await ada(), name), WRITE);
    expect(result.targetAgentId).toBe(join(ctx.cwd, slug));
    expect(await exists(join(ctx.cwd, slug, "AGENTS.md"))).toBe(true);
  });

  describe("routines", () => {
    const folderWith = async (routines: Routine[], opts: Partial<WriteOpts>) => {
      const target = join(root, "out");
      const bundle: Bundle = { ...(await ada()), routines };
      const result = await folderAdapter.write({ ...ctx, targetDir: target }, bundle, {
        ...WRITE,
        ...opts,
      });
      const names = await readdir(join(target, "routines")).catch(() => []);
      const enabled = await Promise.all(
        names.map(async (name) => JSON.parse(await text(join(target, "routines", name))).enabled),
      );
      return { result, enabled };
    };

    it("writes them disabled unless asked to enable them", async () => {
      const { enabled } = await folderWith([routine()], { enableRoutines: false });
      expect(enabled).toEqual([false]);
    });

    it("keeps them enabled when asked to and they were enabled", async () => {
      const { enabled } = await folderWith([routine()], { enableRoutines: true });
      expect(enabled).toEqual([true]);
    });

    it("never enables one that was disabled", async () => {
      const { enabled } = await folderWith([routine({ enabled: false })], {
        enableRoutines: true,
      });
      expect(enabled).toEqual([false]);
    });

    it("warns about stored routines only when there are some", async () => {
      const some = await folderWith([routine()], {});
      expect(some.result.items.warnings).toEqual([ROUTINES_WARNING]);

      await rm(join(root, "out"), { recursive: true });
      const none = await folderWith([], {});
      expect(none.result.items.warnings).toEqual([]);
      expect(none.enabled).toEqual([]);
    });
  });

  describe("files", () => {
    const withFile = async (): Promise<Bundle> => ({
      ...(await ada()),
      files: [{ path: "data/table.csv", bytes: encoder.encode("a,b\n1,2\n") }],
    });

    it("writes them when includeFiles is on", async () => {
      const target = join(root, "out");
      await folderAdapter.write({ ...ctx, targetDir: target }, await withFile(), WRITE);
      expect(await text(join(target, "files", "data", "table.csv"))).toBe("a,b\n1,2\n");
    });

    it("leaves them out when includeFiles is off", async () => {
      const target = join(root, "out");
      await folderAdapter.write({ ...ctx, targetDir: target }, await withFile(), {
        ...WRITE,
        includeFiles: false,
      });
      expect(await exists(join(target, "files"))).toBe(false);
      expect(await exists(join(target, "AGENTS.md"))).toBe(true);
    });
  });

  it("does not change the bundle it is given", async () => {
    const bundle: Bundle = {
      ...(await ada()),
      files: [{ path: "data/table.csv", bytes: encoder.encode("a,b\n") }],
    };
    const before = structuredClone(bundle);
    await folderAdapter.write({ ...ctx, targetDir: join(root, "out") }, bundle, {
      enableRoutines: false,
      includeFiles: false,
      onConflict: "update",
    });
    expect(bundle).toEqual(before);
    expect(bundle.routines[0]?.enabled).toBe(true);
  });

  describe("when the target already has content", () => {
    const replaceInto = async (target: string, over: Partial<Ctx> = {}) =>
      folderAdapter.write({ ...ctx, ...over, targetDir: target }, await ada(), {
        ...WRITE,
        onConflict: "replace",
      });

    it("copy writes next to it as -2, then -3", async () => {
      const copy: WriteOpts = { ...WRITE, onConflict: "copy" };
      const first = await folderAdapter.write(ctx, await ada(), copy);
      const second = await folderAdapter.write(ctx, await ada(), copy);
      const third = await folderAdapter.write(ctx, await ada(), copy);

      expect(first.targetAgentId).toBe(join(ctx.cwd, "ada"));
      expect(second.targetAgentId).toBe(join(ctx.cwd, "ada-2"));
      expect(third.targetAgentId).toBe(join(ctx.cwd, "ada-3"));
      expect(await exists(join(ctx.cwd, "ada-2", "AGENTS.md"))).toBe(true);
      expect(await exists(join(ctx.cwd, "ada-3", "jetpack.json"))).toBe(true);
    });

    it("copy numbers from an explicit target folder too", async () => {
      const target = join(root, "out");
      await put(join(target, "keep.txt"));
      const result = await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), {
        ...WRITE,
        onConflict: "copy",
      });
      expect(result.targetAgentId).toBe(`${target}-2`);
      expect(await exists(join(target, "AGENTS.md"))).toBe(false);
      expect(await text(join(target, "keep.txt"))).toBe("x\n");
    });

    it("copy takes the first free number, and an empty folder counts as free", async () => {
      const target = join(root, "out");
      await put(join(target, "keep.txt"));
      await put(`${target}-2/keep.txt`);
      await mkdir(`${target}-3`);
      const result = await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), {
        ...WRITE,
        onConflict: "copy",
      });
      expect(result.targetAgentId).toBe(`${target}-3`);
      expect(await exists(join(`${target}-3`, "AGENTS.md"))).toBe(true);
    });

    it.each(["update", "copy", "replace"] as const)("%s writes into an empty folder", async (mode) => {
      const target = join(root, "out");
      await mkdir(target);
      const result = await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), {
        ...WRITE,
        onConflict: mode,
      });
      expect(result.targetAgentId).toBe(target);
      expect(await exists(join(target, "AGENTS.md"))).toBe(true);
    });

    it("update overwrites our files and leaves the others alone", async () => {
      const target = join(root, "out");
      const source = await ada();
      await folderAdapter.write({ ...ctx, targetDir: target }, source, WRITE);
      await put(join(target, "notes.txt"), "mine\n");
      await put(join(target, "AGENTS.md"), "edited by hand\n");

      const updated: Bundle = { ...source, instructions: "Fresh instructions.\n", skills: [] };
      const result = await folderAdapter.write({ ...ctx, targetDir: target }, updated, WRITE);

      expect(result.targetAgentId).toBe(target);
      expect(await text(join(target, "AGENTS.md"))).toBe("Fresh instructions.\n");
      expect(await text(join(target, "notes.txt"))).toBe("mine\n");
      expect(await exists(join(target, "skills"))).toBe(false);
    });

    it("update writes another agent of the same name next to it as -2, saying why", async () => {
      const source = await ada();
      const other: Bundle = { ...source, manifest: { ...source.manifest, id: OTHER_ID } };
      const first = await folderAdapter.write(ctx, source, WRITE);
      const second = await folderAdapter.write(ctx, other, WRITE);

      const [taken, copy] = [join(ctx.cwd, "ada"), join(ctx.cwd, "ada-2")];
      expect(first.targetAgentId).toBe(taken);
      expect(second.targetAgentId).toBe(copy);
      expect(second.items.warnings).toEqual([
        `${taken} already holds a different agent (id ${ADA_ID}); written as ${copy}`,
        ROUTINES_WARNING,
      ]);
      expect(JSON.parse(await text(join(taken, "jetpack.json"))).id).toBe(ADA_ID);
      expect(JSON.parse(await text(join(copy, "jetpack.json"))).id).toBe(OTHER_ID);
    });

    it("update finds the -N copy that already holds this agent and updates it", async () => {
      const source = await ada();
      const other = (instructions: string): Bundle => ({
        ...source,
        instructions,
        manifest: { ...source.manifest, id: OTHER_ID },
      });
      await folderAdapter.write(ctx, source, WRITE);
      await folderAdapter.write(ctx, other("Second.\n"), WRITE);
      const third = await folderAdapter.write(ctx, other("Third.\n"), WRITE);

      const copy = join(ctx.cwd, "ada-2");
      expect(third.targetAgentId).toBe(copy);
      expect(third.items.warnings).toEqual([ROUTINES_WARNING]);
      expect(await text(join(copy, "AGENTS.md"))).toBe("Third.\n");
      expect((await readdir(ctx.cwd)).sort()).toEqual(["ada", "ada-2"]);
    });

    it("update looks past a -N copy of yet another agent, and past a gap", async () => {
      const source = await ada();
      const withId = (id: string): Bundle => ({ ...source, manifest: { ...source.manifest, id } });
      const third = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2W";
      await folderAdapter.write(ctx, source, WRITE); // ada
      await folderAdapter.write(ctx, withId(third), WRITE); // ada-2
      await folderAdapter.write(ctx, withId(OTHER_ID), WRITE); // ada-3
      await rm(join(ctx.cwd, "ada-2"), { recursive: true });

      const again = await folderAdapter.write(ctx, withId(OTHER_ID), WRITE);

      expect(again.targetAgentId).toBe(join(ctx.cwd, "ada-3"));
      expect((await readdir(ctx.cwd)).sort()).toEqual(["ada", "ada-3"]);
    });

    it("update counts a -N copy with a corrupt jetpack.json as a different agent", async () => {
      const source = await ada();
      const other: Bundle = { ...source, manifest: { ...source.manifest, id: OTHER_ID } };
      await folderAdapter.write(ctx, source, WRITE);
      await folderAdapter.write(ctx, other, WRITE); // ada-2
      await put(join(ctx.cwd, "ada-2", "jetpack.json"), "{ not json\n");

      const again = await folderAdapter.write(ctx, other, WRITE);

      const [taken, copy] = [join(ctx.cwd, "ada"), join(ctx.cwd, "ada-3")];
      expect(again.targetAgentId).toBe(copy);
      expect(again.items.warnings[0]).toBe(
        `${taken} already holds a different agent (id ${ADA_ID}); written as ${copy}`,
      );
      expect(await text(join(ctx.cwd, "ada-2", "jetpack.json"))).toBe("{ not json\n");
    });

    describe.skipIf(!LINKS_WORK)("links in the way", () => {
      /** An export of `bundle` in a folder outside the working folder, and its AGENTS.md. */
      async function outsideExport(bundle: Bundle): Promise<{ dir: string; agents: string }> {
        const dir = join(root, "outside");
        await folderAdapter.write({ ...ctx, targetDir: dir }, bundle, WRITE);
        return { dir, agents: await text(join(dir, "AGENTS.md")) };
      }
      const edited = (bundle: Bundle): Bundle => ({ ...bundle, instructions: "Edited.\n" });

      it("update never reads or writes through a linked -N copy of this agent", async () => {
        const source = await ada();
        const other: Bundle = { ...source, manifest: { ...source.manifest, id: OTHER_ID } };
        await folderAdapter.write(ctx, source, WRITE); // ada holds another agent
        const outside = await outsideExport(other);
        await symlink(outside.dir, join(ctx.cwd, "ada-2"), "junction");

        const result = await folderAdapter.write(ctx, edited(other), WRITE);

        expect(result.targetAgentId).toBe(join(ctx.cwd, "ada-3"));
        expect(await text(join(outside.dir, "AGENTS.md"))).toBe(outside.agents);
        expect(await text(join(ctx.cwd, "ada-3", "AGENTS.md"))).toBe("Edited.\n");
      });

      it("update never writes through a linked base folder, and says so", async () => {
        const source = await ada();
        const outside = await outsideExport(source);
        const base = join(ctx.cwd, "ada");
        await symlink(outside.dir, base, "junction");

        const result = await folderAdapter.write(ctx, edited(source), WRITE);

        expect(result.targetAgentId).toBe(join(ctx.cwd, "ada-2"));
        expect(result.items.warnings[0]).toBe(`'${base}' is a symlink; not written through`);
        expect(await text(join(outside.dir, "AGENTS.md"))).toBe(outside.agents);
        expect((await lstat(base)).isSymbolicLink()).toBe(true);
      });

      it("update behind a linked base still finds this agent's own -N copy", async () => {
        const source = await ada();
        const outside = await outsideExport(source);
        await symlink(outside.dir, join(ctx.cwd, "ada"), "junction");
        await folderAdapter.write(ctx, source, WRITE); // ada-2

        const again = await folderAdapter.write(ctx, edited(source), WRITE);

        expect(again.targetAgentId).toBe(join(ctx.cwd, "ada-2"));
        expect(await text(join(ctx.cwd, "ada-2", "AGENTS.md"))).toBe("Edited.\n");
        expect(await text(join(outside.dir, "AGENTS.md"))).toBe(outside.agents);
      });

      it("replace refuses a linked base folder and leaves it alone", async () => {
        const source = await ada();
        const outside = await outsideExport(source);
        const base = join(ctx.cwd, "ada");
        await symlink(outside.dir, base, "junction");

        await expect(
          folderAdapter.write(ctx, edited(source), { ...WRITE, onConflict: "replace" }),
        ).rejects.toThrow(`Refusing to replace ${base}: it is a symbolic link.`);
        expect(await text(join(outside.dir, "AGENTS.md"))).toBe(outside.agents);
        expect((await lstat(base)).isSymbolicLink()).toBe(true);
      });

      it("copy goes around a linked base folder", async () => {
        const source = await ada();
        const outside = await outsideExport(source);
        await symlink(outside.dir, join(ctx.cwd, "ada"), "junction");

        const result = await folderAdapter.write(ctx, edited(source), {
          ...WRITE,
          onConflict: "copy",
        });

        expect(result.targetAgentId).toBe(join(ctx.cwd, "ada-2"));
        expect(await text(join(outside.dir, "AGENTS.md"))).toBe(outside.agents);
      });
    });

    it("update counts an earlier export without a readable id as a different agent", async () => {
      const target = join(root, "out");
      await put(join(target, "jetpack.json"), "{ not json\n");
      await put(join(target, "AGENTS.md"), "mine\n");
      const result = await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), WRITE);

      expect(result.targetAgentId).toBe(`${target}-2`);
      expect(result.items.warnings[0]).toBe(
        `${target} already holds a different agent (no readable id); written as ${target}-2`,
      );
      expect(await text(join(target, "AGENTS.md"))).toBe("mine\n");
    });

    it("update refuses a folder that is not an earlier export and points to --copy", async () => {
      const target = join(root, "out");
      await put(join(target, "notes.txt"), "mine\n");
      await expect(
        folderAdapter.write({ ...ctx, targetDir: target }, await ada(), WRITE),
      ).rejects.toThrow(/holds no jetpack\.json.*--copy/);
      expect(await readdir(target)).toEqual(["notes.txt"]);
    });

    it("replace clears the folder first", async () => {
      const target = join(root, "out");
      await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), WRITE);
      await put(join(target, "notes.txt"), "mine\n");
      await put(join(target, "sub", "deep.txt"), "mine\n");

      await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), {
        ...WRITE,
        onConflict: "replace",
      });

      expect((await readdir(target)).sort()).toEqual([
        "AGENTS.md",
        "MEMORY.md",
        "SOUL.md",
        "avatar.png",
        "jetpack.json",
        "memory",
        "routines",
        "skills",
      ]);
    });

    it("replace refuses a non-empty folder that is not an earlier export", async () => {
      const target = join(root, "out");
      await put(join(target, "foreign.txt"), "mine\n");
      await expect(replaceInto(target)).rejects.toThrow(/holds no jetpack\.json.*--copy/);
      expect(await readdir(target)).toEqual(["foreign.txt"]);
      expect(await text(join(target, "foreign.txt"))).toBe("mine\n");
    });

    it("replace works on a folder under cwd, such as the default target", async () => {
      await folderAdapter.write(ctx, await ada(), WRITE);
      const target = join(ctx.cwd, "ada");
      await put(join(target, "stale.txt"));
      const result = await replaceInto(target);
      expect(result.targetAgentId).toBe(target);
      expect(await exists(join(target, "stale.txt"))).toBe(false);
      expect(await exists(join(target, "AGENTS.md"))).toBe(true);
    });

    it("replace keeps the old folder when the bundle cannot be written", async () => {
      const target = join(root, "out");
      await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), WRITE);
      await put(join(target, "precious.txt"), "keep me\n");
      const invalid = withName(await ada(), "Ada");
      invalid.manifest = { ...invalid.manifest, id: "" };

      await expect(
        folderAdapter.write({ ...ctx, targetDir: target }, invalid, {
          ...WRITE,
          onConflict: "replace",
        }),
      ).rejects.toThrow(/manifest is invalid: id:/);
      expect(await text(join(target, "precious.txt"))).toBe("keep me\n");
      expect(await exists(join(target, "jetpack.json"))).toBe(true);
    });

    describe("replace refuses to remove", () => {
      it("the home folder", async () => {
        await put(join(ctx.home, "precious.txt"), "keep me\n");
        await expect(replaceInto(ctx.home)).rejects.toThrow(/home folder/);
        expect(await text(join(ctx.home, "precious.txt"))).toBe("keep me\n");
      });

      it("a folder above the home folder", async () => {
        await put(join(ctx.home, "precious.txt"), "keep me\n");
        await expect(replaceInto(root)).rejects.toThrow(/home folder/);
        expect(await text(join(ctx.home, "precious.txt"))).toBe("keep me\n");
      });

      it("the working folder, even when it looks like an export", async () => {
        await put(join(ctx.cwd, "precious.txt"), "keep me\n");
        await put(join(ctx.cwd, "jetpack.json"), "{}\n");
        await expect(replaceInto(ctx.cwd)).rejects.toThrow(/working folder/);
        expect(await text(join(ctx.cwd, "precious.txt"))).toBe("keep me\n");
      });

      it("a folder above the working folder", async () => {
        const project = join(root, "work", "project");
        await mkdir(project, { recursive: true });
        await put(join(root, "work", "precious.txt"), "keep me\n");
        await expect(replaceInto(join(root, "work"), { cwd: project })).rejects.toThrow(
          /working folder/,
        );
        expect(await text(join(root, "work", "precious.txt"))).toBe("keep me\n");
      });

      it("a filesystem root", async () => {
        const top = parse(tmpdir()).root;
        // The suite's rm check turns a missing guard into a failure here, not a deleted drive.
        await expect(replaceInto(top)).rejects.toThrow(/filesystem root/);
        expect(vi.mocked(rm).mock.calls.map(([path]) => String(path))).not.toContain(top);
      });

      it.skipIf(!LINKS_WORK)("a link that leads to the home folder", async () => {
        await put(join(ctx.home, "precious.txt"), "keep me\n");
        const alias = join(root, "home-alias");
        await symlink(ctx.home, alias, "junction");
        await expect(replaceInto(alias)).rejects.toThrow(/home folder/);
        expect(await text(join(ctx.home, "precious.txt"))).toBe("keep me\n");
      });

      it.skipIf(!LINKS_WORK)("a link that leads to the working folder", async () => {
        await put(join(ctx.cwd, "precious.txt"), "keep me\n");
        const alias = join(root, "cwd-alias");
        await symlink(ctx.cwd, alias, "junction");
        await expect(replaceInto(alias)).rejects.toThrow(/working folder/);
        expect(await text(join(ctx.cwd, "precious.txt"))).toBe("keep me\n");
      });
    });

    it("update and replace refuse a target that is a file, copy goes around it", async () => {
      const target = join(root, "out");
      await put(target, "i am a file\n");
      for (const mode of ["update", "replace"] as const) {
        await expect(
          folderAdapter.write({ ...ctx, targetDir: target }, await ada(), {
            ...WRITE,
            onConflict: mode,
          }),
        ).rejects.toThrow(/not a folder/i);
      }
      expect(await text(target)).toBe("i am a file\n");

      const result = await folderAdapter.write({ ...ctx, targetDir: target }, await ada(), {
        ...WRITE,
        onConflict: "copy",
      });
      expect(result.targetAgentId).toBe(`${target}-2`);
    });
  });
});

describe("folder adapter: round trip", () => {
  it("lists, reads and writes an agent folder to another place", async () => {
    const [agent] = await folderAdapter.list({ ...ctx, sourceDir: NO_MANIFEST_DIR });
    expect(agent).toEqual({ id: ".", name: "no-manifest", location: NO_MANIFEST_DIR });
    const { bundle } = await folderAdapter.read({ ...ctx, sourceDir: NO_MANIFEST_DIR }, ".");

    // A manifest-less read leaves the id empty for the engine to assign; do that here.
    const assigned = { ...bundle, manifest: { ...bundle.manifest, id: ADA_ID } };
    const target = join(root, "copy");
    await folderAdapter.write({ ...ctx, targetDir: target }, assigned, WRITE);

    expect(await text(join(target, "MEMORY.md"))).toBe(
      "- Prefers answers in Polish unless the source is in English.\n",
    );
    expect(await exists(join(target, "SOUL.md"))).toBe(false);
    expect(await exists(join(target, "skills", "web-brief", "SKILL.md"))).toBe(true);
  });
});
