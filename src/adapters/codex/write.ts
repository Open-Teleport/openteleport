// Writes a Bundle into Codex as a custom agent: one `agents/<slug>.toml`. The user's `config.toml`
// and `AGENTS.md` are never written, since that would replace their global setup with one move.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { MAX_TEXT_ENTRY_BYTES } from "../../core/paths.js";
import type { Bundle, ModelPref } from "../../core/schema.js";
import { factsToProse, mergeInstructions, slugify, truncate } from "../../core/text.js";
import { isRecord } from "../../core/values.js";
import { entriesOf, lstatIfAny, replaceFile } from "../fs.js";
import { type AgentIds, readIds, recordId } from "../marker.js";
import { freeName, recordedCopy } from "../names.js";
import { checkSkillMetadata, recordSkills, writeAssociatedSkills } from "./skills.js";
import type { Ctx, WriteOpts, WriteResult } from "../types.js";
import {
  AGENT_EXTENSION,
  DEFAULT_AGENT,
  IDS_FILE,
  agentsDir,
  codexHome,
} from "./paths.js";
import { type CodexAgentFile, parseAgentToml } from "./read.js";

const MAX_DESCRIPTION_CHARS = 120;
/** What Codex accepts as a nickname: ASCII letters, digits, spaces, `-` and `_` (C11). */
const NICKNAME = /^[A-Za-z0-9 _-]+$/;

type Items = WriteResult["items"];

/**
 * The file stem for an agent: lowercase, every run of characters outside `a-z0-9` one `-`, no `-`
 * at either end, at most 64 characters. A name with no letter or digit in it, and `default`, which
 * is the global setup, are refused; a Windows device name such as `con` gets `-agent`.
 */
export function agentSlug(name: string): string {
  const slug = slugify(name, { deviceSuffix: "-agent" });
  if (slug === "") {
    throw new Error(
      `Cannot name a Codex agent file after ${JSON.stringify(name)}: it has no letters or digits. ` +
        "Rename the agent and move it again.",
    );
  }
  if (slug === DEFAULT_AGENT) {
    throw new Error(
      `Cannot write an agent named ${JSON.stringify(name)}: "${DEFAULT_AGENT}" is the global ` +
        "Codex setup. Rename the agent and move it again.",
    );
  }
  return slug;
}

/**
 * The text of an agent file. Fields that are not set are left out; `rest` follows the agent's
 * own fields, which win over a key of the same name in it. Parsing the text gives back what went
 * in, however awkward the strings are.
 */
export function renderAgentToml(agent: CodexAgentFile, rest: Record<string, unknown> = {}): string {
  const table: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(agent)) {
    if (value !== undefined) table[key] = value;
  }
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && !Object.hasOwn(table, key)) table[key] = value;
  }
  const text = stringify(table);
  return text.endsWith("\n") ? text : `${text}\n`;
}

// -- Where the agent goes ------------------------------------------------------------------------

/**
 * The stem of the agent file to write. A free `<slug>.toml` is taken. When it is taken, `copy`
 * goes to the first free `<slug>-2.toml`...; `replace` writes over it only when `ids` records an
 * agent there, which proves that OpenTeleport wrote the file, and refuses otherwise; and `update`
 * writes over it only when `ids` records this very agent (the Bundle's id) there, or else over
 * the `<slug>-N.toml` that `ids` records for it. Any other agent of the same name keeps its file
 * and this one becomes a copy, with a warning that says so. Nothing is written through a link.
 */
async function agentFileSlug(
  dir: string,
  bundle: Bundle,
  opts: WriteOpts,
  ids: AgentIds,
  items: Items,
): Promise<string> {
  const base = agentSlug(bundle.manifest.name);
  const path = join(dir, `${base}${AGENT_EXTENSION}`);
  const existing = await lstatIfAny(path);
  if (existing === undefined) return base;

  if (opts.onConflict === "copy") {
    const slug = await freeName(dir, base, AGENT_EXTENSION);
    items.warnings.push(
      `an agent named ${base} already exists in Codex; this one was written as ${slug}`,
    );
    return slug;
  }
  if (opts.onConflict === "replace") {
    const why = existing.isSymbolicLink()
      ? "it is a symbolic link"
      : !existing.isFile()
        ? "it is not a regular file"
        : !Object.hasOwn(ids, base)
          ? "OpenTeleport did not write it"
          : undefined;
    if (why !== undefined) {
      throw new Error(`Refusing to replace ${path}: ${why}. Delete it yourself if you mean it.`);
    }
    return base;
  }
  if (existing.isSymbolicLink() || !existing.isFile()) {
    // Overwriting would write wherever the link points, so the agent gets a name of its own.
    const slug = await freeName(dir, base, AGENT_EXTENSION);
    items.warnings.push(
      existing.isSymbolicLink()
        ? `agent file '${base}.toml' is a symlink; written as '${slug}.toml'`
        : `'${base}.toml' is not a regular file; written as '${slug}.toml'`,
    );
    return slug;
  }
  // An empty id is no id: nothing proves the agent there is this one.
  const { id } = bundle.manifest;
  if (id !== "" && Object.hasOwn(ids, base) && ids[base] === id) return base;
  // An earlier move may already have given this agent a `-N` file of its own: update that one.
  const own = id === "" ? undefined : await recordedCopy(dir, base, AGENT_EXTENSION, id, ids);
  if (own !== undefined) return own;
  const slug = await freeName(dir, base, AGENT_EXTENSION);
  items.warnings.push(`agent '${base}' already exists; written as '${slug}'`);
  return slug;
}

/** File names and Codex role names are separate namespaces. Keep an update's role. */
async function runtimeName(
  dir: string,
  slug: string,
  wanted: string,
  preserve: boolean,
  items: Items,
): Promise<string> {
  const taken = new Set<string>(["default", "explorer", "worker"]);
  let previous: string | undefined;
  for (const entry of await entriesOf(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(AGENT_EXTENSION)) continue;
    const file = join(dir, entry.name);
    if (((await lstatIfAny(file))?.size ?? 0) > MAX_TEXT_ENTRY_BYTES) {
      throw new Error(`${entry.name} is too large to check its Codex runtime name`);
    }
    const text = await readFile(file, "utf8");
    let name: string;
    try {
      name = parseAgentToml(text, entry.name).agent.name;
    } catch {
      items.warnings.push(
        `could not read runtime name from ${entry.name}; invalid agent file ignored`,
      );
      continue;
    }
    if (entry.name === slug + AGENT_EXTENSION) {
      if (name !== "") previous = name;
    } else if (name !== "") {
      taken.add(name);
    }
  }
  const base = preserve && previous !== undefined ? previous : wanted;
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = base + "-" + n;
  if (name !== wanted) items.warnings.push("Codex runtime role name: " + JSON.stringify(name));
  return name;
}

// -- What goes into the file ---------------------------------------------------------------------

/** The first line of the instructions that is not a heading, without its list marker. */
function firstLine(instructions: string): string {
  const line = instructions
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => text !== "" && !text.startsWith("#"));
  return line?.replace(/^(?:[-*+]|\d+[.)])\s+/, "") ?? "";
}

/** The title, else the opening of the instructions, else the description, else the name. */
function descriptionOf(bundle: Bundle): string {
  const { title, description, name } = bundle.manifest;
  const chosen = [title, firstLine(bundle.instructions), description, name]
    .map((text) => text?.trim() ?? "")
    .find((text) => text !== "");
  return truncate(chosen ?? name, MAX_DESCRIPTION_CHARS);
}

/**
 * The persona and instructions in the layout `readCodexAgent` splits again, then the facts as a
 * `# Facts` section. Codex has no place for facts of its own, so they are part of the text.
 */
function developerInstructions(bundle: Bundle, items: Items): string {
  const merged = mergeInstructions(bundle.persona, bundle.instructions);
  if ((bundle.persona?.trim() ?? "") !== "") {
    items.approximated.push({
      field: "persona",
      detail: "persona and instructions share one field, developer_instructions",
    });
  }
  const facts = factsToProse(bundle.facts);
  if (facts === "") return merged;
  items.approximated.push({
    field: "memory.facts",
    detail: "facts are written as a Facts section at the end of developer_instructions",
  });
  return merged.trim() === "" ? `# Facts\n${facts}` : `${merged}\n\n# Facts\n${facts}`;
}

/** Whether Codex can run the model a preference names: OpenAI's, or one meant for Codex. */
const isForCodex = (pref: ModelPref): boolean =>
  pref.model !== undefined &&
  (pref.runtime === "codex" ||
    pref.provider === "openai" ||
    (pref.runtime === undefined && pref.provider === undefined));

const isNickname = (name: unknown): name is string =>
  typeof name === "string" && NICKNAME.test(name);

/**
 * `x-codex.nickname_candidates` when Codex would accept it. Codex refuses a whole agent file over
 * a bad nickname, so an invalid list is left out and reported instead of written.
 */
function nicknamesOf(value: unknown, items: Items): string[] | undefined {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return undefined;
  if (Array.isArray(value) && value.every(isNickname) && new Set(value).size === value.length) {
    return value;
  }
  items.warnings.push(
    "nickname_candidates not written: Codex takes only unique names of letters, digits, spaces, - and _",
  );
  return undefined;
}

/**
 * The settings of the agent file at `path` that the Bundle has no place for (`features`,
 * `sandbox_mode`, `model_verbosity`...), so that rewriting the file keeps them. Nothing is kept
 * when there is no regular file to overwrite. The parser drops comments, so overwriting a file
 * is reported; unreadable TOML is refused before any destination writes.
 */
async function keptSettings(
  path: string,
  label: string,
  items: Items,
): Promise<Record<string, unknown>> {
  if (!(await lstatIfAny(path))?.isFile()) return {};
  const text = await readFile(path, "utf8");
  try {
    const { rest } = parseAgentToml(text, label);
    items.warnings.push(`${label} rewritten; comments may be lost`);
    return rest;
  } catch (error) {
    throw new Error(`${(error as Error).message}; refusing to overwrite invalid TOML. Repair the file or use --copy.`);
  }
}

/**
 * The text of the agent file for `bundle`; what the report needs to say about it goes to `items`.
 * `kept` is what the file held before (see `keptSettings`); the Bundle's own fields win over it.
 */
function renderBundle(
  bundle: Bundle,
  items: Items,
  kept: Record<string, unknown>,
  name: string,
): string {
  const { manifest } = bundle;
  const model = manifest.models.find(isForCodex)?.model;
  if (model === undefined && manifest.models.length > 0) {
    items.skipped.push({
      field: "models",
      detail: "no model preference Codex can use; the agent uses the session's model",
    });
  }
  // What an agent that came from Codex carried in `x-codex`; anything of the wrong type is ignored.
  const vendor: unknown = manifest["x-codex"];
  const settings = isRecord(vendor) ? vendor : {};
  const { reasoningEffort, skillsConfig } = settings;
  const nicknames = nicknamesOf(settings.nickname_candidates, items);

  const agent: CodexAgentFile = {
    name,
    description: descriptionOf(bundle),
    developer_instructions: developerInstructions(bundle, items),
    ...(model === undefined ? {} : { model }),
    ...(typeof reasoningEffort === "string" && reasoningEffort !== ""
      ? { model_reasoning_effort: reasoningEffort }
      : {}),
    ...(nicknames === undefined ? {} : { nickname_candidates: nicknames }),
  };
  const hasSkillsConfig =
    Array.isArray(skillsConfig) && skillsConfig.length > 0 && skillsConfig.every(isRecord);
  const rest = { ...kept };
  if (hasSkillsConfig) {
    // The Bundle's skills config replaces the file's own; its other `skills` settings stay.
    rest.skills = { ...(isRecord(kept.skills) ? kept.skills : {}), config: skillsConfig };
  }
  return renderAgentToml(agent, rest);
}

/**
 * Writes a Bundle as a custom agent of the Codex home (`ctx.targetDir`, `CODEX_HOME` or
 * `~/.codex`): `agents/<slug>.toml`, its skills in `~/.agents/skills` (shared with every tool
 * that reads it, so a skill that is already there is reused and none is ever removed), and its
 * id in `openteleport-ids.json` in the Codex home. Skill associations are recorded separately in
 * `openteleport-skills/<slug>.json` for custom-agent re-export; shared skills are never deleted.
 * An agent file it overwrites keeps the settings
 * the Bundle has no place for. `config.toml`, `AGENTS.md` and the memory are not touched, and
 * `bundle` is not changed.
 */
export async function writeCodexAgent(
  ctx: Ctx,
  bundle: Bundle,
  opts: WriteOpts,
): Promise<WriteResult> {
  const home = codexHome(ctx);
  const dir = agentsDir(home);
  const idsFile = join(home, IDS_FILE);
  const items: Items = { approximated: [], skipped: [], warnings: [] };

  // Everything that can refuse comes before the first write.
  const ids = await readIds(idsFile);
  const slug = await agentFileSlug(dir, bundle, opts, ids, items);
  const path = join(dir, `${slug}${AGENT_EXTENSION}`);
  const kept = await keptSettings(path, `agents/${slug}${AGENT_EXTENSION}`, items);
  const name = await runtimeName(
    dir, slug, bundle.manifest.name,
    opts.onConflict === "update" && Object.hasOwn(ids, slug) && ids[slug] === bundle.manifest.id,
    items,
  );
  await checkSkillMetadata(home, slug);
  const text = renderBundle(bundle, items, kept, name);

  const skills = await writeAssociatedSkills(ctx, bundle.skills, items);
  if (bundle.skills.length > 0) {
    items.warnings.push("Codex skills are shared by every tool reading ~/.agents/skills");
  }
  await replaceFile(path, text);
  await recordId(idsFile, slug, bundle.manifest.id, items);
  await recordSkills(home, slug, bundle.manifest.id, skills);
  items.warnings.push(
    `Use the Codex agent named ${JSON.stringify(name)} (file: ${slug}.toml)`,
  );

  return { outcome: "done", targetAgentId: slug, artifactPath: path, items };
}
