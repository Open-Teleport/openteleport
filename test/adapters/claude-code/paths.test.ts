import { join, resolve } from "node:path";
import type { execa } from "execa";
import { describe, expect, it } from "vitest";
import { claudePaths, sanitize } from "../../../src/adapters/claude-code/paths.js";
import type { Ctx } from "../../../src/adapters/types.js";

const exec = (() => {
  throw new Error("paths run no commands");
}) as unknown as typeof execa;

const HOME = resolve("/tmp/home");
const CWD = resolve("/tmp/cwd");

const ctxWith = (overrides: Partial<Ctx> = {}): Ctx => ({
  home: HOME,
  cwd: CWD,
  env: {},
  exec,
  logger: () => {},
  ...overrides,
});

describe("sanitize", () => {
  // Every character outside [A-Za-z0-9] becomes one "-", as Claude Code names
  // ~/.claude/projects/<dir>. The rule was read from Claude Code 2.1.273 and matches the
  // directories it created on Windows.
  it.each([
    ["Windows", String.raw`C:\dev\OpenSI`, "C--dev-OpenSI"],
    ["Linux", "/home/u/proj", "-home-u-proj"],
    ["macOS", "/Users/ada/My Project", "-Users-ada-My-Project"],
    [
      "Windows, spaces and brackets",
      String.raw`C:\Program Files (x86)\Acme\APP`,
      "C--Program-Files--x86--Acme-APP",
    ],
    ["dots and underscores", "/srv/my_app.v2/.claude", "-srv-my-app-v2--claude"],
    ["a non-ASCII letter", String.raw`C:\Projekty\AsystenciGłosowi`, "C--Projekty-AsystenciG-osowi"],
  ])("pins the rule for %s", (_os, path, expected) => {
    expect(sanitize(path)).toBe(expected);
  });

  it("cuts a name over 200 characters and appends a hash of the whole path", () => {
    const path = `/home/ada/${"very-long-folder-name/".repeat(10)}project`;

    const name = sanitize(path);

    expect(name).toBe(`${path.replace(/[^A-Za-z0-9]/g, "-").slice(0, 200)}-txqsoh`);
    expect(sanitize(`${path}2`)).not.toBe(name);
  });

  it("leaves a name of exactly 200 characters whole", () => {
    const path = `/${"a".repeat(199)}`;
    expect(sanitize(path)).toBe(`-${"a".repeat(199)}`);
  });
});

describe("claudePaths", () => {
  it("prefers sourceDir, then targetDir, then cwd for the project", () => {
    const source = resolve("/tmp/source");
    const target = resolve("/tmp/target");

    expect(claudePaths(ctxWith({ sourceDir: source, targetDir: target })).projectDir).toBe(source);
    expect(claudePaths(ctxWith({ targetDir: target })).projectDir).toBe(target);
    expect(claudePaths(ctxWith()).projectDir).toBe(CWD);
  });

  it("takes an explicit project directory over the context", () => {
    const target = resolve("/tmp/target");
    expect(claudePaths(ctxWith({ sourceDir: resolve("/tmp/source") }), target).projectDir).toBe(
      target,
    );
  });

  it("lays out the project and user directories", () => {
    const paths = claudePaths(ctxWith());

    expect(paths.projectAgents).toBe(join(CWD, ".claude", "agents"));
    expect(paths.projectSkills).toBe(join(CWD, ".claude", "skills"));
    expect(paths.userDir).toBe(join(HOME, ".claude"));
    expect(paths.userAgents).toBe(join(HOME, ".claude", "agents"));
    expect(paths.userSkills).toBe(join(HOME, ".claude", "skills"));
  });

  it("puts memory under projects/<sanitized absolute project path>/memory", () => {
    const project = resolve("/work/My App");

    expect(claudePaths(ctxWith()).memoryDir(project)).toBe(
      join(HOME, ".claude", "projects", sanitize(project), "memory"),
    );
  });

  it("takes a relative project directory from ctx.cwd, not from the process", () => {
    const paths = claudePaths(ctxWith({ sourceDir: "app" }));

    expect(paths.projectDir).toBe(join(CWD, "app"));
    expect(paths.projectAgents).toBe(join(CWD, "app", ".claude", "agents"));
    expect(paths.memoryDir("app")).toBe(
      join(HOME, ".claude", "projects", sanitize(join(CWD, "app")), "memory"),
    );
  });

  it("uses CLAUDE_CONFIG_DIR instead of <home>/.claude", () => {
    const config = resolve("/tmp/claude-config");
    const paths = claudePaths(ctxWith({ env: { CLAUDE_CONFIG_DIR: config } }));

    expect(paths.userDir).toBe(config);
    expect(paths.userAgents).toBe(join(config, "agents"));
    expect(paths.memoryDir(CWD)).toBe(join(config, "projects", sanitize(CWD), "memory"));
  });

  it("ignores an empty CLAUDE_CONFIG_DIR", () => {
    expect(claudePaths(ctxWith({ env: { CLAUDE_CONFIG_DIR: "" } })).userDir).toBe(
      join(HOME, ".claude"),
    );
  });
});
