import { getAdapter } from "../adapters/registry.js";
import type { WriteOpts } from "../adapters/types.js";
import { readBundleBytes } from "../core/bundle.js";
import { importBundle } from "../core/engine.js";
import type { Bundle } from "../core/schema.js";
import { type Target, bundleAsAdapter, parseTarget, sendToRemote, targetLabel } from "./remote.js";

/** The `source.app` of a report for an import: the agent came from a bundle, not from an app. */
const BUNDLE_SOURCE = "jetpack";
import {
  type CommonOptions,
  type WriteFlags,
  buildCtx,
  confirmReplace,
  conflictMode,
  ensureDetected,
  existingPath,
  messageOf,
  printReport,
  readInput,
  readStdin,
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

/** The `<file.jetpack|folder>` argument that means a `.jetpack` on stdin. */
export const STDIN_SOURCE = "-";

/** The `.jetpack` on stdin, as `import -` reads it; the error names stdin, not a path. */
async function readStdinBundle(includeFiles: boolean): Promise<Bundle> {
  const bytes = await readStdin();
  try {
    const bundle = readBundleBytes(bytes, "stdin");
    return includeFiles ? bundle : { ...bundle, files: [] };
  } catch (error) {
    throw new Error(`Cannot read the .jetpack on stdin: ${messageOf(error)}`, { cause: error });
  }
}

/** `import --to <adapter>@<host>`: the file read here, written there through `ssh`. */
async function importToRemote(
  source: string,
  target: Target & { host: string },
  opts: ImportOptions,
  onConflict: WriteOpts["onConflict"],
): Promise<void> {
  getAdapter(target.adapter);
  const { path, isDirectory } = await existingPath(source);
  const ctx = sideOf(buildCtx(opts), "target");
  const bundle = await readInput(path, isDirectory, opts.includeFiles === true);
  if (onConflict === "replace") {
    await confirmReplace(opts, bundle.manifest.name, { displayName: targetLabel(target) });
  }
  const { report } = await sendToRemote(
    ctx,
    { adapter: bundleAsAdapter(bundle, BUNDLE_SOURCE), agent: bundle.manifest.name },
    target,
    opts,
    onConflict,
  );
  printReport(report, opts, await saveReport(report, ctx.home, bundle.manifest.name));
}

/**
 * `import --to <adapter> <file.jetpack|folder>`: writes the bundle into the app, by default
 * into a folder of its own in the working directory. `import -` reads a `.jetpack` from stdin,
 * which is how a move over ssh delivers it.
 */
export async function importCommand(source: string, opts: ImportOptions): Promise<void> {
  const onConflict = conflictMode(opts);
  const target = parseTarget(opts.to ?? "folder");
  if (target.host !== undefined) {
    return importToRemote(source, { ...target, host: target.host }, opts, onConflict);
  }
  const to = getAdapter(target.adapter);
  const fromStdin = source === STDIN_SOURCE;
  const { path, isDirectory } = fromStdin
    ? { path: STDIN_SOURCE, isDirectory: false }
    : await existingPath(source);
  const ctx = sideOf(buildCtx(opts), "target");
  await ensureDetected(to, ctx, "target");

  const bundle = fromStdin
    ? await readStdinBundle(opts.includeFiles === true)
    : await readInput(path, isDirectory, opts.includeFiles === true);
  if (onConflict === "replace") await confirmReplace(opts, bundle.manifest.name, to);
  const report = await withReplaceHint(onConflict, () =>
    importBundle({ to, bundle, ctx, includeMemory: opts.memory !== false, write: writeOptsOf(opts, onConflict) }),
  );
  printReport(report, opts, await saveReport(report, ctx.home, bundle.manifest.name));
}
