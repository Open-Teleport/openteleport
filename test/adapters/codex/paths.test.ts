import { join, resolve } from "node:path";
import type { execa } from "execa";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT,
  DETECT_FILES,
  IDS_FILE,
  agentsDir,
  codexHome,
  legacySkillsDir,
  userSkillsDir,
} from "../../../src/adapters/codex/paths.js";
import type { Ctx } from "../../../src/adapters/types.js";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

const home = resolve("/people/ada");
const cwd = resolve("/work/project");

function ctxOf(overrides: Partial<Ctx> = {}): Ctx {
  return { home, cwd, env: {}, exec: noExec, logger: () => {}, ...overrides };
}

describe("codexHome", () => {
  it("is ~/.codex without CODEX_HOME or a directory option", () => {
    expect(codexHome(ctxOf())).toBe(join(home, ".codex"));
  });

  it("takes CODEX_HOME from the environment of the context", () => {
    const fromEnv = resolve("/elsewhere/codex-home");
    expect(codexHome(ctxOf({ env: { CODEX_HOME: fromEnv } }))).toBe(fromEnv);
  });

  it("ignores an empty CODEX_HOME", () => {
    expect(codexHome(ctxOf({ env: { CODEX_HOME: "" } }))).toBe(join(home, ".codex"));
  });

  it("lets --source-dir win over everything else", () => {
    const source = resolve("/chosen/source");
    const ctx = ctxOf({
      sourceDir: source,
      targetDir: resolve("/chosen/target"),
      env: { CODEX_HOME: resolve("/elsewhere/codex-home") },
    });
    expect(codexHome(ctx)).toBe(source);
  });

  it("lets --target-dir win over CODEX_HOME", () => {
    const target = resolve("/chosen/target");
    const ctx = ctxOf({ targetDir: target, env: { CODEX_HOME: resolve("/elsewhere/codex-home") } });
    expect(codexHome(ctx)).toBe(target);
  });

  it("takes a relative directory from the working directory", () => {
    expect(codexHome(ctxOf({ sourceDir: "codex-copy" }))).toBe(join(cwd, "codex-copy"));
  });
});

describe("the other locations", () => {
  it("keeps the user skills in <home>/.agents/skills, whatever CODEX_HOME says", () => {
    const ctx = ctxOf({ sourceDir: resolve("/chosen/source") });
    expect(userSkillsDir(ctx)).toBe(join(home, ".agents", "skills"));
  });

  it("puts the deprecated skills and the agents below the Codex home", () => {
    const codex = resolve("/chosen/source");
    expect(legacySkillsDir(codex)).toBe(join(codex, "skills"));
    expect(agentsDir(codex)).toBe(join(codex, "agents"));
  });

  it("names the files and the agent the adapter knows", () => {
    expect(IDS_FILE).toBe("openteleport-ids.json");
    expect(DEFAULT_AGENT).toBe("default");
    expect(DETECT_FILES).toEqual(["config.toml", "AGENTS.md", "auth.json", "agents", "memories"]);
  });
});
