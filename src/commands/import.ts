import { getAdapter } from "../adapters/registry.js";
import { readBundle } from "../core/bundle.js";
import { importBundle } from "../core/engine.js";
import type { Bundle } from "../core/schema.js";
import {
  type CommonOptions,
  type WriteFlags,
  buildCtx,
  confirmReplace,
  conflictMode,
  ensureDetected,
  existingPath,
  printReport,
  saveReport,
  sideOf,
  withReplaceHint,
  writeOptsOf,
} from "./shared.js";

export type ImportOptions = CommonOptions & WriteFlags & { to: string };

/**
 * Reads what `import` was given: a `.jetpack` archive, which must hold `jetpack.json`, or an
 * agent folder, which may do without, as the folder adapter reads one. The error names the path.
 */
async function readSource(path: string, isDirectory: boolean): Promise<Bundle> {
  try {
    return await readBundle(path, { requireManifest: !isDirectory });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes(path)) throw error;
    throw new Error(`Cannot read ${path}: ${message}`, { cause: error });
  }
}

/** `import --to <adapter> <file.jetpack|folder>`: writes the bundle into the app. */
export async function importCommand(source: string, opts: ImportOptions): Promise<void> {
  const onConflict = conflictMode(opts);
  const to = getAdapter(opts.to);
  const { path, isDirectory } = await existingPath(source);
  const ctx = sideOf(buildCtx(opts), "target");
  await ensureDetected(to, ctx, "target");

  const bundle = await readSource(path, isDirectory);
  if (onConflict === "replace") await confirmReplace(opts, bundle.manifest.name, to);
  const report = await withReplaceHint(onConflict, () =>
    importBundle({ to, bundle, ctx, write: writeOptsOf(opts, onConflict) }),
  );
  printReport(report, opts, await saveReport(report, ctx.home, bundle.manifest.name));
}
