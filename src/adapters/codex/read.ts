// Reads Codex (the CLI and the app) from the files it keeps. An "agent" is the global setup
// (`AGENTS.md`, the user's skills, `config.toml`) or one custom agent file `agents/<name>.toml`.
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { MAX_TEXT_ENTRY_BYTES } from "../../core/paths.js";
import {
  type Bundle,
  type Manifest,
  type ModelPref,
  type Note,
  type Skill,
  ULID_PATTERN,
} from "../../core/schema.js";
import { byCodeUnit, splitInstructions } from "../../core/text.js";
import { entriesOf, lstatIfAny } from "../fs.js";
import { readIds } from "../marker.js";
import { readSkillFolders } from "../skill-files.js";
import type { Adapter, AgentRef, Ctx } from "../types.js";
import {
  AGENT_EXTENSION,
  DEFAULT_AGENT,
  DETECT_FILES,
  IDS_FILE,
  agentsDir,
  codexHome,
  isRecord,
  legacySkillsDir,
  truncate,
  userSkillsDir,
} from "./paths.js";

const APP = "codex";
const GLOBAL_NAME = "Codex";
const GLOBAL_LABEL = "Codex (global)";
const MAX_NAME_CHARS = 80;
const MAX_TITLE_CHARS = 120;
/** The note that carries `memories/MEMORY.md`. */
const MEMORY_NOTE = "codex-memory";
const NOT_FOUND_HINT = "Install Codex or pass --source-dir <CODEX_HOME>";

/** What an agent file holds that a Bundle has a place for. Everything else is `rest`. */
export type CodexAgentFile = {
  name: string;
  description: string;
  developer_instructions: string;
  model?: string;
  model_reasoning_effort?: string;
  nickname_candidates?: string[];
};

type Table = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === "string";
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

/** The text with Windows line endings turned into line feeds. */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

const errorLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0]?.trim() ?? "";

/** What the TOML parser objected to, on one line, with the line it found it on. */
function tomlProblem(error: unknown): string {
  const { line } = error as { line?: unknown };
  return typeof line === "number" ? `${errorLine(error)} (line ${line})` : errorLine(error);
}

/**
 * The text of the regular file `path`, or `undefined` when there is none. `label` names the file
 * in an error. A file over the limit for text entries is refused, since a bundle could not hold
 * it anyway.
 */
async function readText(path: string, label: string): Promise<string | undefined> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    size = info.size;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (size > MAX_TEXT_ENTRY_BYTES) {
    throw new Error(
      `${label} is ${size} bytes, over the ${MAX_TEXT_ENTRY_BYTES} byte limit for text files`,
    );
  }
  const text = await readFile(path, "utf8");
  // Some Windows editors start a UTF-8 file with a byte order mark, which would hide `# Persona`.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// -- Detection -----------------------------------------------------------------------------------

/** Found when the Codex home holds anything Codex leaves there; nothing is run. */
export async function detectCodex(ctx: Ctx): ReturnType<Adapter["detect"]> {
  const home = codexHome(ctx);
  for (const name of DETECT_FILES) {
    try {
      if ((await lstatIfAny(join(home, name))) !== undefined) return { found: true, location: home };
    } catch {
      // What cannot be looked at does not show that Codex is there.
    }
  }
  return { found: false, location: home, hint: NOT_FOUND_HINT };
}

// -- Agent files ---------------------------------------------------------------------------------

/**
 * Parses a custom agent file. The fields a Bundle has a place for come back as `agent` (the three
 * Codex requires are empty when missing); every other key, and a known key of the wrong type,
 * stays in `rest` untouched. A document that is not TOML throws an error that starts with `file`.
 */
export function parseAgentToml(
  text: string,
  file: string,
): { agent: CodexAgentFile; rest: Record<string, unknown> } {
  let table: Table;
  try {
    table = parse(text);
  } catch (error) {
    throw new Error(`${file}: ${tomlProblem(error)}`, { cause: error });
  }
  const rest: Table = { ...table };
  const take = <T>(key: string, check: (value: unknown) => value is T): T | undefined => {
    const value = table[key];
    if (!check(value)) return undefined;
    delete rest[key];
    return value;
  };
  const model = take("model", isString);
  const effort = take("model_reasoning_effort", isString);
  const nicknames = take("nickname_candidates", isStrings);
  const agent: CodexAgentFile = {
    name: take("name", isString) ?? "",
    description: take("description", isString) ?? "",
    developer_instructions: take("developer_instructions", isString) ?? "",
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { model_reasoning_effort: effort }),
    ...(nicknames === undefined ? {} : { nickname_candidates: nicknames }),
  };
  return { agent, rest };
}

type AgentFileRef = { stem: string; path: string };

/**
 * The regular `*.toml` files of the agents folder in name order, with the files it has to leave
 * out and why. A file called `default.toml` would clash with the global setup, which has that id.
 */
async function agentFiles(
  home: string,
): Promise<{ files: AgentFileRef[]; skipped: string[] }> {
  const dir = agentsDir(home);
  const files: AgentFileRef[] = [];
  const skipped: string[] = [];
  const entries = (await entriesOf(dir)).sort((a, b) => byCodeUnit(a.name, b.name));
  for (const entry of entries) {
    if (!entry.name.endsWith(AGENT_EXTENSION)) continue;
    const stem = entry.name.slice(0, -AGENT_EXTENSION.length);
    if (stem === "") continue;
    if (entry.isSymbolicLink()) {
      skipped.push(`agents/${entry.name} is a symbolic link; not listed`);
    } else if (!entry.isFile()) {
      continue;
    } else if (stem === DEFAULT_AGENT) {
      skipped.push(`agents/${entry.name} is not listed: "default" is the global setup`);
    } else {
      files.push({ stem, path: join(dir, entry.name) });
    }
  }
  return { files, skipped };
}

const labelOf = (stem: string): string => `agents/${stem}${AGENT_EXTENSION}`;

/** The global setup, then the agents in `agents/*.toml`. A file that cannot be read is skipped. */
export async function listCodexAgents(ctx: Ctx): Promise<AgentRef[]> {
  const home = codexHome(ctx);
  const refs: AgentRef[] = [{ id: DEFAULT_AGENT, name: GLOBAL_LABEL, location: home }];
  const { files, skipped } = await agentFiles(home);
  for (const message of skipped) ctx.logger(message);
  for (const { stem, path } of files) {
    try {
      const text = (await readText(path, labelOf(stem))) ?? "";
      const { agent } = parseAgentToml(text, labelOf(stem));
      refs.push({
        id: stem,
        name: agent.name === "" ? stem : agent.name,
        ...(agent.description === "" ? {} : { title: truncate(agent.description, MAX_TITLE_CHARS) }),
        location: path,
      });
    } catch (error) {
      ctx.logger(`skipped ${errorLine(error)}`);
    }
  }
  return refs;
}

async function locate(home: string, agent: string): Promise<AgentFileRef> {
  const { files } = await agentFiles(home);
  const found = files.find(({ stem }) => stem === agent);
  if (found !== undefined) return found;
  const available = [DEFAULT_AGENT, ...files.map(({ stem }) => stem)];
  throw new Error(`Codex has no agent "${agent}". Available: ${available.join(", ")}`);
}

// -- Pieces of a Bundle --------------------------------------------------------------------------

/**
 * The skills of `~/.agents/skills` and of the deprecated `<CODEX_HOME>/skills`, in name order.
 * Codex does not merge skills that share a name; the one in `~/.agents/skills` is exported.
 */
async function readAllSkills(ctx: Ctx, home: string, warnings: string[]): Promise<Skill[]> {
  // Hidden folders are left alone: Codex keeps its bundled skills in `.system`.
  const read = async (dir: string): Promise<Skill[]> => {
    const found = await readSkillFolders(dir, { skipHidden: true });
    warnings.push(...found.warnings);
    return found.skills;
  };
  const skills = await read(userSkillsDir(ctx));
  const taken = new Set(skills.map(({ name }) => name));
  for (const skill of await read(legacySkillsDir(home))) {
    if (taken.has(skill.name)) {
      warnings.push(
        `skill '${skill.name}' is in both ~/.agents/skills and the deprecated skills folder; ` +
          "exported the one in ~/.agents/skills",
      );
    } else {
      skills.push(skill);
    }
  }
  return skills.sort((a, b) => byCodeUnit(a.name, b.name));
}

/** What `config.toml` says that a Bundle can carry. */
type Settings = {
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
};

/** The settings of the user's `config.toml`, which is only read. A broken file gives none. */
async function readSettings(home: string, warnings: string[]): Promise<Settings> {
  const source = await readText(join(home, "config.toml"), "config.toml");
  if (source === undefined) return {};
  let table: Table;
  try {
    table = parse(source);
  } catch (error) {
    warnings.push(
      `config.toml is not valid TOML (${tomlProblem(error)}); model settings not exported`,
    );
    return {};
  }
  const setting = (key: string): string | undefined => {
    const value = table[key];
    return isString(value) && value !== "" ? value : undefined;
  };
  const model = setting("model");
  const provider = setting("model_provider");
  const reasoningEffort = setting("model_reasoning_effort");
  const approvalPolicy = setting("approval_policy");
  const sandboxMode = setting("sandbox_mode");
  return {
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
  };
}

function modelsOf(model: string | undefined, provider?: string): ModelPref[] {
  if (model === undefined) return [];
  return [{ ...(provider === undefined ? {} : { provider }), model }];
}

/** `x-codex`, or nothing when no value is left. */
function vendorOf(values: Table): { "x-codex"?: Table } {
  const defined = Object.entries(values).filter(([, value]) => value !== undefined);
  return defined.length === 0 ? {} : { "x-codex": Object.fromEntries(defined) };
}

/**
 * The id an earlier move recorded for an agent file (see `writeCodexAgent`), so that the agent
 * keeps it on its way out; `""` for none and for a map that cannot be read, which only costs a
 * new id.
 */
async function recordedId(home: string, stem: string): Promise<string> {
  try {
    const ids = await readIds(join(home, IDS_FILE));
    // Own keys only: an agent called `constructor` has no id because of what every object inherits.
    const id = Object.hasOwn(ids, stem) ? ids[stem] : undefined;
    return id !== undefined && ULID_PATTERN.test(id) ? id : "";
  } catch {
    return "";
  }
}

function bundleOf(manifest: Manifest, text: string, parts: Partial<Bundle>): Bundle {
  const { persona, instructions } = splitInstructions(lf(text));
  return {
    manifest,
    ...(persona === undefined ? {} : { persona }),
    instructions,
    skills: [],
    routines: [],
    facts: [],
    notes: [],
    files: [],
    unknownPaths: [],
    ...parts,
  };
}

// -- Reading an agent ----------------------------------------------------------------------------

/**
 * The global setup as one agent: `AGENTS.override.md` when it has text, else `AGENTS.md`, split
 * into persona and instructions where it has that layout; the skills of both skills folders;
 * the model settings of `config.toml`; and `memories/MEMORY.md` as one note.
 */
async function readGlobal(ctx: Ctx): Promise<{ bundle: Bundle; warnings: string[] }> {
  const home = codexHome(ctx);
  const warnings: string[] = [];

  const override = await readText(join(home, "AGENTS.override.md"), "AGENTS.override.md");
  const text =
    override !== undefined && override.trim() !== ""
      ? override
      : ((await readText(join(home, "AGENTS.md"), "AGENTS.md")) ?? "");
  const settings = await readSettings(home, warnings);
  const skills = await readAllSkills(ctx, home, warnings);

  const notes: Note[] = [];
  const memory = await readText(join(home, "memories", "MEMORY.md"), "memories/MEMORY.md");
  if (memory !== undefined && memory.trim() !== "") {
    notes.push({ name: MEMORY_NOTE, text: memory });
    warnings.push("Codex memory is machine-generated; carried as a note");
  }

  const manifest: Manifest = {
    schemaVersion: "0.1",
    id: "",
    name: GLOBAL_NAME,
    models: modelsOf(settings.model, settings.provider),
    capabilities: [],
    origin: { app: APP, exportedAt: new Date().toISOString() },
    ...vendorOf({
      reasoningEffort: settings.reasoningEffort,
      approvalPolicy: settings.approvalPolicy,
      sandboxMode: settings.sandboxMode,
    }),
  };
  return { bundle: bundleOf(manifest, text, { skills, notes }), warnings };
}

/** The keys of an agent file that the Bundle has no place for, by name. */
function ignoredSettings(rest: Table, skillsConfigKept: boolean): string[] {
  const names = Object.keys(rest).filter((key) => key !== "skills");
  const { skills } = rest;
  if (isRecord(skills)) {
    for (const key of Object.keys(skills)) {
      if (key !== "config" || !skillsConfigKept) names.push(`skills.${key}`);
    }
  } else if (skills !== undefined) {
    names.push("skills");
  }
  return names;
}

/** One custom agent: its `developer_instructions` are the persona and instructions. */
async function readCustom(
  home: string,
  { stem, path }: AgentFileRef,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const warnings: string[] = [];
  const text = (await readText(path, labelOf(stem))) ?? "";
  const { agent, rest } = parseAgentToml(text, labelOf(stem));

  if (agent.developer_instructions === "") {
    warnings.push(`${labelOf(stem)} has no developer_instructions`);
  }
  const skillsConfig = isRecord(rest.skills) ? rest.skills.config : undefined;
  const skillsConfigKept = Array.isArray(skillsConfig);
  const ignored = ignoredSettings(rest, skillsConfigKept);
  if (ignored.length > 0) warnings.push(`agent file settings not exported: ${ignored.join(", ")}`);

  const title = agent.description === "" ? undefined : truncate(agent.description, MAX_TITLE_CHARS);
  const manifest: Manifest = {
    schemaVersion: "0.1",
    id: await recordedId(home, stem),
    name: truncate(agent.name === "" ? stem : agent.name, MAX_NAME_CHARS),
    ...(title === undefined ? {} : { title }),
    // A description the title had to cut is kept whole, so nothing of it is lost.
    ...(title !== undefined && agent.description !== title ? { description: agent.description } : {}),
    models: modelsOf(agent.model),
    capabilities: [],
    origin: { app: APP, exportedAt: new Date().toISOString() },
    ...vendorOf({
      reasoningEffort: agent.model_reasoning_effort,
      nickname_candidates: agent.nickname_candidates,
      skillsConfig: skillsConfigKept ? skillsConfig : undefined,
    }),
  };
  return { bundle: bundleOf(manifest, agent.developer_instructions, {}), warnings };
}

/**
 * Reads `default` (the global setup) or an agent file as a Bundle. `agent` is an id from
 * `listCodexAgents`; only listed files can be found, so no path escapes the agents folder. The
 * id is the one an earlier move recorded for the file, else empty for the engine to fill in.
 */
export async function readCodexAgent(
  ctx: Ctx,
  agent: string,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  if (agent === DEFAULT_AGENT) return readGlobal(ctx);
  const home = codexHome(ctx);
  return readCustom(home, await locate(home, agent));
}

/**
 * What tells this agent apart from every other one: the real path of the Codex home for the
 * global setup, of the agent's file for an agent.
 */
export async function codexCacheIdentity(ctx: Ctx, agent: string): Promise<string> {
  const home = codexHome(ctx);
  const path = agent === DEFAULT_AGENT ? home : join(agentsDir(home), `${agent}${AGENT_EXTENSION}`);
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
