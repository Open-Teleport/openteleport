// The round trip on the OpenClaw and Claude Code installed on this machine:
//
//   (a) Claude Code project -> OpenClaw          `move`, the bundle that left kept with `--keep`
//   (b) OpenClaw            -> agent folder      `move`
//   (c) agent folder        -> .jetpack          `export`, compared with the bundle of (a)
//   (d) bundle with two routines -> OpenClaw     `import`: the routines land disabled
//
// It runs the real `openclaw` binary, so it runs only with OPENTELEPORT_E2E=1, and
// `vitest.config.ts` leaves `test/e2e` out of every other run. How to run it: docs/demo.md.
//
// Nothing outside one temporary folder is written. OpenTeleport's home, Claude Code's config
// directory and HOME / USERPROFILE of every child process point into it, so a command that falls
// back to the user's home finds an empty one. The OpenClaw state directory is made there with
// `openclaw onboard --non-interactive` (or given in OPENTELEPORT_E2E_OPENCLAW_STATE_DIR), and its
// Gateway gets a free port of its own, so no command reaches a Gateway the user runs.
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type ResultPromise, execa, execaNode } from "execa";
import JSON5 from "json5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sanitize } from "../../src/adapters/claude-code/paths.js";
import { type OpenClawCommand, resolveOpenClawCommand } from "../../src/adapters/openclaw/cli.js";
import { readBundle } from "../../src/core/bundle.js";
import type { MoveReport } from "../../src/core/report.js";
import type { Bundle } from "../../src/core/schema.js";

const E2E = process.env.OPENTELEPORT_E2E === "1";
/** A throwaway state directory onboarded by hand, used instead of onboarding a fresh one. */
const GIVEN_STATE_DIR = process.env.OPENTELEPORT_E2E_OPENCLAW_STATE_DIR;
/** Start `openclaw gateway run` for the test, so that the routines of (d) must really land. */
const WITH_GATEWAY = process.env.OPENTELEPORT_E2E_GATEWAY === "1";
/** Keep the temporary folder for a look afterwards. */
const KEEP = process.env.OPENTELEPORT_E2E_KEEP === "1";

// Every `openclaw` command starts a large Node program, and a job command may wait for the
// Gateway's own timeout before it fails.
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const TEST_TIMEOUT_MS = 15 * 60_000;
const GATEWAY_WAIT_MS = 2 * 60_000;

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const CLI = here("../../dist/cli.js");
const PROJECT_FIXTURE = here("../fixtures/claude-code/project");
const MEMORY_FIXTURE = here("../fixtures/claude-code/home/.claude/projects/__project__/memory");
const ADA_FIXTURE = here("../fixtures/jetpack/ada");

const AGENT = "reviewer";
/** The routines agent of (d). Its OpenClaw id has a dash, which `config set` paths must take. */
const ROUTINES_AGENT_NAME = "Ada Lovelace";
const ROUTINES_AGENT_ID = "ada-lovelace";
const ROUTINE_NAMES = ["Inbox sweep", "Morning digest"];
/** What the report says when the routines could not be created for want of a Gateway. */
const GATEWAY_HINT = "openclaw gateway start";

type Run = { exitCode: number; stdout: string; stderr: string };

let root = "";
let home = "";
let project = "";
let stateDir = "";
/** The port of the sandbox Gateway; `undefined` for a given state directory that names none. */
let gatewayPort: number | undefined;
let gatewayUp = false;
let gateway: ResultPromise | undefined;
let openclawCommand: OpenClawCommand | undefined;
/** The user's own OpenClaw config, and its digest before the test, to show it is left alone. */
const USER_CONFIG = resolve(
  process.env.OPENCLAW_CONFIG_PATH ??
    join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"), "openclaw.json"),
);
let userConfigDigest: string | undefined;
/** Printed at the end: what the real install answered, for docs/demo.md. */
const diagnostics: Record<string, unknown> = {};

// -- Helpers ----------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clip = (text: string, max = 4000): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n... (${text.length - max} more characters)`;

const describeRun = (run: Run): string =>
  `exit code ${run.exitCode}\nstdout:\n${clip(run.stdout)}\nstderr:\n${clip(run.stderr)}`;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** Variables that would lead a child process to the user's own installs. */
const LEAKY = /^(?:OPENCLAW_|OPENTELEPORT_|CLAUDE_CONFIG_DIR$)/i;

/**
 * The environment of every child process: the user's (for `PATH`), with every home and app
 * location in the sandbox. Windows names variables in any case, so an override replaces each
 * spelling of its name.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const overrides: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    OPENTELEPORT_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    NO_COLOR: "1",
    ...extra,
  };
  const replaced = new Set(Object.keys(overrides).map((key) => key.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || LEAKY.test(key) || replaced.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

/** `openclaw` sees the sandbox state directory and nothing else, as the adapter runs it. */
const openclawEnv = (): Record<string, string> =>
  childEnv({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json") });

const settle = (result: { exitCode?: number; stdout?: unknown; stderr?: unknown }): Run => ({
  exitCode: result.exitCode ?? -1,
  stdout: String(result.stdout ?? ""),
  stderr: String(result.stderr ?? ""),
});

/** Runs the built CLI, `dist/cli.js`, in the sandbox. */
async function openteleport(args: readonly string[]): Promise<Run> {
  const result = await execaNode(CLI, [...args], {
    cwd: root,
    env: childEnv(),
    extendEnv: false,
    reject: false,
    stdin: "ignore",
    timeout: COMMAND_TIMEOUT_MS,
  });
  return settle(result);
}

/** How the adapter starts `openclaw` (on Windows, the script behind the npm shim). */
async function openclawArgv(args: readonly string[]): Promise<[string, string[]]> {
  openclawCommand ??= await resolveOpenClawCommand(process.env);
  return [openclawCommand.file, [...openclawCommand.prefix, ...args]];
}

/** Runs the real `openclaw` on the sandbox state directory. */
async function openclaw(args: readonly string[]): Promise<Run> {
  const [file, argv] = await openclawArgv(args);
  const result = await execa(file, argv, {
    cwd: root,
    env: openclawEnv(),
    extendEnv: false,
    reject: false,
    stdin: "ignore",
    timeout: COMMAND_TIMEOUT_MS,
  });
  return settle(result);
}

/** The JSON a command printed: from the first line that opens a document that parses. */
function jsonOf(run: Run): unknown {
  const text = run.stdout.trim();
  for (const { index } of text.matchAll(/^[[{]/gm)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // A log line that happens to start with a bracket; try the next one.
    }
  }
  throw new Error(`the command printed no JSON:\n${describeRun(run)}`);
}

/** The rows of a listing printed bare or under one of `keys`. */
function rowsOf(json: unknown, keys: readonly string[]): Record<string, unknown>[] {
  const rows: unknown[] | undefined = Array.isArray(json)
    ? json
    : isRecord(json)
      ? keys.map((key) => json[key]).find(Array.isArray)
      : undefined;
  return (rows ?? []).filter(isRecord);
}

const isDisabled = (job: Record<string, unknown>): boolean =>
  job.disabled === true || job.enabled === false;

/** `openclaw.json` of the sandbox state directory, or `undefined` when it cannot be read. */
async function sandboxConfig(): Promise<Record<string, unknown> | undefined> {
  try {
    const config: unknown = JSON5.parse(await readFile(join(stateDir, "openclaw.json"), "utf8"));
    return isRecord(config) ? config : undefined;
  } catch {
    return undefined;
  }
}

/** The value at `keys` below `value`, through objects only. */
function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) current = isRecord(current) ? current[key] : undefined;
  return current;
}

/** A digest of the file, or `undefined` when there is none. */
async function digestOf(file: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** A TCP port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = isRecord(address) && typeof address.port === "number" ? address.port : 0;
      server.close(() => (port === 0 ? fail(new Error("no free port")) : done(port)));
    });
  });
}

/** Whether something accepts connections on the loopback `port`. */
function accepts(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => {
      socket.destroy();
      done(false);
    });
  });
}

/**
 * Onboards a fresh state directory without a prompt, a model provider, a service or a channel.
 * `--accept-risk` is what `--non-interactive` requires; the rest keeps it local and offline.
 */
async function onboard(port: number): Promise<void> {
  const run = await openclaw([
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode",
    "local",
    "--auth-choice",
    "skip",
    "--workspace",
    join(stateDir, "workspace"),
    "--gateway-port",
    String(port),
    "--gateway-bind",
    "loopback",
    "--tailscale",
    "off",
    "--skip-daemon",
    "--skip-channels",
    "--skip-skills",
    "--skip-search",
    "--skip-hooks",
    "--skip-ui",
    "--skip-health",
    "--suppress-gateway-token-output",
    "--json",
  ]);
  diagnostics.onboardExitCode = run.exitCode;
  if (run.exitCode !== 0 || !(await isFile(join(stateDir, "openclaw.json")))) {
    throw new Error(
      `openclaw onboard --non-interactive did not set up ${stateDir}. Onboard a throwaway ` +
        "state directory by hand and pass it in OPENTELEPORT_E2E_OPENCLAW_STATE_DIR " +
        `(docs/demo.md).\n${describeRun(run)}`,
    );
  }
}

/** Starts `openclaw gateway run` on the sandbox state directory and waits for its port. */
async function startGateway(port: number): Promise<void> {
  const [file, argv] = await openclawArgv([
    "gateway",
    "run",
    "--port",
    String(port),
    "--bind",
    "loopback",
  ]);
  const child = execa(file, argv, {
    cwd: root,
    env: openclawEnv(),
    extendEnv: false,
    reject: false,
    stdin: "ignore",
  });
  let exited = false;
  void child.then(() => {
    exited = true;
  });
  const deadline = Date.now() + GATEWAY_WAIT_MS;
  while (!(await accepts(port))) {
    if (exited) throw new Error(`openclaw gateway run stopped:\n${describeRun(settle(await child))}`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`the Gateway did not open port ${port}:\n${describeRun(settle(await child))}`);
    }
    await delay(1000);
  }
  gateway = child;
}

/** What (c) compares, and the report fields whose approximation excuses a difference in it. */
const PARTS: readonly {
  name: string;
  excusedBy: (field: string) => boolean;
  pick: (bundle: Bundle) => unknown;
}[] = [
  {
    name: "name",
    excusedBy: (field) => field === "name" || field === "identity",
    pick: (bundle) => bundle.manifest.name,
  },
  {
    name: "instructions",
    excusedBy: (field) => field === "instructions",
    // Line endings and a final line break are how a file was saved, not what it says.
    pick: (bundle) => bundle.instructions.replace(/\r\n?/g, "\n").trimEnd(),
  },
  {
    name: "facts",
    excusedBy: (field) => field === "memory.facts",
    pick: (bundle) => bundle.facts,
  },
  {
    name: "skills",
    excusedBy: (field) => field === "skills" || field.startsWith("skill:"),
    pick: (bundle) => bundle.skills.map((skill) => skill.name).sort(),
  },
];

// -- The round trip ---------------------------------------------------------------------------

describe.skipIf(!E2E)("round trip on the installed OpenClaw and Claude Code", () => {
  const reports: { a?: MoveReport; b?: MoveReport } = {};
  const firstBundle = (): string => join(root, "first.jetpack");
  const lastBundle = (): string => join(root, "last.jetpack");
  const folderAgent = (): string => join(root, "folder", AGENT);

  beforeAll(async () => {
    if (!(await isFile(CLI))) throw new Error(`${CLI} is missing: run npm run build first`);
    userConfigDigest = await digestOf(USER_CONFIG);
    root = await mkdtemp(join(tmpdir(), "openteleport-e2e-"));
    home = join(root, "home");
    project = join(root, "project");
    stateDir = GIVEN_STATE_DIR === undefined ? join(root, "openclaw") : resolve(GIVEN_STATE_DIR);
    await mkdir(home);
    await cp(PROJECT_FIXTURE, project, { recursive: true });
    // Claude Code keeps a project's memory under its config directory, keyed by the project path.
    await cp(MEMORY_FIXTURE, join(home, ".claude", "projects", sanitize(project), "memory"), {
      recursive: true,
    });

    const version = await openclaw(["--version"]);
    if (version.exitCode !== 0) {
      throw new Error(`openclaw is not on PATH or does not start:\n${describeRun(version)}`);
    }
    diagnostics.openclawVersion = version.stdout.trim();
    const claude = settle(
      await execa("claude", ["--version"], { env: childEnv(), extendEnv: false, reject: false }),
    );
    diagnostics.claudeCodeVersion = claude.exitCode === 0 ? claude.stdout.trim() : "not found";

    if (GIVEN_STATE_DIR === undefined) {
      gatewayPort = await freePort();
      await onboard(gatewayPort);
    } else {
      if (!(await isFile(join(stateDir, "openclaw.json")))) {
        throw new Error(`OPENTELEPORT_E2E_OPENCLAW_STATE_DIR has no openclaw.json: ${stateDir}`);
      }
      const port = at(await sandboxConfig(), "gateway", "port");
      gatewayPort = typeof port === "number" ? port : undefined;
    }
    diagnostics.stateDir = stateDir;
    diagnostics.gatewayPort = gatewayPort ?? null;

    gatewayUp = gatewayPort !== undefined && (await accepts(gatewayPort));
    if (WITH_GATEWAY && !gatewayUp) {
      if (gatewayPort === undefined) {
        throw new Error(`OPENTELEPORT_E2E_GATEWAY=1, but ${stateDir} names no gateway.port`);
      }
      await startGateway(gatewayPort);
      gatewayUp = true;
    }
    diagnostics.gatewayUp = gatewayUp;
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (stateDir !== "") {
      // Only the agents: the rest of the config holds the Gateway's token.
      diagnostics.configAgents = at(await sandboxConfig(), "agents") ?? null;
    }
    if (gateway !== undefined) {
      // Its output is not kept: a Gateway may print its token.
      gateway.kill();
      diagnostics.gatewayExitCode = settle(await gateway).exitCode;
    }
    const kept = KEEP ? ", kept" : "";
    console.info(
      `OpenTeleport e2e diagnostics (sandbox ${root}${kept}):\n` +
        JSON.stringify(diagnostics, null, 2),
    );
    if (!KEEP && root !== "") {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  }, TEST_TIMEOUT_MS);

  it(
    "(a) moves reviewer from a Claude Code project into OpenClaw",
    async () => {
      const run = await openteleport([
        "move",
        "--from",
        "claude-code",
        "--source-dir",
        project,
        "--to",
        "openclaw",
        "--target-dir",
        stateDir,
        "--agent",
        AGENT,
        "--keep",
        firstBundle(),
        "--json",
      ]);
      expect(run.exitCode, describeRun(run)).toBe(0);
      const report = jsonOf(run) as MoveReport;
      reports.a = report;
      diagnostics.reportA = report;
      expect(report).toMatchObject({
        source: { app: "claude-code", agent: AGENT },
        target: { app: "openclaw", agent: AGENT },
        outcome: "done",
      });

      const listed = await openclaw(["agents", "list", "--json"]);
      diagnostics.agentsList = clip(listed.stdout);
      expect(listed.exitCode, describeRun(listed)).toBe(0);
      expect(rowsOf(jsonOf(listed), ["agents"]).map((row) => row.id)).toContain(AGENT);
      // Whether `agents add` seeds the workspace (BOOTSTRAP.md and the like) before the move.
      diagnostics.reviewerWorkspace = await namesIn(join(stateDir, `workspace-${AGENT}`));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "(b) moves it from OpenClaw into an agent folder",
    async () => {
      const run = await openteleport([
        "move",
        "--from",
        "openclaw",
        "--source-dir",
        stateDir,
        "--to",
        "folder",
        "--target-dir",
        folderAgent(),
        "--agent",
        AGENT,
        "--json",
      ]);
      expect(run.exitCode, describeRun(run)).toBe(0);
      const report = jsonOf(run) as MoveReport;
      reports.b = report;
      diagnostics.reportB = report;
      expect(report).toMatchObject({
        source: { app: "openclaw", agent: AGENT },
        target: { app: "folder", agent: folderAgent() },
        outcome: "done",
      });
      expect(await isFile(join(folderAgent(), "AGENTS.md"))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "(c) exports the folder as the bundle that left Claude Code, but for what was approximated",
    async () => {
      const run = await openteleport([
        "export",
        "--from",
        "folder",
        "--source-dir",
        folderAgent(),
        "--agent",
        ".",
        "--out",
        lastBundle(),
        "--json",
      ]);
      expect(run.exitCode, describeRun(run)).toBe(0);
      const [before, after] = await Promise.all([
        readBundle(firstBundle()),
        readBundle(lastBundle()),
      ]);
      // The comparison only means something when the first bundle carries every part.
      expect(before.instructions.trim()).not.toBe("");
      expect(before.facts.length).toBeGreaterThan(0);
      expect(before.skills.map((skill) => skill.name)).toEqual(["web-brief"]);

      const approximated = [
        ...(reports.a?.approximated ?? []),
        ...(reports.b?.approximated ?? []),
      ].map((item) => item.field);
      const compared = PARTS.filter((part) => !approximated.some(part.excusedBy));
      diagnostics.compared = compared.map((part) => part.name);
      diagnostics.excused = PARTS.filter((part) => !compared.includes(part)).map(
        (part) => part.name,
      );
      expect(compared.length).toBeGreaterThan(0);
      for (const part of compared) expect(part.pick(after), part.name).toEqual(part.pick(before));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "(d) lands two routines in OpenClaw disabled, or says to start the Gateway",
    async () => {
      const source = join(root, "ada");
      await cp(ADA_FIXTURE, source, { recursive: true });
      const manifestFile = join(source, "jetpack.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Record<string, unknown>;
      await writeFile(
        manifestFile,
        `${JSON.stringify({ ...manifest, name: ROUTINES_AGENT_NAME }, null, 2)}\n`,
      );
      // The fixture's one routine is a cron job; this one runs on an interval.
      const sweep = {
        name: "Inbox sweep",
        instruction: "Check the inbox and flag anything urgent.",
        enabled: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "every", every: "30m" },
      };
      await writeFile(
        join(source, "routines", "inbox-sweep.json"),
        `${JSON.stringify(sweep, null, 2)}\n`,
      );

      const run = await openteleport([
        "import",
        "--to",
        "openclaw",
        "--target-dir",
        stateDir,
        source,
        "--json",
      ]);
      expect(run.exitCode, describeRun(run)).toBe(0);
      const report = jsonOf(run) as MoveReport;
      diagnostics.reportD = report;
      expect(report.target).toEqual({ app: "openclaw", agent: ROUTINES_AGENT_ID });
      const toldToStart = report.warnings.some((warning) => warning.includes(GATEWAY_HINT));

      const listed = await openclaw(["cron", "list", "--json", "--all"]);
      diagnostics.cronList = {
        exitCode: listed.exitCode,
        stdout: clip(listed.stdout),
        stderr: clip(listed.stderr),
      };
      const jobs =
        listed.exitCode === 0
          ? rowsOf(jsonOf(listed), ["jobs", "automations"]).filter(
              (job) => (job.agentId ?? job.agent) === ROUTINES_AGENT_ID,
            )
          : [];
      // Whatever the Gateway does, no routine may land enabled.
      expect(jobs.filter((job) => !isDisabled(job)).map((job) => job.name)).toEqual([]);
      const names = jobs.map((job) => String(job.name)).sort();
      const landed = names.join("\n") === ROUTINE_NAMES.join("\n") && jobs.every(isDisabled);
      expect(
        landed || toldToStart,
        `neither both jobs disabled nor "${GATEWAY_HINT}" in the report:\n${describeRun(listed)}`,
      ).toBe(true);
      if (gatewayUp) expect(landed, "the Gateway runs, so both jobs must be listed").toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it("(d) sets model and runtime of an agent whose id has a dash", async () => {
    const entry = at(await sandboxConfig(), "agents", "entries", ROUTINES_AGENT_ID);
    expect(at(entry, "model")).toBe("anthropic/claude-opus-5-5");
    expect(at(entry, "runtime")).toEqual({ type: "acp", acp: { agent: "claude" } });
  });

  it("leaves the user's own OpenClaw config as it was", async () => {
    // With OPENCLAW_STATE_DIR naming the given state directory, that is the one the test writes.
    const way = relative(stateDir, USER_CONFIG);
    if (way !== "" && !way.startsWith("..") && !isAbsolute(way)) return;
    expect(await digestOf(USER_CONFIG)).toBe(userConfigDigest);
  });
});
