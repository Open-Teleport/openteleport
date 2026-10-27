import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Adapter, Ctx } from "../types.js";
import { claudePaths } from "./paths.js";
import { listAgents, readAgent } from "./read.js";
import { writeAgent } from "./write.js";

const NOT_FOUND_HINT = "Pass --source-dir <project with .claude/agents>";
const VERSION_TIMEOUT_MS = 10_000;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The version `claude --version` prints, such as `2.1.273`; `undefined` when it cannot run. */
async function claudeVersion(ctx: Ctx): Promise<string | undefined> {
  try {
    const { stdout } = await ctx.exec("claude", ["--version"], { timeout: VERSION_TIMEOUT_MS });
    const text = String(stdout).trim();
    return /\d+\.\d+\.\d+\S*/.exec(text)?.[0] ?? (text === "" ? undefined : text);
  } catch {
    return undefined;
  }
}

/** Found when the project has a `.claude` directory or the user's Claude Code directory exists. */
async function detect(ctx: Ctx): ReturnType<Adapter["detect"]> {
  const paths = claudePaths(ctx);
  const found =
    (await isDirectory(join(paths.projectDir, ".claude"))) || (await isDirectory(paths.userDir));
  const version = await claudeVersion(ctx);
  return {
    found,
    location: paths.projectDir,
    ...(version === undefined ? {} : { version }),
    ...(found ? {} : { hint: NOT_FOUND_HINT }),
  };
}

/**
 * Claude Code subagents: `.claude/agents/<name>.md` in a project (or `~/.claude/agents/` for the
 * user), the project's skills and its memory under `~/.claude/projects/`. Claude Code keeps
 * scheduled tasks in the cloud, so routines are not supported, and an agent has no avatar or
 * workspace of its own.
 */
export const claudeCodeAdapter: Adapter = {
  name: "claude-code",
  displayName: "Claude Code",
  capabilities: {
    persona: true,
    instructions: true,
    skills: true,
    routines: false,
    facts: true,
    notes: true,
    files: false,
    avatar: false,
    models: true,
    schedules: [],
  },
  detect,
  list: listAgents,
  read: readAgent,
  write: writeAgent,
};

export default claudeCodeAdapter;
