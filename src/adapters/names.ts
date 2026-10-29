// Choosing the name an agent is written under when the one it wants is taken: the free `-N`
// file stem of an agent file, the `-N` stem an earlier move gave the same agent, and the folder
// of a hand-over (`claimFolder`). A link is never written through, whatever the conflict mode.
import { join } from "node:path";
import type { Bundle } from "../core/schema.js";
import { freeSibling, isFree, lstatIfAny, numberedSiblings } from "./fs.js";
import { type AgentIds, MARKER_FILE, carriesMarker, readMarker } from "./marker.js";
import type { WriteOpts } from "./types.js";

/**
 * `<base>`, or the first of `<base>-2`, `<base>-3`... for which `<dir>/<name><ext>` is free. A
 * link, even a broken one, takes its name.
 */
export async function freeName(dir: string, base: string, ext: string): Promise<string> {
  let name = base;
  for (let n = 2; (await lstatIfAny(join(dir, `${name}${ext}`))) !== undefined; n += 1) {
    name = `${base}-${n}`;
  }
  return name;
}

/**
 * The `<base>-N` stem (N from 2, the lowest first) that `ids` records for the agent with `id`
 * and whose file `<dir>/<stem><ext>` is a regular file; `undefined` when there is none. A link, a
 * folder or a file that is gone is not one an update can write over.
 */
export async function recordedCopy(
  dir: string,
  base: string,
  ext: string,
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
    if ((await lstatIfAny(join(dir, `${slug}${ext}`)))?.isFile()) return slug;
  }
  return undefined;
}

/** Where a hand-over folder goes. */
export type Placement = {
  dir: string;
  /** The folder is one OpenTeleport wrote before: what it generated can be written again. */
  owned: boolean;
};

/**
 * The `<wanted>-N` folder (lowest N first) that carries the marker of the agent with `id`, as an
 * earlier move may have left it; `undefined` when there is none.
 */
async function ownSibling(wanted: string, id: string): Promise<string | undefined> {
  if (id === "") return undefined;
  for (const path of await numberedSiblings(wanted)) {
    if ((await lstatIfAny(path))?.isDirectory() && (await carriesMarker(path, id))) return path;
  }
  return undefined;
}

/**
 * Settles where a hand-over folder goes, by the rule of the spec's section 3.4. A free `wanted`
 * is taken. When it is taken, `copy` goes to the first free `<wanted>-2`, `<wanted>-3`...;
 * `replace` writes over `wanted` only when it holds a marker (whose agent it was does not
 * matter) and refuses otherwise; `update` writes over it only when its marker is this agent's
 * (the manifest's `id`), or else over the `<wanted>-N` folder that carries it. Any other folder
 * keeps its content and this one goes to the first free `-N`, with a warning. A link is never
 * written through.
 */
export async function claimFolder(
  wanted: string,
  bundle: Bundle,
  onConflict: WriteOpts["onConflict"],
  warnings: string[],
): Promise<Placement> {
  if (await isFree(wanted)) return { dir: wanted, owned: false };
  if (onConflict === "copy") return { dir: await freeSibling(wanted), owned: false };

  const info = await lstatIfAny(wanted);
  const marker = info?.isDirectory() === true ? await readMarker(wanted) : undefined;
  if (onConflict === "replace") {
    if (marker !== undefined) return { dir: wanted, owned: true };
    const why = info?.isSymbolicLink()
      ? "it is a symbolic link"
      : info?.isDirectory() === true
        ? `it holds no ${MARKER_FILE}, so it is not a folder OpenTeleport wrote`
        : "it is not a folder";
    throw new Error(`Refusing to replace ${wanted}: ${why}. Delete it yourself if you mean it.`);
  }

  const { id } = bundle.manifest;
  if (marker !== undefined && id !== "" && marker.id === id) return { dir: wanted, owned: true };
  const own = await ownSibling(wanted, id);
  if (own !== undefined) return { dir: own, owned: true };
  const dir = await freeSibling(wanted);
  const why = info?.isSymbolicLink()
    ? "is a symbolic link, which is not written through"
    : marker === undefined
      ? `holds no ${MARKER_FILE} of this agent`
      : "holds a different agent";
  warnings.push(`${wanted} ${why}; written as ${dir}`);
  return { dir, owned: false };
}
