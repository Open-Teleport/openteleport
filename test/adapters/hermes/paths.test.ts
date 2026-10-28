import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  PROFILE_FILES,
  hermesHome,
  hermesTimezone,
  isProfile,
  profileDir,
  readConfig,
} from "../../../src/adapters/hermes/paths.js";
import type { Ctx } from "../../../src/adapters/types.js";

const FIXTURE_HOME = fileURLToPath(new URL("../../fixtures/hermes/home", import.meta.url));

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-hermes-paths-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctxOf = (overrides: Partial<Ctx> = {}): Ctx => ({
  home: join(root, "home"),
  cwd: join(root, "cwd"),
  env: {},
  exec: noExec,
  logger: () => {},
  ...overrides,
});

describe("hermesHome", () => {
  it("is <home>/.hermes without any setting", () => {
    const ctx = ctxOf();
    expect(hermesHome(ctx, "linux")).toBe(join(ctx.home, ".hermes"));
  });

  it("takes HERMES_HOME from the environment", () => {
    const ctx = ctxOf({ env: { HERMES_HOME: join(root, "elsewhere") } });
    expect(hermesHome(ctx, "linux")).toBe(join(root, "elsewhere"));
  });

  it("lets --source-dir win over --target-dir and HERMES_HOME", () => {
    const ctx = ctxOf({
      sourceDir: join(root, "source"),
      targetDir: join(root, "target"),
      env: { HERMES_HOME: join(root, "env") },
    });
    expect(hermesHome(ctx, "linux")).toBe(join(root, "source"));
  });

  it("lets --target-dir win over HERMES_HOME", () => {
    const ctx = ctxOf({ targetDir: join(root, "target"), env: { HERMES_HOME: join(root, "env") } });
    expect(hermesHome(ctx, "linux")).toBe(join(root, "target"));
  });

  it("is %LOCALAPPDATA%\\hermes on Windows", () => {
    const localAppData = join(root, "Local");
    const ctx = ctxOf({ env: { LOCALAPPDATA: localAppData } });
    expect(hermesHome(ctx, "win32")).toBe(resolve(ctx.cwd, join(localAppData, "hermes")));
  });

  it("falls back to <home>/AppData/Local/hermes on Windows without LOCALAPPDATA", () => {
    const ctx = ctxOf();
    expect(hermesHome(ctx, "win32")).toBe(join(ctx.home, "AppData", "Local", "hermes"));
  });

  it("still prefers HERMES_HOME on Windows", () => {
    const ctx = ctxOf({ env: { HERMES_HOME: join(root, "env"), LOCALAPPDATA: join(root, "Local") } });
    expect(hermesHome(ctx, "win32")).toBe(join(root, "env"));
  });

  it("ignores LOCALAPPDATA on other systems", () => {
    const ctx = ctxOf({ env: { LOCALAPPDATA: join(root, "Local") } });
    expect(hermesHome(ctx, "darwin")).toBe(join(ctx.home, ".hermes"));
  });

  it("makes a relative path absolute against the working directory", () => {
    const ctx = ctxOf({ sourceDir: "relative/hermes" });
    expect(hermesHome(ctx, "linux")).toBe(resolve(ctx.cwd, "relative/hermes"));
  });
});

describe("profileDir", () => {
  it("is the home itself for the default profile and profiles/<id> for a named one", () => {
    expect(DEFAULT_PROFILE).toBe("default");
    expect(profileDir("/h", DEFAULT_PROFILE)).toBe("/h");
    expect(profileDir("/h", "reviewer")).toBe(join("/h", "profiles", "reviewer"));
  });

  it.each(["", "..", ".", "a/b", "a\\b", "../x", "C:x"])("refuses the id %j", (id) => {
    expect(() => profileDir("/h", id)).toThrow(/profile/i);
  });
});

describe("isProfile", () => {
  it("lists the six files Hermes knows a profile by", () => {
    expect(PROFILE_FILES).toEqual([
      "config.yaml",
      ".env",
      "SOUL.md",
      "profile.yaml",
      "auth.json",
      "state.db",
    ]);
  });

  it("is true for a directory that holds only state.db", async () => {
    const dir = join(root, "p");
    await mkdir(dir);
    await writeFile(join(dir, "state.db"), "");
    expect(await isProfile(dir)).toBe(true);
  });

  it.each(PROFILE_FILES)("is true for a directory that holds %s", async (name) => {
    const dir = join(root, "p");
    await mkdir(dir);
    await writeFile(join(dir, name), "");
    expect(await isProfile(dir)).toBe(true);
  });

  it("is false for an empty directory, a missing one and one with other files", async () => {
    const dir = join(root, "p");
    await mkdir(dir);
    expect(await isProfile(dir)).toBe(false);
    await writeFile(join(dir, "notes.md"), "");
    expect(await isProfile(dir)).toBe(false);
    expect(await isProfile(join(root, "missing"))).toBe(false);
  });

  it("is false when a profile file name is a directory", async () => {
    const dir = join(root, "p");
    await mkdir(join(dir, "config.yaml"), { recursive: true });
    expect(await isProfile(dir)).toBe(false);
  });

  it("counts a dangling link in place of a profile file, as Hermes does", async (task) => {
    const dir = join(root, "p");
    await mkdir(dir);
    try {
      await symlink(join(root, "nowhere"), join(dir, "SOUL.md"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") task.skip();
      throw error;
    }
    expect(await isProfile(dir)).toBe(true);
  });

  it("is true for the profiles in the fixture", async () => {
    expect(await isProfile(FIXTURE_HOME)).toBe(true);
    expect(await isProfile(join(FIXTURE_HOME, "profiles", "reviewer"))).toBe(true);
  });
});

describe("readConfig", () => {
  it("is undefined when there is no config.yaml", async () => {
    expect(await readConfig(root)).toBeUndefined();
  });

  it("reads the fields the adapter uses and keeps the whole mapping as raw", async () => {
    const read = await readConfig(FIXTURE_HOME);
    expect(read?.config).toEqual({
      model: { default: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
      timezone: "Europe/Warsaw",
      memory: { memory_char_limit: 2200 },
    });
    expect(read?.raw).toMatchObject({ timezone: "Europe/Warsaw" });
  });

  it("reads the base URL and the manual system prompt", async () => {
    await writeFile(
      join(root, "config.yaml"),
      "model:\n  default: m\n  base_url: https://example.test/v1\nagent:\n  system_prompt: Be brief.\nother: 1\n",
    );
    const read = await readConfig(root);
    expect(read?.config.model).toEqual({ default: "m", base_url: "https://example.test/v1" });
    expect(read?.config.agent).toEqual({ system_prompt: "Be brief." });
    expect(read?.raw).toMatchObject({ other: 1 });
  });

  it("reads a plain string model as the default model", async () => {
    await writeFile(join(root, "config.yaml"), "model: anthropic/claude-opus-4\n");
    expect((await readConfig(root))?.config.model).toEqual({ default: "anthropic/claude-opus-4" });
  });

  it("leaves out values of the wrong type", async () => {
    await writeFile(
      join(root, "config.yaml"),
      "model: 5\ntimezone: 3\nmemory:\n  memory_char_limit: lots\n  user_char_limit: 10\nagent: []\n",
    );
    expect((await readConfig(root))?.config).toEqual({ memory: { user_char_limit: 10 } });
  });

  it("reads an empty file as an empty config", async () => {
    await writeFile(join(root, "config.yaml"), "");
    expect(await readConfig(root)).toEqual({ config: {}, raw: {} });
  });

  it("throws, naming the file, for YAML that does not parse or is not a mapping", async () => {
    await writeFile(join(root, "config.yaml"), "a: [1, 2\n");
    await expect(readConfig(root)).rejects.toThrow(/config\.yaml/);
    await writeFile(join(root, "config.yaml"), "- a\n- b\n");
    await expect(readConfig(root)).rejects.toThrow(/config\.yaml is not a mapping/);
  });
});

describe("hermesTimezone", () => {
  it("takes HERMES_TIMEZONE first", () => {
    const ctx = ctxOf({ env: { HERMES_TIMEZONE: "America/New_York" } });
    expect(hermesTimezone(ctx, { timezone: "Europe/Warsaw" })).toBe("America/New_York");
  });

  it("then the timezone of the config", () => {
    expect(hermesTimezone(ctxOf(), { timezone: "Europe/Warsaw" })).toBe("Europe/Warsaw");
  });

  it("then the zone of the process", () => {
    expect(hermesTimezone(ctxOf(), undefined)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(hermesTimezone(ctxOf(), {})).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("skips a value that is blank or not a time zone", () => {
    const ctx = ctxOf({ env: { HERMES_TIMEZONE: "  " } });
    expect(hermesTimezone(ctx, { timezone: "Mars/Olympus" })).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    const second = ctxOf({ env: { HERMES_TIMEZONE: "Nowhere/Land" } });
    expect(hermesTimezone(second, { timezone: "Europe/Warsaw" })).toBe("Europe/Warsaw");
  });
});
