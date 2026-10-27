import { join, resolve } from "node:path";
import type { Ctx } from "../types.js";

/** Claude Code cuts a sanitized project path to this length and appends a hash. */
const MAX_SANITIZED_CHARS = 200;

/** Java's `String.hashCode`: the 32-bit hash Claude Code appends to a cut name. */
function hashCode(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

/**
 * The directory name Claude Code gives a project under `<config>/projects/`: every UTF-16 code
 * unit outside `[A-Za-z0-9]` becomes `-` (`C:\dev\OpenSI` → `C--dev-OpenSI`, `/home/u/proj` →
 * `-home-u-proj`). A result over 200 characters is cut to 200 and gets `-<hash>` in base 36, the
 * hash taken over the whole path. Rule read from Claude Code 2.1.273.
 */
export function sanitize(path: string): string {
  const name = path.replace(/[^A-Za-z0-9]/g, "-");
  if (name.length <= MAX_SANITIZED_CHARS) return name;
  return `${name.slice(0, MAX_SANITIZED_CHARS)}-${Math.abs(hashCode(path)).toString(36)}`;
}

export type ClaudePaths = {
  projectDir: string;
  /** `<project>/.claude/agents`: subagent definitions, one `<name>.md` each. */
  projectAgents: string;
  /** `<project>/.claude/skills`: Agent Skills shared by the whole project. */
  projectSkills: string;
  /** `CLAUDE_CONFIG_DIR`, or `<home>/.claude`. */
  userDir: string;
  userAgents: string;
  userSkills: string;
  /** Where Claude Code keeps `MEMORY.md` and the other memory files for a project. */
  memoryDir(projectDir: string): string;
};

/**
 * Where Claude Code keeps its files. The project is `projectDir` when given, otherwise
 * `ctx.sourceDir`, `ctx.targetDir` or `ctx.cwd`, in that order; a relative one is taken from
 * `ctx.cwd`. The user directory comes from `ctx.env` and `ctx.home` only, never from the process.
 */
export function claudePaths(
  ctx: Ctx,
  projectDir: string = ctx.sourceDir ?? ctx.targetDir ?? ctx.cwd,
): ClaudePaths {
  const project = resolve(ctx.cwd, projectDir);
  const configDir = ctx.env.CLAUDE_CONFIG_DIR;
  const userDir = configDir === undefined || configDir === "" ? join(ctx.home, ".claude") : configDir;
  return {
    projectDir: project,
    projectAgents: join(project, ".claude", "agents"),
    projectSkills: join(project, ".claude", "skills"),
    userDir,
    userAgents: join(userDir, "agents"),
    userSkills: join(userDir, "skills"),
    memoryDir: (dir) => join(userDir, "projects", sanitize(resolve(ctx.cwd, dir)), "memory"),
  };
}
