// The universal adapter: an agent that lives in a plain folder, in the same layout a `.jetpack`
// archive uses (`AGENTS.md`, `SOUL.md`, `MEMORY.md`, `skills/`, ...). It reads any folder with an
// `AGENTS.md`, with or without a `jetpack.json`, and writes the full layout, `jetpack.json` too.
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { bundleToEntries, readBundle, writeBundle } from "../../core/bundle.js";
import type { Bundle } from "../../core/schema.js";
import { byCodeUnit, slugify } from "../../core/text.js";
import { freeSibling, isFree, isNotFound, lstatIfAny, numberedSiblings } from "../fs.js";
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
    const { removed } = await writeBundle(prepared, target, { asDirectory: true });

    const warnings = warning === undefined ? [] : [warning];
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
