// Runs the built CLI (`dist/cli.js`) the way a user would, inside a temporary sandbox: the home
// directory (`OPENTELEPORT_HOME`) and the working directory are fresh temp folders, the
// app-specific locations an adapter could read from the environment point into the sandbox, and
// `PATH` leads to an empty folder so that no real app binary (`openclaw`, `claude`, `hermes`,
// `codex`...) ever runs.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execaNode } from "execa";

export const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
export const MEMORY_ADAPTER = fileURLToPath(new URL("./memory-adapter.ts", import.meta.url));
export const ADA_DIR = fileURLToPath(new URL("../fixtures/jetpack/ada", import.meta.url));
export const NO_MANIFEST_DIR = fileURLToPath(
  new URL("../fixtures/folder/no-manifest", import.meta.url),
);
export const ADA_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
/** Shaped like an Anthropic key, so the secret scan stops on it; it is not a real key. */
export const FAKE_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";

export type Sandbox = {
  root: string;
  home: string;
  cwd: string;
  /** An empty folder, used as the whole `PATH`. */
  bin: string;
  cleanup(): Promise<void>;
};

export async function sandbox(): Promise<Sandbox> {
  // The real path: on macOS `tmpdir()` is `/var/...`, a link to `/private/var/...`, which is how
  // the CLI sees its working directory and so how it prints every path below it. Expectations
  // built from the unresolved form would never match.
  const root = await realpath(await mkdtemp(join(tmpdir(), "openteleport-cli-")));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  const bin = join(root, "bin");
  await Promise.all([mkdir(home), mkdir(cwd), mkdir(bin)]);
  return { root, home, cwd, bin, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** How the environment spells `PATH` (`Path` on Windows), so it is replaced, not doubled. */
const PATH_KEY = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

export type RunOptions = {
  /** Default: the sandbox working directory. */
  cwd?: string;
  /** Added to the sandbox environment; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /** Default: the in-memory test adapter. `null` loads no extra adapter. */
  extraAdapter?: string | null;
};

export type RunResult = { exitCode: number; stdout: string; stderr: string };

/** The whole environment of a CLI run: a copy of the real one with the sandbox laid over it. */
function sandboxEnv(box: Sandbox, opts: RunOptions): Record<string, string> {
  const extra = opts.extraAdapter === undefined ? MEMORY_ADAPTER : opts.extraAdapter;
  const env: Record<string, string | undefined> = {
    OPENTELEPORT_HOME: box.home,
    OPENTELEPORT_EXTRA_ADAPTER: extra ?? undefined,
    OPENCLAW_STATE_DIR: join(box.home, ".openclaw"),
    OPENCLAW_CONFIG_PATH: undefined,
    CLAUDE_CONFIG_DIR: join(box.home, ".claude"),
    HERMES_HOME: join(box.home, ".hermes"),
    CODEX_HOME: join(box.home, ".codex"),
    // Where Windows apps keep their data; the home directory is all a test may touch.
    APPDATA: join(box.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(box.home, "AppData", "Local"),
    LETTA_LOCAL_BACKEND_DIR: undefined,
    HERMES_TIMEZONE: undefined,
    NO_COLOR: undefined,
    FORCE_COLOR: undefined,
    [PATH_KEY]: box.bin,
    ...opts.env,
  };
  // execa sets a variable to the string "undefined" when given `undefined`, so drop those from a
  // full copy of the environment instead of extending it.
  const full: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) full[key] = value;
  }
  return full;
}

export async function run(
  box: Sandbox,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const result = await execaNode(CLI, [...args], {
    cwd: opts.cwd ?? box.cwd,
    env: sandboxEnv(box, opts),
    extendEnv: false,
    reject: false,
    stdin: "ignore",
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
}

/**
 * Runs the CLI with the reading end of its stdout closed before it starts, as the reader of
 * `openteleport ... | head` is once it has had enough, and resolves to how the CLI ended. Whatever
 * it writes to stdout meets a closed pipe.
 */
export async function runWithClosedStdout(
  box: Sandbox,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<{ exitCode: number | null; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? box.cwd,
    env: sandboxEnv(box, opts),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { exitCode, stderr };
}

/**
 * Writes an ESM module whose default export is an in-memory adapter built with `options`
 * (anything `createMemoryAdapter` takes that survives JSON), with the members of the object
 * literal `overrides` (JavaScript source) laid over it, and returns its path.
 */
export async function adapterModule(
  box: Sandbox,
  fileName: string,
  options: Record<string, unknown>,
  overrides = "{}",
): Promise<string> {
  const path = join(box.root, fileName);
  const helper = pathToFileURL(MEMORY_ADAPTER).href;
  await writeFile(
    path,
    `import { createMemoryAdapter } from ${JSON.stringify(helper)};\n` +
      `const adapter = createMemoryAdapter(${JSON.stringify(options)});\n` +
      `export default { ...adapter, ...(${overrides}) };\n`,
  );
  return path;
}

/** Parses stdout as JSON, failing with the raw output when it is not. */
export function json<T = unknown>(result: RunResult): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`stdout is not JSON:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

/** Text a user should never see: a stack trace line or an ANSI escape. */
export const STACK_LINE = /^\s+at .+\(.+:\d+:\d+\)$/m;
export const ANSI = /\u001b\[/;
