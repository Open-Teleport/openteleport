// The SSH transport: `--from <adapter>@<host>` and `--to <adapter>@<host>` run the same
// OpenTeleport, pinned to this version, on the host through plain `ssh`, with a `.jetpack`
// streamed over stdin (to a remote target) or stdout (from a remote source). The design is
// `docs/superpowers/specs/2026-11-03-ssh-transport-design.md`.
import type { Adapter, Ctx } from "../adapters/types.js";
import { bundleToZip, readBundleBytes } from "../core/bundle.js";
import { exportBundle } from "../core/engine.js";
import type { MoveReport } from "../core/report.js";
import type { Bundle } from "../core/schema.js";
import { VERSION } from "../version.js";
import {
  type CommonOptions,
  NotDetectedError,
  RemoteError,
  UsageError,
  type WriteFlags,
  messageOf,
} from "./shared.js";
import type { WriteOpts } from "../adapters/types.js";

/** What `--from` or `--to` names: an adapter, on this machine or on an ssh host. */
export type Target = { adapter: string; host?: string };

/**
 * `openclaw` is the local OpenClaw; `openclaw@server` and `openclaw@deploy@server` the one on
 * that ssh destination (the text after the first `@`, since adapter names hold none and a
 * destination may). The host is handed to `ssh` as it is, so `~/.ssh/config` applies.
 */
export function parseTarget(text: string): Target {
  const at = text.indexOf("@");
  if (at === -1) return { adapter: text };
  const adapter = text.slice(0, at);
  const host = text.slice(at + 1);
  if (adapter === "") throw new UsageError(`Missing adapter before '@' in '${text}'`);
  if (host === "") throw new UsageError(`Missing host after '@' in '${text}'`);
  if (host.startsWith("-")) throw new UsageError(`Host '${host}' must not start with '-'`);
  if (/[\s\p{Cc}]/u.test(host)) {
    throw new UsageError(`Host '${host}' must not hold whitespace or control characters`);
  }
  return { adapter, host };
}

/** `<adapter>@<host>` as a report names it: the app the agent came from or went to. */
export const targetLabel = ({ adapter, host }: Target): string =>
  host === undefined ? adapter : `${adapter}@${host}`;

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** `arg` as one word for a POSIX shell: as it is when it needs nothing, else single-quoted. */
export function shellQuote(arg: string): string {
  if (arg !== "" && SAFE_WORD.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** The package the remote runs: this very version, so both sides always agree. */
export const REMOTE_PACKAGE = `openteleport@${VERSION}`;

/**
 * The arguments `ssh` gets: the host, then the whole remote command as one word per argument
 * the way ssh wants it. The remote command is `npx -y openteleport@<version> <args>`, quoted
 * for the POSIX shell that the remote sshd starts.
 */
export function sshArgs(host: string, args: readonly string[]): string[] {
  return [host, ["npx", "-y", REMOTE_PACKAGE, ...args].map(shellQuote).join(" ")];
}

const SSH_FAILED = 255;
const COMMAND_NOT_FOUND = 127;
/** What a POSIX shell, or cmd.exe, says about a command it cannot find. */
const NPX_MISSING = /\bnpx: (?:command )?not found\b|\bnpx\b.*is not recognized/i;

const text = (bytes: Uint8Array | string | undefined): string =>
  bytes === undefined ? "" : typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");

const lastLine = (output: string): string =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1) ?? "";

const firstLine = (output: string): string => output.split(/\r?\n/)[0]?.trim() ?? "";

/** The `{ error: { code, message } }` the CLI prints with `--json` when it fails, if `out` is one. */
function jsonError(out: string): { code: number; message: string } | undefined {
  try {
    const parsed = JSON.parse(out) as { error?: { code?: unknown; message?: unknown } };
    const { error } = parsed;
    if (typeof error?.code === "number" && typeof error.message === "string") return error as { code: number; message: string };
  } catch {
    // Not JSON: the caller words the failure from the exit code and stderr.
  }
  return undefined;
}

export type RemoteRun = {
  /** Bytes for the remote command's stdin; without it stdin is closed. */
  input?: Uint8Array;
  /** Leave the remote's stderr (npx progress, adapter logs) off the local terminal. */
  quiet: boolean;
};

/**
 * Runs `npx -y openteleport@<version> <args>` on `host` through `ssh` and resolves to its
 * stdout. A failure the remote reported as `--json` keeps its exit code (`RemoteError`); a host
 * without `npx` is exit code 3 (`NotDetectedError`), like a target app that is not there; ssh
 * failing to connect, and anything else, is exit code 1 with the last line of stderr.
 */
export async function runRemote(
  ctx: Ctx,
  host: string,
  args: readonly string[],
  opts: RemoteRun,
): Promise<Uint8Array> {
  const result = await ctx.exec("ssh", sshArgs(host, args), {
    env: ctx.env,
    encoding: "buffer",
    reject: false,
    // No timeout: a first `npx` on a slow link may take a while, and the user can interrupt.
    // Passwords and passphrases are read by ssh from the terminal, not from this stdin.
    ...(opts.input === undefined ? { stdin: "ignore" } : { input: opts.input }),
    stderr: opts.quiet ? "pipe" : ["pipe", "inherit"],
  });
  const stdout = result.stdout as Uint8Array;
  const err = text(result.stderr as Uint8Array | string | undefined);
  if ((result as { code?: string }).code === "ENOENT") {
    throw new NotDetectedError("ssh was not found on this machine; install an OpenSSH client");
  }
  const code = result.exitCode;
  if (code === 0) return stdout;
  const reported = jsonError(text(stdout));
  if (reported !== undefined) throw new RemoteError(host, reported.code, reported.message);
  if (code === COMMAND_NOT_FOUND || NPX_MISSING.test(err)) {
    throw new NotDetectedError(
      `npx was not found on ${host}; install Node.js 24 or newer there (the remote runs ` +
        `npx -y ${REMOTE_PACKAGE})`,
    );
  }
  if (code === SSH_FAILED) throw new Error(`ssh ${host} failed: ${lastLine(err) || "no details"}`);
  const detail = lastLine(err) || firstLine(text(stdout)) || "no details";
  throw new Error(`openteleport on ${host} ended with exit code ${String(code)}: ${detail}`);
}

/** `runRemote` for a command run with `--json`: its stdout parsed, or exit code 1 naming what came instead. */
export async function runRemoteJson<T>(
  ctx: Ctx,
  host: string,
  args: readonly string[],
  opts: RemoteRun,
): Promise<T> {
  const out = text(await runRemote(ctx, host, args, opts));
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(
      `openteleport on ${host} printed something that is not JSON: "${firstLine(out)}". ` +
        "A shell profile that prints on login breaks the transport; silence it for non-interactive shells.",
    );
  }
}

// -- The two directions ---------------------------------------------------------------------

const EVERYTHING: Adapter["capabilities"] = {
  persona: true,
  instructions: true,
  skills: true,
  routines: true,
  facts: true,
  notes: true,
  files: true,
  avatar: true,
  models: true,
  schedules: ["cron", "every", "at"],
};

/**
 * A Bundle that arrived from `label` (a remote host, or a file on its way to one), as the source
 * adapter of a move or an export: `read` hands it over, so the engine gives it its id, applies
 * the memory selection, scans it for secrets and reports on it as on any other source.
 */
export function bundleAsAdapter(bundle: Bundle, label: string): Adapter {
  const absent = async () => {
    throw new Error(`${label} is not an app`);
  };
  return {
    name: label,
    displayName: label,
    capabilities: EVERYTHING,
    detect: async () => ({ found: true }),
    list: async () => [{ id: bundle.manifest.name, name: bundle.manifest.name }],
    read: async () => ({ bundle, warnings: [] }),
    write: absent,
  };
}

/** The read flags of `export` and `move`, as the remote `export` takes them. */
export function readFlagArgs(opts: { includeFiles?: boolean; memory?: boolean }): string[] {
  return [
    ...(opts.includeFiles === true ? ["--include-files"] : []),
    ...(opts.memory === false ? ["--no-memory"] : []),
  ];
}

/** The write flags of `import` and `move`, as the remote `import` takes them. */
export function writeFlagArgs(opts: WriteFlags, onConflict: WriteOpts["onConflict"]): string[] {
  return [
    ...(onConflict === "copy" ? ["--copy"] : []),
    // Confirmed on this side, before ssh; the remote has no terminal to ask on.
    ...(onConflict === "replace" ? ["--replace", "--yes"] : []),
    ...(opts.enableRoutines === true ? ["--enable-routines"] : []),
    ...readFlagArgs(opts),
  ];
}

/** Whether what the remote printed is shaped like a MoveReport. */
function isMoveReport(value: unknown): value is MoveReport {
  const report = value as Partial<MoveReport> | null;
  return (
    typeof report === "object" &&
    report !== null &&
    typeof report.outcome === "string" &&
    Array.isArray(report.moved) &&
    Array.isArray(report.approximated) &&
    Array.isArray(report.skipped) &&
    Array.isArray(report.warnings)
  );
}

/**
 * Fetches `agent` from `source.adapter` on `source.host`: the remote `export --out -`, its
 * archive read with the same checks as a `.jetpack` file. The Bundle comes back as it left the
 * server, its id included; the caller feeds it to the engine as a source (`bundleAsAdapter`).
 */
export async function fetchRemoteBundle(
  ctx: Ctx,
  source: Target & { host: string },
  agent: string,
  opts: CommonOptions & { includeFiles?: boolean; memory?: boolean },
): Promise<Bundle> {
  const args = [
    "export",
    "--from",
    source.adapter,
    "--agent",
    agent,
    ...readFlagArgs(opts),
    "--out",
    "-",
    // With `--json` a failure comes back on stdout as `{ error }`, which `runRemote` relays
    // with its exit code; the report of a success goes to stderr and is only forwarded.
    "--json",
    "--quiet",
  ];
  const bytes = await runRemote(ctx, source.host, args, { quiet: opts.quiet === true });
  try {
    return readBundleBytes(bytes, `${targetLabel(source)}`);
  } catch (error) {
    throw new Error(
      `Cannot read the .jetpack from ${source.host}: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

/**
 * Sends `bundle`, read locally from `sourceApp` as `agent`, into `target.adapter` on
 * `target.host`: the engine prepares it here (id, memory selection, `files/` only with
 * `--include-files`, the secret scan: a secret stops it before ssh starts), the archive goes
 * over stdin to the remote `import -`, and the remote's report comes back relabelled with
 * the local source and the remote target.
 */
export async function sendToRemote(
  ctx: Ctx,
  from: { adapter: Adapter; agent: string },
  target: Target & { host: string },
  opts: CommonOptions & WriteFlags,
  onConflict: WriteOpts["onConflict"],
): Promise<{ bundle: Bundle; report: MoveReport }> {
  const { bundle, report: local } = await exportBundle({
    from: from.adapter,
    agent: from.agent,
    ctx,
    includeFiles: opts.includeFiles === true,
    includeMemory: opts.memory !== false,
  });
  const args = [
    "import",
    "--to",
    target.adapter,
    ...writeFlagArgs(opts, onConflict),
    "--json",
    "--quiet",
    "-",
  ];
  const remote = await runRemoteJson<unknown>(ctx, target.host, args, {
    input: bundleToZip(bundle),
    quiet: opts.quiet === true,
  });
  if (!isMoveReport(remote)) {
    throw new Error(`openteleport on ${target.host} printed JSON that is not a move report`);
  }
  const report: MoveReport = {
    ...remote,
    source: { app: from.adapter.name, agent: from.agent },
    target: { ...remote.target, app: targetLabel(target) },
    warnings: [...new Set([...local.warnings, ...remote.warnings])],
  };
  return { bundle, report };
}
