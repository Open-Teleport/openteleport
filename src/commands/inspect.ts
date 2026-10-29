import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ModelPref } from "../core/schema.js";
import { oneLine } from "../core/text.js";
import {
  type CommonOptions,
  NO_MANIFEST_WARNING,
  existingPath,
  readInput,
  writeJson,
  writeOut,
} from "./shared.js";

/** What `inspect --json` prints. */
type Summary = {
  name: string;
  /** `null` until the first export gives the agent one. */
  id: string | null;
  title: string | null;
  models: ModelPref[];
  counts: { skills: number; routines: number; facts: number; notes: number; files: number };
  /** The size of the archive, or of every file in the folder. */
  bytes: number;
  warnings: string[];
};

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

const describeModel = (pref: ModelPref): string =>
  [pref.runtime, pref.provider, pref.model].filter((part) => part !== undefined).join("/");

/**
 * `inspect <file|folder>`: what a `.jetpack` archive or an agent folder holds. An archive must
 * hold `jetpack.json`; a folder without one is read as the folder adapter reads it, with a
 * warning.
 */
export async function inspectCommand(source: string, opts: CommonOptions): Promise<void> {
  const { path, isDirectory } = await existingPath(source);
  const bundle = await readInput(path, isDirectory);
  const { manifest } = bundle;

  const warnings: string[] = [];
  // A manifest that was read always has a valid id; only a synthesized one is empty.
  if (manifest.id === "") warnings.push(NO_MANIFEST_WARNING);
  for (const unknown of bundle.unknownPaths) warnings.push(`not part of the layout: ${unknown}`);

  const summary: Summary = {
    name: manifest.name,
    id: manifest.id === "" ? null : manifest.id,
    title: manifest.title ?? null,
    models: manifest.models,
    counts: {
      skills: bundle.skills.length,
      routines: bundle.routines.length,
      facts: bundle.facts.length,
      notes: bundle.notes.length,
      files: bundle.files.length,
    },
    bytes: isDirectory ? await folderBytes(path) : (await stat(path)).size,
    warnings,
  };
  if (opts.json === true) {
    writeJson(summary);
    return;
  }

  const none = "(none)";
  const models = summary.models.map(describeModel).join(", ");
  writeOut(
    [
      `name: ${oneLine(summary.name)}`,
      `id: ${summary.id ?? none}`,
      `title: ${summary.title === null ? none : oneLine(summary.title)}`,
      `models: ${models === "" ? none : oneLine(models)}`,
      ...Object.entries(summary.counts).map(([what, count]) => `${what}: ${count}`),
      `size: ${summary.bytes} bytes`,
      ...summary.warnings.map((warning) => `warning: ${oneLine(warning)}`),
    ].join("\n"),
  );
}
