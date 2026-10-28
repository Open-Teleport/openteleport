// The engine only knows the adapter interface; it is type-only, so core loads no adapter code.
import type { Adapter, AdapterCapabilities, Ctx, WriteOpts } from "../adapters/types.js";
import { writeBundle } from "./bundle.js";
import { ensureId } from "./ids.js";
import type { Item, MoveReport } from "./report.js";
import type { Bundle } from "./schema.js";
import { type SecretFinding, scanSecrets } from "./secrets.js";

/** The `source.app` of a report for an import: the agent came from a bundle, not from an app. */
const BUNDLE_SOURCE = "jetpack";

/**
 * Thrown before anything is written when the Bundle holds what looks like a credential. The
 * message names each finding as `<path>[:line] <kind>`, one per line, and never the match.
 */
export class SecretsFoundError extends Error {
  readonly findings: SecretFinding[];

  constructor(findings: SecretFinding[]) {
    const where = ({ path, line, kind }: SecretFinding) =>
      `${path}${line === undefined ? "" : `:${line}`} ${kind}`;
    super(
      [
        `Found ${findings.length} possible secret(s); nothing was written. Remove them and retry:`,
        ...findings.map(where),
      ].join("\n"),
    );
    this.name = "SecretsFoundError";
    this.findings = findings;
  }
}

type Field = {
  /** How the report names the field. */
  label: string;
  capability: Exclude<keyof AdapterCapabilities, "schedules">;
  /** The detail of the field's `moved` item, or `undefined` when the field is empty. */
  describe(bundle: Bundle): string | undefined;
  /** A copy of the Bundle with the field emptied. */
  clear(bundle: Bundle): Bundle;
};

const counted = (n: number, noun: string): string | undefined =>
  n === 0 ? undefined : `${n} ${noun}${n === 1 ? "" : "s"}`;

const LINE_BREAK = /\r\n|\r|\n/;

/** The number of lines, a final line break not starting another one; blank text has none. */
const lineCount = (text: string | undefined): string | undefined =>
  text === undefined || text.trim() === ""
    ? undefined
    : counted(text.replace(/(?:\r\n|\r|\n)$/, "").split(LINE_BREAK).length, "line");

/** Every field a capability governs, in the order the report lists them. */
const FIELDS: readonly Field[] = [
  {
    label: "instructions",
    capability: "instructions",
    describe: (bundle) => lineCount(bundle.instructions),
    clear: (bundle) => ({ ...bundle, instructions: "" }),
  },
  {
    label: "persona",
    capability: "persona",
    describe: (bundle) => lineCount(bundle.persona),
    clear: ({ persona: _persona, ...bundle }) => bundle,
  },
  {
    label: "skills",
    capability: "skills",
    describe: (bundle) => counted(bundle.skills.length, "skill"),
    clear: (bundle) => ({ ...bundle, skills: [] }),
  },
  {
    label: "routines",
    capability: "routines",
    describe: (bundle) => counted(bundle.routines.length, "routine"),
    clear: (bundle) => ({ ...bundle, routines: [] }),
  },
  {
    label: "memory.facts",
    capability: "facts",
    describe: (bundle) => counted(bundle.facts.length, "fact"),
    clear: (bundle) => ({ ...bundle, facts: [] }),
  },
  {
    label: "memory.notes",
    capability: "notes",
    describe: (bundle) => counted(bundle.notes.length, "note"),
    clear: (bundle) => ({ ...bundle, notes: [] }),
  },
  {
    label: "files",
    capability: "files",
    describe: (bundle) => counted(bundle.files.length, "file"),
    clear: (bundle) => ({ ...bundle, files: [] }),
  },
  {
    label: "avatar",
    capability: "avatar",
    describe: (bundle) => bundle.avatar?.name,
    clear: ({ avatar: _avatar, ...bundle }) => bundle,
  },
  {
    label: "models",
    capability: "models",
    describe: (bundle) => counted(bundle.manifest.models.length, "model preference"),
    clear: (bundle) => ({ ...bundle, manifest: { ...bundle.manifest, models: [] } }),
  },
];

/** One `moved` item per non-empty field of `bundle`. */
function movedItems(bundle: Bundle): Item[] {
  return FIELDS.flatMap(({ label, describe }) => {
    const detail = describe(bundle);
    return detail === undefined ? [] : [{ field: label, detail }];
  });
}

/**
 * Fits a Bundle to what the target can hold. Every non-empty field whose capability is `false`
 * is emptied and listed as skipped, then every routine whose schedule kind is not in
 * `capabilities.schedules` is dropped and listed on its own as `routine:<name>`. `targetName`
 * is the target's display name, used in the details. Returns a new Bundle; `bundle` is left as
 * it was.
 */
export function diffCapabilities(
  bundle: Bundle,
  capabilities: AdapterCapabilities,
  targetName: string,
): { bundle: Bundle; skipped: Item[] } {
  const skipped: Item[] = [];
  let fitted = bundle;
  for (const field of FIELDS) {
    if (capabilities[field.capability]) continue;
    if (field.describe(fitted) !== undefined) {
      skipped.push({ field: field.label, detail: `${targetName} does not support ${field.label}` });
    }
    fitted = field.clear(fitted);
  }

  const routines = fitted.routines.filter(({ name, schedule }) => {
    if (capabilities.schedules.includes(schedule.kind)) return true;
    skipped.push({
      field: `routine:${name}`,
      detail: `schedule kind '${schedule.kind}' is not supported by ${targetName}`,
    });
    return false;
  });
  return { bundle: { ...fitted, routines }, skipped };
}

/**
 * `ctx` as the source adapter gets it, without `targetDir`; `targetSide` is the converse.
 * Adapters fall back from one folder to the other (a state directory may be
 * `sourceDir ?? targetDir`), so a side that saw the other's folder could read or write there.
 */
const sourceSide = ({ targetDir: _targetDir, ...ctx }: Ctx): Ctx => ctx;
const targetSide = ({ sourceDir: _sourceDir, ...ctx }: Ctx): Ctx => ctx;

function assertNoSecrets(bundle: Bundle): void {
  const findings = scanSecrets(bundle);
  if (findings.length > 0) throw new SecretsFoundError(findings);
}

/** `files/` travels only when asked for; leaving it behind is not reported as a skip. */
const filesIf = (bundle: Bundle, includeFiles: boolean): Bundle =>
  includeFiles ? bundle : { ...bundle, files: [] };

/**
 * The part of a move after the Bundle has its id: leave `files/` behind unless asked for, refuse
 * secrets in what is left, fit the Bundle to the target, write it and report. Read warnings come
 * before the target's warnings.
 */
async function deliver(opts: {
  to: Adapter;
  bundle: Bundle;
  ctx: Ctx;
  write: WriteOpts;
  source: MoveReport["source"];
  readWarnings: string[];
}): Promise<MoveReport> {
  const { to, ctx, write } = opts;
  // Files that stay behind are not scanned: a credential in one must not block the move.
  const carried = filesIf(opts.bundle, write.includeFiles);
  assertNoSecrets(carried);
  const { bundle, skipped } = diffCapabilities(carried, to.capabilities, to.displayName);
  const result = await to.write(targetSide(ctx), bundle, write);
  return {
    source: opts.source,
    target: {
      app: to.name,
      ...(result.targetAgentId === undefined ? {} : { agent: result.targetAgentId }),
    },
    outcome: result.outcome,
    ...(result.nextStep === undefined ? {} : { nextStep: result.nextStep }),
    moved: movedItems(bundle),
    approximated: [...result.items.approximated],
    skipped: [...skipped, ...result.items.skipped],
    warnings: [...opts.readWarnings, ...result.items.warnings],
  };
}

/**
 * Moves an agent from one app to another: read it from `from`, give it an id, refuse it if it
 * holds secrets, drop what `to` cannot hold, write it to `to` and report what happened. The
 * source is only read. `from` never sees `ctx.targetDir` and `to` never sees `ctx.sourceDir`.
 */
export async function move(opts: {
  from: Adapter;
  to: Adapter;
  agent: string;
  ctx: Ctx;
  write: WriteOpts;
}): Promise<MoveReport> {
  const { from, agent, ctx } = opts;
  const read = await from.read(sourceSide(ctx), agent);
  const bundle = await ensureId(read.bundle, { app: from.name, agentId: agent }, ctx.home);
  return deliver({
    to: opts.to,
    bundle,
    ctx,
    write: opts.write,
    source: { app: from.name, agent },
    readWarnings: read.warnings,
  });
}

/**
 * Reads an agent from `from` as a Bundle with an id. `files` is emptied unless `includeFiles`,
 * and what is left is refused if it holds secrets. With `out` the Bundle is also written there
 * as a `.jetpack` archive. `from` never sees `ctx.targetDir`.
 */
export async function exportBundle(opts: {
  from: Adapter;
  agent: string;
  ctx: Ctx;
  out?: string;
  includeFiles: boolean;
}): Promise<{ bundle: Bundle; report: MoveReport }> {
  const { from, agent, ctx } = opts;
  const read = await from.read(sourceSide(ctx), agent);
  const withId = await ensureId(read.bundle, { app: from.name, agentId: agent }, ctx.home);
  const bundle = filesIf(withId, opts.includeFiles);
  assertNoSecrets(bundle);
  if (opts.out !== undefined) await writeBundle(bundle, opts.out);
  return {
    bundle,
    report: {
      source: { app: from.name, agent },
      outcome: "exported",
      moved: movedItems(bundle),
      approximated: [],
      skipped: [],
      warnings: [...read.warnings],
    },
  };
}

/**
 * Writes a Bundle, typically read from a `.jetpack` file, to `to`. A Bundle without an id gets
 * the one recorded for its name, so importing the same file twice gives the same id. `to` never
 * sees `ctx.sourceDir`.
 */
export async function importBundle(opts: {
  to: Adapter;
  bundle: Bundle;
  ctx: Ctx;
  write: WriteOpts;
}): Promise<MoveReport> {
  const { name } = opts.bundle.manifest;
  const bundle = await ensureId(opts.bundle, { app: BUNDLE_SOURCE, agentId: name }, opts.ctx.home);
  return deliver({
    to: opts.to,
    bundle,
    ctx: opts.ctx,
    write: opts.write,
    source: { app: BUNDLE_SOURCE, agent: name },
    readWarnings: [],
  });
}
