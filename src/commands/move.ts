import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getAdapter } from "../adapters/registry.js";
import { writeBundle } from "../core/bundle.js";
import { exportBundle, move } from "../core/engine.js";
import {
  type CommonOptions,
  type WriteFlags,
  boundTo,
  buildCtx,
  confirmReplace,
  conflictMode,
  ensureDetected,
  isInteractive,
  printReport,
  resolveAgent,
  saveReport,
  sideOf,
  withReplaceHint,
  writeOptsOf,
} from "./shared.js";

export type MoveOptions = CommonOptions &
  WriteFlags & { from: string; to: string; agent?: string; keep?: string };

/**
 * `move --from <a> --to <b> --agent <x>`: reads the agent from one app and writes it into the
 * other; the source is only read. `--keep <file>` also saves the bundle that left the source.
 */
export async function moveCommand(opts: MoveOptions): Promise<void> {
  const onConflict = conflictMode(opts);
  const from = getAdapter(opts.from);
  const to = getAdapter(opts.to);
  const ctx = buildCtx(opts);
  const sourceCtx = sideOf(ctx, "source");
  const targetCtx = sideOf(ctx, "target");
  await ensureDetected(from, sourceCtx, "source");
  await ensureDetected(to, targetCtx, "target");
  const agent = await resolveAgent(from, sourceCtx, opts.agent, isInteractive(opts));
  if (onConflict === "replace") await confirmReplace(opts, agent.name, to);

  // The engine hands one context to both adapters; each side gets only its own folder.
  const source = boundTo(from, sourceCtx);
  const target = boundTo(to, targetCtx);
  if (opts.keep !== undefined) {
    // The copy comes from a read of its own. Both reads give the agent the same id, and a
    // bundle that holds secrets stops here, before anything is written.
    const { bundle } = await exportBundle({
      from: source,
      agent: agent.id,
      ctx,
      includeFiles: opts.includeFiles === true,
    });
    const keep = resolve(ctx.cwd, opts.keep);
    await mkdir(dirname(keep), { recursive: true });
    await writeBundle(bundle, keep);
  }
  const report = await withReplaceHint(onConflict, () =>
    move({ from: source, to: target, agent: agent.id, ctx, write: writeOptsOf(opts, onConflict) }),
  );
  printReport(report, opts, await saveReport(report, ctx.home, agent.name));
}
