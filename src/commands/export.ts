import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getAdapter } from "../adapters/registry.js";
import { writeBundle } from "../core/bundle.js";
import { exportBundle } from "../core/engine.js";
import { writeReportFile } from "../core/report.js";
import {
  type CommonOptions,
  buildCtx,
  ensureDetected,
  fileSlug,
  isInteractive,
  printReport,
  resolveAgent,
  sideOf,
} from "./shared.js";

export type ExportOptions = CommonOptions & {
  from: string;
  agent?: string;
  out?: string;
  includeFiles?: boolean;
};

/**
 * `export --from <adapter> --agent <id|name>`: the agent as a `.jetpack` file, `--out` or
 * `<name>.jetpack` in the working directory, with `move-report.md` next to it.
 */
export async function exportCommand(opts: ExportOptions): Promise<void> {
  const from = getAdapter(opts.from);
  const ctx = sideOf(buildCtx(opts), "source");
  await ensureDetected(from, ctx, "source");
  const agent = await resolveAgent(from, ctx, opts.agent, isInteractive(opts));

  const { bundle, report } = await exportBundle({
    from,
    agent: agent.id,
    ctx,
    includeFiles: opts.includeFiles === true,
  });
  // Written here rather than by `exportBundle`, so that the folder of `--out` is only created
  // once the agent is known to be exportable.
  const out = resolve(ctx.cwd, opts.out ?? `${fileSlug(bundle.manifest.name)}.jetpack`);
  await mkdir(dirname(out), { recursive: true });
  await writeBundle(bundle, out);
  printReport(report, opts, await writeReportFile(report, dirname(out)));
}
