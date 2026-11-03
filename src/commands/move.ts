import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getAdapter } from "../adapters/registry.js";
import type { Ctx } from "../adapters/types.js";
import { writeBundle } from "../core/bundle.js";
import { exportBundle, move } from "../core/engine.js";
import type { Bundle } from "../core/schema.js";
import {
  type Target,
  bundleAsAdapter,
  fetchRemoteBundle,
  parseTarget,
  sendToRemote,
  targetLabel,
} from "./remote.js";
import {
  type CommonOptions,
  UsageError,
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

/** `--keep <file>`: the bundle that left the source, saved as a `.jetpack`. */
async function keepBundle(ctx: Ctx, bundle: Bundle, keep: string): Promise<void> {
  const path = resolve(ctx.cwd, keep);
  await mkdir(dirname(path), { recursive: true });
  await writeBundle(bundle, path);
}

/** `move --to <adapter>@<host>`: read here, write there through `ssh` (see `remote.ts`). */
async function moveToRemote(
  fromName: string,
  to: Target & { host: string },
  opts: MoveOptions,
): Promise<void> {
  const onConflict = conflictMode(opts);
  const from = getAdapter(fromName);
  getAdapter(to.adapter);
  const ctx = buildCtx(opts);
  const sourceCtx = sideOf(ctx, "source");
  await ensureDetected(from, sourceCtx, "source");
  const agent = await resolveAgent(from, sourceCtx, opts.agent, isInteractive(opts));
  if (onConflict === "replace") await confirmReplace(opts, agent.name, { displayName: targetLabel(to) });
  const { bundle, report } = await sendToRemote(
    ctx,
    { adapter: boundTo(from, sourceCtx), agent: agent.id },
    to,
    opts,
    onConflict,
  );
  if (opts.keep !== undefined) await keepBundle(ctx, bundle, opts.keep);
  printReport(report, opts, await saveReport(report, ctx.home, agent.name));
}

/** `move --from <adapter>@<host>`: fetched through `ssh`, written here (see `remote.ts`). */
async function moveFromRemote(
  from: Target & { host: string },
  toName: string,
  opts: MoveOptions,
): Promise<void> {
  const onConflict = conflictMode(opts);
  getAdapter(from.adapter);
  const to = getAdapter(toName);
  if (opts.agent === undefined) {
    throw new UsageError("Missing --agent: a remote source cannot be browsed interactively");
  }
  const ctx = buildCtx(opts);
  const targetCtx = sideOf(ctx, "target");
  await ensureDetected(to, targetCtx, "target");
  if (onConflict === "replace") await confirmReplace(opts, opts.agent, to);
  const bundle = await fetchRemoteBundle(ctx, from, opts.agent, opts);
  if (opts.keep !== undefined) await keepBundle(ctx, bundle, opts.keep);
  const source = bundleAsAdapter(bundle, targetLabel(from));
  const report = await withReplaceHint(onConflict, () =>
    move({
      from: source,
      to: boundTo(to, targetCtx),
      agent: opts.agent ?? bundle.manifest.name,
      ctx,
      includeMemory: opts.memory !== false,
      write: writeOptsOf(opts, onConflict),
    }),
  );
  printReport(report, opts, await saveReport(report, ctx.home, bundle.manifest.name));
}

/**
 * `move --from <a> --to <b> --agent <x>`: reads the agent from one app and writes it into the
 * other; the source is only read. `--keep <file>` also saves the bundle that left the source.
 * Either side, not both, may be `<adapter>@<host>`: an app on an ssh host.
 */
export async function moveCommand(opts: MoveOptions): Promise<void> {
  const fromTarget = parseTarget(opts.from);
  const toTarget = parseTarget(opts.to);
  if (fromTarget.host !== undefined && toTarget.host !== undefined) {
    throw new UsageError(
      "--from and --to cannot both be remote; run the move on one of the two machines",
    );
  }
  if (toTarget.host !== undefined) {
    return moveToRemote(fromTarget.adapter, { ...toTarget, host: toTarget.host }, opts);
  }
  if (fromTarget.host !== undefined) {
    return moveFromRemote({ ...fromTarget, host: fromTarget.host }, toTarget.adapter, opts);
  }
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
      includeMemory: opts.memory !== false,
    });
    await keepBundle(ctx, bundle, opts.keep);
  }
  const report = await withReplaceHint(onConflict, () =>
    move({ from: source, to: target, agent: agent.id, ctx, includeMemory: opts.memory !== false, write: writeOptsOf(opts, onConflict) }),
  );
  printReport(report, opts, await saveReport(report, ctx.home, agent.name));
}
