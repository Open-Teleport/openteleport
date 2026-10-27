// The universal adapter: an agent that lives in a plain folder, in the same layout a `.jetpack`
// archive uses (`AGENTS.md`, `SOUL.md`, `MEMORY.md`, `skills/`, ...). It reads any folder with an
// `AGENTS.md`, with or without a `jetpack.json`, and writes the full layout, `jetpack.json` too.
import { readFile, readdir, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bundleToEntries, readBundle, writeBundle } from "../../core/bundle.js";
import { isReservedDeviceName } from "../../core/paths.js";
import type { Bundle } from "../../core/schema.js";
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

const MAX_SLUG_CHARS = 64;

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

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ||
  (error as NodeJS.ErrnoException).code === "ENOTDIR";

/** What `stat` says about a path, or `undefined` when nothing is there. Follows symbolic links. */
async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
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
    if (isMissing(error)) return [];
    throw error;
  }
}

// -- Finding agents -------------------------------------------------------------------------

/** Where to look: `sourceDir`, else `targetDir`, else the working directory. */
const baseDir = (ctx: Ctx): string => resolve(ctx.cwd, ctx.sourceDir ?? ctx.targetDir ?? ctx.cwd);

/** Folders that hold other things than agents are not searched. */
const isSearched = (name: string): boolean => name !== "node_modules" && !name.startsWith(".");

/** Plain code-unit order, so that the result does not depend on the locale. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The immediate subfolders of `dir` that hold an `AGENTS.md`, sorted by name. */
async function agentFolders(dir: string): Promise<string[]> {
  const names = (await namesIn(dir)).filter(isSearched);
  const holding = await Promise.all(
    names.map(async (name) => ((await isFile(join(dir, name, INSTRUCTIONS_FILE))) ? name : "")),
  );
  return holding.filter((name) => name !== "").sort(byName);
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
 * Lowercases a name, turns every run of characters outside `a-z0-9` into one `-`, trims the
 * dashes and cuts the result to 64 characters. Nothing usable gives `agent`; a Windows device
 * name such as `con` gets `-r` because a folder of that name cannot be created there.
 */
function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-$/, "");
  if (base === "") return "agent";
  return isReservedDeviceName(base) ? `${base}-r` : base;
}

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

/** Free means nothing is there, or there is an empty folder to write into. */
async function isFree(path: string): Promise<boolean> {
  const info = await statOrUndefined(path);
  if (info === undefined) return true;
  return info.isDirectory() && (await namesIn(path)).length === 0;
}

/**
 * Settles where the agent goes when `wanted` is already taken, and makes the place ready.
 * Nothing is removed before the Bundle is known to be writable.
 */
async function claimTarget(
  ctx: Ctx,
  wanted: string,
  onConflict: WriteOpts["onConflict"],
  bundle: Bundle,
): Promise<string> {
  if (await isFree(wanted)) return wanted;

  if (onConflict === "copy") {
    for (let n = 2; ; n += 1) {
      const candidate = `${wanted}-${n}`;
      if (await isFree(candidate)) return candidate;
    }
  }

  const info = await statOrUndefined(wanted);
  if (!info?.isDirectory()) throw new Error(`${wanted} exists and is not a folder`);

  if (onConflict === "update") {
    if (!(await namesIn(wanted)).includes(MANIFEST_FILE)) {
      throw new Error(
        `${wanted} is not empty and holds no ${MANIFEST_FILE}, so it is not an agent folder ` +
          "OpenTeleport wrote. Use --copy to write next to it, or --replace to overwrite it.",
      );
    }
    return wanted;
  }

  // replace
  if (isWithin(wanted, ctx.home)) {
    throw new Error(`Refusing to replace ${wanted}: it is the home folder or contains it`);
  }
  bundleToEntries(bundle); // throws for a Bundle that cannot be written, before anything is lost
  await rm(wanted, { recursive: true, force: true });
  return wanted;
}

// -- The adapter ----------------------------------------------------------------------------

export const folderAdapter: Adapter = {
  name: "folder",
  displayName: "Folder",
  capabilities: CAPABILITIES,

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
      bundle = await readBundle(folder, { requireManifest: false });
    } catch (error) {
      throw new Error(`Cannot read ${folder}: ${(error as Error).message}`, { cause: error });
    }

    const warnings: string[] = [];
    for (const file of OPTIONAL_FILES) {
      if (!(await isFile(join(folder, file)))) warnings.push(`${file} not found`);
    }
    return { bundle, warnings };
  },

  async write(ctx, bundle, opts): Promise<WriteResult> {
    const prepared = prepareBundle(bundle, opts);
    const wanted = resolve(ctx.cwd, ctx.targetDir ?? join(ctx.cwd, slug(bundle.manifest.name)));
    const target = await claimTarget(ctx, wanted, opts.onConflict, prepared);
    await writeBundle(prepared, target, { asDirectory: true });

    return {
      outcome: "done",
      targetAgentId: target,
      items: {
        approximated: [],
        skipped: [],
        warnings: prepared.routines.length > 0 ? [ROUTINES_WARNING] : [],
      },
    };
  },
};

export default folderAdapter;
