// Writes a Bundle for OpenBot as an `openbot-agent-import` archive to hand over. OpenBot takes it
// under Server settings, Import; its local Team API, the one other way in, is only up while a
// host service runs and asks for a member's sign-in, so it is not used.
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Bundle } from "../../core/schema.js";
import { readOpenBotZip, writeOpenBotImportZip } from "../../formats/openbot-zip.js";
import { VERSION } from "../../version.js";
import { lstatIfAny, replaceFile } from "../fs.js";
import type { Ctx, WriteOpts, WriteResult } from "../types.js";

const MAX_SLUG_CHARS = 64;
const ARTIFACT_SUFFIX = "-openbot-import";
const ARTIFACT_EXTENSION = ".zip";
/** The `source.app` of the archive: who made it. */
const APP = "openteleport";

/** Lowercase letters and digits, runs of anything else one `-`; `agent` when nothing is left. */
function slugOf(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");
  return slug === "" ? "agent" : slug;
}

// -- Where the archive goes -------------------------------------------------------------------

/**
 * The ids of the agents an archive says OpenTeleport wrote (the `x-openteleport` marker of its
 * manifest). None for a file that is not an OpenBot archive, or has no marker.
 */
async function markedIds(path: string): Promise<string[]> {
  try {
    const { agents } = await readOpenBotZip(path);
    return agents.map(({ bundle }) => bundle.manifest.id).filter((id) => id !== "");
  } catch {
    return [];
  }
}

/** The `<stem>-N.zip` (lowest N from 2) with nothing at that path, not even a link. */
async function freeSibling(stem: string): Promise<string> {
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ARTIFACT_EXTENSION}`;
    if ((await lstatIfAny(candidate)) === undefined) return candidate;
  }
}

/**
 * The `<stem>-N.zip` (lowest N first) that carries the marker of the agent with `id`, as an
 * earlier move may have left it; `undefined` when there is none.
 */
async function ownSibling(stem: string, id: string): Promise<string | undefined> {
  if (id === "") return undefined;
  let names: string[];
  try {
    names = await readdir(dirname(stem));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const prefix = `${basename(stem)}-`;
  const copies = names
    .filter(
      (name) =>
        name.startsWith(prefix) &&
        name.endsWith(ARTIFACT_EXTENSION) &&
        /^[1-9]\d*$/.test(name.slice(prefix.length, -ARTIFACT_EXTENSION.length)),
    )
    .map((name) => ({
      path: join(dirname(stem), name),
      n: Number(name.slice(prefix.length, -ARTIFACT_EXTENSION.length)),
    }))
    .filter(({ n }) => n >= 2)
    .sort((a, b) => a.n - b.n);
  for (const { path } of copies) {
    if ((await lstatIfAny(path))?.isFile() && (await markedIds(path)).includes(id)) return path;
  }
  return undefined;
}

/**
 * Settles where the archive goes. A free `<stem>.zip` is taken. When it is taken, `copy` goes to
 * the first free `<stem>-2.zip`, `-3`...; `replace` writes over it only when it is an archive with
 * a marker (whose agent it was does not matter) and refuses otherwise; `update` writes over it
 * only when its marker is this agent's, or else over the `-N` archive that carries it. Any other
 * file keeps its content and this archive goes to the first free `-N`, with a warning. A link is
 * never written through.
 */
async function claimTarget(
  stem: string,
  id: string,
  onConflict: WriteOpts["onConflict"],
  warnings: string[],
): Promise<string> {
  const wanted = `${stem}${ARTIFACT_EXTENSION}`;
  const taken = await lstatIfAny(wanted);
  if (taken === undefined) return wanted;
  if (onConflict === "copy") return freeSibling(stem);

  const ids = taken.isFile() ? await markedIds(wanted) : [];
  if (onConflict === "replace") {
    if (ids.length > 0) return wanted;
    const why = taken.isSymbolicLink()
      ? "it is a symbolic link"
      : taken.isFile()
        ? "it holds no OpenTeleport marker, so it is not an archive OpenTeleport wrote"
        : "it is not a file";
    throw new Error(`Refusing to replace ${wanted}: ${why}. Delete it yourself if you mean it.`);
  }

  if (id !== "" && ids.includes(id)) return wanted;
  const own = await ownSibling(stem, id);
  if (own !== undefined) return own;
  const path = await freeSibling(stem);
  const why = taken.isSymbolicLink()
    ? "is a symbolic link, which is not written through"
    : ids.length === 0
      ? "holds no OpenTeleport marker of this agent"
      : "holds a different agent";
  warnings.push(`${wanted} ${why}; written as ${path}`);
  return path;
}


// -- Writing ----------------------------------------------------------------------------------

/**
 * Writes `<targetDir ?? cwd>/<slug>-openbot-import.zip`, an `openbot-agent-import` v1 archive of
 * the agent, and hands it over: the user imports it in OpenBot. Routines are written off unless
 * `enableRoutines` is set and they were on. The archive carries the agent's id (the
 * `x-openteleport` marker of its manifest), which is how a later move of the same agent finds
 * it again. What the format could not take is named in `items`. `bundle` is not changed.
 */
export async function writeOpenBotAgent(
  ctx: Ctx,
  bundle: Bundle,
  opts: WriteOpts,
): Promise<WriteResult> {
  // Everything that can be built is built before the disk is touched.
  const routines = bundle.routines.map((routine) => ({
    ...routine,
    enabled: opts.enableRoutines && routine.enabled,
  }));
  const { bytes, items } = writeOpenBotImportZip([{ ...bundle, routines }], {
    app: APP,
    version: VERSION,
    includeFiles: opts.includeFiles,
  });

  const folder = resolve(ctx.cwd, ctx.targetDir ?? ".");
  const stem = join(folder, `${slugOf(bundle.manifest.name)}${ARTIFACT_SUFFIX}`);
  const path = await claimTarget(stem, bundle.manifest.id, opts.onConflict, items.warnings);
  await replaceFile(path, bytes);

  return {
    outcome: "handoff",
    nextStep: `Open OpenBot, go to Server settings, choose Import and pick ${path}`,
    artifactPath: path,
    items,
  };
}
