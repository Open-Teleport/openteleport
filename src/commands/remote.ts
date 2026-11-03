// The SSH transport: `--from <adapter>@<host>` and `--to <adapter>@<host>` run the same
// OpenTeleport, pinned to this version, on the host through plain `ssh`, with a `.jetpack`
// streamed over stdin (to a remote target) or stdout (from a remote source). The design is
// `docs/superpowers/specs/2026-11-03-ssh-transport-design.md`.
import type { Ctx } from "../adapters/types.js";
import { VERSION } from "../version.js";
import { NotDetectedError, RemoteError, UsageError } from "./shared.js";

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
