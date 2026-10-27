import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawCli } from "../../../src/adapters/openclaw/cli.js";
import openclawAdapterDefault, { openclawAdapter } from "../../../src/adapters/openclaw/index.js";
import { openclawPaths, readOpenClawConfig } from "../../../src/adapters/openclaw/paths.js";
import { readOpenClawAgent } from "../../../src/adapters/openclaw/read.js";
import type { Ctx } from "../../../src/adapters/types.js";
import { bundleToEntries, entriesToBundle } from "../../../src/core/bundle.js";
import type { Bundle } from "../../../src/core/schema.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/openclaw/", import.meta.url));
const FIXTURE_STATE = join(FIXTURES, "home");
const NOW = new Date("2026-10-27T09:15:00.000Z");

const CAPABILITIES = ["browser", "shell", "filesystem", "network", "scheduler"];
const CAPABILITIES_WARNING = "capabilities are assumed; OpenClaw does not declare them per agent";

/** What `openclaw agents list --json` prints for the fixture install. */
const AGENT_ROWS = [
  { id: "ada", name: "Ada", workspace: "/ignored/because/config/wins" },
  { id: "bare" },
  { id: "ops", name: "Ops", workspace: "/srv/openclaw/workspace-ops" },
];

type ExecCall = { file: string; args: string[]; env: Record<string, string | undefined> };
/** Stdout for a command, an Error to fail it with, or `undefined` for an unknown command. */
type Reply = string | Error | undefined;

/** A stand-in for `execa` that records every call and answers from `reply`. */
function stubExec(reply: (args: string[]) => Reply): { exec: typeof execa; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec = async (
    file: string,
    args: readonly string[] = [],
    options: { env?: Record<string, string | undefined> } = {},
  ) => {
    calls.push({ file, args: [...args], env: { ...options.env } });
    const out = reply([...args]);
    if (out === undefined) throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    if (out instanceof Error) throw out;
    return { stdout: out, stderr: "", exitCode: 0 };
  };
  return { exec: exec as unknown as typeof execa, calls };
}

let automationsJson: string;

/** Answers the read-side commands the way the fixture install would. */
function fixtureReply(args: string[]): Reply {
  switch (args.join(" ")) {
    case "automations list --all --json":
      return automationsJson;
    case "agents list --json":
      return JSON.stringify(AGENT_ROWS);
    case "--version":
      return "OpenClaw 2026.10.3 (a1b2c3d)\n";
    default:
      return undefined;
  }
}

let scratch: string;
let home: string;
let stateDir: string;
let logs: string[];
let calls: ExecCall[];
let ctx: Ctx;

function makeCtx(
  overrides: Partial<Ctx> = {},
  reply: (args: string[]) => Reply = fixtureReply,
): Ctx {
  const stub = stubExec(reply);
  calls = stub.calls;
  return {
    sourceDir: stateDir,
    home,
    cwd: scratch,
    env: {},
    exec: stub.exec,
    logger: (msg) => logs.push(msg),
    ...overrides,
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  automationsJson = await readFile(join(FIXTURES, "automations.json"), "utf8");
  scratch = await mkdtemp(join(tmpdir(), "openteleport-openclaw-"));
  home = join(scratch, "home");
  await mkdir(home);
  stateDir = join(scratch, "state");
  await cp(FIXTURE_STATE, stateDir, { recursive: true });
  logs = [];
  ctx = makeCtx();
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(scratch, { recursive: true, force: true });
});

async function writeTree(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** A fresh state directory with `openclaw.json` holding `entries` and the given files. */
async function makeState(
  entries: Record<string, unknown>,
  files: Record<string, string | Uint8Array> = {},
): Promise<string> {
  const dir = await mkdtemp(join(scratch, "state-"));
  await writeTree(dir, { "openclaw.json": JSON.stringify({ agents: { entries } }), ...files });
  return dir;
}

const text = (path: string): Promise<string> => readFile(path, "utf8");
const bytes = async (path: string): Promise<Uint8Array> => new Uint8Array(await readFile(path));
const noJobs = (args: string[]): Reply =>
  args[0] === "automations" ? JSON.stringify({ jobs: [] }) : fixtureReply(args);

function manifest(overrides: Partial<Bundle["manifest"]> = {}): Bundle["manifest"] {
  return {
    schemaVersion: "0.1",
    id: "",
    name: "agent",
    models: [],
    capabilities: CAPABILITIES as Bundle["manifest"]["capabilities"],
    origin: { app: "openclaw", exportedAt: NOW.toISOString() },
    ...overrides,
  };
}

async function expectedAda(dir: string): Promise<Bundle> {
  const ws = join(dir, "workspace-ada");
  return {
    manifest: manifest({
      name: "Ada",
      title: "Research assistant",
      models: [
        { provider: "anthropic", model: "claude-opus-5-5" },
        { provider: "openai", model: "gpt-5.5" },
      ],
      "x-openclaw": {
        identity: {
          name: "Ada",
          theme: "Research assistant",
          emoji: "🔎",
          avatar: "avatars/ada.png",
        },
      },
    }),
    persona: await text(join(ws, "SOUL.md")),
    instructions: await text(join(ws, "AGENTS.md")),
    skills: [
      {
        name: "web-brief",
        files: [
          { path: "SKILL.md", bytes: await bytes(join(ws, "skills", "web-brief", "SKILL.md")) },
          {
            path: "template.md",
            bytes: await bytes(join(ws, "skills", "web-brief", "template.md")),
          },
        ],
      },
    ],
    routines: [
      {
        name: "Morning digest",
        instruction: "Summarise new papers and unread mail into a five-line digest.",
        enabled: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "cron", expression: "30 8 * * 1-5" },
      },
      {
        name: "Inbox sweep",
        instruction: "Check the inbox and flag anything urgent.",
        enabled: false,
        timezone: "UTC",
        schedule: { kind: "every", every: "30m" },
      },
    ],
    facts: [
      "Prefers answers in Polish unless the source is in English.",
      "Reads the digest on a phone, so keep it under five lines.",
    ],
    notes: [
      { name: "2026-10-20", text: await text(join(ws, "memory", "2026-10-20.md")) },
      {
        name: "MEMORY-prose",
        text: "Ada keeps long-form notes in memory/ and only distils stable facts into this file.",
      },
      { name: "USER", text: await text(join(ws, "USER.md")) },
    ],
    files: [],
    avatar: { name: "avatar.png", bytes: await bytes(join(ws, "avatars", "ada.png")) },
    unknownPaths: [],
  };
}

const ADA_WARNINGS = [
  CAPABILITIES_WARNING,
  "skill 'scratch' is not on the agent's skill allowlist; not exported",
  "automation 'Session wrap-up' skipped: unsupported schedule kind 'on-exit'",
];

describe("openclawPaths", () => {
  const base = (overrides: Partial<Ctx>): Ctx => makeCtx({ sourceDir: undefined, ...overrides });

  it("takes the state dir from sourceDir, targetDir, OPENCLAW_STATE_DIR, then home", () => {
    const env = { OPENCLAW_STATE_DIR: join(scratch, "from-env") };
    expect(
      openclawPaths(base({ sourceDir: join(scratch, "src"), targetDir: join(scratch, "dst"), env }))
        .stateDir,
    ).toBe(join(scratch, "src"));
    expect(openclawPaths(base({ targetDir: join(scratch, "dst"), env })).stateDir).toBe(
      join(scratch, "dst"),
    );
    expect(openclawPaths(base({ env })).stateDir).toBe(join(scratch, "from-env"));
    expect(openclawPaths(base({})).stateDir).toBe(join(home, ".openclaw"));
  });

  it("expands ~ in OPENCLAW_STATE_DIR to ctx.home", () => {
    expect(openclawPaths(base({ env: { OPENCLAW_STATE_DIR: "~/claw" } })).stateDir).toBe(
      join(home, "claw"),
    );
    expect(openclawPaths(base({ env: { OPENCLAW_STATE_DIR: "~" } })).stateDir).toBe(home);
  });

  it("reads the config from OPENCLAW_CONFIG_PATH, else from <state dir>/openclaw.json", () => {
    expect(openclawPaths(ctx).configFile).toBe(join(stateDir, "openclaw.json"));
    const custom = join(scratch, "elsewhere", "claw.json5");
    expect(openclawPaths(makeCtx({ env: { OPENCLAW_CONFIG_PATH: custom } })).configFile).toBe(
      custom,
    );
  });

  it("resolves workspaces: entry, defaults, the only agent, then workspace-<id>", () => {
    const { workspaceFor } = openclawPaths(ctx);
    const two = { agents: { entries: { ada: {}, bare: {} } } };

    expect(workspaceFor("ada", { agents: { entries: { ada: { workspace: "~/ws/ada" } } } })).toBe(
      join(home, "ws", "ada"),
    );
    const absolute = join(scratch, "abs-ws");
    expect(workspaceFor("ada", { agents: { entries: { ada: { workspace: absolute } } } })).toBe(
      absolute,
    );
    expect(
      workspaceFor("ada", { agents: { defaults: { workspace: "~/claws" }, entries: { ada: {} } } }),
    ).toBe(join(home, "claws", "ada"));
    expect(workspaceFor("ada", { agents: { entries: { ada: {} } } })).toBe(
      join(stateDir, "workspace"),
    );
    expect(workspaceFor("main", {})).toBe(join(stateDir, "workspace"));
    expect(workspaceFor("main", { agents: { entries: {} } })).toBe(join(stateDir, "workspace"));
    expect(workspaceFor("ada", two)).toBe(join(stateDir, "workspace-ada"));
    expect(workspaceFor("other", {})).toBe(join(stateDir, "workspace-other"));
    expect(workspaceFor("other", { agents: { entries: { ada: {} } } })).toBe(
      join(stateDir, "workspace-other"),
    );
  });

  it("resolves a relative workspace against ctx.cwd", () => {
    const { workspaceFor } = openclawPaths(ctx);
    expect(workspaceFor("ada", { agents: { entries: { ada: { workspace: "rel/ada" } } } })).toBe(
      join(scratch, "rel", "ada"),
    );
  });
});

describe("readOpenClawConfig", () => {
  it("parses JSON5 with comments and trailing commas", async () => {
    const cfg = await readOpenClawConfig(join(stateDir, "openclaw.json"));
    expect(Object.keys(cfg.agents?.entries ?? {})).toEqual(["ada", "bare"]);
    expect(cfg.agents?.entries?.ada?.model).toEqual({
      primary: "anthropic/claude-opus-5-5",
      fallbacks: ["openai/gpt-5.5"],
    });
    expect(cfg.agents?.entries?.bare).toEqual({});
  });

  it("treats a missing file as an empty config", async () => {
    await expect(readOpenClawConfig(join(scratch, "nope.json"))).resolves.toEqual({});
  });

  it("names the file when it is not valid JSON5", async () => {
    const file = join(scratch, "broken.json");
    await writeFile(file, "{ agents: ");
    await expect(readOpenClawConfig(file)).rejects.toThrow(/broken\.json is not valid JSON5/);
  });

  it("refuses a config that is not an object", async () => {
    const file = join(scratch, "list.json");
    await writeFile(file, "[1, 2]");
    await expect(readOpenClawConfig(file)).rejects.toThrow(/list\.json.*not an object/);
  });
});

describe("OpenClawCli", () => {
  function cliWith(reply: (args: string[]) => Reply, env: NodeJS.ProcessEnv = {}): OpenClawCli {
    return new OpenClawCli(makeCtx({ env }, reply), stateDir);
  }

  it("runs every command with --json and OPENCLAW_STATE_DIR, keeping the other env", async () => {
    const cli = cliWith(
      (args) => {
        if (args[0] === "automations" && args[1] === "add") return '{"id":"job-9"}';
        if (args[0] === "automations" && args[1] === "list") return "[]";
        if (args[0] === "agents" && args[1] === "list") return "[]";
        return "";
      },
      { PATH: "/usr/bin", OPENCLAW_STATE_DIR: "/real/home/.openclaw" },
    );

    await cli.agentsList();
    await cli.automationsList();
    await cli.agentsAdd("ada", "/ws/ada");
    await cli.setIdentity("ada", { name: "Ada", emoji: "🔎", avatar: "avatars/ada.png" });
    await cli.setIdentity("ada", { name: "Ada" });
    expect(await cli.automationsAdd(["--name", "Morning digest", "--every", "30m"])).toEqual({
      id: "job-9",
    });
    await cli.automationsDisable("job-9");
    expect(await cli.configSet("agents.entries.ada.model", "anthropic/claude-opus-5-5")).toBe(
      true,
    );

    expect(calls.map(({ file, args }) => [file, ...args].join(" "))).toEqual([
      "openclaw agents list --json",
      "openclaw automations list --all --json",
      "openclaw agents add ada --workspace /ws/ada --non-interactive --json",
      "openclaw agents set-identity --agent ada --name Ada --emoji 🔎 --avatar avatars/ada.png --json",
      "openclaw agents set-identity --agent ada --name Ada --json",
      "openclaw automations add --name Morning digest --every 30m --json",
      "openclaw automations disable job-9 --json",
      "openclaw config set agents.entries.ada.model anthropic/claude-opus-5-5 --json",
    ]);
    for (const call of calls) {
      expect(call.env).toEqual({ PATH: "/usr/bin", OPENCLAW_STATE_DIR: stateDir });
    }
  });

  it("parses the automations fixture", async () => {
    const jobs = await cliWith(fixtureReply).automationsList();
    expect(jobs).toEqual([
      {
        id: "3f6c1a52-8d0e-4b7a-9c11-0a2b3c4d5e01",
        name: "Morning digest",
        agentId: "ada",
        enabled: true,
        schedule: { kind: "cron", expr: "30 8 * * 1-5", tz: "Europe/Warsaw" },
        message: "Summarise new papers and unread mail into a five-line digest.",
      },
      {
        id: "3f6c1a52-8d0e-4b7a-9c11-0a2b3c4d5e02",
        name: "Inbox sweep",
        agentId: "ada",
        enabled: false,
        schedule: { kind: "every", everyMs: 1800000 },
        message: "Check the inbox and flag anything urgent.",
      },
      {
        id: "3f6c1a52-8d0e-4b7a-9c11-0a2b3c4d5e03",
        name: "Session wrap-up",
        agentId: "ada",
        enabled: true,
        schedule: { kind: "on-exit" },
        message: "Write what you learned today to memory/.",
      },
      {
        id: "3f6c1a52-8d0e-4b7a-9c11-0a2b3c4d5e04",
        name: "Deploy queue check",
        agentId: "ops",
        enabled: true,
        schedule: { kind: "cron", expr: "*/15 * * * *" },
        message: "Check the deploy queue.",
      },
    ]);
  });

  it("reads job rows tolerantly and skips the ones it cannot use, naming them", async () => {
    const rows = [
      {
        id: "a",
        name: "Uses agent",
        agent: "ada",
        enabled: false,
        schedule: {},
        payload: { prompt: "P" },
      },
      { id: "b", name: "Top-level message", agentId: "ada", schedule: {}, message: "M" },
      { id: 7, agentId: "ada", schedule: {}, payload: { message: "Numeric id, no name" } },
      { id: "d", name: "No message", agentId: "ada", schedule: {}, payload: { kind: "event" } },
      { name: "No id", agentId: "ada", schedule: {} },
      "not a row",
    ];
    const warnings: string[] = [];
    const jobs = await cliWith(() => JSON.stringify(rows)).automationsList((w) => warnings.push(w));

    expect(jobs).toEqual([
      { id: "a", name: "Uses agent", agentId: "ada", enabled: false, schedule: {}, message: "P" },
      {
        id: "b",
        name: "Top-level message",
        agentId: "ada",
        enabled: true,
        schedule: {},
        message: "M",
      },
      {
        id: "7",
        name: "7",
        agentId: "ada",
        enabled: true,
        schedule: {},
        message: "Numeric id, no name",
      },
      { id: "d", name: "No message", agentId: "ada", enabled: true, schedule: {} },
    ]);
    expect(warnings).toEqual([
      "automation 'No id' skipped: openclaw automations list gave it no id",
      "automation #6 skipped: openclaw automations list gave a row that is not an object",
    ]);
    expect(logs).toEqual([]);
  });

  it("sends skipped-row warnings to ctx.logger when no callback is given", async () => {
    await cliWith(() => JSON.stringify({ automations: [{ name: "No id" }] })).automationsList();
    expect(logs).toEqual(["automation 'No id' skipped: openclaw automations list gave it no id"]);
  });

  it("accepts the job list bare, under jobs or under automations, after log lines", async () => {
    const row = { id: "x", name: "X", agentId: "ada", schedule: {}, payload: { message: "Go" } };
    for (const out of [
      JSON.stringify([row]),
      JSON.stringify({ jobs: [row] }),
      JSON.stringify({ automations: [row] }),
      `[openclaw] config migrated\n${JSON.stringify({ jobs: [row] }, null, 2)}`,
    ]) {
      expect(await cliWith(() => out).automationsList()).toHaveLength(1);
    }
  });

  it("fails clearly when the output is not JSON or holds no list", async () => {
    await expect(cliWith(() => "Gateway not running").automationsList()).rejects.toThrow(
      /openclaw automations list did not print JSON/,
    );
    await expect(cliWith(() => '{"count":0}').automationsList()).rejects.toThrow(
      /openclaw automations list printed no list/,
    );
  });

  it("parses agent rows bare or under agents, skipping rows without an id", async () => {
    const rows = [
      { id: "ada", name: "Ada", workspace: "/ws/ada" },
      { id: "bare", name: 3 },
      { name: "no id" },
    ];
    expect(await cliWith(() => JSON.stringify({ agents: rows })).agentsList()).toEqual([
      { id: "ada", name: "Ada", workspace: "/ws/ada" },
      { id: "bare" },
    ]);
    expect(logs).toEqual(["openclaw agents list: row 3 has no id; ignored"]);
    expect(await cliWith(() => JSON.stringify(rows)).agentsList()).toHaveLength(2);
  });

  it("reads the job id from automations add tolerantly and fails without one", async () => {
    expect(await cliWith(() => '{"job":{"id":"j1"}}').automationsAdd([])).toEqual({ id: "j1" });
    await expect(cliWith(() => '{"ok":true}').automationsAdd([])).rejects.toThrow(
      /openclaw automations add printed no job id/,
    );
  });

  it("reports false from configSet only when OpenClaw has no such command", async () => {
    const unknown = Object.assign(new Error("Command failed with exit code 1: openclaw config"), {
      stderr: "error: unknown command 'config'",
    });
    expect(await cliWith(() => unknown).configSet("a.b", "c")).toBe(false);

    const other = Object.assign(new Error("Command failed with exit code 1"), {
      stderr: "error: invalid config path",
    });
    await expect(cliWith(() => other).configSet("a.b", "c")).rejects.toThrow(/exit code 1/);
  });

  it("reads the version with --version, and gives undefined when that fails", async () => {
    expect(await cliWith(fixtureReply).version()).toBe("2026.10.3");
    expect(calls).toEqual([
      { file: "openclaw", args: ["--version"], env: { OPENCLAW_STATE_DIR: stateDir } },
    ]);
    expect(await cliWith(() => new Error("spawn openclaw ENOENT")).version()).toBeUndefined();
  });
});

describe("readOpenClawAgent", () => {
  it("reads Ada from the fixture", async () => {
    const { bundle, warnings } = await readOpenClawAgent(ctx, "ada");
    expect(bundle).toStrictEqual(await expectedAda(stateDir));
    expect(warnings).toEqual(ADA_WARNINGS);
    expect(calls).toEqual([
      {
        file: "openclaw",
        args: ["automations", "list", "--all", "--json"],
        env: { OPENCLAW_STATE_DIR: stateDir },
      },
    ]);
    expect(logs).toEqual([]);
  });

  it("reads an agent with only AGENTS.md and says what is missing", async () => {
    const { bundle, warnings } = await readOpenClawAgent(ctx, "bare");
    expect(bundle).toStrictEqual({
      manifest: manifest({ name: "bare" }),
      instructions: await text(join(stateDir, "workspace-bare", "AGENTS.md")),
      skills: [],
      routines: [],
      facts: [],
      notes: [],
      files: [],
      unknownPaths: [],
    });
    expect(bundle.persona).toBeUndefined();
    expect(warnings).toEqual(["SOUL.md not found", "IDENTITY.md not found", CAPABILITIES_WARNING]);
  });

  it("finds the state directory through OPENCLAW_STATE_DIR", async () => {
    const env = { OPENCLAW_STATE_DIR: stateDir, PATH: "/usr/bin" };
    const { bundle } = await readOpenClawAgent(makeCtx({ sourceDir: undefined, env }), "ada");
    expect(bundle).toStrictEqual(await expectedAda(stateDir));
    expect(calls.map((call) => call.env)).toEqual([env]);
  });

  it("finds the state directory under <home>/.openclaw by default", async () => {
    const defaultDir = join(home, ".openclaw");
    await cp(FIXTURE_STATE, defaultDir, { recursive: true });
    const { bundle } = await readOpenClawAgent(makeCtx({ sourceDir: undefined }), "ada");
    expect(bundle).toStrictEqual(await expectedAda(defaultDir));
    expect(calls.map((call) => call.env.OPENCLAW_STATE_DIR)).toEqual([defaultDir]);
  });

  it("prefers sourceDir over OPENCLAW_STATE_DIR, for the files and for the CLI", async () => {
    const env = { OPENCLAW_STATE_DIR: join(scratch, "not-this-one") };
    const { bundle } = await readOpenClawAgent(makeCtx({ env }), "ada");
    expect(bundle.manifest.name).toBe("Ada");
    expect(calls.map((call) => call.env.OPENCLAW_STATE_DIR)).toEqual([stateDir]);
  });

  it("throws for an agent without a workspace", async () => {
    await expect(readOpenClawAgent(ctx, "ghost")).rejects.toThrow(
      /OpenClaw agent "ghost" not found: no workspace at .*workspace-ghost/,
    );
  });

  it("reads instructions as empty and says so when AGENTS.md is missing", async () => {
    const dir = await makeState(
      {},
      { "workspace/SOUL.md": "Calm.\n", "workspace/IDENTITY.md": "" },
    );
    const { bundle, warnings } = await readOpenClawAgent(
      makeCtx({ sourceDir: dir }, noJobs),
      "main",
    );
    expect(bundle.instructions).toBe("");
    expect(bundle.persona).toBe("Calm.\n");
    expect(bundle.manifest.name).toBe("main");
    expect(warnings).toEqual(["AGENTS.md not found", CAPABILITIES_WARNING]);
  });

  describe("models", () => {
    async function modelsFor(entry: Record<string, unknown>): Promise<unknown> {
      const dir = await makeState({ ada: entry }, { "workspace/AGENTS.md": "x\n" });
      const { bundle } = await readOpenClawAgent(makeCtx({ sourceDir: dir }, noJobs), "ada");
      return bundle.manifest.models;
    }

    it.each([
      ["no model", {}, []],
      [
        "a provider/model string",
        { model: "anthropic/claude-opus-5-5" },
        [{ provider: "anthropic", model: "claude-opus-5-5" }],
      ],
      ["a model without a provider", { model: "gpt-5.5" }, [{ model: "gpt-5.5" }]],
      [
        "a nested provider path",
        { model: "openrouter/anthropic/claude-sonnet-5" },
        [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
      ],
      [
        "primary and fallbacks",
        {
          model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-opus-5-5", "llama-4"] },
        },
        [
          { provider: "openai", model: "gpt-5.5" },
          { provider: "anthropic", model: "claude-opus-5-5" },
          { model: "llama-4" },
        ],
      ],
      [
        "an ACP runtime with a model",
        {
          model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-opus-5-5"] },
          runtime: { type: "acp", acp: { agent: "codex" } },
        },
        [
          { runtime: "codex", provider: "openai", model: "gpt-5.5" },
          { provider: "anthropic", model: "claude-opus-5-5" },
        ],
      ],
      [
        "an ACP runtime alone",
        { runtime: { type: "acp", acp: { agent: "codex" } } },
        [{ runtime: "codex" }],
      ],
      [
        "blank strings",
        { model: { primary: " ", fallbacks: ["", "openai/gpt-5.5"] } },
        [{ provider: "openai", model: "gpt-5.5" }],
      ],
    ])("maps %s", async (_label, entry, expected) => {
      expect(await modelsFor(entry)).toStrictEqual(expected);
    });
  });

  describe("memory", () => {
    it("keeps a fact over 500 characters in MEMORY-prose and warns", async () => {
      const long = "x".repeat(501);
      const exact = "y".repeat(500);
      const dir = await makeState(
        {},
        {
          "workspace/AGENTS.md": "x\n",
          "workspace/SOUL.md": "s\n",
          "workspace/IDENTITY.md": "",
          "workspace/MEMORY.md": [
            "# Memory",
            "",
            "- Short fact.",
            "  - Indented fact.",
            `- ${long}`,
            `- ${exact}`,
            "-",
            "Closing line.",
            "",
          ].join("\n"),
        },
      );
      const { bundle, warnings } = await readOpenClawAgent(
        makeCtx({ sourceDir: dir }, noJobs),
        "main",
      );
      expect(bundle.facts).toEqual(["Short fact.", "Indented fact.", exact]);
      expect(bundle.notes).toEqual([
        { name: "MEMORY-prose", text: `# Memory\n${long}\n-\nClosing line.` },
      ]);
      expect(warnings).toEqual([
        CAPABILITIES_WARNING,
        "MEMORY.md line 5: fact is 501 characters, over the 500 limit; kept in note MEMORY-prose",
      ]);
    });

    it("leaves MEMORY-prose out when MEMORY.md has only facts, and reads CRLF files", async () => {
      const dir = await makeState(
        {},
        {
          "workspace/AGENTS.md": "x\n",
          "workspace/MEMORY.md": "- One.\r\n- Two.\r\n",
          "workspace/memory/b.md": "B",
          "workspace/memory/a.md": "A",
          "workspace/memory/nested/c.md": "not a note",
          "workspace/memory/notes.txt": "not a note",
        },
      );
      const { bundle } = await readOpenClawAgent(makeCtx({ sourceDir: dir }, noJobs), "main");
      expect(bundle.facts).toEqual(["One.", "Two."]);
      expect(bundle.notes).toEqual([
        { name: "a", text: "A" },
        { name: "b", text: "B" },
      ]);
    });
  });

  describe("identity and avatar", () => {
    async function readWith(
      entry: Record<string, unknown>,
      files: Record<string, string | Uint8Array>,
    ): Promise<{ bundle: Bundle; warnings: string[] }> {
      const dir = await makeState(
        { ada: entry },
        { "workspace/AGENTS.md": "x\n", "workspace/SOUL.md": "s\n", ...files },
      );
      return readOpenClawAgent(makeCtx({ sourceDir: dir }, noJobs), "ada");
    }

    it("falls back to IDENTITY.md for what the config does not set", async () => {
      const { bundle, warnings } = await readWith(
        { name: "Entry name", identity: { emoji: "🦉" } },
        {
          "workspace/IDENTITY.md": [
            "# IDENTITY.md - Who Am I?",
            "",
            "- **Name:** Nova",
            "- **Creature:** owl",
            "- **Emoji:** 🦞",
            "- **Theme:** Night-shift analyst",
            "- **Avatar:**",
            "  _(workspace-relative path, http(s) URL, or data URI)_",
          ].join("\n"),
        },
      );
      expect(bundle.manifest.name).toBe("Nova");
      expect(bundle.manifest.title).toBe("Night-shift analyst");
      expect(bundle.manifest["x-openclaw"]).toEqual({
        identity: { name: "Nova", emoji: "🦉", theme: "Night-shift analyst" },
      });
      expect(bundle.avatar).toBeUndefined();
      expect(warnings).toEqual([CAPABILITIES_WARNING]);
    });

    it("names the agent after the entry, then the id, without an identity", async () => {
      const named = await readWith({ name: "Entry name" }, { "workspace/IDENTITY.md": "# None\n" });
      expect(named.bundle.manifest.name).toBe("Entry name");
      expect(named.bundle.manifest).not.toHaveProperty("x-openclaw");
      expect(named.bundle.manifest).not.toHaveProperty("title");
      const unnamed = await readWith({}, { "workspace/IDENTITY.md": "" });
      expect(unnamed.bundle.manifest.name).toBe("ada");
    });

    it("cuts a name over 80 and a title over 120 characters, and says so", async () => {
      const { bundle, warnings } = await readWith(
        { identity: { name: "n".repeat(81), theme: "t".repeat(121) } },
        { "workspace/IDENTITY.md": "" },
      );
      expect(bundle.manifest.name).toBe("n".repeat(80));
      expect(bundle.manifest.title).toBe("t".repeat(120));
      expect(warnings).toEqual([
        CAPABILITIES_WARNING,
        "name cut to 80 characters",
        "title cut to 120 characters",
      ]);
    });

    it.each([
      ["https://example.com/ada.png", "avatar is a URL or data URI; not exported"],
      ["http://example.com/ada.png", "avatar is a URL or data URI; not exported"],
      ["data:image/png;base64,iVBORw0KGgo=", "avatar is a URL or data URI; not exported"],
      ["avatars/missing.png", "avatar 'avatars/missing.png' not found; not exported"],
      ["../outside.png", "avatar '../outside.png' is outside the workspace; not exported"],
      ["avatars/ada.gif", "avatar 'avatars/ada.gif' is not a PNG, JPEG or WebP image; not exported"],
      ["avatars/big.png", "avatar 'avatars/big.png' is 524289 bytes, over the 524288 byte limit; not exported"],
    ])("does not export avatar %s", async (avatar, warning) => {
      const { bundle, warnings } = await readWith(
        { identity: { name: "Ada", avatar } },
        {
          "workspace/IDENTITY.md": "",
          "outside.png": new Uint8Array([1]),
          "workspace/avatars/ada.gif": new Uint8Array([1]),
          "workspace/avatars/big.png": new Uint8Array(524_289),
        },
      );
      expect(bundle.avatar).toBeUndefined();
      expect(warnings).toEqual([CAPABILITIES_WARNING, warning]);
    });

    it("names the avatar avatar.<ext> whatever its file name", async () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
      const { bundle, warnings } = await readWith(
        { identity: { avatar: "img/Me.JPEG" } },
        { "workspace/IDENTITY.md": "", "workspace/img/Me.JPEG": jpeg },
      );
      expect(bundle.avatar).toStrictEqual({ name: "avatar.jpeg", bytes: jpeg });
      expect(warnings).toEqual([CAPABILITIES_WARNING]);
    });
  });

  describe("skills", () => {
    async function readSkills(
      entry: Record<string, unknown>,
      files: Record<string, string | Uint8Array>,
    ): Promise<{ bundle: Bundle; warnings: string[] }> {
      const dir = await makeState(
        { ada: entry },
        {
          "workspace/AGENTS.md": "x\n",
          "workspace/SOUL.md": "s\n",
          "workspace/IDENTITY.md": "",
          ...files,
        },
      );
      return readOpenClawAgent(makeCtx({ sourceDir: dir }, noJobs), "ada");
    }

    it("exports every skill without an allowlist, SKILL.md first, then by path", async () => {
      const { bundle, warnings } = await readSkills(
        {},
        {
          "workspace/skills/zeta/SKILL.md": "---\nname: zeta\n---\n# Zeta\n",
          "workspace/skills/alpha/SKILL.md": "# Alpha\n",
          "workspace/skills/alpha/scripts/run.sh": "echo hi\n",
          "workspace/skills/alpha/README.md": "readme\n",
          "workspace/skills/alpha/node_modules/left-pad/index.js": "module.exports = 1;\n",
          "workspace/skills/alpha/.env": "TOKEN=1\n",
          "workspace/skills/empty/notes.md": "no SKILL.md here\n",
          "workspace/skills/loose-file.md": "not a skill directory\n",
        },
      );
      const layout = bundle.skills.map(({ name, files }) => [name, files.map(({ path }) => path)]);
      expect(layout).toEqual([
        ["alpha", ["SKILL.md", "README.md", "scripts/run.sh"]],
        ["zeta", ["SKILL.md"]],
      ]);
      expect(new TextDecoder().decode(bundle.skills[0]?.files[2]?.bytes)).toBe("echo hi\n");
      expect(warnings).toEqual([
        CAPABILITIES_WARNING,
        "skill 'alpha': left out .env",
        "skill 'alpha': left out node_modules",
        "skills/empty has no SKILL.md; not exported",
      ]);
    });

    it("matches the allowlist on SKILL.md names, reporting allowed skills it lacks", async () => {
      const { bundle, warnings } = await readSkills(
        { skills: ["brief", "weather"] },
        {
          "workspace/skills/web-brief/SKILL.md": "---\nname: brief\ndescription: d\n---\n# Brief\n",
          "workspace/skills/other/SKILL.md": "# Other\n",
        },
      );
      expect(bundle.skills.map(({ name }) => name)).toEqual(["web-brief"]);
      expect(warnings).toEqual([
        CAPABILITIES_WARNING,
        "skill 'other' is not on the agent's skill allowlist; not exported",
        "skill 'weather' is not in the workspace; not exported",
      ]);
    });

    it("exports no skill for an empty allowlist", async () => {
      const { bundle } = await readSkills(
        { skills: [] },
        { "workspace/skills/web-brief/SKILL.md": "# Brief\n" },
      );
      expect(bundle.skills).toEqual([]);
    });
  });

  describe("routines", () => {
    async function readJobs(jobs: unknown[]): Promise<{ bundle: Bundle; warnings: string[] }> {
      const dir = await makeState(
        {},
        { "workspace/AGENTS.md": "x\n", "workspace/SOUL.md": "s\n", "workspace/IDENTITY.md": "" },
      );
      return readOpenClawAgent(
        makeCtx({ sourceDir: dir }, (args) =>
          args[0] === "automations" ? JSON.stringify({ jobs }) : undefined,
        ),
        "main",
      );
    }
    const job = (name: string, schedule: unknown, extra: Record<string, unknown> = {}) => ({
      id: name,
      name,
      agentId: "main",
      schedule,
      payload: { kind: "agentTurn", message: `Run ${name}.` },
      ...extra,
    });

    it("reads each supported schedule kind and names every job it skips", async () => {
      const { bundle, warnings } = await readJobs([
        job("Cron, no zone", { kind: "cron", expr: "0 9 * * *" }),
        job("Once", { kind: "at", at: "2026-11-01T10:00:00+01:00" }),
        job("No agent", { kind: "every", everyMs: 3_600_000 }, { agentId: undefined }),
        job("Someone else", { kind: "every", everyMs: 3_600_000 }, { agentId: "ops" }),
        job("Odd interval", { kind: "every", everyMs: 90_000 }),
        job("Streamed", { kind: "stream", source: "mail" }),
        job("No schedule", undefined),
        job("Bad zone", { kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" }),
        {
          id: "silent",
          name: "Silent",
          agentId: "main",
          schedule: { kind: "cron", expr: "0 9 * * *" },
        },
      ]);
      expect(bundle.routines).toStrictEqual([
        {
          name: "Cron, no zone",
          instruction: "Run Cron, no zone.",
          enabled: true,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          schedule: { kind: "cron", expression: "0 9 * * *" },
        },
        {
          name: "Once",
          instruction: "Run Once.",
          enabled: true,
          timezone: "UTC",
          schedule: { kind: "at", at: "2026-11-01T09:00:00.000Z" },
        },
        {
          name: "No agent",
          instruction: "Run No agent.",
          enabled: true,
          timezone: "UTC",
          schedule: { kind: "every", every: "1h" },
        },
      ]);
      expect(warnings).toEqual([
        CAPABILITIES_WARNING,
        "automation 'Odd interval' skipped: its 'every' schedule cannot be expressed as a routine",
        "automation 'Streamed' skipped: unsupported schedule kind 'stream'",
        "automation 'No schedule' skipped: it has no schedule kind",
        "automation 'Bad zone' skipped: timezone: Not an IANA time zone",
        "automation 'Silent' skipped: no message to run",
      ]);
    });

    it("exports the agent without routines when the automations cannot be listed", async () => {
      const dir = await makeState(
        {},
        { "workspace/AGENTS.md": "x\n", "workspace/SOUL.md": "s\n", "workspace/IDENTITY.md": "" },
      );
      const fail = new Error("spawn openclaw ENOENT\n    at ChildProcess.spawn");
      const { bundle, warnings } = await readOpenClawAgent(
        makeCtx({ sourceDir: dir }, () => fail),
        "main",
      );
      expect(bundle.routines).toEqual([]);
      expect(warnings).toEqual([
        CAPABILITIES_WARNING,
        "automations not read (spawn openclaw ENOENT); no routines exported",
      ]);
    });

    it("puts automation rows the CLI could not use among the warnings", async () => {
      const { warnings } = await readJobs([{ name: "Nameless id" }]);
      expect(warnings).toEqual([
        CAPABILITIES_WARNING,
        "automation 'Nameless id' skipped: openclaw automations list gave it no id",
      ]);
      expect(logs).toEqual([]);
    });
  });

  it("gives Bundles that a .jetpack holds and gives back unchanged", async () => {
    const longFact = await makeState(
      {},
      {
        "workspace/AGENTS.md": "x\n",
        "workspace/MEMORY.md": `- Short.\n- ${"z".repeat(600)}\n`,
        "workspace/avatars/me.webp": new Uint8Array([1, 2, 3]),
        "workspace/IDENTITY.md": "- **Avatar:** avatars/me.webp\n",
      },
    );
    const reads = [
      await readOpenClawAgent(ctx, "ada"),
      await readOpenClawAgent(ctx, "bare"),
      await readOpenClawAgent(makeCtx({ sourceDir: longFact }, noJobs), "main"),
    ];
    expect(reads[2]?.bundle.avatar?.name).toBe("avatar.webp");
    expect(reads[2]?.bundle.notes.map(({ name }) => name)).toEqual(["MEMORY-prose"]);

    const byName = <T extends { name: string }>(items: T[]): T[] =>
      [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const { bundle } of reads) {
      const withId = {
        ...bundle,
        manifest: { ...bundle.manifest, id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T" },
      };
      const reread = entriesToBundle(bundleToEntries(withId));
      expect({
        ...reread,
        notes: byName(reread.notes),
        routines: byName(reread.routines),
      }).toStrictEqual({
        ...withId,
        notes: byName(withId.notes),
        routines: byName(withId.routines),
      });
    }
  });

  it("does not modify the source", async () => {
    const before = await snapshot(stateDir);
    await readOpenClawAgent(ctx, "ada");
    await readOpenClawAgent(ctx, "bare");
    expect(await snapshot(stateDir)).toEqual(before);
  });
});

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path] = (await readFile(path)).toString("base64");
  }
  return out;
}

describe("openclawAdapter", () => {
  it("is exported as the default too, under the name openclaw", () => {
    expect(openclawAdapterDefault).toBe(openclawAdapter);
    expect(openclawAdapter.name).toBe("openclaw");
    expect(openclawAdapter.displayName).toBe("OpenClaw");
    expect(openclawAdapter.capabilities).toEqual({
      persona: true,
      instructions: true,
      skills: true,
      routines: true,
      facts: true,
      notes: true,
      files: false,
      avatar: true,
      models: true,
      schedules: ["cron", "every", "at"],
    });
  });

  it("reads through the adapter as readOpenClawAgent does", async () => {
    const { bundle, warnings } = await openclawAdapter.read(ctx, "ada");
    expect(bundle).toStrictEqual(await expectedAda(stateDir));
    expect(warnings).toEqual(ADA_WARNINGS);
  });

  it("leaves writing to a later task", async () => {
    const { bundle } = await openclawAdapter.read(ctx, "bare");
    await expect(
      openclawAdapter.write(ctx, bundle, {
        enableRoutines: false,
        includeFiles: false,
        onConflict: "copy",
      }),
    ).rejects.toThrow("OpenClaw write is implemented in a later task");
  });

  describe("detect", () => {
    it("finds the install by its config file and reports the CLI version", async () => {
      expect(await openclawAdapter.detect(ctx)).toEqual({
        found: true,
        location: stateDir,
        version: "2026.10.3",
      });
      expect(calls).toEqual([
        { file: "openclaw", args: ["--version"], env: { OPENCLAW_STATE_DIR: stateDir } },
      ]);
    });

    it("still finds the install when the CLI is not on the PATH", async () => {
      const noCli = makeCtx({}, () => new Error("spawn openclaw ENOENT"));
      expect(await openclawAdapter.detect(noCli)).toEqual({ found: true, location: stateDir });
    });

    it("gives a hint when there is no config file", async () => {
      const empty = join(scratch, "empty");
      await mkdir(empty);
      expect(await openclawAdapter.detect(makeCtx({ sourceDir: empty }))).toEqual({
        found: false,
        location: empty,
        version: "2026.10.3",
        hint: "Install OpenClaw or pass --source-dir <state dir>",
      });
    });

    it("looks for the config at OPENCLAW_CONFIG_PATH", async () => {
      const elsewhere = join(scratch, "elsewhere.json5");
      const env = { OPENCLAW_CONFIG_PATH: elsewhere };
      expect((await openclawAdapter.detect(makeCtx({ env }))).found).toBe(false);
      await writeFile(elsewhere, "{}");
      expect((await openclawAdapter.detect(makeCtx({ env }))).found).toBe(true);
    });
  });

  describe("list", () => {
    it("lists the config's agents, then the ones only the CLI knows", async () => {
      expect(await openclawAdapter.list(ctx)).toEqual([
        {
          id: "ada",
          name: "Ada",
          title: "Research assistant",
          location: join(stateDir, "workspace-ada"),
        },
        { id: "bare", name: "bare", location: join(stateDir, "workspace-bare") },
        { id: "ops", name: "Ops", location: "/srv/openclaw/workspace-ops" },
      ]);
      expect(calls.map((call) => [call.args.join(" "), call.env.OPENCLAW_STATE_DIR])).toEqual([
        ["agents list --json", stateDir],
      ]);
      expect(logs).toEqual([]);
    });

    it("lists the config's agents only, and logs why, when the CLI fails", async () => {
      const failing = makeCtx({}, () => new Error("spawn openclaw ENOENT"));
      expect((await openclawAdapter.list(failing)).map(({ id }) => id)).toEqual(["ada", "bare"]);
      expect(logs).toEqual([
        "openclaw agents list failed (spawn openclaw ENOENT); listing the agents in openclaw.json only",
      ]);
    });

    it("lists main when the config has no agents but the default workspace exists", async () => {
      const dir = await makeState({}, { "workspace/AGENTS.md": "x\n" });
      const noAgents = (args: string[]): Reply => (args[0] === "agents" ? "[]" : undefined);
      expect(await openclawAdapter.list(makeCtx({ sourceDir: dir }, noAgents))).toEqual([
        { id: "main", name: "main", location: join(dir, "workspace") },
      ]);
      const bare = await makeState({});
      expect(await openclawAdapter.list(makeCtx({ sourceDir: bare }, noAgents))).toEqual([]);
    });
  });
});
