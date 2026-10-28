import { getAdapter } from "../adapters/registry.js";
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
  const adapter = getAdapter(opts.from);
  const ctx = sideOf(buildCtx(opts), "source");
  await ensureDetected(adapter, ctx, "source");
  const refs = await adapter.list(ctx);
  if (opts.json === true) {
    writeJson(refs);
    return;
  }
  if (refs.length === 0) {
    writeOut(`No agents found in ${adapter.displayName}.`);
    return;
  }
  writeOut(
    table(
      ["id", "name", "location"],
      refs.map(({ id, name, location }) => [id, name, location ?? ""]),
    ),
  );
}
