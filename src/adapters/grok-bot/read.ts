// Reading Bots for the `grok-bot` adapter. Grok Bot keeps its Bots on a computer in the cloud and
// offers no export of its own, so there is nothing on disk to read. What can be read is the zip
// that OpenBot's export skill makes when a Bot is asked to run it (`openbot-agent-import` v1),
// which `--source-dir` points at. The zip is read by `src/formats/openbot-zip.ts`.
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { Bundle } from "../../core/schema.js";
import { type OpenBotZipAgent, readOpenBotZip } from "../../formats/openbot-zip.js";
import { isNotFound } from "../fs.js";
import type { AgentRef, Ctx } from "../types.js";

/** The `origin.app` of every Bot read here, whatever app the archive says made it. */
const APP = "grok-bot";

/** What `detect` says, and what an error starts with when there is no zip to read. */
export const HINT =
  "Grok Bot keeps agents in the cloud. Ask your Bot to run the OpenBot export skill, then pass --source-dir <openbot-export-*.zip>";

/** `stat` (a link to a zip is read like the zip), or `undefined` when nothing is there. */
async function statIfAny(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** The zip `--source-dir` names, or why there is none: `problem` is the whole message. */
async function findZip(
  ctx: Ctx,
): Promise<{ file: string } | { problem: string; location?: string }> {
  if (ctx.sourceDir === undefined) return { problem: HINT };
  const file = resolve(ctx.cwd, ctx.sourceDir);
  const info = await statIfAny(file);
  if (info === undefined) return { problem: `${HINT}. ${file} does not exist.`, location: file };
  if (info.isDirectory()) {
    return { problem: `${HINT}. ${file} is a folder, not a zip file.`, location: file };
  }
  if (extname(file).toLowerCase() !== ".zip") {
    return { problem: `${HINT}. ${file} is not a .zip file.`, location: file };
  }
  return { file };
}

async function requireZip(ctx: Ctx): Promise<string> {
  const zip = await findZip(ctx);
  if ("problem" in zip) throw new Error(zip.problem);
  return zip.file;
}

/**
 * Found only with `--source-dir` pointing at a zip; there is no Grok Bot on this computer to
 * find. Looks at the path and nothing else, and runs nothing.
 */
export async function detectGrokBot(
  ctx: Ctx,
): Promise<{ found: boolean; location?: string; hint?: string }> {
  const zip = await findZip(ctx);
  if ("file" in zip) return { found: true, location: zip.file };
  const { location } = zip;
  return { found: false, ...(location === undefined ? {} : { location }), hint: HINT };
}

/** The Bot of `archive` that `wanted` names: its key, else its name in any case. */
function pick(agents: readonly OpenBotZipAgent[], wanted: string, file: string): OpenBotZipAgent {
  const byKey = agents.find(({ key }) => key === wanted);
  if (byKey !== undefined) return byKey;
  const lower = wanted.toLowerCase();
  const byName = agents.filter(({ bundle }) => bundle.manifest.name.toLowerCase() === lower);
  const [only, ...more] = byName;
  if (only !== undefined && more.length === 0) return only;
  const keys = (list: readonly OpenBotZipAgent[]): string => list.map(({ key }) => key).join(", ");
  throw new Error(
    only === undefined
      ? `${file} has no Bot "${wanted}". Available: ${keys(agents)}`
      : `Several Bots in ${file} are called "${wanted}": ${keys(byName)}. Pass the key.`,
  );
}

/** The Bots in the zip `--source-dir` names: the key is the id, `<zip>#<key>` the location. */
export async function listGrokBots(ctx: Ctx): Promise<AgentRef[]> {
  const file = await requireZip(ctx);
  const { agents } = await readOpenBotZip(file);
  return agents.map(({ key, bundle }) => ({
    id: key,
    name: bundle.manifest.name,
    ...(bundle.manifest.title === undefined ? {} : { title: bundle.manifest.title }),
    location: `${file}#${key}`,
  }));
}

/**
 * `bundle` as a Grok Bot's: its origin is Grok Bot, with the version of the app that made the
 * archive kept only when that app is Grok Bot itself (an instance transfer carries OpenBot's).
 */
function asGrokBot(bundle: Bundle, warnings: string[]): Bundle {
  const { origin } = bundle.manifest;
  if (origin === undefined) return bundle;
  const own = origin.app === APP;
  if (!own) {
    warnings.push(
      `The archive says it was made by ${JSON.stringify(origin.app)}, not by Grok Bot; ` +
        "it is read the same way.",
    );
  }
  const { version, ...rest } = origin;
  return {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      origin: { ...rest, app: APP, ...(own && version !== undefined ? { version } : {}) },
    },
  };
}

/**
 * One Bot of the zip, by key or by name. The id is the one an earlier OpenTeleport zip carries
 * (`x-openteleport`), else empty: the engine then gives it one under `grokBotCacheIdentity`.
 */
export async function readGrokBot(
  ctx: Ctx,
  agent: string,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const file = await requireZip(ctx);
  const archive = await readOpenBotZip(file);
  const found = pick(archive.agents, agent, file);
  const warnings = [...archive.warnings];
  return { bundle: asGrokBot(found.bundle, warnings), warnings };
}

/**
 * What tells this Bot apart from every other: `zip:<format>:<key>`, with neither the path nor the
 * date of the export, so that asking the same Bot to export again and moving it again updates what
 * the first move wrote instead of making a copy.
 */
export async function grokBotCacheIdentity(ctx: Ctx, agent: string): Promise<string> {
  const file = await requireZip(ctx);
  const archive = await readOpenBotZip(file);
  return `zip:${archive.format}:${pick(archive.agents, agent, file).key}`;
}
