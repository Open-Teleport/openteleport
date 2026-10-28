import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DB_FILE,
  KNOWN_SCHEMA_VERSION,
  openBotUserData,
  zipSource,
} from "../../../src/adapters/openbot/paths.js";
import type { Ctx } from "../../../src/adapters/types.js";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let root: string;
let ctx: Ctx;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-openbot-paths-"));
  ctx = { home: join(root, "home"), cwd: join(root, "cwd"), env: {}, exec: noExec, logger: () => {} };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("openBotUserData", () => {
  it("is %APPDATA%\OpenBot on Windows, from ctx.env", () => {
    const withAppData: Ctx = { ...ctx, env: { APPDATA: join(root, "roaming") } };
    expect(openBotUserData(withAppData, "win32")).toBe(join(root, "roaming", "OpenBot"));
  });

  it("falls back to <home>/AppData/Roaming/OpenBot on Windows without APPDATA", () => {
    expect(openBotUserData(ctx, "win32")).toBe(join(ctx.home, "AppData", "Roaming", "OpenBot"));
    expect(openBotUserData({ ...ctx, env: { APPDATA: "" } }, "win32")).toBe(
      join(ctx.home, "AppData", "Roaming", "OpenBot"),
    );
  });

  it("is <home>/Library/Application Support/OpenBot on macOS", () => {
    expect(openBotUserData(ctx, "darwin")).toBe(
      join(ctx.home, "Library", "Application Support", "OpenBot"),
    );
  });

  it("is <home>/.config/OpenBot on Linux and anywhere else", () => {
    expect(openBotUserData(ctx, "linux")).toBe(join(ctx.home, ".config", "OpenBot"));
    expect(openBotUserData(ctx, "freebsd")).toBe(join(ctx.home, ".config", "OpenBot"));
  });

  it("does not read APPDATA off Windows", () => {
    const withAppData: Ctx = { ...ctx, env: { APPDATA: join(root, "roaming") } };
    expect(openBotUserData(withAppData, "linux")).toBe(join(ctx.home, ".config", "OpenBot"));
  });

  it("takes --source-dir, else --target-dir, over every default", () => {
    const given = join(root, "given");
    const other = join(root, "other");
    expect(openBotUserData({ ...ctx, sourceDir: given }, "win32")).toBe(given);
    expect(openBotUserData({ ...ctx, targetDir: other }, "darwin")).toBe(other);
    expect(openBotUserData({ ...ctx, sourceDir: given, targetDir: other }, "linux")).toBe(given);
  });

  it("names the folder of the real platform by default", () => {
    expect(openBotUserData(ctx)).toBe(openBotUserData(ctx, process.platform));
  });
});

describe("constants", () => {
  it("name the database file and the last schema version the adapter knows", () => {
    expect(DB_FILE).toBe("openbot.db");
    expect(KNOWN_SCHEMA_VERSION).toBe(47);
  });
});

describe("zipSource", () => {
  it("is the path of --source-dir when it is a .zip file", async () => {
    const file = join(root, "export.zip");
    await writeFile(file, "not looked into here");
    expect(await zipSource({ ...ctx, sourceDir: file })).toBe(file);
    const upper = join(root, "EXPORT.ZIP");
    await writeFile(upper, "x");
    expect(await zipSource({ ...ctx, sourceDir: upper })).toBe(upper);
  });

  it("is undefined without --source-dir, for a folder, a missing path and another file", async () => {
    expect(await zipSource(ctx)).toBeUndefined();
    expect(await zipSource({ ...ctx, sourceDir: root })).toBeUndefined();
    const folderNamedLikeZip = join(root, "folder.zip");
    await mkdir(folderNamedLikeZip);
    expect(await zipSource({ ...ctx, sourceDir: folderNamedLikeZip })).toBeUndefined();
    expect(await zipSource({ ...ctx, sourceDir: join(root, "missing.zip") })).toBeUndefined();
    const text = join(root, "notes.txt");
    await writeFile(text, "x");
    expect(await zipSource({ ...ctx, sourceDir: text })).toBeUndefined();
  });

  it("does not look at --target-dir", async () => {
    const file = join(root, "export.zip");
    await writeFile(file, "x");
    expect(await zipSource({ ...ctx, targetDir: file })).toBeUndefined();
  });
});
