import { join, resolve } from "node:path";
import type { Ctx } from "../types.js";

/** The file beside `config.toml` that maps an agent file's name to the id it was moved with. */
export const IDS_FILE = "openteleport-ids.json";

/** The id of the global setup (`AGENTS.md` and the user's skills) among the agents `list` shows. */
export const DEFAULT_AGENT = "default";

/**
 * What a Codex home holds as soon as Codex has run: a fresh installation has only `auth.json`
 * (C5). Any of them is enough for `detect`.
 */
export const DETECT_FILES = ["config.toml", "AGENTS.md", "auth.json", "agents", "memories"] as const;

/**
 * The Codex home (`CODEX_HOME`): `ctx.sourceDir`, else `ctx.targetDir`, else `CODEX_HOME` of the
 * context's environment, else `<home>/.codex`, which is the default on Windows too. A relative
 * directory is taken from `ctx.cwd`. The process environment is never read.
 */
export function codexHome(ctx: Ctx): string {
  const fromEnv = ctx.env.CODEX_HOME === "" ? undefined : ctx.env.CODEX_HOME;
  const dir = ctx.sourceDir ?? ctx.targetDir ?? fromEnv ?? join(ctx.home, ".codex");
  return resolve(ctx.cwd, dir);
}

/**
 * The user's skills, shared with every other tool that reads `~/.agents/skills`. It does not
 * move with the Codex home.
 */
export function userSkillsDir(ctx: Ctx): string {
  return join(ctx.home, ".agents", "skills");
}

/** The deprecated skills folder of a Codex home: still read, never written. */
export function legacySkillsDir(home: string): string {
  return join(home, "skills");
}

/** Where Codex looks for custom agents: one `<name>.toml` each. `home` is the Codex home. */
export function agentsDir(home: string): string {
  return join(home, "agents");
}
