// What every command shares: the context adapters run in, finding adapters and agents, asking the
// user, exit codes and output. Commands print their results to stdout and everything else
// (errors, adapter logs) to stderr, so that `--json` output can always be parsed.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { confirm, isCancel, select } from "@clack/prompts";
import { execa } from "execa";
import { UnknownAdapterError, listAdapters, registerAdapter } from "../adapters/registry.js";
import type { Adapter, AgentRef, Ctx, WriteOpts } from "../adapters/types.js";
import { SecretsFoundError } from "../core/engine.js";
import { readBundle } from "../core/bundle.js";
import { isReservedDeviceName } from "../core/paths.js";
import { type MoveReport, renderReportMarkdown, renderReportTerminal } from "../core/report.js";
import type { Bundle } from "../core/schema.js";
import type { SecretFinding } from "../core/secrets.js";

/** Flags every command takes. */
export type CommonOptions = {
  sourceDir?: string;
  targetDir?: string;
  json?: boolean;
  quiet?: boolean;
};

/** Flags of the commands that write an agent into an app. */
export type WriteFlags = {
  enableRoutines?: boolean;
  includeFiles?: boolean;
  copy?: boolean;
  replace?: boolean;
  yes?: boolean;
};

// -- Errors and exit codes ------------------------------------------------------------------

/** A bad flag or argument. Exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The app an adapter stands for is not where it was looked for. Exit code 3. */
export class NotDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotDetectedError";
  }
}

/**
 * 0 is success (a hand-over included), 1 a bundle that is invalid or holds secrets and any
 * unexpected failure, 2 a bad flag, argument or adapter name, 3 an app that is not there.
 */
export function exitCodeOf(error: unknown): number {
  if (error instanceof UsageError || error instanceof UnknownAdapterError) return 2;
  if (error instanceof NotDetectedError) return 3;
  return 1;
}

const SECRETS_HINT = "Remove the secret or move it to your app's secret store, then retry.";

/** Where a secret was found, as `<path>[:line] <kind>`; never the secret itself. */
export const findingLine = ({ path, line, kind }: SecretFinding): string =>
  `${path}${line === undefined ? "" : `:${line}`} ${kind}`;

/** What to tell the user about `error`: one line, or one line per secret found. */
export function messageOf(error: unknown): string {
  if (error instanceof SecretsFoundError) {
    const count = error.findings.length;
    return [
      `Found ${count} possible secret${count === 1 ? "" : "s"}; nothing was written.`,
      ...error.findings.map(findingLine),
      SECRETS_HINT,
    ].join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Prints `error: <message>` to stderr (and with `json` the error as JSON on stdout) and sets the
 * exit code. Never a stack trace: the message is what the user can act on. A message can quote
 * what an app holds, so control characters other than line breaks are blanked on the terminal.
 */
export function reportFailure(error: unknown, json: boolean): void {
  const code = exitCodeOf(error);
  const message = messageOf(error);
  process.stderr.write(`error: ${message.replace(/(?!\n)\p{Cc}/gu, " ")}\n`);
  if (json) writeJson({ error: { code, message } });
  process.exitCode = code;
}

// -- Output ---------------------------------------------------------------------------------

export function writeOut(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Text from an app squeezed onto one line: a line break or a control character (an ANSI escape
 * included) in an agent's name must not break a table or drive the terminal.
 */
export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\s]+/gu, " ").trim();
}

/** Rows under a header, each column as wide as its widest cell, two spaces apart. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cleaned = rows.map((row) => row.map(oneLine));
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cleaned.map((row) => (row[column] ?? "").length)),
  );
  return [header, ...cleaned]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** Colors only for a terminal, and never with `NO_COLOR` set. */
const useColor = (): boolean => process.stdout.isTTY === true && !process.env.NO_COLOR;

/**
 * The outcome of an export, import or move. With `--json` stdout carries only the report, and
 * the report file is mentioned on stderr unless `--quiet`. Otherwise the report is printed, then
 * where its file went (unless `--quiet`), then, for a hand-over, the step left to the user.
 */
export function printReport(report: MoveReport, opts: CommonOptions, reportPath: string): void {
  const written = `Report written to ${reportPath}`;
  if (opts.json === true) {
    writeJson(report);
    if (opts.quiet !== true) process.stderr.write(`${written}\n`);
    return;
  }
  const lines = [renderReportTerminal(report, { color: useColor() }), ""];
  if (opts.quiet !== true) lines.push(written);
  if (report.outcome === "handoff" && report.nextStep !== undefined) {
    lines.push(`Next step: ${oneLine(report.nextStep)}`);
  }
  writeOut(lines.join("\n").trimEnd());
}

// -- Files ----------------------------------------------------------------------------------

/** What `inspect` and `validate` say about an agent folder that holds no `jetpack.json`. */
export const NO_MANIFEST_WARNING = "no jetpack.json; manifest would be synthesized";

const MAX_SLUG_CHARS = 64;

/** A file name made from an agent's name: `Ada Lovelace` → `ada-lovelace`. */
export function fileSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-$/, "");
  if (slug === "") return "agent";
  return isReservedDeviceName(slug) ? `${slug}-agent` : slug;
}

/**
 * Writes the Markdown report of an import or move to
 * `<home>/.openteleport/reports/<timestamp>-<agent>.md` (`-2`, `-3`... after it when two land in
 * the same millisecond) and returns its path. An earlier report is never overwritten.
 */
export async function saveReport(
  report: MoveReport,
  home: string,
  agentName: string,
): Promise<string> {
  const dir = join(home, ".openteleport", "reports");
  await mkdir(dir, { recursive: true });
  const base = `${new Date().toISOString().replace(/[:.]/g, "-")}-${fileSlug(agentName)}`;
  for (let n = 1; ; n += 1) {
    const path = join(dir, n === 1 ? `${base}.md` : `${base}-${n}.md`);
    try {
      await writeFile(path, renderReportMarkdown(report), { encoding: "utf8", flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * Reads a bundle a command was given: a `.jetpack` archive, which must hold `jetpack.json`, or
 * an agent folder, which may do without, as the folder adapter reads one. The error names the
 * path.
 */
export async function readInput(path: string, isDirectory: boolean): Promise<Bundle> {
  try {
    return await readBundle(path, { requireManifest: !isDirectory });
  } catch (error) {
    const message = messageOf(error);
    if (message.includes(path)) throw error;
    throw new Error(`Cannot read ${path}: ${message}`, { cause: error });
  }
}

/** `path` made absolute against the working directory; exit code 2 when nothing is there. */
export async function existingPath(path: string): Promise<{ path: string; isDirectory: boolean }> {
  const absolute = resolve(process.cwd(), path);
  try {
    return { path: absolute, isDirectory: (await stat(absolute)).isDirectory() };
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new UsageError(`No such file or folder: ${path}`);
    }
    throw error;
  }
}

// -- The context adapters run in ------------------------------------------------------------

/**
 * The context for a command: home is `OPENTELEPORT_HOME` or the user's home, the environment is
 * the process's own (the OpenClaw adapter finds `openclaw` on its `PATH`), and adapter logs go
 * to stderr unless `--quiet`. `--source-dir` and `--target-dir` are taken from the working
 * directory.
 */
export function buildCtx(opts: CommonOptions): Ctx {
  const cwd = process.cwd();
  const home = process.env.OPENTELEPORT_HOME;
  return {
    ...(opts.sourceDir === undefined ? {} : { sourceDir: resolve(cwd, opts.sourceDir) }),
    ...(opts.targetDir === undefined ? {} : { targetDir: resolve(cwd, opts.targetDir) }),
    home: home === undefined || home === "" ? homedir() : resolve(cwd, home),
    cwd,
    env: { ...process.env },
    exec: execa,
    logger: opts.quiet === true ? () => {} : (msg) => process.stderr.write(`${msg}\n`),
  };
}

/**
 * `ctx` as one side of a move sees it: the source without `targetDir`, the target without
 * `sourceDir`. Adapters fall back from one to the other (an OpenClaw state directory is
 * `sourceDir ?? targetDir`), so a target that saw `--source-dir` would write into the source.
 */
export function sideOf(ctx: Ctx, side: "source" | "target"): Ctx {
  const { sourceDir, targetDir, ...rest } = ctx;
  if (side === "source") return sourceDir === undefined ? rest : { ...rest, sourceDir };
  return targetDir === undefined ? rest : { ...rest, targetDir };
}

/** `adapter` with every call made in `ctx`, whatever context its caller passes. */
export function boundTo(adapter: Adapter, ctx: Ctx): Adapter {
  return {
    ...adapter,
    detect: () => adapter.detect(ctx),
    list: () => adapter.list(ctx),
    read: (_ctx, agent) => adapter.read(ctx, agent),
    write: (_ctx, bundle, opts) => adapter.write(ctx, bundle, opts),
  };
}

// -- Adapters -------------------------------------------------------------------------------

/**
 * A folder target is created when the agent is written, so a folder adapter that finds no agent
 * there yet does not mean an app is missing; its `detect` only answers for a source.
 */
const CREATED_ON_WRITE: ReadonlySet<string> = new Set(["folder"]);

/** Exit code 3, with the adapter's hint, when the app is not there. */
export async function ensureDetected(
  adapter: Adapter,
  ctx: Ctx,
  side: "source" | "target",
): Promise<void> {
  if (side === "target" && CREATED_ON_WRITE.has(adapter.name)) return;
  const { found, location, hint } = await adapter.detect(ctx);
  if (found) return;
  const where = location === undefined ? "" : ` at ${location}`;
  throw new NotDetectedError(
    `${adapter.displayName} was not detected${where}${hint === undefined ? "" : `. ${hint}`}`,
  );
}

const CAPABILITY_FLAGS = [
  "persona",
  "instructions",
  "skills",
  "routines",
  "facts",
  "notes",
  "files",
  "avatar",
  "models",
] as const;
const SCHEDULE_KINDS: readonly string[] = ["cron", "every", "at"];
const ADAPTER_FUNCTIONS = ["detect", "list", "read", "write"] as const;

/** What keeps `value` from being an `Adapter`, or `undefined` when nothing does. */
function adapterProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return "it is not an object";
  const adapter = value as Record<string, unknown>;
  for (const key of ["name", "displayName"]) {
    const text = adapter[key];
    if (typeof text !== "string" || text.trim() === "") return `${key} is not a non-empty string`;
  }
  const capabilities = adapter.capabilities;
  if (typeof capabilities !== "object" || capabilities === null) {
    return "capabilities is not an object";
  }
  const declared = capabilities as Record<string, unknown>;
  for (const flag of CAPABILITY_FLAGS) {
    if (typeof declared[flag] !== "boolean") return `capabilities.${flag} is not a boolean`;
  }
  const { schedules } = declared;
  if (!Array.isArray(schedules) || !schedules.every((kind) => SCHEDULE_KINDS.includes(kind))) {
    return `capabilities.schedules is not a list of ${SCHEDULE_KINDS.join(", ")}`;
  }
  for (const name of ADAPTER_FUNCTIONS) {
    if (typeof adapter[name] !== "function") return `${name}() is missing`;
  }
  return undefined;
}

/**
 * Registers the default export of the ESM module at `path` (from `OPENTELEPORT_EXTRA_ADAPTER`)
 * after the built-in adapters. A module that cannot be loaded, does not export an adapter or
 * exports one under a name already registered is exit code 2.
 */
export async function loadExtraAdapter(path: string): Promise<void> {
  const absolute = resolve(process.cwd(), path);
  let loaded: { default?: unknown };
  try {
    loaded = (await import(pathToFileURL(absolute).href)) as { default?: unknown };
  } catch (error) {
    throw new UsageError(`Cannot load OPENTELEPORT_EXTRA_ADAPTER ${absolute}: ${messageOf(error)}`);
  }
  const problem = adapterProblem(loaded.default);
  if (problem !== undefined) {
    throw new UsageError(
      `OPENTELEPORT_EXTRA_ADAPTER ${absolute}: the default export is not an adapter: ${problem}`,
    );
  }
  const adapter = loaded.default as Adapter;
  // Registering under a taken name would quietly swap a built-in adapter for this one.
  if (listAdapters().some(({ name }) => name === adapter.name)) {
    throw new UsageError(
      `extra adapter '${oneLine(adapter.name)}' would replace a built-in adapter`,
    );
  }
  registerAdapter(adapter);
}

// -- Asking the user ------------------------------------------------------------------------

/** The user said no, or stopped a prompt. Exit code 1: nothing was done. */
class CancelledError extends Error {
  constructor() {
    super("Cancelled; nothing was written.");
    this.name = "CancelledError";
  }
}

/** Prompts only when both ends are a terminal, and never under `--json`, which is for scripts. */
export function isInteractive(opts: CommonOptions): boolean {
  return opts.json !== true && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

const describeAgent = ({ id, name }: AgentRef): string =>
  name === id ? oneLine(id) : `${oneLine(id)} (${oneLine(name)})`;

const available = (refs: readonly AgentRef[]): string =>
  refs.length === 0 ? "(none)" : refs.map(describeAgent).join(", ");

/** The agents `wanted` names: the one with that id, else every one of that name in any case. */
export function matchAgents(refs: readonly AgentRef[], wanted: string): AgentRef[] {
  const byId = refs.filter(({ id }) => id === wanted);
  if (byId.length > 0) return byId;
  const lower = wanted.toLowerCase();
  return refs.filter(({ name }) => name.toLowerCase() === lower);
}

/**
 * The agent `--agent` names among those the adapter lists. Without `--agent` the user picks one
 * when the terminal allows; otherwise, or when the name matches no agent or several, exit code 2
 * listing the agents there are.
 */
export async function resolveAgent(
  adapter: Adapter,
  ctx: Ctx,
  wanted: string | undefined,
  interactive: boolean,
): Promise<AgentRef> {
  const refs = await adapter.list(ctx);
  if (wanted === undefined) {
    if (!interactive || refs.length === 0) {
      throw new UsageError(`Missing --agent. Available: ${available(refs)}`);
    }
    const choice = await select({
      message: `Which agent from ${adapter.displayName}?`,
      options: refs.map((ref) => ({
        value: ref.id,
        label: oneLine(ref.name),
        hint: oneLine(ref.location ?? ref.id),
      })),
    });
    const picked = refs.find(({ id }) => id === choice);
    if (isCancel(choice) || picked === undefined) throw new CancelledError();
    return picked;
  }

  const [match, ...more] = matchAgents(refs, wanted);
  if (match === undefined) {
    throw new UsageError(
      `No agent "${wanted}" in ${adapter.displayName}. Available: ${available(refs)}`,
    );
  }
  if (more.length > 0) {
    throw new UsageError(
      `Several agents in ${adapter.displayName} are called "${wanted}": ` +
        `${[match, ...more].map(describeAgent).join(", ")}. Pass --agent <id>.`,
    );
  }
  return match;
}

/**
 * The conflict mode the flags ask for: `update` by default. `--replace` destroys what is there,
 * so without a terminal to confirm it in it needs `--yes`.
 */
export function conflictMode(opts: WriteFlags & CommonOptions): WriteOpts["onConflict"] {
  if (opts.copy === true && opts.replace === true) {
    throw new UsageError("--copy and --replace cannot be used together");
  }
  if (opts.replace !== true) return opts.copy === true ? "copy" : "update";
  if (opts.yes !== true && !isInteractive(opts)) {
    throw new UsageError("--replace requires --yes when not interactive");
  }
  return "replace";
}

/** Asks before `--replace` overwrites an agent, unless `--yes`; a no is exit code 1. */
export async function confirmReplace(
  opts: WriteFlags,
  agentName: string,
  target: Adapter,
): Promise<void> {
  if (opts.yes === true) return;
  const answer = await confirm({
    message: `Replace existing agent "${oneLine(agentName)}" in ${target.displayName}?`,
    initialValue: false,
  });
  if (isCancel(answer) || answer !== true) throw new CancelledError();
}

export function writeOptsOf(opts: WriteFlags, onConflict: WriteOpts["onConflict"]): WriteOpts {
  return {
    enableRoutines: opts.enableRoutines === true,
    includeFiles: opts.includeFiles === true,
    onConflict,
  };
}

/**
 * Runs a write and, when an adapter refuses to replace something (`Refusing to replace ...`),
 * adds what the user can do instead. Updating in place is not offered: a folder that is not an
 * earlier export is refused by an update too.
 */
export async function withReplaceHint<T>(
  onConflict: WriteOpts["onConflict"],
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const refused = error instanceof Error && /^Refusing to replace /.test(error.message);
    if (onConflict === "replace" && refused) {
      throw new Error(`${error.message} Use --copy, or point --target-dir at an empty folder.`, {
        cause: error,
      });
    }
    throw error;
  }
}
