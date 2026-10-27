import type { Dirent, Stats } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { MAX_AVATAR_BYTES, MAX_FACT_CHARS, isForbiddenPath } from "../../core/paths.js";
import { fromOpenClawJob } from "../../core/schedule.js";
import {
  type Bundle,
  type Capability,
  type FileEntry,
  type Manifest,
  type ModelPref,
  type Note,
  type Routine,
  RoutineSchema,
  type Skill,
} from "../../core/schema.js";
import type { AgentRef, Ctx } from "../types.js";
import { type AgentRow, type JobRow, OpenClawCli } from "./cli.js";
import {
  DEFAULT_AGENT_ID,
  type OpenClawAgentEntry,
  type OpenClawConfig,
  type OpenClawIdentity,
  type OpenClawPaths,
  openclawPaths,
  readOpenClawConfig,
} from "./paths.js";

/** OpenClaw does not say what an agent may do, so every export claims the same. */
const CAPABILITIES: readonly Capability[] = [
  "browser",
  "shell",
  "filesystem",
  "network",
  "scheduler",
];
const CAPABILITIES_WARNING = "capabilities are assumed; OpenClaw does not declare them per agent";

/** The note that carries the lines of `MEMORY.md` that are not facts. */
const MEMORY_PROSE_NOTE = "MEMORY-prose";
const USER_NOTE = "USER";

const MAX_NAME_CHARS = 80;
const MAX_TITLE_CHARS = 120;
const AVATAR_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SCHEDULE_KINDS: ReadonlySet<string> = new Set(["cron", "every", "at"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed, non-empty string, or `undefined`. */
function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const errorLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]?.trim() ?? "";

const isNotFound = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** `lstat`, or `undefined` when nothing is there. Symbolic links are not followed. */
async function lstatIfAny(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Whether `path` is `root` itself or below it; both absolute. */
function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Views a Node buffer as a plain `Uint8Array` without copying it. */
const toBytes = (buffer: Buffer): Uint8Array =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

// Plain code-unit order, so that the result does not depend on the locale.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** The entries of a directory sorted by name; none when it does not exist. */
async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.sort((a, b) => compare(a.name, b.name));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function entryOf(cfg: OpenClawConfig, agentId: string): OpenClawAgentEntry {
  const entries = cfg.agents?.entries;
  const entry = isRecord(entries) && Object.hasOwn(entries, agentId) ? entries[agentId] : undefined;
  return isRecord(entry) ? entry : {};
}

// -- Identity ----------------------------------------------------------------------------------

const IDENTITY_KEYS: ReadonlyMap<string, keyof OpenClawIdentity> = new Map([
  ["name", "name"],
  ["emoji", "emoji"],
  ["theme", "theme"],
  ["avatar", "avatar"],
]);
// `- **Name:** Ada`, also with the colon outside the bold.
const IDENTITY_LINE = /^\s*[-*]\s+\*\*\s*([A-Za-z]+)\s*:?\s*\*\*\s*:?\s*(.*)$/;
// The template's hints, such as `_(pick something you like)_`.
const PLACEHOLDER = /^[_*]\(.*\)[_*]$/;

/** The `- **Name:** …` lines of IDENTITY.md, and likewise Emoji, Theme and Avatar. */
function parseIdentityFile(text: string): OpenClawIdentity {
  const identity: OpenClawIdentity = {};
  for (const line of text.split(/\r?\n/)) {
    const match = IDENTITY_LINE.exec(line);
    const key = match?.[1] === undefined ? undefined : IDENTITY_KEYS.get(match[1].toLowerCase());
    const value = label(match?.[2]);
    if (key !== undefined && value !== undefined && !PLACEHOLDER.test(value)) {
      identity[key] ??= value;
    }
  }
  return identity;
}

/** The config's identity over IDENTITY.md's, key by key; `undefined` when neither says anything. */
function mergeIdentity(
  fromConfig: unknown,
  fromFile: OpenClawIdentity,
): OpenClawIdentity | undefined {
  const config = isRecord(fromConfig) ? fromConfig : {};
  const merged: OpenClawIdentity = {};
  for (const key of ["name", "theme", "emoji", "avatar"] as const) {
    const value = label(config[key]) ?? fromFile[key];
    if (value !== undefined) merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

type Profile = {
  workspace: string;
  entry: OpenClawAgentEntry;
  identity?: OpenClawIdentity;
  hasIdentityFile: boolean;
};

async function readProfile(
  paths: OpenClawPaths,
  cfg: OpenClawConfig,
  agentId: string,
): Promise<Profile> {
  const entry = entryOf(cfg, agentId);
  const workspace = paths.workspaceFor(agentId, cfg);
  const file = await readText(join(workspace, "IDENTITY.md"));
  const identity = mergeIdentity(entry.identity, file === undefined ? {} : parseIdentityFile(file));
  return {
    workspace,
    entry,
    ...(identity === undefined ? {} : { identity }),
    hasIdentityFile: file !== undefined,
  };
}

const agentName = (agentId: string, { entry, identity }: Profile): string =>
  identity?.name ?? label(entry.name) ?? agentId;

/** Cuts `value` to `max` UTF-16 units, never through a surrogate pair, and says so. */
function clip(value: string, max: number, field: string, warnings: string[]): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  warnings.push(`${field} cut to ${max} characters`);
  return value.slice(0, end);
}

// -- Models ------------------------------------------------------------------------------------

function modelPref(ref: unknown): ModelPref | undefined {
  const text = label(ref);
  if (text === undefined) return undefined;
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return { model: text };
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

/** Primary first, then the fallbacks; an ACP runtime goes on the first preference. */
function modelsFor(entry: OpenClawAgentEntry): ModelPref[] {
  const model: unknown = entry.model;
  const refs: unknown[] = isRecord(model)
    ? [model.primary, ...(Array.isArray(model.fallbacks) ? model.fallbacks : [])]
    : [model];
  const models = refs.flatMap((ref) => modelPref(ref) ?? []);
  const runtime: unknown = entry.runtime;
  const acp = isRecord(runtime) && isRecord(runtime.acp) ? label(runtime.acp.agent) : undefined;
  if (acp === undefined) return models;
  const [first, ...rest] = models;
  return [{ runtime: acp, ...first }, ...rest];
}

// -- Memory ------------------------------------------------------------------------------------

/**
 * `MEMORY.md` lines starting with `- ` are facts; a fact over the limit and every other non-empty
 * line go to the `MEMORY-prose` note. `USER.md` is the `USER` note and each `memory/<name>.md`
 * the note `<name>`. Notes come out sorted by name.
 */
async function readMemory(
  workspace: string,
): Promise<{ facts: string[]; notes: Note[]; warnings: string[] }> {
  const facts: string[] = [];
  const prose: string[] = [];
  const warnings: string[] = [];
  const memory = (await readText(join(workspace, "MEMORY.md"))) ?? "";
  memory.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    if (!trimmed.startsWith("- ")) {
      prose.push(line.trimEnd());
      return;
    }
    const fact = trimmed.slice(2).trim();
    if (fact.length > MAX_FACT_CHARS) {
      // Without its marker, so that the note does not read back as an over-long fact.
      prose.push(fact);
      warnings.push(
        `MEMORY.md line ${index + 1}: fact is ${fact.length} characters, over the ` +
          `${MAX_FACT_CHARS} limit; kept in note ${MEMORY_PROSE_NOTE}`,
      );
      return;
    }
    facts.push(fact);
  });

  const notes: Note[] = [];
  if (prose.length > 0) notes.push({ name: MEMORY_PROSE_NOTE, text: prose.join("\n") });
  const user = await readText(join(workspace, "USER.md"));
  if (user !== undefined) notes.push({ name: USER_NOTE, text: user });

  const memoryDir = join(workspace, "memory");
  for (const dirent of await listDirectory(memoryDir)) {
    if (!dirent.isFile() || !/\.md$/i.test(dirent.name)) continue;
    const name = dirent.name.slice(0, -".md".length);
    if (notes.some((note) => note.name === name)) {
      warnings.push(`memory/${dirent.name} has the same name as another note; not exported`);
      continue;
    }
    notes.push({ name, text: await readFile(join(memoryDir, dirent.name), "utf8") });
  }
  notes.sort((a, b) => compare(a.name, b.name));
  return { facts, notes, warnings };
}

// -- Skills ------------------------------------------------------------------------------------

const SKILL_FILE = "SKILL.md";

/** The `name` in a SKILL.md frontmatter block, if there is one. */
function frontmatterName(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(bytes);
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (block === undefined) return undefined;
  try {
    const data: unknown = parseYaml(block);
    return isRecord(data) ? label(data.name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every file of a skill directory except SKILL.md, sorted by path. Paths that never go into an
 * archive (`.env*`, `node_modules`, `.git`, nested archives) and anything that is not a regular
 * file or directory are left out, with a warning.
 */
async function skillFiles(dir: string, skill: string, warnings: string[]): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    for (const dirent of await listDirectory(current)) {
      const path = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
      if (path === SKILL_FILE) continue;
      const absolute = join(current, dirent.name);
      if (isForbiddenPath(dirent.name)) {
        warnings.push(`skill '${skill}': left out ${path}`);
      } else if (dirent.isDirectory()) {
        await walk(absolute, path);
      } else if (dirent.isFile()) {
        files.push({ path, bytes: toBytes(await readFile(absolute)) });
      } else {
        warnings.push(`skill '${skill}': left out ${path} (not a regular file)`);
      }
    }
  }
  await walk(dir, "");
  return files.sort((a, b) => compare(a.path, b.path));
}

/**
 * The skills in `<workspace>/skills/<name>/`. With an allowlist, only the skills it names (by
 * SKILL.md `name` or directory name) are exported, and a name it lists that the workspace does
 * not have is reported.
 */
async function readSkills(
  workspace: string,
  allowlist: unknown,
): Promise<{ skills: Skill[]; warnings: string[] }> {
  const allowed = Array.isArray(allowlist)
    ? new Set(allowlist.flatMap((name) => label(name) ?? []))
    : undefined;
  const skills: Skill[] = [];
  const warnings: string[] = [];
  const present = new Set<string>();
  const root = join(workspace, "skills");

  for (const dirent of await listDirectory(root)) {
    if (isForbiddenPath(dirent.name)) continue;
    if (dirent.isSymbolicLink()) {
      warnings.push(`skills/${dirent.name} is a symbolic link; not exported`);
      continue;
    }
    if (!dirent.isDirectory()) continue;
    const dir = join(root, dirent.name);
    const mainPath = join(dir, SKILL_FILE);
    const mainInfo = await lstatIfAny(mainPath);
    if (mainInfo?.isSymbolicLink()) {
      warnings.push(`skills/${dirent.name}/${SKILL_FILE} is a symbolic link; not exported`);
      continue;
    }
    if (!mainInfo?.isFile()) {
      warnings.push(`skills/${dirent.name} has no ${SKILL_FILE}; not exported`);
      continue;
    }
    const mainBytes = toBytes(await readFile(mainPath));
    const names = [dirent.name, frontmatterName(mainBytes) ?? dirent.name];
    for (const name of names) present.add(name);
    if (allowed !== undefined && !names.some((name) => allowed.has(name))) {
      warnings.push(`skill '${dirent.name}' is not on the agent's skill allowlist; not exported`);
      continue;
    }
    const rest = await skillFiles(dir, dirent.name, warnings);
    skills.push({ name: dirent.name, files: [{ path: SKILL_FILE, bytes: mainBytes }, ...rest] });
  }

  for (const name of allowed ?? []) {
    if (!present.has(name)) warnings.push(`skill '${name}' is not in the workspace; not exported`);
  }
  return { skills, warnings };
}

// -- Routines ----------------------------------------------------------------------------------

/** The zone a cron job without one runs in: the Gateway's, assumed to be this machine's. */
const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** A routine with, optionally, a note about it; or the warning that says why the job is skipped. */
function toRoutine(job: JobRow): { routine: Routine; note?: string } | { warning: string } {
  const skipped = (reason: string) => ({ warning: `automation '${job.name}' skipped: ${reason}` });
  const kind = isRecord(job.schedule) ? label(job.schedule.kind) : undefined;
  if (kind === undefined) return skipped("it has no schedule kind");
  if (!SCHEDULE_KINDS.has(kind)) return skipped(`unsupported schedule kind '${kind}'`);
  const converted = fromOpenClawJob(job);
  if (converted === null) {
    return skipped(`its '${kind}' schedule cannot be expressed as a routine`);
  }
  if (job.message === undefined) return skipped("no message to run");
  // An interval has no zone, and a one-off time is already in UTC.
  const assumed = converted.timezone === undefined && kind === "cron" ? hostTimeZone() : undefined;
  const timezone = converted.timezone ?? assumed ?? "UTC";
  const parsed = RoutineSchema.safeParse({
    name: job.name,
    instruction: job.message,
    enabled: job.enabled,
    timezone,
    schedule: converted.schedule,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return skipped(
      issue ? `${issue.path.join(".")}: ${issue.message}` : "it is not a valid routine",
    );
  }
  if (assumed === undefined) return { routine: parsed.data };
  return {
    routine: parsed.data,
    note: `automation '${job.name}' has no timezone; assuming ${assumed}`,
  };
}

/** The agent's jobs as routines. Without the CLI the agent is still exported, without routines. */
async function readRoutines(
  cli: OpenClawCli,
  agentId: string,
): Promise<{ routines: Routine[]; warnings: string[] }> {
  const warnings: string[] = [];
  let jobs: JobRow[];
  try {
    jobs = await cli.automationsList((warning) => warnings.push(warning));
  } catch (error) {
    warnings.push(`automations not read (${errorLine(error)}); no routines exported`);
    return { routines: [], warnings };
  }
  const routines: Routine[] = [];
  for (const job of jobs) {
    if ((job.agentId ?? DEFAULT_AGENT_ID) !== agentId) continue;
    const result = toRoutine(job);
    if ("warning" in result) {
      warnings.push(result.warning);
      continue;
    }
    routines.push(result.routine);
    if (result.note !== undefined) warnings.push(result.note);
  }
  return { routines, warnings };
}

// -- Avatar ------------------------------------------------------------------------------------

/**
 * The avatar file when `ref` is a workspace-relative path to a PNG, JPEG or WebP image within the
 * size limit, named `avatar.<ext>` as the bundle layout wants; otherwise a warning. The file must
 * not be a symbolic link and must really be inside the workspace, symbolic links on the way
 * resolved, since `ref` can come from IDENTITY.md, a file the agent itself may edit.
 */
async function readAvatar(
  workspace: string,
  ref: string | undefined,
): Promise<{ avatar?: NonNullable<Bundle["avatar"]>; warning?: string }> {
  if (ref === undefined) return {};
  if (/^(?:https?:|data:)/i.test(ref)) {
    return { warning: "avatar is a URL or data URI; not exported" };
  }
  const notExported = (why: string) => ({ warning: `avatar '${ref}' ${why}; not exported` });

  const file = resolve(workspace, ref);
  if (file === workspace || !isWithin(workspace, file)) {
    return notExported("is outside the workspace");
  }
  const info = await lstatIfAny(file);
  if (info?.isSymbolicLink()) return { warning: "avatar is a symlink; not exported" };
  if (!info?.isFile()) return notExported("not found");
  // A symbolic link to a directory on the way could still lead out of the workspace.
  if (!isWithin(await realpath(workspace), await realpath(file))) {
    return notExported("is outside the workspace");
  }
  const extension = extname(file).toLowerCase();
  if (!AVATAR_EXTENSIONS.has(extension)) return notExported("is not a PNG, JPEG or WebP image");
  if (info.size > MAX_AVATAR_BYTES) {
    return notExported(`is ${info.size} bytes, over the ${MAX_AVATAR_BYTES} byte limit`);
  }
  return { avatar: { name: `avatar${extension}`, bytes: toBytes(await readFile(file)) } };
}

// -- Agents ------------------------------------------------------------------------------------

/**
 * Reads one OpenClaw agent as a Bundle; nothing in the install is changed. The workspace gives
 * the persona (`SOUL.md`), instructions (`AGENTS.md`), memory and skills, `openclaw.json` gives
 * the name, models and identity, and `openclaw automations list` gives the routines. The
 * manifest `id` is left empty for the engine to fill in.
 */
export async function readOpenClawAgent(
  ctx: Ctx,
  agentId: string,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const paths = openclawPaths(ctx);
  const cfg = await readOpenClawConfig(paths.configFile);
  const workspace = paths.workspaceFor(agentId, cfg);
  if (!(await isDirectory(workspace))) {
    throw new Error(`OpenClaw agent "${agentId}" not found: no workspace at ${workspace}`);
  }
  const profile = await readProfile(paths, cfg, agentId);
  const { entry, identity } = profile;

  const missing: string[] = [];
  const instructions = await readText(join(workspace, "AGENTS.md"));
  if (instructions === undefined) missing.push("AGENTS.md not found");
  const persona = await readText(join(workspace, "SOUL.md"));
  if (persona === undefined) missing.push("SOUL.md not found");
  if (!profile.hasIdentityFile) missing.push("IDENTITY.md not found");

  const skills = await readSkills(workspace, entry.skills);
  const cli = new OpenClawCli(ctx, paths.stateDir, paths.configFile);
  const routines = await readRoutines(cli, agentId);
  const memory = await readMemory(workspace);
  const avatar = await readAvatar(workspace, identity?.avatar);
  const clipped: string[] = [];
  const name = clip(agentName(agentId, profile), MAX_NAME_CHARS, "name", clipped);
  const title =
    identity?.theme === undefined
      ? undefined
      : clip(identity.theme, MAX_TITLE_CHARS, "title", clipped);

  const manifest: Manifest = {
    schemaVersion: "0.1",
    id: "",
    name,
    ...(title === undefined ? {} : { title }),
    models: modelsFor(entry),
    capabilities: [...CAPABILITIES],
    origin: { app: "openclaw", exportedAt: new Date().toISOString() },
    ...(identity === undefined ? {} : { "x-openclaw": { identity } }),
  };
  const bundle: Bundle = {
    manifest,
    instructions: instructions ?? "",
    skills: skills.skills,
    routines: routines.routines,
    facts: memory.facts,
    notes: memory.notes,
    files: [],
    unknownPaths: [],
  };
  if (persona !== undefined) bundle.persona = persona;
  if (avatar.avatar !== undefined) bundle.avatar = avatar.avatar;

  const warnings = [
    ...missing,
    CAPABILITIES_WARNING,
    ...skills.warnings,
    ...routines.warnings,
    ...memory.warnings,
    ...(avatar.warning === undefined ? [] : [avatar.warning]),
    ...clipped,
  ];
  return { bundle, warnings };
}

/**
 * The agents of the install: those in `openclaw.json`, then any more that `openclaw agents list`
 * knows (when the CLI fails, the config's alone, with a logged warning). When neither has any,
 * `main` if its workspace exists.
 */
export async function listOpenClawAgents(ctx: Ctx): Promise<AgentRef[]> {
  const paths = openclawPaths(ctx);
  const cfg = await readOpenClawConfig(paths.configFile);
  const entries = cfg.agents?.entries;
  const ids = isRecord(entries) ? Object.keys(entries) : [];

  const refs: AgentRef[] = [];
  for (const id of ids) {
    const profile = await readProfile(paths, cfg, id);
    refs.push({
      id,
      name: agentName(id, profile),
      ...(profile.identity?.theme === undefined ? {} : { title: profile.identity.theme }),
      location: profile.workspace,
    });
  }

  let rows: AgentRow[] = [];
  try {
    rows = await new OpenClawCli(ctx, paths.stateDir, paths.configFile).agentsList();
  } catch (error) {
    ctx.logger(
      `openclaw agents list failed (${errorLine(error)}); listing the agents in openclaw.json only`,
    );
  }
  const seen = new Set(ids);
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    refs.push({
      id: row.id,
      name: row.name ?? row.id,
      ...(row.workspace === undefined ? {} : { location: row.workspace }),
    });
  }

  if (refs.length === 0) {
    const workspace = paths.workspaceFor(DEFAULT_AGENT_ID, cfg);
    if (await isDirectory(workspace)) {
      refs.push({ id: DEFAULT_AGENT_ID, name: DEFAULT_AGENT_ID, location: workspace });
    }
  }
  return refs;
}
