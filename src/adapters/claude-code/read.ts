import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MAX_FACT_CHARS, isForbiddenPath } from "../../core/paths.js";
import type {
  Bundle,
  Capability,
  FileEntry,
  Manifest,
  ModelPref,
  Note,
  Skill,
} from "../../core/schema.js";
import { splitInstructions } from "../../core/text.js";
import { lstatIfAny } from "../fs.js";
import { readIds } from "../marker.js";
import type { AgentRef, Ctx } from "../types.js";
import { type AgentFile, parseAgentFile } from "./frontmatter.js";
import { type ClaudePaths, claudePaths } from "./paths.js";
import { idsFileOf, isNoteLink } from "./write.js";

const APP = "claude-code";
const MAX_NAME_CHARS = 80;
const MAX_TITLE_CHARS = 120;
const USER_PREFIX = "user:";
const MEMORY_FILE = "MEMORY.md";
const SKILL_FILE = "SKILL.md";
/** The note that carries the lines of `MEMORY.md` that are not facts. */
const PROSE_NOTE = "MEMORY-prose";
/** The note that carries the `MEMORY.md` bullets too long to be facts. */
const LONG_NOTE = "MEMORY-long";
/** Same rule as the manifest `id` in `schema.ts`. */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Tool name prefixes, compared ignoring case, and the capability each one implies. */
const CAPABILITY_PREFIXES: readonly { capability: Capability; prefixes: readonly string[] }[] = [
  { capability: "browser", prefixes: ["mcp__claude-in-chrome", "mcp__Claude_Browser", "Browser"] },
  { capability: "shell", prefixes: ["Bash", "PowerShell"] },
  {
    capability: "filesystem",
    prefixes: ["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"],
  },
  { capability: "network", prefixes: ["WebFetch", "WebSearch"] },
];

/** Cuts `text` to `max` characters, the last one an ellipsis. */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

// Plain code-unit order, so that the result does not depend on the locale.
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

/** The entries of `dir`, or none when it does not exist. */
async function entriesOf(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

const linkWarning = (skill: string, path?: string): string =>
  path === undefined
    ? `skill '${skill}' is a symlink; not exported`
    : `skill '${skill}': '${path}' is a symlink; not exported`;

/** The stems of the `*.md` files in `dir`, sorted. */
async function markdownStems(dir: string): Promise<string[]> {
  return (await entriesOf(dir))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -".md".length))
    .sort(byCodeUnit);
}

type AgentLocation = { id: string; stem: string; scope: "project" | "user"; path: string };

/**
 * Every agent file, project ones first. A user agent whose stem a project agent already takes
 * gets the id `user:<stem>`. When the project is the home directory both scopes are the same
 * directory, and its agents are listed once, as project agents.
 */
async function agentLocations(paths: ClaudePaths): Promise<AgentLocation[]> {
  const project = await markdownStems(paths.projectAgents);
  const sameDir = resolve(paths.projectAgents) === resolve(paths.userAgents);
  const user = sameDir ? [] : await markdownStems(paths.userAgents);
  const taken = new Set(project);
  return [
    ...project.map((stem) => ({
      id: stem,
      stem,
      scope: "project" as const,
      path: join(paths.projectAgents, `${stem}.md`),
    })),
    ...user.map((stem) => ({
      id: taken.has(stem) ? `${USER_PREFIX}${stem}` : stem,
      stem,
      scope: "user" as const,
      path: join(paths.userAgents, `${stem}.md`),
    })),
  ];
}

async function parseAt(path: string): Promise<AgentFile> {
  const text = await readFile(path, "utf8");
  try {
    return parseAgentFile(text);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

/** The agents in `projectAgents`, then those in `userAgents`; `id` is what `readAgent` takes. */
export async function listAgents(ctx: Ctx): Promise<AgentRef[]> {
  const refs: AgentRef[] = [];
  for (const { id, stem, path } of await agentLocations(claudePaths(ctx))) {
    let file: AgentFile | undefined;
    try {
      file = await parseAt(path);
    } catch {
      // A file that cannot be parsed is still an agent; `read` reports what is wrong with it.
    }
    const description = file?.description;
    refs.push({
      id,
      name: file?.name ?? stem,
      ...(description === undefined ? {} : { title: truncate(description, MAX_TITLE_CHARS) }),
      location: path,
    });
  }
  return refs;
}

/**
 * The agent `agent` names: a project agent before a user agent of the same stem, and only a
 * user agent after a `user:` prefix. Only listed files can be found, so no path escapes the
 * agents directories.
 */
async function locate(paths: ClaudePaths, agent: string): Promise<AgentLocation> {
  const locations = await agentLocations(paths);
  const userOnly = agent.startsWith(USER_PREFIX);
  const stem = userOnly ? agent.slice(USER_PREFIX.length) : agent;
  const found = locations.find(
    (location) => location.stem === stem && (!userOnly || location.scope === "user"),
  );
  if (found !== undefined) return found;
  throw new Error(
    locations.length === 0
      ? `Claude Code has no agent "${agent}": no agents in ${paths.projectAgents} or ${paths.userAgents}`
      : `Claude Code has no agent "${agent}". Available: ${locations.map(({ id }) => id).join(", ")}`,
  );
}

function capabilitiesOf(tools: readonly string[]): Capability[] {
  const names = tools.map((tool) => tool.toLowerCase());
  return CAPABILITY_PREFIXES.filter(({ prefixes }) =>
    names.some((name) => prefixes.some((prefix) => name.startsWith(prefix.toLowerCase()))),
  ).map(({ capability }) => capability);
}

/**
 * Files below `dir` as `/`-separated paths. Links (symbolic links and junctions) are never
 * followed; they, forbidden paths and special files are left out and named.
 */
async function skillFiles(dir: string, skill: string, warnings: string[]): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    // Dirent types come from lstat, so a link is neither a file nor a directory here.
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(linkWarning(skill, path));
      } else if (isForbiddenPath(path) || !(entry.isDirectory() || entry.isFile())) {
        warnings.push(`skill '${skill}': left out '${path}'`);
      } else if (entry.isDirectory()) {
        await walk(absolute, path);
      } else {
        files.push({ path, bytes: new Uint8Array(await readFile(absolute)) });
      }
    }
  }
  await walk(dir, "");
  // SKILL.md first, then the others in code-unit order.
  return files.sort((a, b) =>
    a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : byCodeUnit(a.path, b.path),
  );
}

/**
 * Every real folder of `skillsDir` that holds a real `SKILL.md`, in name order. A linked skill
 * folder or `SKILL.md` is never followed, since it can point anywhere on disk; it is named in a
 * warning instead.
 */
async function readSkills(skillsDir: string, warnings: string[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  const names = (await entriesOf(skillsDir)).map((entry) => entry.name).sort(byCodeUnit);
  for (const name of names) {
    const dir = join(skillsDir, name);
    const folder = await lstatIfAny(dir);
    if (folder?.isSymbolicLink()) {
      warnings.push(linkWarning(name));
      continue;
    }
    if (!folder?.isDirectory()) continue;
    const skillFile = await lstatIfAny(join(dir, SKILL_FILE));
    if (skillFile?.isSymbolicLink()) {
      warnings.push(linkWarning(name, SKILL_FILE));
      continue;
    }
    if (!skillFile?.isFile()) continue;
    skills.push({ name, files: await skillFiles(dir, name, warnings) });
  }
  return skills;
}

/**
 * `MEMORY.md` bullets are facts, its other lines one `MEMORY-prose` note, and every other `*.md`
 * file of the memory directory a note named by its stem. A bullet over 500 characters is kept
 * in a `MEMORY-long` note instead of being cut. A bullet that is only a link to a file beside
 * `MEMORY.md` (`- [diary](imported-ada-diary.md)`, as a move in writes for each note) is an
 * index entry: the file is read as a note, the line as neither a fact nor prose.
 */
async function readMemory(
  memoryDir: string,
  warnings: string[],
): Promise<{ facts: string[]; notes: Note[] }> {
  const facts: string[] = [];
  const notes: Note[] = [];
  const prose: string[] = [];
  const long: string[] = [];

  for (const stem of await markdownStems(memoryDir)) {
    const text = await readFile(join(memoryDir, `${stem}.md`), "utf8");
    if (`${stem}.md` !== MEMORY_FILE) {
      notes.push({ name: stem, text });
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (!trimmed.startsWith("- ")) {
        prose.push(line.trimEnd());
        continue;
      }
      const fact = trimmed.slice(2).trim();
      if (isNoteLink(fact)) continue;
      if (fact.length > MAX_FACT_CHARS) long.push(fact);
      else facts.push(fact);
    }
  }

  if (prose.length > 0) notes.push({ name: PROSE_NOTE, text: prose.join("\n") });
  if (long.length > 0) {
    notes.push({ name: LONG_NOTE, text: long.map((fact) => `- ${fact}`).join("\n") });
    warnings.push(
      long.length === 1
        ? `1 fact over ${MAX_FACT_CHARS} characters was kept as the note ${LONG_NOTE}`
        : `${long.length} facts over ${MAX_FACT_CHARS} characters were kept as the note ${LONG_NOTE}`,
    );
  }
  return { facts, notes };
}

/**
 * The id an earlier move recorded for a project agent's file (see `writeAgent`), so that the
 * agent keeps it on its way out; `""` for a user agent, for none and for one that cannot be
 * read, which only costs a new id.
 */
async function recordedId(paths: ClaudePaths, location: AgentLocation): Promise<string> {
  if (location.scope !== "project") return "";
  try {
    const id = (await readIds(idsFileOf(paths)))[location.stem];
    return id !== undefined && ULID_PATTERN.test(id) ? id : "";
  } catch {
    return "";
  }
}

function modelsOf(model: string | undefined, warnings: string[]): ModelPref[] {
  if (model === undefined || model.toLowerCase() === "inherit") {
    warnings.push("model is inherited; not exported");
    return [];
  }
  // Aliases such as `sonnet` stay as they are: only Claude Code knows what they stand for today.
  return [{ runtime: APP, provider: "anthropic", model }];
}

/**
 * Reads a subagent as a Bundle. `agent` is a file stem from `listAgents`. The body becomes the
 * persona and instructions, the frontmatter the manifest, every project skill a skill and the
 * project's memory the facts and notes. `CLAUDE.md` is project-wide and is not read. The id is
 * the one an earlier move recorded for the agent's file, else empty for the engine to fill in.
 */
export async function readAgent(
  ctx: Ctx,
  agent: string,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const paths = claudePaths(ctx);
  const location = await locate(paths, agent);
  const file = await parseAt(location.path);
  const warnings: string[] = [];

  if (file.ignored.length > 0) {
    warnings.push(`frontmatter fields not exported: ${file.ignored.join(", ")}`);
  }
  const models = modelsOf(file.model, warnings);

  let capabilities: Capability[] = [];
  if (file.tools === undefined) {
    warnings.push("tools are not declared; capabilities unknown");
  } else {
    capabilities = capabilitiesOf(file.tools);
    if (capabilities.length > 0) warnings.push("capabilities are derived from the tools list");
  }

  const skills = await readSkills(paths.projectSkills, warnings);
  if (skills.length > 0) warnings.push("Claude Code skills are project-wide; all were exported");
  const { facts, notes } = await readMemory(paths.memoryDir(paths.projectDir), warnings);

  const { description } = file;
  const title = description === undefined ? undefined : truncate(description, MAX_TITLE_CHARS);
  const manifest: Manifest = {
    schemaVersion: "0.1",
    id: await recordedId(paths, location),
    name: truncate(file.name ?? location.stem, MAX_NAME_CHARS),
    ...(title === undefined ? {} : { title }),
    // A description the title had to cut is kept whole, so nothing of it is lost.
    ...(description !== undefined && description !== title ? { description } : {}),
    models,
    capabilities,
    origin: { app: APP, exportedAt: new Date().toISOString() },
    "x-claude-code": {
      tools: file.tools ?? [],
      ...(file.model === undefined ? {} : { model: file.model }),
      scope: location.scope,
    },
  };

  const { persona, instructions } = splitInstructions(file.body);
  return {
    bundle: {
      manifest,
      ...(persona === undefined ? {} : { persona }),
      instructions,
      skills,
      routines: [],
      facts,
      notes,
      files: [],
      unknownPaths: [],
    },
    warnings,
  };
}
