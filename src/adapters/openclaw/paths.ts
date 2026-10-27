import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSON5 from "json5";
import type { Ctx } from "../types.js";

/** How an agent presents itself. `avatar` is a workspace-relative path, a URL or a data URI. */
export type OpenClawIdentity = { name?: string; emoji?: string; theme?: string; avatar?: string };

/** One agent under `agents.entries.<id>` in `openclaw.json`. */
export type OpenClawAgentEntry = {
  name?: string;
  workspace?: string;
  /** `"provider/model"`, or a primary model with fallbacks in the same form. */
  model?: string | { primary: string; fallbacks?: string[] };
  /** Allowlist of skill names the agent may use; absent means every skill. */
  skills?: string[];
  identity?: OpenClawIdentity;
  /** `{ type: "acp", acp: { agent: "codex" } }` runs the agent through an external harness. */
  runtime?: { type?: string; acp?: { agent?: string } };
};

/** The part of `openclaw.json` the adapter uses. */
export type OpenClawConfig = {
  agents?: {
    defaults?: { workspace?: string };
    entries?: Record<string, OpenClawAgentEntry>;
  };
};

export type OpenClawPaths = {
  stateDir: string;
  configFile: string;
  workspaceFor(agentId: string, cfg: OpenClawConfig): string;
};

/** The id OpenClaw gives the agent of an install that configures none. */
export const DEFAULT_AGENT_ID = "main";

/** `~` alone or followed by a separator stands for the home directory. */
function expandHome(path: string, home: string): string {
  return /^~(?=$|[\\/])/.test(path) ? join(home, path.slice(1)) : path;
}

/**
 * Where an OpenClaw install keeps its state. The state directory is `sourceDir`, else
 * `targetDir`, else `OPENCLAW_STATE_DIR`, else `<home>/.openclaw`; the config file is
 * `OPENCLAW_CONFIG_PATH`, else `<state dir>/openclaw.json`. Every path has `~` expanded to
 * `ctx.home` and is made absolute against `ctx.cwd`.
 */
export function openclawPaths(ctx: Ctx): OpenClawPaths {
  const absolute = (path: string): string => resolve(ctx.cwd, expandHome(path, ctx.home));
  const stateDir = absolute(
    ctx.sourceDir ?? ctx.targetDir ?? ctx.env.OPENCLAW_STATE_DIR ?? join(ctx.home, ".openclaw"),
  );
  const configFile = absolute(ctx.env.OPENCLAW_CONFIG_PATH ?? join(stateDir, "openclaw.json"));

  /**
   * The entry's own `workspace`; else `<agents.defaults.workspace>/<id>`; else
   * `<state dir>/workspace` for the only configured agent (or `main` when none is configured);
   * else `<state dir>/workspace-<id>`.
   */
  function workspaceFor(agentId: string, cfg: OpenClawConfig): string {
    const entries = cfg.agents?.entries ?? {};
    const own = entries[agentId]?.workspace;
    if (typeof own === "string" && own.trim() !== "") return absolute(own);
    const shared = cfg.agents?.defaults?.workspace;
    if (typeof shared === "string" && shared.trim() !== "") return join(absolute(shared), agentId);
    const ids = Object.keys(entries);
    const onlyAgent =
      ids.length === 0 ? agentId === DEFAULT_AGENT_ID : ids.length === 1 && ids[0] === agentId;
    return join(stateDir, onlyAgent ? "workspace" : `workspace-${agentId}`);
  }

  return { stateDir, configFile, workspaceFor };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads `openclaw.json`, which is JSON5 (comments and trailing commas allowed). A missing file is
 * an empty config, since an install can run without one. Only the top level is checked; the
 * fields the adapter uses are checked where they are read.
 */
export async function readOpenClawConfig(file: string): Promise<OpenClawConfig> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let config: unknown;
  try {
    config = JSON5.parse(source);
  } catch (error) {
    throw new Error(`${file} is not valid JSON5: ${(error as Error).message}`, { cause: error });
  }
  if (!isRecord(config)) throw new Error(`${file} is not an object`);
  return config as OpenClawConfig;
}
