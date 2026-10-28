// What an adapter leaves in the folders it writes so that a later move of the same agent updates
// them in place: the marker file of an agent folder, and the map of ids kept beside a project.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../core/values.js";
import { isNotFound, lstatIfAny, replaceFile } from "./fs.js";

/** Left in a folder an adapter wrote, with the manifest id of the agent it wrote there. */
export const MARKER_FILE = ".openteleport.json";

export type Marker = { id: string; movedAt: string } & Record<string, unknown>;

/**
 * The marker in `dir`. It is `undefined` when there is none (no file, or nothing on the way to
 * it), when it is not a regular file (a link is never followed), is not JSON or holds no string
 * `id`; a marker without a time gets an empty `movedAt`. Any other error, such as a refused
 * permission, is thrown: a marker that cannot be read is not proof that there is none, and
 * treating it so would turn an update into a copy.
 */
export async function readMarker(dir: string): Promise<Marker | undefined> {
  const file = join(dir, MARKER_FILE);
  if (!(await lstatIfAny(file))?.isFile()) return undefined;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // Gone since the check above.
    if (isNotFound(error)) return undefined;
    throw error;
  }
  let marker: unknown;
  try {
    marker = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(marker) || typeof marker.id !== "string") return undefined;
  return {
    ...marker,
    id: marker.id,
    movedAt: typeof marker.movedAt === "string" ? marker.movedAt : "",
  };
}

/**
 * Whether `dir` holds the marker of the agent whose manifest id is `id`; never for no id. Throws
 * what `readMarker` throws.
 */
export async function carriesMarker(dir: string, id: string): Promise<boolean> {
  if (id === "") return false;
  return (await readMarker(dir))?.id === id;
}

/** The marker as it is written: JSON indented by two spaces, ending in a line break. */
export function renderMarker(marker: Marker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

/**
 * Writes the marker into `dir`, creating the folder when needed. The file is replaced in one
 * step (`replaceFile`). Throws when `<dir>/.openteleport.json` is there and is not a regular file
 * (a link or a folder): nothing is written then.
 */
export async function writeMarker(dir: string, marker: Marker): Promise<void> {
  const file = join(dir, MARKER_FILE);
  try {
    if (!(await lstat(file)).isFile()) throw new Error(`${file} is not a regular file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await replaceFile(file, renderMarker(marker));
}

/** Agent slug → manifest id, as a project's map of ids holds it. */
export type AgentIds = Record<string, string>;

/**
 * The ids recorded in `path`. A missing file records none, and so does one that is not a JSON
 * object: it is replaced on the next write, which costs only an update that becomes a copy. Any
 * other read error is thrown before anything is written.
 */
export async function readIds(path: string): Promise<AgentIds> {
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
 * Records that `slug` holds the agent with `id`, keeping what was recorded for the other slugs.
 * The file is replaced in one step through a temporary sibling, so it is never left half written
 * and a link in its place is replaced rather than written through. A failure only costs a later
 * in-place update, so it becomes a warning.
 */
export async function recordId(
  path: string,
  slug: string,
  id: string,
  items: { warnings: string[] },
): Promise<void> {
  if (id === "") return;
  try {
    const ids = { ...(await readIds(path)), [slug]: id };
    await replaceFile(path, `${JSON.stringify(ids, null, 2)}\n`);
  } catch (error) {
    items.warnings.push(
      `could not record the agent's id in ${path} (${(error as Error).message}); a later move ` +
        "will write a copy instead of updating it",
    );
  }
}
