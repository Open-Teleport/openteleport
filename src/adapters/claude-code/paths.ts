import { dirname, isAbsolute, join, resolve } from "node:path";
import { lstatIfAny } from "../fs.js";
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
  /** Map an already resolved project root to its memory path; see `claudeMemoryDir`. */
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

/**
 * Claude Code shares auto memory across a repository's main checkout, worktrees and subfolders.
 * Git's NUL-delimited worktree listing identifies the primary checkout even with spaces,
 * non-ASCII paths, nested repositories or a separate Git directory. Plain folders need no Git.
 */
async function memoryRoot(ctx: Ctx, project: string): Promise<string> {
  let directory = project;
  for (;;) {
    if ((await lstatIfAny(join(directory, ".git"))) !== undefined) break;
    const parent = dirname(directory);
    if (parent === directory) return project;
    directory = parent;
  }
  // Caller-provided Git routing variables must not point this lookup at an unrelated repo.
  const env = Object.fromEntries(
    Object.entries(ctx.env).filter(([name]) => !/^GIT_/i.test(name)),
  );
  let primary: string | undefined;
  try {
    const result = await ctx.exec(
      "git", ["--no-optional-locks", "-C", directory, "worktree", "list", "--porcelain", "-z"],
      { env: { ...env, HOME: ctx.home, USERPROFILE: ctx.home, GIT_TERMINAL_PROMPT: "0" },
        extendEnv: false, timeout: 5000, maxBuffer: 1024 * 1024, reject: false },
    );
    const first = result.stdout.split("\0")[0];
    if (result.exitCode === 0 && first?.startsWith("worktree ")) primary = first.slice(9);
  } catch (error) {
    throw new Error(`Cannot resolve Claude Code memory for ${project}: Git lookup failed.`, { cause: error });
  }
  if (!primary || !isAbsolute(primary)) {
    throw new Error(`Cannot resolve Claude Code memory for ${project}: Git did not report a primary worktree.`);
  }
  return resolve(primary);
}

/** Native auto-memory location; agent identity sidecars remain scoped to each checkout. */
export async function claudeMemoryDir(ctx: Ctx, paths: ClaudePaths): Promise<string> {
  // Native Claude Code 2.1.273 accepts this override only beside CLAUDE_CONFIG_DIR and with
  // this portable component grammar. Invalid values fall back to the repository-derived key.
  const override = ctx.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  if (ctx.env.CLAUDE_CONFIG_DIR && override && /^[A-Za-z0-9_-]{1,64}$/.test(override) &&
      !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(override)) {
    return join(paths.userDir, "projects", override, "memory");
  }
  return paths.memoryDir(await memoryRoot(ctx, paths.projectDir));
}
