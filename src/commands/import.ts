import { getAdapter } from "../adapters/registry.js";
import { importBundle } from "../core/engine.js";
import {
  type CommonOptions,
  type WriteFlags,
  buildCtx,
  confirmReplace,
  conflictMode,
  ensureDetected,
  existingPath,
  printReport,
  readInput,
  saveReport,
  sideOf,
  withReplaceHint,
  writeOptsOf,
} from "./shared.js";

export type ImportOptions = CommonOptions &
  WriteFlags & {
    /** Default: `folder`, a folder named after the agent in the working directory. */
    to?: string;
  };

/**
 * `import --to <adapter> <file.jetpack|folder>`: writes the bundle into the app, by default
 * into a folder of its own in the working directory.
 */
export async function importCommand(source: string, opts: ImportOptions): Promise<void> {
  const onConflict = conflictMode(opts);
  const to = getAdapter(opts.to ?? "folder");
  const { path, isDirectory } = await existingPath(source);
  const ctx = sideOf(buildCtx(opts), "target");
  await ensureDetected(to, ctx, "target");

  const bundle = await readInput(path, isDirectory);
  if (onConflict === "replace") await confirmReplace(opts, bundle.manifest.name, to);
  const report = await withReplaceHint(onConflict, () =>
    importBundle({ to, bundle, ctx, includeMemory: opts.memory !== false, write: writeOptsOf(opts, onConflict) }),
  );
  printReport(report, opts, await saveReport(report, ctx.home, bundle.manifest.name));
}
