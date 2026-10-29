import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openbotAdapter } from "../../../src/adapters/openbot/index.js";
import { writeOpenBotAgent } from "../../../src/adapters/openbot/write.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import { readBundle } from "../../../src/core/bundle.js";
import type { Bundle } from "../../../src/core/schema.js";
import { VERSION } from "../../../src/index.js";
import { readOpenBotZip } from "../../../src/formats/openbot-zip.js";
import { ADA_DIR, ADA_ID } from "../../helpers/cli.js";
import { zipDirectoryToFile } from "../../helpers/zip.js";

const OTHER_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2V";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

const DEFAULT: WriteOpts = { enableRoutines: false, includeFiles: false, onConflict: "update" };
const COPY: WriteOpts = { ...DEFAULT, onConflict: "copy" };
const REPLACE: WriteOpts = { ...DEFAULT, onConflict: "replace" };

/** Whether this machine lets the tests create symbolic links. */
const canSymlink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "openteleport-symlink-"));
  try {
    await writeFile(join(dir, "target"), "x");
    await symlink(join(dir, "target"), join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

let root: string;
let cwd: string;
let ctx: Ctx;
let ada: Bundle;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-openbot-write-"));
  cwd = join(root, "cwd");
  await mkdir(cwd);
  ctx = { home: join(root, "home"), cwd, env: {}, exec: noExec, logger: () => {} };
  ada = await readBundle(ADA_DIR);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const asAgent = (bundle: Bundle, id: string, extra: Partial<Bundle> = {}): Bundle => ({
  ...bundle,
  ...extra,
  manifest: { ...bundle.manifest, id },
});

/** The zip the adapter wrote, read back. */
const agentOf = async (file: string, includeFiles = false) => {
  const { format, agents } = await readOpenBotZip(file, { includeFiles });
  expect(format).toBe("openbot-agent-import");
  expect(agents).toHaveLength(1);
  return (agents[0] as NonNullable<(typeof agents)[number]>).bundle;
};

describe("the adapter", () => {
  it("is a handoff that needs no install and holds what the import format holds", () => {
    expect(openbotAdapter).toMatchObject({
      name: "openbot",
      displayName: "OpenBot",
      createsOnWrite: true,
      handoff: true,
      capabilities: {
        persona: true,
        instructions: true,
        skills: true,
        routines: true,
        facts: true,
        notes: false,
        files: true,
        avatar: true,
        models: false,
        schedules: ["cron", "every"],
      },
    });
  });
});

describe("writeOpenBotAgent", () => {
  it("writes <name>-openbot-import.zip to the working directory and hands it over", async () => {
    const result = await writeOpenBotAgent(ctx, ada, DEFAULT);
    const file = join(cwd, "ada-openbot-import.zip");

    expect(result.outcome).toBe("handoff");
    expect(result.artifactPath).toBe(file);
    expect(result.nextStep).toBe(
      `Open OpenBot, go to Server settings, choose Import and pick ${file}`,
    );
    expect(result.targetAgentId).toBeUndefined();
    expect(await readdir(cwd)).toEqual(["ada-openbot-import.zip"]);

    const written = await agentOf(file);
    expect(written.manifest.id).toBe(ada.manifest.id);
    expect(written.manifest.name).toBe("Ada");
    expect(written.manifest.title).toBe("Research assistant");
    expect(written.instructions).toContain("Ada is a calm, curious research assistant.");
    expect(written.instructions).toContain("Read the sources before summarising them.");
    expect(written.facts).toEqual(ada.facts);
    expect(written.skills.map(({ name }) => name)).toEqual(["web-brief"]);
    expect(written.avatar?.name).toBe("avatar.png");
    expect(written.routines.map(({ name }) => name)).toEqual(["Morning digest"]);
    expect(written.routines[0]?.schedule).toEqual({ kind: "cron", expression: "30 8 * * 1-5" });
  });

  it("puts the jetpack id and the version in the manifest of the archive", async () => {
    await writeOpenBotAgent(ctx, ada, DEFAULT);
    const entries = unzipSync(new Uint8Array(await readFile(join(cwd, "ada-openbot-import.zip"))));
    const manifest = JSON.parse(strFromU8(entries["openbot-import.json"] as Uint8Array)) as Record<
      string,
      unknown
    >;
    expect(manifest["x-openteleport"]).toEqual({ id: ADA_ID, version: VERSION });
    expect(manifest.source).toMatchObject({ app: "openteleport" });
  });

  it("says what it changed to fit: the persona is joined with the instructions", async () => {
    const result = await writeOpenBotAgent(ctx, ada, DEFAULT);
    expect(result.items.approximated).toContainEqual(
      expect.objectContaining({ field: "persona" }),
    );
    expect(result.items.skipped).toEqual([]);
  });

  it("passes on what the format could not take", async () => {
    const long = asAgent(ada, ADA_ID, { facts: ["x".repeat(501), "fine"] });
    const result = await writeOpenBotAgent(ctx, long, DEFAULT);
    expect(result.items.skipped).toEqual([
      expect.objectContaining({ field: "fact:1", detail: expect.stringContaining("500") }),
    ]);
    expect((await agentOf(result.artifactPath as string)).facts).toEqual(["fine"]);
  });

  it("lands routines disabled, and enabled only with enableRoutines and only if they were on", async () => {
    await writeOpenBotAgent(ctx, ada, DEFAULT);
    expect((await agentOf(join(cwd, "ada-openbot-import.zip"))).routines[0]?.enabled).toBe(false);

    const paused = asAgent(ada, OTHER_ID, {
      routines: [
        ...ada.routines,
        {
          name: "Paused",
          instruction: "Stay off.",
          enabled: false,
          timezone: "UTC",
          schedule: { kind: "every", every: "1h" },
        },
      ],
    });
    const result = await writeOpenBotAgent(ctx, paused, { ...DEFAULT, enableRoutines: true });
    const written = await agentOf(result.artifactPath as string);
    expect(written.routines.map(({ name, enabled }) => [name, enabled])).toEqual([
      ["Morning digest", true],
      ["Paused", false],
    ]);
  });

  it("does not change the bundle it is given", async () => {
    const before = JSON.stringify(ada);
    await writeOpenBotAgent(ctx, ada, { ...DEFAULT, enableRoutines: true });
    expect(JSON.stringify(ada)).toBe(before);
    expect(ada.routines[0]?.enabled).toBe(true);
  });

  it("carries the files only with includeFiles", async () => {
    const bytes = new TextEncoder().encode("- finish the review\n");
    const withFiles = asAgent(ada, ADA_ID, { files: [{ path: "notes/todo.md", bytes }] });

    await writeOpenBotAgent(ctx, withFiles, DEFAULT);
    expect((await agentOf(join(cwd, "ada-openbot-import.zip"), true)).files).toEqual([]);

    await writeOpenBotAgent(ctx, withFiles, { ...DEFAULT, includeFiles: true });
    const written = await agentOf(join(cwd, "ada-openbot-import.zip"), true);
    expect(written.files.map(({ path }) => path)).toEqual(["notes/todo.md"]);
  });

  it("names the file after the agent in letters and digits", async () => {
    const result = await writeOpenBotAgent(
      ctx,
      asAgent({ ...ada, manifest: { ...ada.manifest, name: "Zażółć Gęślą / Jaźń" } }, ADA_ID),
      DEFAULT,
    );
    expect(result.artifactPath).toBe(join(cwd, "zazolc-gesla-jazn-openbot-import.zip"));
    const nothing = await writeOpenBotAgent(
      ctx,
      asAgent({ ...ada, manifest: { ...ada.manifest, name: "***" } }, OTHER_ID),
      DEFAULT,
    );
    expect(nothing.artifactPath).toBe(join(cwd, "agent-openbot-import.zip"));
  });

  it("writes into --target-dir, made when needed, resolved against the working directory", async () => {
    const result = await writeOpenBotAgent({ ...ctx, targetDir: "out/zips" }, ada, DEFAULT);
    expect(result.artifactPath).toBe(join(cwd, "out", "zips", "ada-openbot-import.zip"));
    expect((await stat(result.artifactPath as string)).isFile()).toBe(true);
    expect(await readdir(cwd)).toEqual(["out"]);

    const absolute = join(root, "elsewhere");
    const again = await writeOpenBotAgent({ ...ctx, targetDir: absolute }, ada, DEFAULT);
    expect(again.artifactPath).toBe(join(absolute, "ada-openbot-import.zip"));
  });

  it("fails without leaving a half written file when the folder cannot be made", async () => {
    const blocker = join(root, "blocker");
    await writeFile(blocker, "a file, not a folder");
    await expect(writeOpenBotAgent({ ...ctx, targetDir: blocker }, ada, DEFAULT)).rejects.toThrow();
    expect(await readdir(cwd)).toEqual([]);
    expect(await readFile(blocker, "utf8")).toBe("a file, not a folder");
  });

  it("leaves no temporary file beside the archive", async () => {
    await writeOpenBotAgent(ctx, ada, DEFAULT);
    await writeOpenBotAgent(ctx, ada, DEFAULT);
    expect(await readdir(cwd)).toEqual(["ada-openbot-import.zip"]);
  });
});

describe("a file of that name is already there", () => {
  const first = (): string => join(cwd, "ada-openbot-import.zip");
  const second = (): string => join(cwd, "ada-openbot-import-2.zip");
  const third = (): string => join(cwd, "ada-openbot-import-3.zip");

  it("is overwritten when it holds the same agent", async () => {
    await writeOpenBotAgent(ctx, ada, DEFAULT);
    const changed = asAgent(ada, ADA_ID, { instructions: "Something new.", persona: undefined });
    const result = await writeOpenBotAgent(ctx, changed, DEFAULT);

    expect(result.artifactPath).toBe(first());
    expect(result.items.warnings).toEqual([]);
    expect(await readdir(cwd)).toEqual(["ada-openbot-import.zip"]);
    expect((await agentOf(first())).instructions).toBe("Something new.");
  });

  it("is kept, and the archive goes to -2, when it holds another agent", async () => {
    await writeOpenBotAgent(ctx, asAgent(ada, OTHER_ID), DEFAULT);
    const theirs = await readFile(first());

    const result = await writeOpenBotAgent(ctx, ada, DEFAULT);

    expect(result.artifactPath).toBe(second());
    expect(result.items.warnings).toEqual([
      expect.stringContaining(`${first()} holds a different agent; written as ${second()}`),
    ]);
    expect(Buffer.compare(await readFile(first()), theirs)).toBe(0);
    expect((await agentOf(second())).manifest.id).toBe(ADA_ID);
    expect((await agentOf(first())).manifest.id).toBe(OTHER_ID);
  });

  it("is kept, and the archive goes to -2, when it is no archive of ours at all", async () => {
    await writeFile(first(), "just some bytes");
    const result = await writeOpenBotAgent(ctx, ada, DEFAULT);
    expect(result.artifactPath).toBe(second());
    expect(result.items.warnings).toEqual([
      `${first()} holds no OpenTeleport marker of this agent; written as ${second()}`,
    ]);
    expect(await readFile(first(), "utf8")).toBe("just some bytes");
  });

  it("is kept when it is an OpenBot archive without our marker", async () => {
    // An archive of the export skill: valid, but not written by OpenTeleport.
    await zipDirectoryToFile(
      fileURLToPath(new URL("../../fixtures/openbot/import-v1", import.meta.url)),
      first(),
    );
    const theirs = await readFile(first());
    const result = await writeOpenBotAgent(ctx, ada, DEFAULT);
    expect(result.artifactPath).toBe(second());
    expect(Buffer.compare(await readFile(first()), theirs)).toBe(0);
  });

  it("updates the -N archive of the same agent instead of starting another", async () => {
    await writeOpenBotAgent(ctx, asAgent(ada, OTHER_ID), DEFAULT);
    await writeOpenBotAgent(ctx, ada, DEFAULT);
    const result = await writeOpenBotAgent(
      ctx,
      asAgent(ada, ADA_ID, { instructions: "Newer.", persona: undefined }),
      DEFAULT,
    );

    expect(result.artifactPath).toBe(second());
    expect((await readdir(cwd)).sort()).toEqual([
      "ada-openbot-import-2.zip",
      "ada-openbot-import.zip",
    ]);
    expect((await agentOf(second())).instructions).toBe("Newer.");
  });

  it("with --copy is always a new archive next to it", async () => {
    await writeOpenBotAgent(ctx, ada, DEFAULT);
    const one = await writeOpenBotAgent(ctx, ada, COPY);
    const two = await writeOpenBotAgent(ctx, ada, COPY);
    expect(one.artifactPath).toBe(second());
    expect(two.artifactPath).toBe(third());
    expect((await readdir(cwd)).sort()).toEqual([
      "ada-openbot-import-2.zip",
      "ada-openbot-import-3.zip",
      "ada-openbot-import.zip",
    ]);
  });

  it("with --copy is the plain name when nothing is there", async () => {
    const result = await writeOpenBotAgent(ctx, ada, COPY);
    expect(result.artifactPath).toBe(first());
  });

  it("with --replace is overwritten when it carries a marker, of whatever agent", async () => {
    await writeOpenBotAgent(ctx, asAgent(ada, OTHER_ID), DEFAULT);
    const result = await writeOpenBotAgent(ctx, ada, REPLACE);
    expect(result.artifactPath).toBe(first());
    expect((await agentOf(first())).manifest.id).toBe(ADA_ID);
    expect(await readdir(cwd)).toEqual(["ada-openbot-import.zip"]);
  });

  it("with --replace is refused when it has no marker, and left as it was", async () => {
    await writeFile(first(), "just some bytes");
    await expect(writeOpenBotAgent(ctx, ada, REPLACE)).rejects.toThrow(
      `Refusing to replace ${first()}: it holds no OpenTeleport marker, so it is not an archive ` +
        "OpenTeleport wrote. Delete it yourself if you mean it.",
    );
    expect(await readFile(first(), "utf8")).toBe("just some bytes");
    expect(await readdir(cwd)).toEqual(["ada-openbot-import.zip"]);
  });

  it("with --replace is refused when it is a folder", async () => {
    await mkdir(first());
    await expect(writeOpenBotAgent(ctx, ada, REPLACE)).rejects.toThrow(
      /Refusing to replace .*ada-openbot-import\.zip: it is not a file/,
    );
  });

  it("with --replace is simply written when nothing is there", async () => {
    const result = await writeOpenBotAgent(ctx, ada, REPLACE);
    expect(result.artifactPath).toBe(first());
  });

  it.runIf(canSymlink)("is never written through when it is a link", async () => {
    const target = join(root, "target.zip");
    await writeFile(target, "the link leads here");
    await symlink(target, first(), "file");

    const result = await writeOpenBotAgent(ctx, ada, DEFAULT);

    expect(result.artifactPath).toBe(second());
    expect(await readFile(target, "utf8")).toBe("the link leads here");
    await expect(writeOpenBotAgent(ctx, ada, REPLACE)).rejects.toThrow(
      /Refusing to replace .*: it is a symbolic link/,
    );
    expect(await readFile(target, "utf8")).toBe("the link leads here");
  });
});
