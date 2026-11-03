import { getAdapter } from "../adapters/registry.js";
import type { AgentRef } from "../adapters/types.js";
import { parseTarget, runRemoteJson, targetLabel } from "./remote.js";
import {
  type CommonOptions,
  buildCtx,
  ensureDetected,
  sideOf,
  table,
  writeJson,
  writeOut,
} from "./shared.js";

export type ListOptions = CommonOptions & { from: string };

/** `list --from <adapter>`: the agents the app has, as a table of id, name and location. */
export async function listCommand(opts: ListOptions): Promise<void> {
  const target = parseTarget(opts.from);
  const adapter = getAdapter(target.adapter);
  const ctx = sideOf(buildCtx(opts), "source");
  let refs: AgentRef[];
  if (target.host !== undefined) {
    const args = ["list", "--from", target.adapter, "--json", "--quiet"];
    refs = await runRemoteJson<AgentRef[]>(ctx, target.host, args, { quiet: opts.quiet === true });
  } else {
    await ensureDetected(adapter, ctx, "source");
    refs = await adapter.list(ctx);
  }
  if (opts.json === true) {
    writeJson(refs);
    return;
  }
  if (refs.length === 0) {
    writeOut(`No agents found in ${target.host === undefined ? adapter.displayName : targetLabel(target)}.`);
    return;
  }
  writeOut(
    table(
      ["id", "name", "location"],
      refs.map(({ id, name, location }) => [id, name, location ?? ""]),
    ),
  );
}
