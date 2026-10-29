import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSON5 from "json5";
import { isRecord } from "../../core/values.js";
import type { Ctx } from "../types.js";

/** How an agent presents itself. `avatar` is a workspace-relative path, a URL or a data URI. */
export type OpenClawIdentity = { name?: string; emoji?: string; theme?: string; avatar?: string };

/**
 * One agent of the roster in `openclaw.json`: under `agents.entries.<id>`, keyed by id (OpenClaw
 * 2026.6 and later), or an element of the `agents.list` array that names its `id` (up to
 * 2026.5.28).
 */
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
    defaults?: { workspace?: string; systemAgent?: { agentId?: string } };
    /** The keyed roster, OpenClaw 2026.6 and later. */
    entries?: Record<string, OpenClawAgentEntry>;
    /** The roster as an array, up to 2026.5.28; each element names its `id`. */
    list?: (OpenClawAgentEntry & { id?: unknown; default?: unknown })[];
  };
};

/**
 * The roster by id, whichever form the config keeps it in: the elements of `agents.list` that
 * name an id, then `agents.entries`, which wins for an id in both. An element or entry that is
 * not an object counts as an empty one; an element without an id is left out.
 */
export function agentEntries(cfg: OpenClawConfig): Record<string, OpenClawAgentEntry> {
  const roster: Record<string, OpenClawAgentEntry> = Object.create(null);
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    for (const element of list) {
      if (!isRecord(element)) continue;
      const id = element.id;
      if (typeof id === "string" && id !== "") roster[id] = element as OpenClawAgentEntry;
    }
  }
  const entries = cfg.agents?.entries;
  if (isRecord(entries)) {
    for (const [id, entry] of Object.entries(entries)) {
      roster[id] = isRecord(entry) ? (entry as OpenClawAgentEntry) : {};
    }
  }
  return roster;
}

/**
 * The agent whose workspace is `agents.defaults.workspace` itself (or `<state dir>/workspace`).
 * In an `agents.list` roster: the element marked `default`, else the first, else `main`, as
 * OpenClaw 2026.5.28 picks it. In a keyed roster: `agents.defaults.systemAgent.agentId`, which
 * OpenClaw 2026.10 writes; without it the only agent, or `main` when none is configured, and
 * none of several (not checked on an install).
 */
export function defaultAgentId(cfg: OpenClawConfig): string | undefined {
  const list = cfg.agents?.list;
  if (Array.isArray(list)) {
    const elements = list.filter(isRecord);
    const chosen = elements.find((element) => Boolean(element.default)) ?? elements[0];
    const id = chosen?.id;
    return typeof id === "string" && id !== "" ? id : DEFAULT_AGENT_ID;
  }
  const designated = cfg.agents?.defaults?.systemAgent?.agentId;
  if (typeof designated === "string" && designated.trim() !== "") return designated;
  const ids = Object.keys(agentEntries(cfg));
  if (ids.length === 0) return DEFAULT_AGENT_ID;
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Where the config keeps agent `id`, as a path for `openclaw config set`: `agents.entries.<id>`
 * when it is keyed there, `agents.list[<index>]` when it is in the array, `undefined` when it
 * is in neither.
 */
export function agentConfigPath(cfg: OpenClawConfig, id: string): string | undefined {
  const entries = cfg.agents?.entries;
  if (isRecord(entries) && Object.hasOwn(entries, id)) return `agents.entries.${id}`;
  const list = cfg.agents?.list;
  const index = Array.isArray(list)
    ? list.findIndex((element) => isRecord(element) && element.id === id)
    : -1;
  return index === -1 ? undefined : `agents.list[${index}]`;
}

export type OpenClawPaths = {
  stateDir: string;
  configFile: string;
  workspaceFor(agentId: string, cfg: OpenClawConfig): string;
};

/** The id OpenClaw gives the agent of an install that configures none. */
export const DEFAULT_AGENT_ID = "main";

/**
 * Throws unless `agentId` is a single path segment: not empty, not `.` or `..`, no `/` or `\`
 * and no drive prefix such as `C:`. Workspace paths are built from it.
 */
export function assertAgentId(agentId: string): void {
  const segment =
    agentId !== "" &&
    agentId !== "." &&
    agentId !== ".." &&
    !/[\\/]/.test(agentId) &&
    !/^[A-Za-z]:/.test(agentId);
  if (!segment) {
    throw new Error(
      `invalid OpenClaw agent id ${JSON.stringify(agentId)}: it must be a single path segment`,
    );
  }
}

/** `~` alone or followed by a separator stands for the home directory. */
function expandHome(path: string, home: string): string {
  return /^~(?=$|[\\/])/.test(path) ? join(home, path.slice(1)) : path;
}

/**
 * Where an OpenClaw install keeps its state. The state directory is `sourceDir`, else
 * `targetDir`, else `OPENCLAW_STATE_DIR`, else `<home>/.openclaw`. A directory passed in
 * explicitly (`sourceDir` or `targetDir`) holds its own config, `<dir>/openclaw.json`; only
 * without one does `OPENCLAW_CONFIG_PATH` name the config file. Every path has `~` expanded to
 * `ctx.home` and is made absolute against `ctx.cwd`.
 */
export function openclawPaths(ctx: Ctx): OpenClawPaths {
  const absolute = (path: string): string => resolve(ctx.cwd, expandHome(path, ctx.home));
  const explicitDir = ctx.sourceDir ?? ctx.targetDir;
  const stateDir = absolute(
    explicitDir ?? ctx.env.OPENCLAW_STATE_DIR ?? join(ctx.home, ".openclaw"),
  );
  const configOverride = explicitDir === undefined ? ctx.env.OPENCLAW_CONFIG_PATH : undefined;
  const configFile =
    configOverride === undefined ? join(stateDir, "openclaw.json") : absolute(configOverride);

  /**
   * The entry's own `workspace`; else, for the default agent (`defaultAgentId`),
   * `agents.defaults.workspace` itself or `<state dir>/workspace`; else
   * `<agents.defaults.workspace>/<id>` or `<state dir>/workspace-<id>`. This is OpenClaw
   * 2026.5.28's own rule (its `resolveAgentWorkspaceDir`); 2026.10 writes every entry's
   * workspace out, so the rule only fills gaps there. Throws for an id that is not a single
   * path segment.
   */
  function workspaceFor(agentId: string, cfg: OpenClawConfig): string {
    assertAgentId(agentId);
    const own = agentEntries(cfg)[agentId]?.workspace;
    if (typeof own === "string" && own.trim() !== "") return absolute(own);
    const shared = cfg.agents?.defaults?.workspace;
    const named = typeof shared === "string" && shared.trim() !== "" ? absolute(shared) : undefined;
    if (agentId === defaultAgentId(cfg)) return named ?? join(stateDir, "workspace");
    return named === undefined ? join(stateDir, `workspace-${agentId}`) : join(named, agentId);
  }

  return { stateDir, configFile, workspaceFor };
}

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
