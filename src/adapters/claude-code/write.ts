import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Item } from "../../core/report.js";
import { isReservedDeviceName, isSafeArchivePath } from "../../core/paths.js";
import type { Bundle, Manifest, Skill } from "../../core/schema.js";
import { factsToProse, mergeInstructions } from "../../core/text.js";
import type { Ctx, WriteOpts, WriteResult } from "../types.js";
import { renderAgentFile } from "./frontmatter.js";
import { claudePaths } from "./paths.js";

const MAX_SLUG_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 120;
const MEMORY_FILE = "MEMORY.md";
/**
 * Which agent each `<slug>.md` of a project holds, as `{ "<slug>": "<manifest id>" }`. It sits
 * beside the project's memory directory, never inside it, so Claude Code does not read it as
 * memory, and the agent file itself stays as Claude Code writes it.
 */
const IDS_FILE = "openteleport-ids.json";

type Items = WriteResult["items"];

/**
 * The file stem and frontmatter `name` for an agent: lowercase, every run of characters outside
 * `a-z0-9` one `-`, no `-` at either end, at most 64 characters. Nothing usable gives `agent`;
 * a Windows device name such as `con` gets `-agent`.
 */
export function agentSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-$/, "");
  if (slug === "") return "agent";
  return isReservedDeviceName(slug) ? `${slug}-agent` : slug;
}

/** A name that is one safe path segment: it cannot reach outside the directory it is put in. */
const isSafeName = (name: string): boolean => isSafeArchivePath(name) && !name.includes("/");

/** Cuts `text` to `max` characters, the last one an ellipsis. */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** What is at `path` itself, a link never followed; `undefined` when nothing is. */
async function lstatOf(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * `<base><ext>` in `dir`, or the first of `<base>-2<ext>`, `<base>-3<ext>`... that is free. A
 * link, even a broken one, takes its name.
 */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  let name = base;
  for (let n = 2; (await lstatOf(join(dir, `${name}${ext}`))) !== undefined; n += 1) {
    name = `${base}-${n}`;
  }
  return name;
}

/** The first sentence of the instructions' prose, headings and list markers left out. */
function firstSentence(instructions: string): string {
  const prose = instructions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/^(?:[-*+]|\d+[.)])\s+/, ""))
    .join(" ");
  return /^.*?[.!?](?=\s|$)/.exec(prose)?.[0] ?? prose;
}

/** `x-claude-code.tools` when it is a non-empty list of names. */
function toolsOf(manifest: Manifest): string[] | undefined {
  const vendor = manifest["x-claude-code"];
  if (typeof vendor !== "object" || vendor === null) return undefined;
  const { tools } = vendor as { tools?: unknown };
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.every((tool) => typeof tool === "string") ? [...tools] : undefined;
}

/**
 * The stem of the agent file to write. A free `<slug>.md` is taken. When it is taken, `copy`
 * goes to the first free `<slug>-2.md`, `<slug>-3.md`...; a link is never written through, so it
 * gets a name of its own in every mode; `replace` writes over the file; and `update` writes
 * over it only when `ids` records this very agent (the Bundle's id) there. Any other agent of
 * the same name keeps its file and this one becomes a copy, with a warning that says so.
 */
async function agentFileSlug(
  dir: string,
  bundle: Bundle,
  opts: WriteOpts,
  ids: AgentIds,
  items: Items,
): Promise<string> {
  const base = agentSlug(bundle.manifest.name);
  const existing = await lstatOf(join(dir, `${base}.md`));
  if (existing === undefined) return base;

  if (opts.onConflict === "copy") {
    const slug = await freeName(dir, base, ".md");
    items.warnings.push(
      `an agent named ${base} already exists in Claude Code; this one was written as ${slug}`,
    );
    return slug;
  }
  if (existing.isSymbolicLink()) {
    // Overwriting would write wherever the link points, so the agent gets a name of its own.
    const slug = await freeName(dir, base, ".md");
    items.warnings.push(`agent file '${base}.md' is a symlink; written as '${slug}.md'`);
    return slug;
  }
  if (opts.onConflict === "replace") return base;
  // An empty id is no id: nothing proves the agent there is this one.
  if (bundle.manifest.id !== "" && ids[base] === bundle.manifest.id) return base;
  const slug = await freeName(dir, base, ".md");
  items.warnings.push(`agent '${base}' already exists; written as '${slug}'`);
  return slug;
}

async function writeAgentFile(
  dir: string,
  bundle: Bundle,
  opts: WriteOpts,
  ids: AgentIds,
  items: Items,
): Promise<{ slug: string; path: string }> {
  const { manifest } = bundle;
  const slug = await agentFileSlug(dir, bundle, opts, ids, items);

  const model = manifest.models.find((pref) => pref.provider === "anthropic")?.model;
  if (model === undefined && manifest.models.length > 0) {
    items.skipped.push({
      field: "models",
      detail: "no Anthropic model preference; the agent uses the session's model",
    });
  }
  const tools = toolsOf(manifest);
  if (tools === undefined && manifest.capabilities.length > 0) {
    items.approximated.push({
      field: "capabilities",
      detail: "no Claude Code tools list; the agent gets every tool the session allows",
    });
  }
  // The full description, never shortened; then the title; then the opening of the instructions.
  const description =
    manifest.description?.trim() ||
    manifest.title?.trim() ||
    truncate(firstSentence(bundle.instructions), MAX_DESCRIPTION_CHARS) ||
    manifest.name;

  const path = join(dir, `${slug}.md`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path,
    renderAgentFile({
      name: slug,
      description,
      ...(tools === undefined ? {} : { tools }),
      ...(model === undefined ? {} : { model }),
      body: mergeInstructions(bundle.persona, bundle.instructions),
    }),
  );
  return { slug, path };
}

/**
 * True when the real directory `dir` holds exactly the files of `skill`, byte for byte. A link
 * anywhere below it, or any other special file, makes it different: links are never followed.
 */
async function holdsSkill(dir: string, skill: Skill): Promise<boolean> {
  const found = new Map<string, string>();
  async function walk(current: string, prefix: string): Promise<boolean> {
    // Dirent types come from lstat, so a link is neither a file nor a directory here.
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(absolute, path))) return false;
      } else if (entry.isFile()) {
        found.set(path, absolute);
      } else {
        return false;
      }
    }
    return true;
  }
  if (!(await walk(dir, "")) || found.size !== skill.files.length) return false;
  for (const file of skill.files) {
    const absolute = found.get(file.path);
    if (absolute === undefined || !(await readFile(absolute)).equals(file.bytes)) return false;
  }
  return true;
}

/**
 * The folder name to write `skill` under, or `undefined` to reuse a folder that already holds
 * it. `<name>`, then `<name>-2`, `<name>-3`... are tried in order: the first real folder with the
 * same files and bytes is reused. Under `replace` a real `<name>` folder that differs is removed
 * and its name returned. Otherwise the first free name is returned, with a warning when it is
 * not `<name>`. A link (symbolic link or junction) is never followed or removed: it counts as a
 * taken name that differs.
 */
async function placeSkill(
  dir: string,
  skill: Skill,
  opts: WriteOpts,
  items: Items,
): Promise<string | undefined> {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? skill.name : `${skill.name}-${n}`;
    const path = join(dir, name);
    const existing = await lstatOf(path);
    if (existing === undefined) {
      if (name !== skill.name) {
        items.warnings.push(
          `skill '${skill.name}' already exists with different content; written as '${name}'`,
        );
      }
      return name;
    }
    // lstat: a symbolic link or junction is never a directory here.
    if (!existing.isDirectory()) continue;
    if (await holdsSkill(path, skill)) return undefined;
    if (n === 1 && opts.onConflict === "replace") {
      await rm(path, { recursive: true, force: true });
      return name;
    }
  }
}

/**
 * Skills go to `<project>/.claude/skills/<name>/`, where the whole project shares them, so one
 * that is already there is reused rather than written again (see `placeSkill`).
 */
async function writeSkills(dir: string, bundle: Bundle, opts: WriteOpts, items: Items) {
  for (const skill of bundle.skills) {
    if (!isSafeName(skill.name) || skill.files.some((file) => !isSafeArchivePath(file.path))) {
      items.skipped.push({
        field: `skill:${skill.name}`,
        detail: "its name or a file path is not safe to write",
      });
      continue;
    }
    const name = await placeSkill(dir, skill, opts, items);
    if (name === undefined) continue;
    for (const file of skill.files) {
      const path = join(dir, name, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes);
    }
  }
}

/** The facts `MEMORY.md` already holds: its `- ` lines, as `readAgent` reads them. */
function factsIn(memory: string): Set<string> {
  const facts = new Set<string>();
  for (const line of memory.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) facts.add(trimmed.slice(2).trim());
  }
  return facts;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** A skipped item for a memory file that is a link: it is never written through. */
const linkedMemory = (field: "memory.facts" | "memory.notes", path: string): Item => ({
  field,
  detail: `${path} is a symlink; not written`,
});

/**
 * Appends the facts `MEMORY.md` does not hold yet as `- fact` lines, in the file's own line
 * endings and after a blank line when the file ends in prose. A linked `MEMORY.md` is left
 * alone and reported.
 */
async function appendFacts(memoryDir: string, facts: readonly string[], items: Items) {
  if (facts.length === 0) return;
  const path = join(memoryDir, MEMORY_FILE);
  if ((await lstatOf(path))?.isSymbolicLink()) {
    items.skipped.push(linkedMemory("memory.facts", path));
    return;
  }
  const existing = await readText(path);
  const known = factsIn(existing);
  const fresh: string[] = [];
  for (const fact of facts) {
    const line = factsToProse([fact]).slice(2);
    if (line === "" || known.has(line)) continue;
    known.add(line);
    fresh.push(line);
  }
  if (fresh.length === 0) return;

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/).filter((line) => line.trim() !== "");
  const last = lines.at(-1);
  let separator = "";
  if (existing !== "" && !existing.endsWith("\n")) separator = eol;
  if (last !== undefined && !last.trim().startsWith("- ")) separator += eol;
  const appended = fresh.map((fact) => `- ${fact}${eol}`).join("");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(path, `${existing}${separator}${appended}`);
}

/**
 * Notes go next to `MEMORY.md` as `imported-<slug>-<note>.md`, overwriting earlier imports. A
 * note whose file is a link is left alone and reported.
 */
async function writeNotes(memoryDir: string, slug: string, bundle: Bundle, items: Items) {
  for (const note of bundle.notes) {
    const name = `imported-${slug}-${note.name}.md`;
    if (!isSafeName(note.name) || !isSafeName(name)) {
      items.skipped.push({ field: `note:${note.name}`, detail: "its name is not safe to write" });
      continue;
    }
    const path = join(memoryDir, name);
    if ((await lstatOf(path))?.isSymbolicLink()) {
      items.skipped.push(linkedMemory("memory.notes", path));
      continue;
    }
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path, note.text);
  }
}

/** What Claude Code cannot hold at all, one skipped item each. */
function unsupported(bundle: Bundle, opts: WriteOpts): Item[] {
  const skipped: Item[] = bundle.routines.map((routine) => ({
    field: `routine:${routine.name}`,
    detail: "Claude Code has no file-based routines",
  }));
  if (bundle.avatar !== undefined) {
    skipped.push({ field: "avatar", detail: "Claude Code agents have no avatar" });
  }
  if (opts.includeFiles && bundle.files.length > 0) {
    skipped.push({ field: "files", detail: "Claude Code has no per-agent workspace" });
  }
  return skipped;
}

/** Agent slug → manifest id, as `IDS_FILE` holds it. */
type AgentIds = Record<string, string>;

/**
 * The ids recorded for a project. A missing file records none, and so does one that is not a
 * JSON object: it is replaced on the next write, which costs only an update that becomes a copy.
 * Any other read error is thrown before anything is written.
 */
async function readIds(path: string): Promise<AgentIds> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  return Object.fromEntries(
    Object.entries(json).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}

/**
 * Records that `<slug>.md` holds the agent with `id`, keeping what was recorded for the other
 * slugs. The file is replaced in one step through a temporary sibling, so it is never left half
 * written and a link in its place is replaced rather than written through. A failure only costs
 * a later in-place update, so it becomes a warning.
 */
async function recordId(path: string, slug: string, id: string, items: Items): Promise<void> {
  if (id === "") return;
  const temporary = `${path}.${process.pid}-${Date.now()}.tmp`;
  try {
    const ids = { ...(await readIds(path)), [slug]: id };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(ids, null, 2)}
`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    items.warnings.push(
      `could not record the agent's id in ${path} (${(error as Error).message}); a later move ` +
        "will write a copy instead of updating it",
    );
  }
}

/**
 * Writes a Bundle as a project subagent of `ctx.targetDir` (or `ctx.cwd`): the agent file in
 * `.claude/agents/`, its skills in `.claude/skills/`, its facts and notes in the project's memory
 * directory under the user's Claude Code directory, and its id in `IDS_FILE` beside that memory
 * directory. Nothing else of the user's directory is touched, and `bundle` is not changed.
 */
export async function writeAgent(ctx: Ctx, bundle: Bundle, opts: WriteOpts): Promise<WriteResult> {
  const paths = claudePaths(ctx, ctx.targetDir ?? ctx.cwd);
  const items: Items = { approximated: [], skipped: [], warnings: [] };

  const memoryDir = paths.memoryDir(paths.projectDir);
  const idsFile = join(dirname(memoryDir), IDS_FILE);

  const ids = await readIds(idsFile);
  const agent = await writeAgentFile(paths.projectAgents, bundle, opts, ids, items);
  await writeSkills(paths.projectSkills, bundle, opts, items);
  await appendFacts(memoryDir, bundle.facts, items);
  await writeNotes(memoryDir, agent.slug, bundle, items);
  items.skipped.push(...unsupported(bundle, opts));
  await recordId(idsFile, agent.slug, bundle.manifest.id, items);

  return { outcome: "done", targetAgentId: agent.slug, artifactPath: agent.path, items };
}
