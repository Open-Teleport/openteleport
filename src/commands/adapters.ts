import { listAdapters } from "../adapters/registry.js";
import { type CommonOptions, buildCtx, messageOf, table, writeJson, writeOut } from "./shared.js";

type AdapterRow = {
  name: string;
  displayName: string;
  found: boolean;
  location: string | null;
  version: string | null;
  hint: string | null;
};

/** `adapters`: every registered adapter and what its `detect` finds on this machine. */
export async function adaptersCommand(opts: CommonOptions): Promise<void> {
  const ctx = buildCtx(opts);
  const rows = await Promise.all(
    listAdapters().map(async (adapter): Promise<AdapterRow> => {
      const detected = await adapter.detect(ctx).catch((error: unknown) => ({
        found: false,
        location: undefined,
        version: undefined,
        hint: `detect failed: ${messageOf(error)}`,
      }));
      return {
        name: adapter.name,
        displayName: adapter.displayName,
        found: detected.found,
        location: detected.location ?? null,
        version: detected.version ?? null,
        hint: detected.hint ?? null,
      };
    }),
  );
  if (opts.json === true) {
    writeJson(rows);
    return;
  }
  writeOut(
    table(
      ["name", "app", "found", "version", "location", "hint"],
      rows.map((row) => [
        row.name,
        row.displayName,
        row.found ? "yes" : "no",
        row.version ?? "-",
        row.location ?? "-",
        row.hint ?? "",
      ]),
    ),
  );
}
