import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Item } from "../../core/report.js";
import { isReservedDeviceName, isSafeArchivePath } from "../../core/paths.js";
import type { Bundle, Manifest } from "../../core/schema.js";
import { factsToProse, mergeInstructions } from "../../core/text.js";
import type { Ctx, WriteOpts, WriteResult } from "../types.js";
import { renderAgentFile } from "./frontmatter.js";
import { claudePaths } from "./paths.js";

const MAX_SLUG_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 120;
const MEMORY_FILE = "MEMORY.md";

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

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** `<base><ext>` in `dir`, or the first of `<base>-2<ext>`, `<base>-3<ext>`... that is free. */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  let name = base;
  for (let n = 2; await exists(join(dir, `${name}${ext}`)); n += 1) name = `${base}-${n}`;
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

async function writeAgentFile(
  dir: string,
  bundle: Bundle,
  opts: WriteOpts,
  items: Items,
): Promise<{ slug: string; path: string }> {
  const { manifest } = bundle;
  const base = agentSlug(manifest.name);
  const slug = opts.onConflict === "copy" ? await freeName(dir, base, ".md") : base;
  if (slug !== base) {
    items.warnings.push(
      `an agent named ${base} already exists in Claude Code; this one was written as ${slug}`,
    );
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
  const title = manifest.title?.trim();
  const description =
    title || truncate(firstSentence(bundle.instructions), MAX_DESCRIPTION_CHARS) || manifest.name;

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
 * Skills go to `<project>/.claude/skills/<name>/`. They are shared by the whole project, so only
 * `update` overwrites one that exists; `copy` and `replace` write `<name>-2` instead.
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
    const name = opts.onConflict === "update" ? skill.name : await freeName(dir, skill.name, "");
    if (name !== skill.name) {
      items.approximated.push({
        field: `skill:${skill.name}`,
        detail: `a skill of that name already exists; written as ${name}`,
      });
    }
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

/**
 * Appends the facts `MEMORY.md` does not hold yet as `- fact` lines, in the file's own line
 * endings and after a blank line when the file ends in prose.
 */
async function appendFacts(memoryDir: string, facts: readonly string[]): Promise<void> {
  const path = join(memoryDir, MEMORY_FILE);
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

/** Notes go next to `MEMORY.md` as `imported-<slug>-<note>.md`, overwriting earlier imports. */
async function writeNotes(memoryDir: string, slug: string, bundle: Bundle, items: Items) {
  for (const note of bundle.notes) {
    const name = `imported-${slug}-${note.name}.md`;
    if (!isSafeName(note.name) || !isSafeName(name)) {
      items.skipped.push({ field: `note:${note.name}`, detail: "its name is not safe to write" });
      continue;
    }
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, name), note.text);
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

/**
 * Writes a Bundle as a project subagent of `ctx.targetDir` (or `ctx.cwd`): the agent file in
 * `.claude/agents/`, its skills in `.claude/skills/`, its facts and notes in the project's memory
 * directory under the user's Claude Code directory. Nothing else of that directory is touched,
 * and `bundle` is not changed.
 */
export async function writeAgent(ctx: Ctx, bundle: Bundle, opts: WriteOpts): Promise<WriteResult> {
  const paths = claudePaths(ctx, ctx.targetDir ?? ctx.cwd);
  const items: Items = { approximated: [], skipped: [], warnings: [] };

  const agent = await writeAgentFile(paths.projectAgents, bundle, opts, items);
  await writeSkills(paths.projectSkills, bundle, opts, items);
  const memoryDir = paths.memoryDir(paths.projectDir);
  await appendFacts(memoryDir, bundle.facts);
  await writeNotes(memoryDir, agent.slug, bundle, items);
  items.skipped.push(...unsupported(bundle, opts));

  return { outcome: "done", targetAgentId: agent.slug, artifactPath: agent.path, items };
}
