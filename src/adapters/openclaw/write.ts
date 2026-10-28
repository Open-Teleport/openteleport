// Writes a Bundle into an OpenClaw install. The agent is created (or found) and configured
// through the `openclaw` CLI; its workspace files are written directly, since they are plain
// files that OpenClaw reads as they are.
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import JSON5 from "json5";
import { ulid } from "ulid";
import { SecretsFoundError } from "../../core/engine.js";
import { isReservedDeviceName, isSafeArchivePath } from "../../core/paths.js";
import type { Item } from "../../core/report.js";
import { toOpenClawFlags } from "../../core/schedule.js";
import type { Bundle, ModelPref, Routine } from "../../core/schema.js";
import { scanSecrets } from "../../core/secrets.js";
import { factsToProse } from "../../core/text.js";
import { lstatIfAny } from "../fs.js";
import { MARKER_FILE, carriesMarker, renderMarker } from "../marker.js";
import type { Ctx, WriteOpts, WriteResult } from "../types.js";
import { type AgentRow, type JobRow, OpenClawCli, ShimLineBreakError } from "./cli.js";
import {
  DEFAULT_AGENT_ID,
  type OpenClawConfig,
  type OpenClawPaths,
  assertAgentId,
  openclawPaths,
  readOpenClawConfig,
} from "./paths.js";

const MAX_ID_CHARS = 32;
/** The note that carries the lines of `MEMORY.md` that are not facts. */
const MEMORY_PROSE_NOTE = "MEMORY-prose";
/** The note that is the workspace's `USER.md`. */
const USER_NOTE = "USER";
const DEFAULT_EMOJI = "🤖";
const RESTART_WARNING = "Restart the Gateway to load the new agent: openclaw gateway restart";
const GATEWAY_WARNING =
  "Routines need the Gateway, which did not answer; start it, then move the agent again: " +
  "openclaw gateway start";
const CAPABILITIES_DETAIL = "OpenClaw does not take capability declarations; defaults apply";
const REWRITE_WARNING = "openclaw.json rewritten; comments may be lost";

/**
 * The ACP agent OpenClaw runs for each runtime (`docs/tools/acp-agents.md`): our runtime names
 * first, then the ACP names themselves, which is how the read side reports a runtime.
 */
const ACP_AGENTS: ReadonlyMap<string, string> = new Map([
  ["codex", "codex"],
  ["claude-code", "claude"],
  ["gemini-cli", "gemini"],
  ["opencode", "opencode"],
  ["cursor", "cursor"],
  ["cline", "cline"],
  ["claude", "claude"],
  ["gemini", "gemini"],
]);

type Items = WriteResult["items"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed, non-empty string, or `undefined`. */
function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** One line of text: every run of whitespace, line breaks included, becomes one space. */
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * What a failed command said: its stderr when it has one, else the error message. (The message
 * of a failed command starts with the command line, which holds the routine's own text.)
 */
function errorOutput(error: unknown): string {
  const { message, stderr } = error as { message?: unknown; stderr?: unknown };
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr;
  return typeof message === "string" ? message : String(error);
}

/** The first non-blank line of what a failed command said. */
const reason = (error: unknown): string =>
  errorOutput(error)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/** Jobs go through the Gateway, so a job command that names it failed for want of it. */
const blamesGateway = (error: unknown): boolean => /gateway/i.test(errorOutput(error));

/** Says once per write that the routines need the Gateway started. */
function warnGatewayDown(items: Items): void {
  if (!items.warnings.includes(GATEWAY_WARNING)) items.warnings.push(GATEWAY_WARNING);
}

// -- Where the agent goes ----------------------------------------------------------------------

/**
 * The agent id for a name: lower case, every run of characters outside `a-z0-9` one `-`, dashes
 * trimmed, at most 32 characters. Nothing usable gives `agent`; a Windows device name such as
 * `con` gets `-r`, since its workspace folder could not be created there.
 */
function agentIdFor(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .slice(0, MAX_ID_CHARS)
    .replace(/-$/, "");
  if (base === "") return "agent";
  return isReservedDeviceName(base) ? `${base}-r` : base;
}

/** `<base>-<n>`, the base cut so that the whole stays within 32 characters. */
function withSuffix(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${base.slice(0, MAX_ID_CHARS - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/** The workspace of an agent OpenClaw has: the config's, else the CLI's, else the default. */
function existingWorkspace(
  paths: OpenClawPaths,
  cfg: OpenClawConfig,
  rows: AgentRow[],
  id: string,
): string {
  const entries = cfg.agents?.entries;
  const entry = isRecord(entries) && Object.hasOwn(entries, id) ? entries[id] : undefined;
  if (isRecord(entry) && label(entry.workspace) !== undefined) return paths.workspaceFor(id, cfg);
  const listed = rows.find((row) => row.id === id)?.workspace;
  return listed !== undefined && isAbsolute(listed) ? listed : paths.workspaceFor(id, cfg);
}

type Target = {
  id: string;
  workspace: string;
  /** `new` is created with `agents add`; `update` and `replace` write over an existing agent. */
  mode: "new" | "update" | "replace";
};

/**
 * The `<base>-N` agent (N from 2, in number order, gaps skipped) that OpenClaw knows and whose
 * workspace carries the marker of the agent with manifest id `id`, as an earlier move may have
 * left it; `undefined` when there is none.
 */
async function ownCopy(
  paths: OpenClawPaths,
  cfg: OpenClawConfig,
  rows: AgentRow[],
  known: ReadonlySet<string>,
  base: string,
  id: string,
): Promise<{ id: string; workspace: string } | undefined> {
  if (id === "") return undefined;
  const copies = [...known]
    .map((candidate) => ({ candidate, n: Number(/-([1-9]\d*)$/.exec(candidate)?.[1]) }))
    .filter(({ candidate, n }) => n >= 2 && candidate === withSuffix(base, n))
    .sort((a, b) => a.n - b.n);
  for (const { candidate } of copies) {
    const workspace = existingWorkspace(paths, cfg, rows, candidate);
    if (await carriesMarker(workspace, id)) return { id: candidate, workspace };
  }
  return undefined;
}

/**
 * Where the agent goes. An id is taken when OpenClaw knows an agent by it (the CLI or the
 * config) or when the workspace a new agent of that id would get already exists. A known agent
 * is written over with `replace`, and with `update` only when its workspace carries this
 * agent's marker: OpenClaw keeps no manifest id of its own, so the marker is the only proof that
 * the agent there is this one. When it does not, `update` looks for the `<id>-N` copy an earlier
 * move gave this agent and updates that one. Otherwise the agent becomes a copy under the first
 * free `<id>-2`, `<id>-3`..., with a warning unless a copy is what was asked for.
 */
async function claimTarget(
  paths: OpenClawPaths,
  cfg: OpenClawConfig,
  cli: OpenClawCli,
  bundle: Bundle,
  onConflict: WriteOpts["onConflict"],
  warnings: string[],
): Promise<Target> {
  const rows = await cli.agentsList();
  const entries = cfg.agents?.entries;
  const configured = isRecord(entries) ? Object.keys(entries) : [];
  const known = new Set([...rows.map((row) => row.id), ...configured]);
  const freshWorkspace = (id: string): string => join(paths.stateDir, `workspace-${id}`);
  const isFree = async (id: string): Promise<boolean> =>
    !known.has(id) && (await lstatIfAny(freshWorkspace(id))) === undefined;

  const base = agentIdFor(bundle.manifest.name);
  assertAgentId(base);
  if (known.has(base)) {
    const workspace = existingWorkspace(paths, cfg, rows, base);
    if (onConflict === "replace") return { id: base, workspace, mode: "replace" };
    if (onConflict === "update" && (await carriesMarker(workspace, bundle.manifest.id))) {
      return { id: base, workspace, mode: "update" };
    }
  } else if (await isFree(base)) {
    return { id: base, workspace: freshWorkspace(base), mode: "new" };
  }
  if (onConflict === "update") {
    const own = await ownCopy(paths, cfg, rows, known, base, bundle.manifest.id);
    if (own !== undefined) return { ...own, mode: "update" };
  }

  let n = 2;
  while (!(await isFree(withSuffix(base, n)))) n += 1;
  const id = withSuffix(base, n);
  if (onConflict !== "copy") {
    const taken = known.has(base)
      ? `agent '${base}' already exists`
      : `${freshWorkspace(base)} already exists`;
    warnings.push(`${taken}; written as '${id}'`);
  }
  return { id, workspace: freshWorkspace(id), mode: "new" };
}

// -- Workspace files ---------------------------------------------------------------------------

/**
 * Writes `data` to the `/`-separated path `rel` below `root`, creating directories as needed.
 * Never writes through a symbolic link (or junction) and never replaces anything but a regular
 * file; returns why when it does not write, `undefined` when it does.
 */
async function writeInside(
  root: string,
  rel: string,
  data: string | Uint8Array,
): Promise<string | undefined> {
  const segments = rel.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstatIfAny(current);
    if (info === undefined) break;
    const last = index === segments.length - 1;
    const shown = segments.slice(0, index + 1).join("/");
    if (info.isSymbolicLink()) {
      return last ? `${rel} is a symbolic link` : `${rel} is behind the symbolic link ${shown}`;
    }
    if (last && !info.isFile()) return `${rel} is not a regular file`;
    if (!last && !info.isDirectory()) return `${rel} is behind ${shown}, which is not a directory`;
  }
  const file = join(root, ...segments);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  return undefined;
}

/** A name that is one safe path segment: no separator, and safe as `<dir>/<name>`. */
const isSafeSegment = (name: string): boolean =>
  !/[\\/]/.test(name) && isSafeArchivePath(`x/${name}`);

/** The facts as a bullet list, then the `MEMORY-prose` note; `undefined` when both are empty. */
function memoryText(bundle: Bundle): string | undefined {
  const parts: string[] = [];
  const facts = factsToProse(bundle.facts);
  if (facts !== "") parts.push(facts);
  const prose = bundle.notes.find((note) => note.name === MEMORY_PROSE_NOTE)?.text.trimEnd();
  if (prose !== undefined && prose.trim() !== "") parts.push(prose);
  return parts.length === 0 ? undefined : `${parts.join("\n\n")}\n`;
}

/** `x-openclaw.identity.emoji` of the manifest, if it has one. */
function emojiOf(manifest: Bundle["manifest"]): string | undefined {
  const vendor = manifest["x-openclaw"];
  const identity = isRecord(vendor) ? vendor.identity : undefined;
  return isRecord(identity) ? label(identity.emoji) : undefined;
}

type Identity = { name: string; theme?: string; emoji: string; avatar?: string };

/** IDENTITY.md in OpenClaw's layout: one `- **Key:** value` line per field. */
function identityText(identity: Identity): string {
  const lines = ["# IDENTITY.md - Who Am I?", "", `- **Name:** ${identity.name}`];
  if (identity.theme !== undefined) lines.push(`- **Theme:** ${identity.theme}`);
  lines.push(`- **Emoji:** ${identity.emoji}`);
  if (identity.avatar !== undefined) lines.push(`- **Avatar:** ${identity.avatar}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Writes the workspace: `SOUL.md` (when there is a persona), `AGENTS.md`, `MEMORY.md` (when
 * there is memory), `USER.md` and `memory/<name>.md` for the notes, the skills, the avatar and
 * `IDENTITY.md`. A file that cannot be written safely is skipped and reported. Returns the
 * identity as written, with the avatar's workspace path when the avatar was written.
 */
async function writeWorkspace(workspace: string, bundle: Bundle, items: Items): Promise<Identity> {
  const skip = (field: string, detail: string): void => {
    items.skipped.push({ field, detail });
  };
  const put = async (rel: string, data: string | Uint8Array, field: string): Promise<boolean> => {
    const why = await writeInside(workspace, rel, data);
    if (why !== undefined) skip(field, `${why}; not written`);
    return why === undefined;
  };

  if (bundle.persona !== undefined && bundle.persona.trim() !== "") {
    await put("SOUL.md", bundle.persona, "persona");
  }
  await put("AGENTS.md", bundle.instructions, "instructions");
  const memory = memoryText(bundle);
  if (memory !== undefined) await put("MEMORY.md", memory, "memory.facts");

  for (const note of bundle.notes) {
    const field = `note:${note.name}`;
    if (note.name === MEMORY_PROSE_NOTE) continue;
    if (note.name === USER_NOTE) await put("USER.md", note.text, field);
    else if (!isSafeSegment(`${note.name}.md`)) skip(field, "unsafe name; not written");
    else await put(`memory/${note.name}.md`, note.text, field);
  }

  for (const skill of bundle.skills) {
    const field = `skill:${skill.name}`;
    if (!isSafeSegment(skill.name)) {
      skip(field, "unsafe name; not written");
      continue;
    }
    for (const file of skill.files) {
      const rel = `skills/${skill.name}/${file.path}`;
      if (isSafeArchivePath(rel)) await put(rel, file.bytes, field);
      else skip(field, `unsafe path '${file.path}'; not written`);
    }
  }

  const identity: Identity = {
    name: oneLine(bundle.manifest.name),
    emoji: oneLine(emojiOf(bundle.manifest) ?? DEFAULT_EMOJI),
  };
  const theme = label(bundle.manifest.title);
  if (theme !== undefined) identity.theme = oneLine(theme);
  if (bundle.avatar !== undefined) {
    const rel = `avatars/${bundle.avatar.name}`;
    if (!isSafeSegment(bundle.avatar.name)) {
      skip("avatar", `unsafe name '${bundle.avatar.name}'; not written`);
    } else if (await put(rel, bundle.avatar.bytes, "avatar")) {
      identity.avatar = rel;
    }
  }
  await put("IDENTITY.md", identityText(identity), "identity");
  return identity;
}

// -- Config ------------------------------------------------------------------------------------

/** Copies `file` next to itself as `<file>.bak-<timestamp>`, never over an earlier backup. */
async function backUp(file: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let n = 1; ; n += 1) {
    const backup = `${file}.bak-${stamp}${n === 1 ? "" : `-${n}`}`;
    try {
      await copyFile(file, backup, constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * Replaces `file` in one step, as `replaceCache` in `core/ids.ts` does: the content goes to a
 * sibling temporary file, which is then renamed over it, so a crash or a full disk leaves the
 * old file or the new one, never a truncated one, and a running Gateway never reads half of it.
 * The file keeps its mode (`openclaw.json` holds credentials; a new one is owner-only), and a
 * symbolic link stays one: the file it points to is replaced.
 */
async function replaceFile(file: string, content: string): Promise<void> {
  let real = file;
  try {
    real = await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let mode = 0o600;
  try {
    mode = (await stat(real)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${real}.${ulid()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    // The mode given to `writeFile` is narrowed by the umask; this sets it exactly.
    await chmod(temporary, mode);
    await rename(temporary, real);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Sets `values` on `agents.entries.<id>` by rewriting `openclaw.json` (JSON5) as JSON, after a
 * backup of the file as it was. Everything else in the file is kept, but not its comments or
 * layout. Returns whether an existing file was rewritten.
 */
async function rewriteConfig(
  file: string,
  id: string,
  values: Record<string, unknown>,
): Promise<boolean> {
  let source: string | undefined;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let config: unknown = {};
  if (source !== undefined) {
    try {
      config = JSON5.parse(source);
    } catch (error) {
      throw new Error(`${file} is not valid JSON5: ${(error as Error).message}`, { cause: error });
    }
  }
  if (!isRecord(config)) throw new Error(`${file} is not an object`);

  let entry = config;
  const path: string[] = [];
  for (const key of ["agents", "entries", id]) {
    path.push(key);
    const child = Object.hasOwn(entry, key) ? entry[key] : undefined;
    if (child === undefined) entry[key] = {};
    else if (!isRecord(child)) throw new Error(`${file}: ${path.join(".")} is not an object`);
    entry = entry[key] as Record<string, unknown>;
  }
  Object.assign(entry, values);

  if (source !== undefined) await backUp(file);
  await replaceFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return source !== undefined;
}

/**
 * Sets `agents.entries.<id>.<key>` for each value with `openclaw config set` (an object passed
 * as JSON, with `--strict-json`). Once the CLI turns out to have no such command, the rest is
 * set by rewriting `openclaw.json` once, with a backup and a warning.
 */
async function setAgentConfig(
  cli: OpenClawCli,
  configFile: string,
  id: string,
  values: [key: string, value: unknown][],
  warnings: string[],
): Promise<void> {
  const pending: [string, unknown][] = [];
  for (const [key, value] of values) {
    if (pending.length === 0) {
      const path = `agents.entries.${id}.${key}`;
      const set =
        typeof value === "string"
          ? await cli.configSet(path, value)
          : await cli.configSet(path, JSON.stringify(value), { strictJson: true });
      if (set) continue;
    }
    pending.push([key, value]);
  }
  if (pending.length === 0) return;
  if (await rewriteConfig(configFile, id, Object.fromEntries(pending))) {
    warnings.push(REWRITE_WARNING);
  }
}

/**
 * The model is the first preference that names a provider and a model, as `provider/model`;
 * the runtime is the first preference's, as the ACP agent that runs it. What cannot be set is
 * reported as approximated.
 */
function modelConfig(models: ModelPref[], approximated: Item[]): [string, unknown][] {
  const values: [string, unknown][] = [];
  const named = (pref: ModelPref): boolean =>
    pref.provider !== undefined || pref.model !== undefined;
  const chosen = models.find(
    (pref) => label(pref.provider) !== undefined && label(pref.model) !== undefined,
  );
  if (chosen !== undefined) {
    const ref = `${label(chosen.provider)}/${label(chosen.model)}`;
    values.push(["model", ref]);
    const others = models.filter((pref) => pref !== chosen && named(pref)).length;
    if (others > 0) {
      approximated.push({
        field: "models",
        detail: `model set to ${ref}; ${others} other preference${others === 1 ? "" : "s"} not set`,
      });
    }
  } else if (models.some(named)) {
    approximated.push({
      field: "models",
      detail: "no preference names both a provider and a model; OpenClaw's default applies",
    });
  }

  const runtime = label(models[0]?.runtime);
  if (runtime !== undefined) {
    const agent = ACP_AGENTS.get(runtime);
    if (agent !== undefined) {
      values.push(["runtime", { type: "acp", acp: { agent } }]);
    } else {
      approximated.push({
        field: "models",
        detail: `runtime '${runtime}' has no OpenClaw ACP agent; not set`,
      });
    }
  }
  return values;
}

// -- Routines ----------------------------------------------------------------------------------

/**
 * Disables a job that could not be created disabled. A job that cannot be disabled is removed
 * again, so that no routine lands enabled against the user's wish; one that cannot be removed
 * either is reported loudly.
 */
async function disableJob(
  cli: OpenClawCli,
  routine: Routine,
  jobId: string,
  items: Items,
): Promise<void> {
  try {
    await cli.automationsDisable(jobId);
  } catch (error) {
    const why = reason(error);
    try {
      await cli.automationsRemove(jobId);
      items.skipped.push({
        field: `routine:${routine.name}`,
        detail: `could not be disabled (${why}); removed again`,
      });
    } catch {
      items.warnings.push(
        `automation '${routine.name}' (${jobId}) could not be disabled (${why}) and is ENABLED; ` +
          `disable it with: openclaw ${await cli.jobCommand()} disable ${jobId}`,
      );
    }
  }
}

/**
 * Creates one job per routine, run in an isolated session of the agent, and left enabled only
 * when `enableRoutines` is set and the routine is enabled: created disabled where the CLI can
 * (`cron add --disabled`), disabled right after otherwise. With `replace` the agent's existing
 * jobs are removed first; with `update` a routine the agent already has a job of the same name
 * for is left out, so that moving the same agent again does not double its jobs. A routine the
 * CLI refuses is skipped and the rest still go in. When the Gateway is to blame, one warning
 * says how to start it, and the removal of old jobs stops there.
 */
async function writeRoutines(
  cli: OpenClawCli,
  target: Target,
  routines: Routine[],
  existing: JobRow[],
  opts: WriteOpts,
  items: Items,
): Promise<void> {
  if (target.mode === "replace") {
    for (const job of existing) {
      try {
        await cli.automationsRemove(job.id);
      } catch (error) {
        if (!blamesGateway(error)) throw error;
        warnGatewayDown(items);
        break;
      }
    }
  }
  const kept = new Set(target.mode === "update" ? existing.map((job) => job.name) : []);

  for (const routine of routines) {
    const field = `routine:${routine.name}`;
    if (kept.has(routine.name)) {
      items.skipped.push({
        field,
        detail:
          `agent '${target.id}' already has an automation of this name; left as it is ` +
          "(use --replace to recreate it)",
      });
      continue;
    }
    const disable = !(opts.enableRoutines && routine.enabled);
    let job: { id: string; disabled: boolean };
    try {
      // Every flag before the message (the CLI keeps `--message` last as well).
      job = await cli.automationsAdd(
        [
          "--name",
          routine.name,
          ...toOpenClawFlags(routine.schedule, routine.timezone),
          "--agent",
          target.id,
          "--session",
          "isolated",
          "--message",
          routine.instruction,
        ],
        { disabled: disable },
      );
    } catch (error) {
      if (error instanceof ShimLineBreakError) {
        items.skipped.push({ field, detail: error.message });
        continue;
      }
      items.skipped.push({ field, detail: `not created: ${reason(error)}` });
      if (blamesGateway(error)) warnGatewayDown(items);
      continue;
    }
    if (disable && !job.disabled) await disableJob(cli, routine, job.id, items);
  }
}

/** Whether the Gateway runs. A probe that fails says nothing either way and counts as no. */
async function gatewayRunning(cli: OpenClawCli): Promise<boolean> {
  try {
    return (await cli.gatewayStatus()).running;
  } catch {
    return false;
  }
}

// -- The adapter's write -----------------------------------------------------------------------

/**
 * Writes a Bundle into the OpenClaw install of `ctx` (its `targetDir`, else the usual state
 * directory). In order: the agent is found or created with `openclaw agents add`; the workspace
 * files and the `.openteleport.json` marker are written; the identity is set with
 * `agents set-identity`; model and runtime with `config set`, or by rewriting `openclaw.json`
 * when the CLI has no such command; each routine becomes a job, disabled unless
 * `enableRoutines`; and a running Gateway gets a restart warning. A Bundle that holds a secret
 * is refused before anything runs or is written, and an error after `agents add` says where the
 * new agent was created. `bundle` is not changed. `artifactPath` is the agent's workspace.
 */
export async function writeOpenClawAgent(
  ctx: Ctx,
  bundle: Bundle,
  opts: WriteOpts,
): Promise<WriteResult> {
  // This adapter never writes `files`, so a secret there does not stop it.
  const findings = scanSecrets({ ...bundle, files: [] });
  if (findings.length > 0) throw new SecretsFoundError(findings);

  const items: Items = { approximated: [], skipped: [], warnings: [] };
  if (bundle.manifest.capabilities.length > 0) {
    items.approximated.push({ field: "capabilities", detail: CAPABILITIES_DETAIL });
  }
  if (label(bundle.manifest.description) !== undefined) {
    items.skipped.push({ field: "description", detail: "OpenClaw has no field for it" });
  }

  const paths = openclawPaths(ctx);
  const cfg = await readOpenClawConfig(paths.configFile);
  const cli = new OpenClawCli(ctx, paths.stateDir, paths.configFile);
  const target = await claimTarget(paths, cfg, cli, bundle, opts.onConflict, items.warnings);
  const existing = await existingJobs(cli, target, bundle.routines, items);

  if (target.mode === "new") await cli.agentsAdd(target.id, target.workspace);
  try {
    return await finishWrite(cli, paths, target, bundle, opts, existing, items);
  } catch (error) {
    if (target.mode !== "new") throw error;
    // The agent exists now; say where, so that it can be removed or the move retried (the
    // marker, once written, makes a retry update it in place).
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`agent '${target.id}' was created in ${target.workspace}; ${message}`, {
      cause: error,
    });
  }
}

/**
 * The jobs the existing agent already has, read before anything changes, so that a CLI that
 * cannot list them stops the write here. Only `replace` (which removes them) and `update` with
 * routines (which leaves out their names) need them. A listing the Gateway refuses gives the
 * Gateway warning and no jobs: nothing is removed or left out, and the write goes on.
 */
async function existingJobs(
  cli: OpenClawCli,
  target: Target,
  routines: Routine[],
  items: Items,
): Promise<JobRow[]> {
  const needed = target.mode === "replace" || (target.mode === "update" && routines.length > 0);
  if (!needed) return [];
  try {
    const jobs = await cli.automationsList();
    return jobs.filter((job) => (job.agentId ?? DEFAULT_AGENT_ID) === target.id);
  } catch (error) {
    if (!blamesGateway(error)) throw error;
    warnGatewayDown(items);
    return [];
  }
}

/** Everything after the agent exists: workspace, marker, identity, config, routines, Gateway. */
async function finishWrite(
  cli: OpenClawCli,
  paths: OpenClawPaths,
  target: Target,
  bundle: Bundle,
  opts: WriteOpts,
  existing: JobRow[],
  items: Items,
): Promise<WriteResult> {
  const identity = await writeWorkspace(target.workspace, bundle, items);
  const marker = { id: bundle.manifest.id, movedAt: new Date().toISOString() };
  const unmarked = await writeInside(target.workspace, MARKER_FILE, renderMarker(marker));
  if (unmarked !== undefined) {
    items.warnings.push(
      `${unmarked}; not written, so a later move will not update this agent in place`,
    );
  }

  await cli.setIdentity(target.id, {
    name: identity.name,
    emoji: identity.emoji,
    ...(identity.avatar === undefined ? {} : { avatar: identity.avatar }),
    ...(identity.theme === undefined ? {} : { theme: identity.theme }),
  });
  const config = modelConfig(bundle.manifest.models, items.approximated);
  await setAgentConfig(cli, paths.configFile, target.id, config, items.warnings);
  await writeRoutines(cli, target, bundle.routines, existing, opts, items);
  if (await gatewayRunning(cli)) items.warnings.push(RESTART_WARNING);

  return { outcome: "done", targetAgentId: target.id, artifactPath: target.workspace, items };
}
