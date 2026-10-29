import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getAdapter } from "../adapters/registry.js";
import type { Adapter, AgentRef, Ctx } from "../adapters/types.js";
import { writeBundle } from "../core/bundle.js";
import { exportBundle } from "../core/engine.js";
import { writeReportFile } from "../core/report.js";
import {
  type CommonOptions,
  UsageError,
  buildCtx,
  ensureDetected,
  fileSlug,
  isInteractive,
  printReport,
  resolveAgent,
  sideOf,
} from "./shared.js";

export type ExportOptions = CommonOptions & {
  /** Default: `folder`, the agent folder you are in. */
  from?: string;
  agent?: string;
  out?: string;
  includeFiles?: boolean;
};

/**
 * The agent of the folder you are in: the one the folder adapter lists as `.`. A folder with
 * agents in subfolders but no `AGENTS.md` of its own is not one.
 */
async function agentHere(folder: Adapter, ctx: Ctx): Promise<AgentRef> {
  const here = (await folder.list(ctx)).find(({ id }) => id === ".");
  if (here === undefined) {
    throw new UsageError("No AGENTS.md here; pass --from <app> or run from an agent folder");
  }
  return here;
}

/**
 * `export --from <adapter> --agent <id|name>`: the agent as a `.jetpack` file, `--out` or
 * `<name>.jetpack` in the working directory, with `move-report.md` next to it. Without `--from`
 * (and `--agent`) it is the agent folder you are in.
 */
export async function exportCommand(opts: ExportOptions): Promise<void> {
  const from = getAdapter(opts.from ?? "folder");
  const ctx = sideOf(buildCtx(opts), "source");
  let agent: AgentRef;
  if (opts.from === undefined && opts.agent === undefined) {
    agent = await agentHere(from, ctx);
  } else {
    await ensureDetected(from, ctx, "source");
    agent = await resolveAgent(from, ctx, opts.agent, isInteractive(opts));
  }

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
