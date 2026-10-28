import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Item } from "../../core/report.js";
import { isReservedDeviceName, isSafeArchivePath } from "../../core/paths.js";
import type { Bundle, Manifest } from "../../core/schema.js";
import { factsToProse, mergeInstructions } from "../../core/text.js";
import { type AgentIds, readIds, recordId } from "../marker.js";
import { writeSkills } from "../skills.js";
import type { Ctx, WriteOpts, WriteResult } from "../types.js";
import { renderAgentFile } from "./frontmatter.js";
import { type ClaudePaths, claudePaths } from "./paths.js";

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
 * The `<base>-N` stem that `ids` records for the agent with `id`, the lowest N first, when its
 * file is not a link; `undefined` when there is none.
 */
async function recordedCopy(
  dir: string,
  base: string,
  id: string,
  ids: AgentIds,
): Promise<string | undefined> {
  const prefix = `${base}-`;
  const copies = Object.entries(ids)
    .filter(([slug, recorded]) => recorded === id && slug.startsWith(prefix))
    .map(([slug]) => ({ slug, n: slug.slice(prefix.length) }))
    .filter(({ n }) => /^[1-9]\d*$/.test(n) && Number(n) >= 2)
    .sort((a, b) => Number(a.n) - Number(b.n));
  for (const { slug } of copies) {
    if (!(await lstatOf(join(dir, `${slug}.md`)))?.isSymbolicLink()) return slug;
  }
  return undefined;
}

/**
 * The stem of the agent file to write. A free `<slug>.md` is taken. When it is taken, `copy`
 * goes to the first free `<slug>-2.md`, `<slug>-3.md`...; a link is never written through, so it
 * gets a name of its own in every mode; `replace` writes over the file; and `update` writes
 * over it only when `ids` records this very agent (the Bundle's id) there, or else over the
 * `<slug>-N.md` that `ids` records for it. Any other agent of the same name keeps its file and
 * this one becomes a copy, with a warning that says so.
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
  const { id } = bundle.manifest;
  if (id !== "" && ids[base] === id) return base;
  // An earlier move may already have given this agent a `-N` file of its own: update that one.
  const own = id === "" ? undefined : await recordedCopy(dir, base, id, ids);
  if (own !== undefined) return own;
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
  if (slug !== manifest.name) {
    items.approximated.push({
      field: "name",
      detail: `written as ${slug}; Claude Code names are lowercase and hyphenated`,
    });
  }

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
const linkedMemory = (field: string, path: string): Item => ({
  field,
  detail: `${path} is a symlink; not written`,
});

/**
 * The bullet text that links a note file from `MEMORY.md`, `[<note>](<file>)`, so that Claude
 * Code, which loads `MEMORY.md` as the index of the memory directory, finds the note. A file
 * name with spaces or parentheses is put in `<...>`.
 */
export function noteLink(note: string, file: string): string {
  const label = note.replace(/[\\[\]]/g, "\\$&");
  return `[${label}](${/[\s()<>]/.test(file) ? `<${file}>` : file})`;
}

/** `[label](file.md)` alone, the file a single name: what `noteLink` writes. */
const NOTE_LINK = /^\[(?:\\.|[^\\[\]\r\n])*\]\((?:<([^<>\r\n]+)>|([^\s()<>]+))\)$/;

/**
 * Whether the text of a `MEMORY.md` bullet is only a link to a Markdown file beside it, as
 * `noteLink` writes one: an index entry, not a fact. A link with more text after it is a fact.
 */
export function isNoteLink(text: string): boolean {
  const match = NOTE_LINK.exec(text);
  const file = match?.[1] ?? match?.[2];
  return file !== undefined && file.endsWith(".md") && !/[\\/]/.test(file);
}

/**
 * Appends to `MEMORY.md` the facts it does not hold yet, then a link to each imported note it
 * does not link yet, as `- ` lines in the file's own line endings, after a blank line when the
 * file ends in prose. The file is only ever appended to, never rewritten, so what it holds stays
 * byte for byte even while Claude Code writes to it. A linked `MEMORY.md` is left alone and
 * reported.
 */
async function appendMemory(
  memoryDir: string,
  facts: readonly string[],
  links: readonly string[],
  items: Items,
) {
  if (facts.length === 0 && links.length === 0) return;
  const path = join(memoryDir, MEMORY_FILE);
  if ((await lstatOf(path))?.isSymbolicLink()) {
    if (facts.length > 0) items.skipped.push(linkedMemory("memory.facts", path));
    if (links.length > 0) {
      items.warnings.push(`${path} is a symlink; the imported notes are not linked from it`);
    }
    return;
  }
  const existing = await readText(path);
  const known = factsIn(existing);
  const fresh: string[] = [];
  for (const bullet of [...facts.map((fact) => factsToProse([fact]).slice(2)), ...links]) {
    if (bullet === "" || known.has(bullet)) continue;
    known.add(bullet);
    fresh.push(bullet);
  }
  if (fresh.length === 0) return;

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/).filter((line) => line.trim() !== "");
  const last = lines.at(-1);
  let separator = "";
  if (existing !== "" && !existing.endsWith("\n")) separator = eol;
  if (last !== undefined && !last.trim().startsWith("- ")) separator += eol;
  const appended = fresh.map((bullet) => `- ${bullet}${eol}`).join("");
  await mkdir(memoryDir, { recursive: true });
  await appendFile(path, `${separator}${appended}`);
}

/**
 * Notes go next to `MEMORY.md` as `imported-<slug>-<note>.md`, overwriting earlier imports. A
 * note whose file is a link is left alone and reported. Returns the `MEMORY.md` link of each
 * note written (see `noteLink`).
 */
async function writeNotes(
  memoryDir: string,
  slug: string,
  bundle: Bundle,
  items: Items,
): Promise<string[]> {
  const links: string[] = [];
  for (const note of bundle.notes) {
    const name = `imported-${slug}-${note.name}.md`;
    if (!isSafeName(note.name) || !isSafeName(name)) {
      items.skipped.push({ field: `note:${note.name}`, detail: "its name is not safe to write" });
      continue;
    }
    const path = join(memoryDir, name);
    if ((await lstatOf(path))?.isSymbolicLink()) {
      items.skipped.push(linkedMemory(`note:${note.name}`, path));
      continue;
    }
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path, note.text);
    links.push(noteLink(note.name, name));
  }
  return links;
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

/** Where the ids of a project's agents are recorded: beside its memory directory. */
export function idsFileOf(paths: ClaudePaths): string {
  return join(dirname(paths.memoryDir(paths.projectDir)), IDS_FILE);
}

/**
 * Writes a Bundle as a project subagent of `ctx.targetDir` (or `ctx.cwd`): the agent file in
 * `.claude/agents/`, its skills in `.claude/skills/`, its facts and notes in the project's memory
 * directory under the user's Claude Code directory (each note linked from `MEMORY.md`, which is
 * only appended to), and its id in `IDS_FILE` beside that memory directory. Nothing else of the
 * user's directory is touched, and `bundle` is not changed.
 */
export async function writeAgent(ctx: Ctx, bundle: Bundle, opts: WriteOpts): Promise<WriteResult> {
  const paths = claudePaths(ctx, ctx.targetDir ?? ctx.cwd);
  const items: Items = { approximated: [], skipped: [], warnings: [] };

  const memoryDir = paths.memoryDir(paths.projectDir);
  const idsFile = idsFileOf(paths);

  const ids = await readIds(idsFile);
  const agent = await writeAgentFile(paths.projectAgents, bundle, opts, ids, items);
  await writeSkills(paths.projectSkills, bundle.skills, items);
  const links = await writeNotes(memoryDir, agent.slug, bundle, items);
  await appendMemory(memoryDir, bundle.facts, links, items);
  items.skipped.push(...unsupported(bundle, opts));
  await recordId(idsFile, agent.slug, bundle.manifest.id, items);

  return { outcome: "done", targetAgentId: agent.slug, artifactPath: agent.path, items };
}
