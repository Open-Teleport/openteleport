// Puts a fake `ssh` on the sandbox PATH (see `fake-ssh.mjs`) and gives the test the environment
// that makes the CLI use it, a "remote" home and working folder inside the sandbox, and the log
// of every call the fake saw.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI, MEMORY_ADAPTER, type Sandbox } from "./cli.js";

const FAKE = fileURLToPath(new URL("./fake-ssh.mjs", import.meta.url));
const { version: VERSION } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

export type FakeSsh = {
  /** Added to `run(box, args, { env })`. */
  env: Record<string, string>;
  /** The fake remote's home and working folder. */
  remoteHome: string;
  remoteCwd: string;
  /** Every call so far, oldest first. */
  calls(): Promise<{ host: string; command: string }[]>;
};

export type FakeSshMode = "ok" | "no-npx" | "unreachable" | "banner";

/** How the environment spells `PATH` (`Path` on Windows). */
const PATH_KEY = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

/**
 * Installs the fake `ssh` into `box.bin` (the whole `PATH` of a CLI run) and sets up the remote
 * side: a home and a working folder under `box.root`, where the local CLI runs as the remote
 * with the in-memory adapter loaded and no real app binary reachable.
 */
export async function installFakeSsh(box: Sandbox, mode: FakeSshMode = "ok"): Promise<FakeSsh> {
  const remoteHome = join(box.root, "remote-home");
  const remoteCwd = join(box.root, "remote-cwd");
  await Promise.all([mkdir(remoteHome), mkdir(remoteCwd)]);
  const log = join(box.root, "ssh-calls.log");
  await writeFile(log, "");

  if (process.platform === "win32") {
    await writeFile(
      join(box.bin, "ssh.cmd"),
      `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`,
    );
  } else {
    const shim = join(box.bin, "ssh");
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    await chmod(shim, 0o755);
  }

  const remoteEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) remoteEnv[key] = value;
  Object.assign(remoteEnv, {
    OPENTELEPORT_HOME: remoteHome,
    OPENTELEPORT_EXTRA_ADAPTER: MEMORY_ADAPTER,
    OPENCLAW_STATE_DIR: join(remoteHome, ".openclaw"),
    CLAUDE_CONFIG_DIR: join(remoteHome, ".claude"),
    HERMES_HOME: join(remoteHome, ".hermes"),
    CODEX_HOME: join(remoteHome, ".codex"),
    APPDATA: join(remoteHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(remoteHome, "AppData", "Local"),
    [PATH_KEY]: box.bin,
  });
  for (const key of ["OPENCLAW_CONFIG_PATH", "LETTA_LOCAL_BACKEND_DIR", "NO_COLOR", "FORCE_COLOR"]) {
    delete remoteEnv[key];
  }

  return {
    env: {
      FAKE_SSH_LOG: log,
      FAKE_SSH_MODE: mode,
      FAKE_SSH_VERSION: VERSION,
      FAKE_SSH_CLI: CLI,
      FAKE_SSH_REMOTE_CWD: remoteCwd,
      FAKE_SSH_REMOTE_ENV: JSON.stringify(remoteEnv),
    },
    remoteHome,
    remoteCwd,
    calls: async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { host: string; command: string }),
  };
}
