// The universal adapter: an agent that lives in a plain folder, in the same layout a `.jetpack`
// archive uses (`AGENTS.md`, `SOUL.md`, `MEMORY.md`, `skills/`, ...). It reads any folder with an
// `AGENTS.md`, with or without a `jetpack.json`, and writes the full layout, `jetpack.json` too.
// For the tools that open such a folder (Cursor, Gemini CLI, Cline, Codex) it also mirrors the
// skills to `.agents/skills/` and gives Gemini CLI a `GEMINI.md` that imports `AGENTS.md`.
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { bundleToEntries, readBundle, writeBundle } from "../../core/bundle.js";
import type { Bundle, Skill } from "../../core/schema.js";
import { byCodeUnit, slugify } from "../../core/text.js";
import { freeSibling, isFree, isNotFound, lstatIfAny, numberedSiblings } from "../fs.js";
import { findSkillFolders, readSkillFiles } from "../skill-files.js";
import type {
  Adapter,
  AdapterCapabilities,
  AgentRef,
  Ctx,
  WriteOpts,
  WriteResult,
} from "../types.js";

const INSTRUCTIONS_FILE = "AGENTS.md";
const MANIFEST_FILE = "jetpack.json";
/** Files whose absence from a source folder is worth a warning. */
const OPTIONAL_FILES = ["SOUL.md", "MEMORY.md"] as const;

/**
 * Where the tools that work from a folder look for skills: `.agents/skills/<name>/SKILL.md` is
 * what Cursor, Gemini CLI, Cline and Codex all read (checked on Gemini CLI 0.66 and the `skills`
 * CLI Cline 3.0 uses; none of them looks at `skills/`). A write keeps the layout's `skills/` as
 * the record and mirrors each skill here; a read takes a skill that is only here, as a tool or
 * `npx skills add` left it.
 */
const TOOL_SKILLS_DIR = join(".agents", "skills");
/** Gemini CLI reads `GEMINI.md` by default, not `AGENTS.md`; this one-line file imports it. */
const GEMINI_FILE = "GEMINI.md";
const GEMINI_IMPORT = "@./AGENTS.md\n";

const DETECT_HINT = "Pass --source-dir <folder> with an AGENTS.md inside";
const ROUTINES_WARNING = "routines are stored in the folder; no app runs them from here yet";

const CAPABILITIES: AdapterCapabilities = {
  persona: true,
  instructions: true,
  skills: true,
  routines: true,
  facts: true,
  notes: true,
  files: true,
  avatar: true,
  models: true,
  schedules: ["cron", "every", "at"],
  policy: "text",
};

// -- Disk helpers ---------------------------------------------------------------------------

/** What `stat` says about a path, or `undefined` when nothing is there. Follows symbolic links. */
async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  return (await statOrUndefined(path))?.isFile() ?? false;
}

/** The names in a folder; none when it is missing or is not a folder. */
async function namesIn(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

// -- Finding agents -------------------------------------------------------------------------

/** Where to look: `sourceDir`, else `targetDir`, else the working directory. */
const baseDir = (ctx: Ctx): string => resolve(ctx.cwd, ctx.sourceDir ?? ctx.targetDir ?? ctx.cwd);

/** Folders that hold other things than agents are not searched. */
const isSearched = (name: string): boolean => name !== "node_modules" && !name.startsWith(".");

/** The immediate subfolders of `dir` that hold an `AGENTS.md`, sorted by name. */
async function agentFolders(dir: string): Promise<string[]> {
  const names = (await namesIn(dir)).filter(isSearched);
  const holding = await Promise.all(
    names.map(async (name) => ((await isFile(join(dir, name, INSTRUCTIONS_FILE))) ? name : "")),
  );
  return holding.filter((name) => name !== "").sort(byCodeUnit);
}

/** `name` from the folder's `jetpack.json`, else the folder's own name. */
async function agentName(folder: string): Promise<string> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(folder, MANIFEST_FILE), "utf8"));
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "name" in manifest &&
      typeof manifest.name === "string" &&
      manifest.name !== ""
    ) {
      return manifest.name;
    }
  } catch {
    // Listing is for discovery: a missing or broken manifest is reported by `read`, not here.
  }
  return basename(folder);
}

/**
 * The folder an agent id stands for: `"."` is `dir` itself, anything else must be the name of
 * one folder inside it, so that an id can never reach outside `dir`.
 */
function folderOf(dir: string, agent: string): string {
  if (agent === ".") return dir;
  const escapes =
    agent === "" ||
    agent === ".." ||
    /[\\/]/.test(agent) ||
    isAbsolute(agent) ||
    /^[a-z]:/i.test(agent); // a drive-relative path such as "C:agent"
  if (escapes) {
    throw new Error(
      `Invalid agent id ${JSON.stringify(agent)}: use "." or the single folder name of an ` +
        `agent inside ${dir}`,
    );
  }
  return join(dir, agent);
}

// -- Writing --------------------------------------------------------------------------------

/**
 * The folder name for an agent's name (see `slugify`). Nothing usable gives `agent`; a Windows
 * device name such as `con` gets `-r` because a folder of that name cannot be created there.
 */
const slug = (name: string): string => slugify(name, { fallback: "agent", deviceSuffix: "-r" });

/** A copy of the Bundle as this adapter stores it; the argument is left alone. */
function prepareBundle(bundle: Bundle, opts: WriteOpts): Bundle {
  return {
    ...bundle,
    routines: bundle.routines.map((routine) => ({
      ...routine,
      enabled: opts.enableRoutines && routine.enabled,
    })),
    files: opts.includeFiles ? bundle.files : [],
  };
}

/** True when `path` is `ancestor` or lies below it. */
function isWithin(ancestor: string, path: string): boolean {
  const way = relative(ancestor, path);
  return way === "" || (way !== ".." && !way.startsWith(`..${sep}`) && !isAbsolute(way));
}

/**
 * `path` with every symbolic link and junction resolved. A part that does not exist yet is
 * kept as written, below the deepest ancestor that does exist.
 */
async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonical(parent), basename(absolute));
  }
}

/**
 * Throws unless `wanted` may be removed whole: it must not be a filesystem root, the home
 * folder or a folder above it, or the working folder or a folder above it. The comparison is
 * made on real paths, so a link or junction that leads to such a folder is caught as well.
 */
async function assertRemovable(ctx: Ctx, wanted: string): Promise<void> {
  const [target, home, cwd] = await Promise.all([
    canonical(wanted),
    canonical(resolve(ctx.cwd, ctx.home)),
    canonical(ctx.cwd),
  ]);
  const refuse = (why: string): never => {
    throw new Error(`Refusing to replace ${wanted}: ${why}. Delete it yourself if you mean it.`);
  };
  if (parse(target).root === target) refuse("it is a filesystem root");
  if (isWithin(target, home)) refuse("it is the home folder or contains it");
  if (isWithin(target, cwd)) refuse("it is the working folder or contains it");
}

/**
 * The first `<wanted>-N` folder that already holds the agent with `id`, as an earlier move may
 * have left it. Only real folders count: a link is never read through.
 */
async function sameAgentSibling(wanted: string, id: string): Promise<string | undefined> {
  for (const sibling of await numberedSiblings(wanted)) {
    const info = await lstatIfAny(sibling);
    if (info?.isDirectory() && (await manifestId(sibling)) === id) return sibling;
  }
  return undefined;
}

/** The `id` in the `jetpack.json` of `folder`; `undefined` when none can be read. */
async function manifestId(folder: string): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(folder, MANIFEST_FILE), "utf8"));
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "id" in manifest &&
      typeof manifest.id === "string" &&
      manifest.id !== ""
    ) {
      return manifest.id;
    }
  } catch {
    // Without a readable id the folder cannot be shown to hold this agent: it is not updated.
  }
  return undefined;
}

/**
 * Settles where the agent goes when `wanted` is already taken, and makes the place ready.
 * `update` writes in place only over this very agent, the one with the Bundle's id, whether it
 * is in `wanted` or in a `-N` folder an earlier move gave it. Another agent of the same name
 * keeps its folder, and this one goes to the first free `-2`, `-3`..., with a warning that says
 * why. A link is never read or written through: as `wanted` it sends `update` elsewhere with a
 * warning and makes `replace` refuse; as a `-N` it is taken. Nothing is removed before the
 * Bundle is known to be writable.
 */
async function claimTarget(
  ctx: Ctx,
  wanted: string,
  onConflict: WriteOpts["onConflict"],
  bundle: Bundle,
): Promise<{ target: string; warning?: string }> {
  if (await isFree(wanted)) return { target: wanted };
  if (onConflict === "copy") return { target: await freeSibling(wanted) };

  const info = await lstatIfAny(wanted);
  if (info?.isSymbolicLink()) {
    // A link leads somewhere else: what it holds is never read, and nothing is written through it.
    if (onConflict === "replace") {
      await assertRemovable(ctx, wanted); // a link to home or the working folder says so
      throw new Error(
        `Refusing to replace ${wanted}: it is a symbolic link. Delete it yourself if you mean it.`,
      );
    }
    const target =
      (await sameAgentSibling(wanted, bundle.manifest.id)) ?? (await freeSibling(wanted));
    return { target, warning: `'${wanted}' is a symlink; not written through` };
  }
  if (!info?.isDirectory()) throw new Error(`${wanted} exists and is not a folder`);

  // Replacing removes the folder whole, so `replace` needs the same proof as `update` that the
  // folder is an agent OpenTeleport wrote, and more: a folder that holds our files may still be
  // the user's home or working folder.
  if (onConflict === "replace") await assertRemovable(ctx, wanted);
  if (!(await namesIn(wanted)).includes(MANIFEST_FILE)) {
    throw new Error(
      `${wanted} is not empty and holds no ${MANIFEST_FILE}, so it is not an agent folder ` +
        "OpenTeleport wrote. Use --copy to write next to it, or point --target-dir at an empty " +
        "folder.",
    );
  }
  if (onConflict === "replace") {
    bundleToEntries(bundle); // throws for a Bundle that cannot be written, before anything is lost
    await rm(wanted, { recursive: true, force: true });
    return { target: wanted };
  }

  const id = await manifestId(wanted);
  if (id === bundle.manifest.id) return { target: wanted };
  // An earlier move may already have given this agent a `-N` folder of its own: update that one.
  const own = await sameAgentSibling(wanted, bundle.manifest.id);
  if (own !== undefined) return { target: own };
  const target = await freeSibling(wanted);
  const whose = id === undefined ? "no readable id" : `id ${id}`;
  return {
    target,
    warning: `${wanted} already holds a different agent (${whose}); written as ${target}`,
  };
}

// -- What the tools read -------------------------------------------------------------------------

/** Refuse links in either parent before reading, deleting or writing a tool skill. */
async function mirrorRootProblem(target: string): Promise<string | undefined> {
  for (const path of [join(target, ".agents"), join(target, TOOL_SKILLS_DIR)]) {
    const info = await lstatIfAny(path);
    if (info === undefined) return undefined;
    if (info.isSymbolicLink()) return `${path} is a symbolic link`;
    if (!info.isDirectory()) return `${path} is not a folder`;
  }
  return undefined;
}

/** Exact file/tree comparison, including extra files; no links are followed on either side. */
async function sameSkillTree(left: string, right: string): Promise<boolean> {
  const a = await lstatIfAny(left);
  const b = await lstatIfAny(right);
  if (!a || !b || a.isSymbolicLink() || b.isSymbolicLink()) return false;
  if (a.isFile() && b.isFile()) {
    return a.size === b.size && (await readFile(left)).equals(await readFile(right));
  }
  if (!a.isDirectory() || !b.isDirectory()) return false;
  const names = (await readdir(left)).sort(byCodeUnit);
  const other = (await readdir(right)).sort(byCodeUnit);
  if (names.length !== other.length || names.some((name, i) => name !== other[i])) return false;
  for (const name of names) {
    if (!(await sameSkillTree(join(left, name), join(right, name)))) return false;
  }
  return true;
}

/**
 * Plan before writeBundle replaces the old layout. A mirror belongs to the earlier export only
 * while it exactly matches that export's canonical skill. A same-name foreign or edited skill
 * blocks the update; an edited stale mirror stays, with a warning. Nothing is removed on refusal.
 */
async function planSkillMirrors(
  target: string,
  skills: readonly Skill[],
  warnings: string[],
): Promise<string[]> {
  const problem = await mirrorRootProblem(target);
  if (problem !== undefined) throw new Error(`Refusing skill mirror update: ${problem}`);
  const canonical = join(target, "skills");
  const info = await lstatIfAny(canonical);
  const plainCanonical = info?.isDirectory() === true && !info.isSymbolicLink();
  const oldNames = plainCanonical ? await readdir(canonical) : [];
  const incoming = new Set(skills.map(({ name }) => name));
  const remove: string[] = [];
  for (const name of new Set([...oldNames, ...incoming])) {
    const mirror = join(target, TOOL_SKILLS_DIR, name);
    if ((await lstatIfAny(mirror)) === undefined) continue;
    const owned = plainCanonical && (await sameSkillTree(join(canonical, name), mirror));
    if (!owned) {
      if (incoming.has(name)) {
        throw new Error(
          `Skill mirror conflict at ${mirror}: an existing or edited skill would be overwritten. ` +
            "Use --copy or resolve the conflict first.",
        );
      }
      warnings.push(`kept modified or unowned skill mirror '${name}'`);
    } else if (!incoming.has(name)) {
      remove.push(name);
    }
  }
  return remove;
}

/** Apply the preflighted mirror update after the canonical layout has been written. */
async function mirrorSkills(
  target: string,
  skills: readonly Skill[],
  removed: readonly string[],
): Promise<void> {
  const problem = await mirrorRootProblem(target);
  if (problem !== undefined) throw new Error(`Refusing skill mirror update: ${problem}`);
  const mirror = join(target, TOOL_SKILLS_DIR);
  for (const name of removed) await rm(join(mirror, name), { recursive: true, force: true });
  for (const skill of skills) {
    const dir = join(mirror, skill.name);
    await rm(dir, { recursive: true, force: true });
    for (const file of skill.files) {
      const absolute = join(dir, ...file.path.split("/"));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.bytes);
    }
  }
}

/** Writes the `GEMINI.md` import unless the folder has a `GEMINI.md` of its own. */
async function writeGeminiImport(target: string): Promise<void> {
  const path = join(target, GEMINI_FILE);
  if ((await lstatIfAny(path)) === undefined) await writeFile(path, GEMINI_IMPORT);
}

/** Whether `GEMINI.md` in `folder` is the import this adapter writes, not a file of the user's. */
async function isGeminiImport(folder: string): Promise<boolean> {
  try {
    return (await readFile(join(folder, GEMINI_FILE), "utf8")) === GEMINI_IMPORT;
  } catch {
    return false;
  }
}

/**
 * The skills of `.agents/skills/` that the layout's `skills/` does not have, in name order, as
 * a tool or `npx skills add` left them there.
 */
async function toolOnlySkills(
  folder: string,
  have: readonly Skill[],
  warnings: string[],
): Promise<Skill[]> {
  const problem = await mirrorRootProblem(folder);
  if (problem !== undefined) {
    warnings.push(`${problem}; tool skills not exported`);
    return [];
  }
  const known = new Set(have.map(({ name }) => name));
  const skills: Skill[] = [];
  for (const found of await findSkillFolders(join(folder, TOOL_SKILLS_DIR), warnings)) {
    if (known.has(found.name)) continue;
    skills.push({ name: found.name, files: await readSkillFiles(found.dir, found.name, warnings) });
  }
  return skills;
}

// -- The adapter ----------------------------------------------------------------------------

export const folderAdapter: Adapter = {
  name: "folder",
  displayName: "Folder",
  capabilities: CAPABILITIES,
  createsOnWrite: true,

  async detect(ctx) {
    const dir = baseDir(ctx);
    const found =
      (await isFile(join(dir, INSTRUCTIONS_FILE))) || (await agentFolders(dir)).length > 0;
    return found ? { found, location: dir } : { found, location: dir, hint: DETECT_HINT };
  },

  async list(ctx): Promise<AgentRef[]> {
    const dir = baseDir(ctx);
    if (await isFile(join(dir, INSTRUCTIONS_FILE))) {
      return [{ id: ".", name: await agentName(dir), location: dir }];
    }
    return Promise.all(
      (await agentFolders(dir)).map(async (id) => {
        const location = join(dir, id);
        return { id, name: await agentName(location), location };
      }),
    );
  },

  async read(ctx, agent) {
    const folder = folderOf(baseDir(ctx), agent);
    const info = await statOrUndefined(folder);
    if (info === undefined) throw new Error(`${folder} does not exist`);
    if (!info.isDirectory()) throw new Error(`${folder} is not a folder`);

    let bundle: Bundle;
    try {
      bundle = await readBundle(folder, { requireManifest: false, includeFiles: ctx.readIncludeFiles });
    } catch (error) {
      throw new Error(`Cannot read ${folder}: ${(error as Error).message}`, { cause: error });
    }

    const warnings: string[] = [];
    for (const file of OPTIONAL_FILES) {
      if (!(await isFile(join(folder, file)))) warnings.push(`${file} not found`);
    }

    // What this adapter writes for the tools is part of the layout, not an unknown path, and a
    // skill a tool added under `.agents/skills/` comes along.
    const extra = await toolOnlySkills(folder, bundle.skills, warnings);
    if (extra.length > 0) {
      bundle.skills = [...bundle.skills, ...extra].sort((a, b) => byCodeUnit(a.name, b.name));
    }
    const geminiImport = await isGeminiImport(folder);
    bundle.unknownPaths = bundle.unknownPaths.filter(
      (path) => path !== ".agents" && !(geminiImport && path === GEMINI_FILE),
    );
    return { bundle, warnings };
  },

  /** The real path of the agent's folder: `.` and a subfolder's name mean other agents elsewhere. */
  cacheIdentity(ctx, agent) {
    return canonical(folderOf(baseDir(ctx), agent));
  },

  async write(ctx, bundle, opts): Promise<WriteResult> {
    const prepared = prepareBundle(bundle, opts);
    const wanted = resolve(ctx.cwd, ctx.targetDir ?? join(ctx.cwd, slug(bundle.manifest.name)));
    const { target, warning } = await claimTarget(ctx, wanted, opts.onConflict, prepared);
    const warnings = warning === undefined ? [] : [warning];
    const staleMirrors = await planSkillMirrors(target, prepared.skills, warnings);
    const { removed } = await writeBundle(prepared, target, { asDirectory: true });
    await mirrorSkills(target, prepared.skills, staleMirrors);
    await writeGeminiImport(target);

    // Updating an earlier export clears its layout; what this Bundle no longer has is named.
    for (const path of removed) warnings.push(`removed stale ${path}`);
    if (prepared.routines.length > 0) warnings.push(ROUTINES_WARNING);
    return {
      outcome: "done",
      targetAgentId: target,
      items: { approximated: [], skipped: [], warnings },
    };
  },
};

export default folderAdapter;
