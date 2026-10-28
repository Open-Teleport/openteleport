import { writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenClawCli,
  ShimLineBreakError,
  resolveOpenClawCommand,
} from "../../../src/adapters/openclaw/cli.js";
import { openclawAdapter } from "../../../src/adapters/openclaw/index.js";
import { readOpenClawAgent } from "../../../src/adapters/openclaw/read.js";
import { writeOpenClawAgent } from "../../../src/adapters/openclaw/write.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import { SecretsFoundError } from "../../../src/core/engine.js";
import type { Bundle, Routine } from "../../../src/core/schema.js";

// `rename` as Node has it, unless a test makes it fail as a full disk would.
const renameControl = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameControl.fail) {
        throw Object.assign(new Error("ENOSPC: no space left on device, rename"), {
          code: "ENOSPC",
        });
      }
      return actual.rename(...args);
    },
  };
});

const NOW = new Date("2026-10-27T09:15:00.000Z");
const ADA_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
const RESTART_WARNING = "Restart the Gateway to load the new agent: openclaw gateway restart";
const GATEWAY_WARNING =
  "Routines need the Gateway, which did not answer; start it, then move the agent again: " +
  "openclaw gateway start";
const CAPABILITIES_ITEM = {
  field: "capabilities",
  detail: "OpenClaw does not take capability declarations; defaults apply",
};
const REWRITE_WARNING = "openclaw.json rewritten; comments may be lost";
const BACKUP_NAME = "openclaw.json.bak-2026-10-27T09-15-00-000Z";
/** What `openclaw.json` holds before every test: JSON5 with a comment, as OpenClaw writes it. */
const CONFIG_SOURCE = "// OpenClaw configuration\n{\n  agents: {\n    entries: {},\n  },\n}\n";

/** Whether this machine lets the tests create file and directory symbolic links. */
const canSymlink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "openteleport-symlink-"));
  try {
    await writeFile(join(dir, "file"), "");
    await mkdir(join(dir, "dir"));
    await symlink(join(dir, "file"), join(dir, "file-link"), "file");
    await symlink(join(dir, "dir"), join(dir, "dir-link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type ExecCall = { file: string; args: string[]; env: Record<string, string | undefined> };
/** Stdout for a command, an Error to fail it with, or `undefined` to fall through. */
type Reply = string | Error | undefined;

/** An error such as execa throws for an `openclaw` that has no such command. */
const unknownCommand = (): Error =>
  Object.assign(new Error("Command failed with exit code 1: openclaw config set"), {
    stderr: "error: unknown command 'set'",
  });

/** What OpenClaw 2026.5.28, which has `cron` instead, says to any `automations` command. */
const unknownAutomations = (args: string[]): Error =>
  Object.assign(new Error(`Command failed with exit code 1: openclaw ${args.join(" ")}`), {
    stderr:
      "[openclaw] Could not start the CLI.\n" +
      "[openclaw] Reason: Unknown command: openclaw automations. No built-in command or " +
      'plugin CLI metadata owns "automations".',
  });

/** An OpenClaw with the `cron` family: every `automations` command is unknown. */
const cronFamily = (args: string[]): Reply =>
  args[0] === "automations" ? unknownAutomations(args) : undefined;

/** An error such as execa throws when a job command cannot reach the Gateway. */
const gatewayDown = (args: string[]): Error =>
  Object.assign(new Error(`Command failed with exit code 1: openclaw ${args.join(" ")}`), {
    stderr: "Error: gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED)",
  });

let scratch: string;
let home: string;
let stateDir: string;
let logs: string[];
let calls: ExecCall[];
/** The rows `openclaw agents list --json` prints. */
let agentRows: unknown[];
/** The jobs `openclaw automations list --all --json` prints. */
let jobs: unknown[];
/** Asked first for every command; `undefined` falls through to the defaults below. */
let override: (args: string[]) => Reply;
let jobCounter: number;

/** How a working OpenClaw answers each command the write side runs. */
function defaultReply(args: string[]): Reply {
  const command = args.slice(0, 2).join(" ");
  switch (command) {
    case "agents list":
      return JSON.stringify(agentRows);
    case "agents add":
      return JSON.stringify({ id: args[2] });
    case "agents set-identity":
      return "{}";
    case "config set":
      return "";
    case "automations list":
    case "cron list":
      return JSON.stringify({ jobs });
    case "automations add":
    case "cron add":
      jobCounter += 1;
      return `Adding job...\n${JSON.stringify({ job: { id: `job-${jobCounter}` } })}`;
    case "automations disable":
    case "automations remove":
    case "cron rm":
      return "{}";
    case "cron disable":
      return "";
    case "gateway status":
      return JSON.stringify({ running: false });
    default:
      return undefined;
  }
}

function stubExec(): typeof execa {
  const exec = async (
    file: string,
    args: readonly string[] = [],
    options: { env?: Record<string, string | undefined> } = {},
  ) => {
    calls.push({ file, args: [...args], env: { ...options.env } });
    // Node running OpenClaw's script gets the script first; the replies go by OpenClaw's own.
    const own = file === process.execPath ? args.slice(1) : [...args];
    const out = override(own) ?? defaultReply(own);
    if (out === undefined) throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    if (out instanceof Error) throw out;
    return { stdout: out, stderr: "", exitCode: 0 };
  };
  return exec as unknown as typeof execa;
}

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    targetDir: stateDir,
    home,
    cwd: scratch,
    // An install the user points elsewhere; an explicit target dir must win over it.
    env: {
      PATH: "/usr/bin",
      OPENCLAW_STATE_DIR: "/somewhere/else",
      OPENCLAW_CONFIG_PATH: "/somewhere/else/openclaw.json",
    },
    exec: stubExec(),
    logger: (msg) => logs.push(msg),
    ...overrides,
  };
}

const OPTS: WriteOpts = { enableRoutines: false, includeFiles: false, onConflict: "update" };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  scratch = await mkdtemp(join(tmpdir(), "openteleport-openclaw-write-"));
  home = join(scratch, "home");
  await mkdir(home);
  stateDir = join(scratch, "state");
  await mkdir(stateDir);
  await writeFile(join(stateDir, "openclaw.json"), CONFIG_SOURCE);
  logs = [];
  calls = [];
  agentRows = [];
  jobs = [];
  override = () => undefined;
  jobCounter = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  renameControl.fail = false;
  Object.defineProperty(process, "platform", PLATFORM);
  await rm(scratch, { recursive: true, force: true });
});

/** `process.platform` as Node set it; a test may pretend to run on another one. */
const PLATFORM = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
const pretendPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", { ...PLATFORM, value: platform });
};

const MORNING_DIGEST: Routine = {
  name: "Morning digest",
  instruction: "Summarise new papers and unread mail into a five-line digest.",
  enabled: true,
  timezone: "Europe/Warsaw",
  schedule: { kind: "cron", expression: "30 8 * * 1-5" },
};

function ada(overrides: Partial<Bundle> = {}, manifest: Partial<Bundle["manifest"]> = {}): Bundle {
  return {
    manifest: {
      schemaVersion: "0.1",
      id: ADA_ID,
      name: "Ada",
      title: "Research assistant",
      models: [{ provider: "anthropic", model: "claude-opus-5-5" }],
      // None declared: a declaration only adds an approximated item (tested on its own).
      capabilities: [],
      "x-openclaw": { identity: { name: "Ada", emoji: "🔎" } },
      ...manifest,
    },
    persona: "# Ada\n\nAda is a calm, curious research assistant.\n",
    instructions: "# Instructions\n\n- Read the sources before summarising them.\n",
    skills: [
      {
        name: "web-brief",
        files: [
          { path: "SKILL.md", bytes: encode("---\nname: web-brief\n---\n\n# Web brief\n") },
          { path: "templates/brief.md", bytes: encode("Five lines.\n") },
        ],
      },
    ],
    routines: [MORNING_DIGEST],
    facts: ["The user reports in EUR.", "Reads the digest on a phone."],
    notes: [
      { name: "2026-10-20", text: "# 2026-10-20\n\nCompared three papers.\n" },
      { name: "MEMORY-prose", text: "Ada keeps long-form notes in memory/." },
      { name: "USER", text: "# USER.md\n\n- Name: Sam\n" },
    ],
    files: [],
    avatar: { name: "avatar.png", bytes: PNG },
    unknownPaths: [],
    ...overrides,
  };
}

const text = (path: string): Promise<string> => readFile(path, "utf8");
const exists = (path: string): Promise<boolean> =>
  readFile(path).then(
    () => true,
    () => false,
  );
const argsOf = (): string[][] => calls.map((call) => call.args);
const commands = (): string[] => calls.map((call) => call.args.slice(0, 2).join(" "));

async function writeTree(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** Every file under `root`, as `/`-separated paths, sorted. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name).slice(root.length + 1).split(/[\\/]/).join("/"),
    )
    .sort();
}

const MARKER = (id = ADA_ID) => `${JSON.stringify({ id, movedAt: NOW.toISOString() }, null, 2)}\n`;

describe("writeOpenClawAgent: a new agent", () => {
  it("creates the agent through the CLI and writes its workspace", async () => {
    const ws = join(stateDir, "workspace-ada");
    const bundle = ada({}, { capabilities: ["browser", "filesystem", "scheduler"] });
    const result = await writeOpenClawAgent(makeCtx(), bundle, OPTS);

    expect(result).toEqual({
      outcome: "done",
      targetAgentId: "ada",
      artifactPath: ws,
      items: { approximated: [CAPABILITIES_ITEM], skipped: [], warnings: [] },
    });

    expect(argsOf()).toEqual([
      ["agents", "list", "--json"],
      ["agents", "add", "ada", "--workspace", ws, "--non-interactive", "--json"],
      [
        "agents",
        "set-identity",
        "--agent",
        "ada",
        "--name",
        "Ada",
        "--emoji",
        "🔎",
        "--avatar",
        "avatars/avatar.png",
        "--theme",
        "Research assistant",
        "--json",
      ],
      ["config", "set", "agents.entries.ada.model", "anthropic/claude-opus-5-5"],
      // The first job command settles the family; this OpenClaw has `automations`.
      ["automations", "list", "--all", "--json"],
      [
        "automations",
        "add",
        "--name",
        "Morning digest",
        "--cron",
        "30 8 * * 1-5",
        "--tz",
        "Europe/Warsaw",
        "--agent",
        "ada",
        "--session",
        "isolated",
        "--json",
        // Last, so that a command line cut inside the message still carries every flag.
        "--message",
        "Summarise new papers and unread mail into a five-line digest.",
      ],
      ["automations", "disable", "job-1", "--json"],
      ["gateway", "status", "--json"],
    ]);
    expect(calls.every((call) => call.file === "openclaw")).toBe(true);

    expect(await listFiles(ws)).toEqual([
      ".openteleport.json",
      "AGENTS.md",
      "IDENTITY.md",
      "MEMORY.md",
      "SOUL.md",
      "USER.md",
      "avatars/avatar.png",
      "memory/2026-10-20.md",
      "skills/web-brief/SKILL.md",
      "skills/web-brief/templates/brief.md",
    ]);
    expect(await text(join(ws, "SOUL.md"))).toBe(ada().persona);
    expect(await text(join(ws, "AGENTS.md"))).toBe(ada().instructions);
    expect(await text(join(ws, "IDENTITY.md"))).toBe(
      [
        "# IDENTITY.md - Who Am I?",
        "",
        "- **Name:** Ada",
        "- **Theme:** Research assistant",
        "- **Emoji:** 🔎",
        "- **Avatar:** avatars/avatar.png",
        "",
      ].join("\n"),
    );
    const memory = await text(join(ws, "MEMORY.md"));
    expect(memory.startsWith("- The user reports in EUR.")).toBe(true);
    expect(memory).toBe(
      "- The user reports in EUR.\n- Reads the digest on a phone.\n\n" +
        "Ada keeps long-form notes in memory/.\n",
    );
    expect(await text(join(ws, "memory", "2026-10-20.md"))).toBe(
      "# 2026-10-20\n\nCompared three papers.\n",
    );
    expect(await text(join(ws, "USER.md"))).toBe("# USER.md\n\n- Name: Sam\n");
    expect(await text(join(ws, "skills", "web-brief", "SKILL.md"))).toBe(
      "---\nname: web-brief\n---\n\n# Web brief\n",
    );
    expect(await text(join(ws, "skills", "web-brief", "templates", "brief.md"))).toBe(
      "Five lines.\n",
    );
    expect(new Uint8Array(await readFile(join(ws, "avatars", "avatar.png")))).toEqual(PNG);
    expect(await text(join(ws, ".openteleport.json"))).toBe(MARKER());
    // The CLI did the config work; the file itself is left alone.
    expect(await text(join(stateDir, "openclaw.json"))).toBe(CONFIG_SOURCE);
  });

  it("pins every call to the target dir and its config, over the env", async () => {
    await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.env.OPENCLAW_STATE_DIR).toBe(stateDir);
      expect(call.env.OPENCLAW_CONFIG_PATH).toBe(join(stateDir, "openclaw.json"));
      expect(call.env.PATH).toBe("/usr/bin");
    }
  });

  it("leaves routines enabled only with enableRoutines and an enabled routine", async () => {
    const paused: Routine = { ...MORNING_DIGEST, name: "Paused", enabled: false };
    const bundle = ada({ routines: [MORNING_DIGEST, paused] });

    await writeOpenClawAgent(makeCtx(), bundle, { ...OPTS, enableRoutines: true });

    const automations = argsOf().filter((args) => args[0] === "automations");
    expect(automations.map((args) => args.slice(0, 4))).toEqual([
      ["automations", "list", "--all", "--json"],
      ["automations", "add", "--name", "Morning digest"],
      ["automations", "add", "--name", "Paused"],
      ["automations", "disable", "job-2", "--json"],
    ]);
  });

  it("disables every routine without enableRoutines", async () => {
    const paused: Routine = { ...MORNING_DIGEST, name: "Paused", enabled: false };
    await writeOpenClawAgent(makeCtx(), ada({ routines: [MORNING_DIGEST, paused] }), OPTS);

    expect(argsOf().filter((args) => args[1] === "disable")).toEqual([
      ["automations", "disable", "job-1", "--json"],
      ["automations", "disable", "job-2", "--json"],
    ]);
  });

  it("passes interval and one-off schedules as OpenClaw flags", async () => {
    const routines: Routine[] = [
      { ...MORNING_DIGEST, name: "Sweep", schedule: { kind: "every", every: "30m" } },
      {
        ...MORNING_DIGEST,
        name: "Once",
        timezone: "UTC",
        schedule: { kind: "at", at: "2026-11-01T09:00:00.000Z" },
      },
    ];
    await writeOpenClawAgent(makeCtx(), ada({ routines }), OPTS);

    const adds = argsOf().filter((args) => args[1] === "add" && args[0] === "automations");
    expect(adds).toEqual([
      [
        "automations",
        "add",
        "--name",
        "Sweep",
        "--every",
        "30m",
        "--agent",
        "ada",
        "--session",
        "isolated",
        "--json",
        "--message",
        MORNING_DIGEST.instruction,
      ],
      [
        "automations",
        "add",
        "--name",
        "Once",
        "--at",
        "2026-11-01T09:00:00.000Z",
        "--tz",
        "UTC",
        "--agent",
        "ada",
        "--session",
        "isolated",
        "--json",
        "--message",
        MORNING_DIGEST.instruction,
      ],
    ]);
  });

  it("skips a routine the CLI refuses and carries on with the rest", async () => {
    const second: Routine = { ...MORNING_DIGEST, name: "Evening digest" };
    override = (args) =>
      args[1] === "add" && args[3] === "Morning digest"
        ? new Error("invalid cron expression\nmore detail")
        : undefined;

    const result = await writeOpenClawAgent(
      makeCtx(),
      ada({ routines: [MORNING_DIGEST, second] }),
      OPTS,
    );

    expect(result.items.skipped).toEqual([
      { field: "routine:Morning digest", detail: "not created: invalid cron expression" },
    ]);
    expect(argsOf().filter((args) => args[0] === "automations")).toEqual([
      ["automations", "list", "--all", "--json"],
      expect.arrayContaining(["add", "Morning digest"]),
      expect.arrayContaining(["add", "Evening digest"]),
      ["automations", "disable", "job-1", "--json"],
    ]);
  });

  it("removes a job it cannot disable, so that no routine lands enabled", async () => {
    override = (args) => (args[1] === "disable" ? new Error("gateway unreachable") : undefined);

    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    expect(argsOf().filter((args) => args[0] === "automations").slice(2)).toEqual([
      ["automations", "disable", "job-1", "--json"],
      ["automations", "remove", "job-1", "--json"],
    ]);
    expect(result.items.skipped).toEqual([
      {
        field: "routine:Morning digest",
        detail: "could not be disabled (gateway unreachable); removed again",
      },
    ]);
  });

  it("warns loudly when a job can be neither disabled nor removed", async () => {
    override = (args) =>
      args[1] === "disable" || args[1] === "remove" ? new Error("gateway unreachable") : undefined;

    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    expect(result.items.warnings).toEqual([
      "automation 'Morning digest' (job-1) could not be disabled (gateway unreachable) and is " +
        "ENABLED; disable it with: openclaw automations disable job-1",
    ]);
  });

  it("writes no SOUL.md without a persona and no MEMORY.md without memory", async () => {
    const { persona: _persona, ...rest } = ada({ facts: [], notes: [] });
    const result = await writeOpenClawAgent(makeCtx(), rest, OPTS);

    const files = await listFiles(result.artifactPath ?? "");
    expect(files).not.toContain("SOUL.md");
    expect(files).not.toContain("MEMORY.md");
    expect(files).toContain("AGENTS.md");
  });

  it("writes MEMORY.md from the prose note alone when there are no facts", async () => {
    const result = await writeOpenClawAgent(
      makeCtx(),
      ada({ facts: [], notes: [{ name: "MEMORY-prose", text: "Only prose." }] }),
      OPTS,
    );
    expect(await text(join(result.artifactPath ?? "", "MEMORY.md"))).toBe("Only prose.\n");
  });

  it("uses the default emoji and no avatar when the bundle has neither", async () => {
    const { avatar: _avatar, ...rest } = ada({}, { title: undefined, "x-openclaw": undefined });
    const result = await writeOpenClawAgent(makeCtx(), rest, OPTS);

    expect(argsOf()[2]).toEqual([
      "agents",
      "set-identity",
      "--agent",
      "ada",
      "--name",
      "Ada",
      "--emoji",
      "🤖",
      "--json",
    ]);
    expect(await text(join(result.artifactPath ?? "", "IDENTITY.md"))).toBe(
      "# IDENTITY.md - Who Am I?\n\n- **Name:** Ada\n- **Emoji:** 🤖\n",
    );
  });

  it("derives the agent id from the name", async () => {
    const cases: [string, string][] = [
      ["Ada Lovelace (v2)!", "ada-lovelace-v2"],
      ["  --Ops--  ", "ops"],
      ["x".repeat(40), "x".repeat(32)],
      [`${"a".repeat(31)} b`, "a".repeat(31)],
      ["CON", "con-r"],
      ["Ада", "agent"],
    ];
    for (const [name, id] of cases) {
      calls = [];
      const result = await writeOpenClawAgent(
        makeCtx(),
        ada({ routines: [] }, { name, id: "" }),
        OPTS,
      );
      expect(result.targetAgentId, name).toBe(id);
      expect(argsOf()[1]?.slice(0, 3), name).toEqual(["agents", "add", id]);
    }
  });

  it("reports what OpenClaw has no place for", async () => {
    const bundle = ada(
      {},
      {
        description: "Reads papers so you do not have to.",
        models: [
          { model: "local-only" },
          { provider: "anthropic", model: "claude-opus-5-5" },
          { provider: "openai", model: "gpt-5.5" },
        ],
      },
    );
    const result = await writeOpenClawAgent(makeCtx(), bundle, OPTS);

    expect(argsOf()).toContainEqual([
      "config",
      "set",
      "agents.entries.ada.model",
      "anthropic/claude-opus-5-5",
    ]);
    expect(result.items.approximated).toEqual([
      {
        field: "models",
        detail: "model set to anthropic/claude-opus-5-5; 2 other preferences not set",
      },
    ]);
    expect(result.items.skipped).toEqual([
      { field: "description", detail: "OpenClaw has no field for it" },
    ]);
  });

  it("sets no model when no preference names a provider and a model", async () => {
    const result = await writeOpenClawAgent(
      makeCtx(),
      ada({}, { models: [{ model: "local-only" }] }),
      OPTS,
    );
    expect(commands()).not.toContain("config set");
    expect(result.items.approximated).toEqual([
      {
        field: "models",
        detail: "no preference names both a provider and a model; OpenClaw's default applies",
      },
    ]);
  });
});

describe("writeOpenClawAgent: runtime", () => {
  const runtimeArgs = (agent: string) => [
    "config",
    "set",
    "agents.entries.ada.runtime",
    JSON.stringify({ type: "acp", acp: { agent } }),
    "--strict-json",
  ];

  it("maps each known runtime to its ACP agent, after the model", async () => {
    const cases: [string, string][] = [
      ["codex", "codex"],
      ["claude-code", "claude"],
      ["gemini-cli", "gemini"],
      ["opencode", "opencode"],
      ["cursor", "cursor"],
      ["cline", "cline"],
      // The ACP names themselves, as the read side reports them.
      ["claude", "claude"],
      ["gemini", "gemini"],
    ];
    for (const [runtime, agent] of cases) {
      calls = [];
      await rm(join(stateDir, "workspace-ada"), { recursive: true, force: true });
      const models = [{ runtime, provider: "anthropic", model: "claude-opus-5-5" }];
      const result = await writeOpenClawAgent(
        makeCtx(),
        ada({ routines: [] }, { models, id: "" }),
        OPTS,
      );
      expect(result.items.approximated, runtime).toEqual([]);
      const configCalls = argsOf().filter((args) => args[0] === "config");
      expect(configCalls, runtime).toEqual([
        ["config", "set", "agents.entries.ada.model", "anthropic/claude-opus-5-5"],
        runtimeArgs(agent),
      ]);
    }
  });

  it("takes the runtime of the first preference, with or without a model", async () => {
    const models = [{ runtime: "codex" }, { provider: "openai", model: "gpt-5.5" }];
    await writeOpenClawAgent(makeCtx(), ada({}, { models }), OPTS);

    expect(argsOf().filter((args) => args[0] === "config")).toEqual([
      ["config", "set", "agents.entries.ada.model", "openai/gpt-5.5"],
      runtimeArgs("codex"),
    ]);
  });

  it("writes no runtime OpenClaw cannot run, and says so", async () => {
    const models = [{ runtime: "letta", provider: "anthropic", model: "claude-opus-5-5" }];
    const result = await writeOpenClawAgent(makeCtx(), ada({}, { models }), OPTS);

    expect(argsOf().filter((args) => args[0] === "config")).toEqual([
      ["config", "set", "agents.entries.ada.model", "anthropic/claude-opus-5-5"],
    ]);
    expect(result.items.approximated).toEqual([
      { field: "models", detail: "runtime 'letta' has no OpenClaw ACP agent; not set" },
    ]);
  });
});

describe("writeOpenClawAgent: config fallback", () => {
  it("rewrites openclaw.json once, with a backup, when `config set` is unknown", async () => {
    override = (args) => (args[0] === "config" ? unknownCommand() : undefined);
    const models = [{ runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" }];

    const result = await writeOpenClawAgent(makeCtx(), ada({}, { models }), OPTS);

    // Once the CLI says it has no `config set`, it is not asked again.
    expect(commands().filter((command) => command === "config set")).toHaveLength(1);
    expect(result.items.warnings).toEqual([REWRITE_WARNING]);
    expect(await text(join(stateDir, BACKUP_NAME))).toBe(CONFIG_SOURCE);
    const config = JSON5.parse(await text(join(stateDir, "openclaw.json")));
    expect(config).toEqual({
      agents: {
        entries: {
          ada: {
            model: "anthropic/claude-opus-5-5",
            runtime: { type: "acp", acp: { agent: "claude" } },
          },
        },
      },
    });
    // The rest of the move still ran.
    expect(commands().slice(-3)).toEqual([
      "automations add",
      "automations disable",
      "gateway status",
    ]);
  });

  it("keeps what the config already holds for the agent and the rest", async () => {
    await writeFile(
      join(stateDir, "openclaw.json"),
      '{ gateway: { port: 18789 }, agents: { entries: { ada: { workspace: "~/x" } } } }',
    );
    override = (args) => (args[0] === "config" ? unknownCommand() : undefined);
    // `ada` is in the config, so a copy is made; the new entry sits beside it.
    const result = await writeOpenClawAgent(makeCtx(), ada(), { ...OPTS, onConflict: "copy" });

    expect(result.targetAgentId).toBe("ada-2");
    expect(JSON5.parse(await text(join(stateDir, "openclaw.json")))).toEqual({
      gateway: { port: 18789 },
      agents: {
        entries: {
          ada: { workspace: "~/x" },
          "ada-2": { model: "anthropic/claude-opus-5-5" },
        },
      },
    });
  });

  it("throws on any other `config set` failure", async () => {
    override = (args) => (args[0] === "config" ? new Error("permission denied") : undefined);
    await expect(writeOpenClawAgent(makeCtx(), ada(), OPTS)).rejects.toThrow("permission denied");
  });
});

describe("writeOpenClawAgent: the config rewrite is atomic", () => {
  const configFile = () => join(stateDir, "openclaw.json");
  const noConfigSet = (args: string[]): Reply =>
    args[0] === "config" ? unknownCommand() : undefined;

  it("leaves the original intact and no temporary file when the rename fails", async () => {
    override = noConfigSet;
    renameControl.fail = true;

    const error = await writeOpenClawAgent(makeCtx(), ada(), OPTS).catch((e: unknown) => e);

    expect((error as Error).message).toBe(
      `agent 'ada' was created in ${join(stateDir, "workspace-ada")}; ` +
        "ENOSPC: no space left on device, rename",
    );
    expect(await text(configFile())).toBe(CONFIG_SOURCE);
    expect((await readdir(stateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await text(join(stateDir, BACKUP_NAME))).toBe(CONFIG_SOURCE);
  });

  it.skipIf(process.platform === "win32")("keeps the mode of openclaw.json", async () => {
    await chmod(configFile(), 0o640);
    override = noConfigSet;

    await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    expect((await stat(configFile())).mode & 0o777).toBe(0o640);
    expect(JSON5.parse(await text(configFile()))).toMatchObject({
      agents: { entries: { ada: { model: "anthropic/claude-opus-5-5" } } },
    });
  });

  it.skipIf(process.platform === "win32")("creates a missing config owner-only", async () => {
    await rm(configFile());
    override = noConfigSet;

    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
    // Nothing was there to lose, so neither a backup nor the warning.
    expect(result.items.warnings).toEqual([]);
    expect((await readdir(stateDir)).filter((name) => name.includes(".bak-"))).toEqual([]);
  });

  it.skipIf(!canSymlink)("keeps a symbolic-link openclaw.json a link", async () => {
    const real = join(scratch, "dotfiles", "openclaw.json5");
    await writeTree(scratch, { "dotfiles/openclaw.json5": CONFIG_SOURCE });
    await rm(configFile());
    await symlink(real, configFile(), "file");
    override = noConfigSet;

    await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    expect((await lstat(configFile())).isSymbolicLink()).toBe(true);
    expect(JSON5.parse(await text(real))).toMatchObject({
      agents: { entries: { ada: { model: "anthropic/claude-opus-5-5" } } },
    });
    expect(await text(join(stateDir, BACKUP_NAME))).toBe(CONFIG_SOURCE);
  });
});

describe("writeOpenClawAgent: conflicts", () => {
  /** An agent `ada` OpenClaw already has, with a workspace of its own. */
  async function existingAda(files: Record<string, string> = {}): Promise<string> {
    const ws = join(scratch, "their-ada");
    agentRows = [{ id: "ada", name: "Ada", workspace: ws }];
    await writeTree(ws, { "AGENTS.md": "Theirs.\n", ...files });
    return ws;
  }

  it("writes a copy, with a warning, beside an agent it did not write", async () => {
    const theirs = await existingAda();
    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    const ws = join(stateDir, "workspace-ada-2");
    expect(result.targetAgentId).toBe("ada-2");
    expect(result.artifactPath).toBe(ws);
    expect(result.items.warnings).toEqual(["agent 'ada' already exists; written as 'ada-2'"]);
    expect(argsOf()[1]).toEqual([
      "agents",
      "add",
      "ada-2",
      "--workspace",
      ws,
      "--non-interactive",
      "--json",
    ]);
    expect(argsOf()).toContainEqual(expect.arrayContaining(["--agent", "ada-2"]));
    expect(await text(join(ws, "AGENTS.md"))).toBe(ada().instructions);
    expect(await listFiles(theirs)).toEqual(["AGENTS.md"]);
    expect(await text(join(theirs, "AGENTS.md"))).toBe("Theirs.\n");
  });

  it("finds an agent the config knows and the CLI does not", async () => {
    await writeFile(
      join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { entries: { ada: {} } } }),
    );
    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);
    expect(result.targetAgentId).toBe("ada-2");
  });

  it("treats a marker of another agent like no marker", async () => {
    await existingAda({ ".openteleport.json": MARKER("01J9ZT3Z9K8QGQ2M6Q4Y3V6B2X") });
    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);
    expect(result.targetAgentId).toBe("ada-2");
  });

  it("does not take a leftover workspace for a new agent", async () => {
    await writeTree(join(stateDir, "workspace-ada"), { "AGENTS.md": "Left over.\n" });
    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    expect(result.targetAgentId).toBe("ada-2");
    expect(result.items.warnings).toEqual([
      `${join(stateDir, "workspace-ada")} already exists; written as 'ada-2'`,
    ]);
    expect(await text(join(stateDir, "workspace-ada", "AGENTS.md"))).toBe("Left over.\n");
  });

  it("copies without a warning when asked to, past every taken id", async () => {
    agentRows = [{ id: "ada" }, { id: "ada-2" }];
    const result = await writeOpenClawAgent(makeCtx(), ada(), { ...OPTS, onConflict: "copy" });

    expect(result.targetAgentId).toBe("ada-3");
    expect(result.items.warnings).toEqual([]);
  });

  it("keeps a copy's id within 32 characters", async () => {
    const name = "r".repeat(32);
    agentRows = [{ id: name }];
    const result = await writeOpenClawAgent(makeCtx(), ada({}, { name }), {
      ...OPTS,
      onConflict: "copy",
    });
    expect(result.targetAgentId).toBe(`${"r".repeat(30)}-2`);
  });

  it("updates in place when the workspace carries this agent's marker", async () => {
    const ws = await existingAda({ ".openteleport.json": MARKER(), "TOOLS.md": "Mine.\n" });
    jobs = [
      { id: "old-1", name: "Morning digest", agentId: "ada", disabled: true },
      { id: "other", name: "Evening digest", agentId: "ops" },
    ];
    const evening: Routine = { ...MORNING_DIGEST, name: "Evening digest" };

    const result = await writeOpenClawAgent(
      makeCtx(),
      ada({ routines: [MORNING_DIGEST, evening] }),
      OPTS,
    );

    expect(result.targetAgentId).toBe("ada");
    expect(result.artifactPath).toBe(ws);
    expect(result.items.warnings).toEqual([]);
    expect(commands()).not.toContain("agents add");
    expect(commands()).not.toContain("automations remove");
    expect(argsOf()[1]).toEqual(["automations", "list", "--all", "--json"]);
    // The job of the same name is kept, not doubled; the other agent's job does not count.
    expect(result.items.skipped).toEqual([
      {
        field: "routine:Morning digest",
        detail:
          "agent 'ada' already has an automation of this name; left as it is " +
          "(use --replace to recreate it)",
      },
    ]);
    expect(argsOf().filter((args) => args[1] === "add")).toEqual([
      expect.arrayContaining(["--name", "Evening digest", "--agent", "ada"]),
    ]);
    expect(await text(join(ws, "AGENTS.md"))).toBe(ada().instructions);
    expect(await text(join(ws, "TOOLS.md"))).toBe("Mine.\n");
    expect(await text(join(ws, ".openteleport.json"))).toBe(MARKER());
  });

  it("finds an existing agent's workspace in the config first", async () => {
    const ws = join(scratch, "configured-ws");
    await writeTree(ws, { ".openteleport.json": MARKER() });
    await writeFile(
      join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { entries: { ada: { workspace: ws } } } }),
    );
    agentRows = [{ id: "ada", workspace: join(scratch, "not-this") }];

    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    expect(result.artifactPath).toBe(ws);
    expect(await exists(join(ws, "AGENTS.md"))).toBe(true);
  });

  it("replaces: writes in place and recreates the agent's automations", async () => {
    const ws = await existingAda();
    jobs = [
      { id: "old-1", name: "Morning digest", agentId: "ada" },
      { id: "old-2", name: "Inbox sweep", agent: "ada", disabled: true },
      { id: "other", name: "Ops job", agentId: "ops" },
      { id: "main-1", name: "Main job" },
    ];

    const result = await writeOpenClawAgent(makeCtx(), ada(), { ...OPTS, onConflict: "replace" });

    expect(result.targetAgentId).toBe("ada");
    expect(result.artifactPath).toBe(ws);
    expect(result.items.warnings).toEqual([]);
    expect(commands()).toEqual([
      "agents list",
      "automations list",
      "agents set-identity",
      "config set",
      "automations remove",
      "automations remove",
      "automations add",
      "automations disable",
      "gateway status",
    ]);
    expect(argsOf().filter((args) => args[1] === "remove")).toEqual([
      ["automations", "remove", "old-1", "--json"],
      ["automations", "remove", "old-2", "--json"],
    ]);
    expect(await text(join(ws, "AGENTS.md"))).toBe(ada().instructions);
    expect(await text(join(ws, ".openteleport.json"))).toBe(MARKER());
  });

  it("writes nothing when the automations of an existing agent cannot be listed", async () => {
    const ws = await existingAda();
    override = (args) =>
      args[0] === "automations" && args[1] === "list" ? new Error("down") : undefined;

    await expect(
      writeOpenClawAgent(makeCtx(), ada(), { ...OPTS, onConflict: "replace" }),
    ).rejects.toThrow("down");
    expect(await listFiles(ws)).toEqual(["AGENTS.md"]);
  });
});

describe("writeOpenClawAgent: the Gateway", () => {
  it.each([[{ running: true }], [{ status: "running" }], [{ status: "Running" }]])(
    "asks for a restart when the Gateway reports %j",
    async (status) => {
      override = (args) => (args[0] === "gateway" ? JSON.stringify(status) : undefined);
      const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);
      expect(result.items.warnings).toEqual([RESTART_WARNING]);
    },
  );

  it.each([
    ["is stopped", JSON.stringify({ running: false, status: "stopped" })],
    ["prints no JSON", "Gateway: not running"],
    ["fails", new Error("unknown command 'gateway'")],
  ])("stays quiet when the status probe %s", async (_label, reply) => {
    override = (args) => (args[0] === "gateway" ? reply : undefined);
    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);
    expect(result.outcome).toBe("done");
    expect(result.items.warnings).toEqual([]);
  });
});

describe("OpenClawCli: the job command family", () => {
  const cli = () => new OpenClawCli(makeCtx(), stateDir, join(stateDir, "openclaw.json"));

  it("is cron when `automations` is an unknown command, probed once", async () => {
    override = cronFamily;
    const claw = cli();

    expect(await claw.jobCommand()).toBe("cron");
    expect(await claw.jobCommand()).toBe("cron");
    expect(argsOf()).toEqual([["automations", "list", "--all", "--json"]]);
  });

  it("is automations when the probe works, or fails for another reason", async () => {
    expect(await cli().jobCommand()).toBe("automations");
    override = (args) => (args[0] === "automations" ? gatewayDown(args) : undefined);
    expect(await cli().jobCommand()).toBe("automations");
  });

  it("lists jobs with the probe itself under automations", async () => {
    jobs = [{ id: "j1", name: "Digest", agentId: "ada" }];
    const claw = cli();

    expect(await claw.automationsList()).toMatchObject([{ id: "j1", name: "Digest" }]);
    expect(await claw.jobCommand()).toBe("automations");
    expect(argsOf()).toEqual([["automations", "list", "--all", "--json"]]);
  });

  it("drives the cron commands with the flags each one takes", async () => {
    override = cronFamily;
    jobs = [{ id: "j1", name: "Digest", agentId: "ada" }];
    const claw = cli();

    expect(await claw.automationsList()).toMatchObject([{ id: "j1" }]);
    expect(await claw.automationsAdd(["--name", "A"], { disabled: true })).toEqual({
      id: "job-1",
      disabled: true,
    });
    expect(await claw.automationsAdd(["--name", "B"], { disabled: false })).toEqual({
      id: "job-2",
      disabled: false,
    });
    await claw.automationsDisable("job-2");
    await claw.automationsRemove("j1");

    expect(argsOf()).toEqual([
      ["automations", "list", "--all", "--json"],
      ["cron", "list", "--all", "--json"],
      ["cron", "add", "--name", "A", "--disabled", "--json"],
      ["cron", "add", "--name", "B", "--json"],
      ["cron", "disable", "job-2"],
      ["cron", "rm", "j1", "--json"],
    ]);
  });

  it("cannot create an automations job disabled, and says so", async () => {
    expect(await cli().automationsAdd(["--name", "A"], { disabled: true })).toEqual({
      id: "job-1",
      disabled: false,
    });
    expect(argsOf()[1]).toEqual(["automations", "add", "--name", "A", "--json"]);
  });
});

describe("writeOpenClawAgent: the cron family (OpenClaw 2026.5)", () => {
  const cronAdd = (name: string, ...tail: string[]) => [
    "cron",
    "add",
    "--name",
    name,
    "--cron",
    "30 8 * * 1-5",
    "--tz",
    "Europe/Warsaw",
    "--agent",
    "ada",
    "--session",
    "isolated",
    ...tail,
    "--json",
    "--message",
    MORNING_DIGEST.instruction,
  ];

  it("creates the jobs disabled with `cron add --disabled`, with no disable call", async () => {
    override = cronFamily;
    const paused: Routine = { ...MORNING_DIGEST, name: "Paused", enabled: false };

    const result = await writeOpenClawAgent(
      makeCtx(),
      ada({ routines: [MORNING_DIGEST, paused] }),
      OPTS,
    );

    expect(result.items).toEqual({ approximated: [], skipped: [], warnings: [] });
    expect(argsOf().slice(4)).toEqual([
      ["automations", "list", "--all", "--json"],
      cronAdd("Morning digest", "--disabled"),
      cronAdd("Paused", "--disabled"),
      ["gateway", "status", "--json"],
    ]);
    expect(commands().filter((command) => command.endsWith(" disable"))).toEqual([]);
  });

  it("leaves a job enabled only with enableRoutines and an enabled routine", async () => {
    override = cronFamily;
    const paused: Routine = { ...MORNING_DIGEST, name: "Paused", enabled: false };

    await writeOpenClawAgent(makeCtx(), ada({ routines: [MORNING_DIGEST, paused] }), {
      ...OPTS,
      enableRoutines: true,
    });

    expect(argsOf().filter((args) => args[0] === "cron")).toEqual([
      cronAdd("Morning digest"),
      cronAdd("Paused", "--disabled"),
    ]);
  });

  it("replaces through cron list and cron rm", async () => {
    override = cronFamily;
    agentRows = [{ id: "ada", workspace: join(scratch, "their-ada") }];
    jobs = [
      { id: "old-1", name: "Morning digest", agentId: "ada" },
      { id: "other", name: "Ops job", agentId: "ops" },
    ];

    await writeOpenClawAgent(makeCtx(), ada(), { ...OPTS, onConflict: "replace" });

    expect(argsOf().filter((args) => args[0] === "automations" || args[0] === "cron")).toEqual([
      ["automations", "list", "--all", "--json"],
      ["cron", "list", "--all", "--json"],
      ["cron", "rm", "old-1", "--json"],
      cronAdd("Morning digest", "--disabled"),
    ]);
  });

  it("says once how to start the Gateway when it refuses the jobs", async () => {
    override = (args) => (args[0] === "cron" ? gatewayDown(args) : cronFamily(args));
    const evening: Routine = { ...MORNING_DIGEST, name: "Evening digest" };

    const result = await writeOpenClawAgent(
      makeCtx(),
      ada({ routines: [MORNING_DIGEST, evening] }),
      OPTS,
    );

    const detail =
      "not created: Error: gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED)";
    expect(result.items.skipped).toEqual([
      { field: "routine:Morning digest", detail },
      { field: "routine:Evening digest", detail },
    ]);
    expect(result.items.warnings).toEqual([GATEWAY_WARNING]);
  });

  it("does not blame the Gateway for a routine whose own text names it", async () => {
    const routine: Routine = { ...MORNING_DIGEST, instruction: "Check the gateway logs." };
    override = (args) =>
      args[0] === "cron" && args[1] === "add"
        ? Object.assign(new Error(`Command failed: openclaw ${args.join(" ")}`), {
            stderr: "error: invalid cron expression",
          })
        : cronFamily(args);

    const result = await writeOpenClawAgent(makeCtx(), ada({ routines: [routine] }), OPTS);

    expect(result.items.skipped).toEqual([
      { field: "routine:Morning digest", detail: "not created: error: invalid cron expression" },
    ]);
    expect(result.items.warnings).toEqual([]);
  });

  it("replaces the rest without the Gateway, with one warning, when it cannot list", async () => {
    const ws = join(scratch, "their-ada");
    await writeTree(ws, { "AGENTS.md": "Theirs.\n" });
    agentRows = [{ id: "ada", workspace: ws }];
    override = (args) => (args[0] === "cron" ? gatewayDown(args) : cronFamily(args));

    const result = await writeOpenClawAgent(makeCtx(), ada(), { ...OPTS, onConflict: "replace" });

    expect(result.targetAgentId).toBe("ada");
    expect(result.items.warnings).toEqual([GATEWAY_WARNING]);
    expect(result.items.skipped).toEqual([
      {
        field: "routine:Morning digest",
        detail: "not created: Error: gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED)",
      },
    ]);
    // Nothing to remove without a listing; the workspace and the identity are still written.
    expect(commands()).not.toContain("cron rm");
    expect(commands()).toContain("agents set-identity");
    expect(await text(join(ws, "AGENTS.md"))).toBe(ada().instructions);
  });

  it("stops removing old jobs, with the warning, when the Gateway goes away", async () => {
    const ws = join(scratch, "their-ada");
    agentRows = [{ id: "ada", workspace: ws }];
    jobs = [
      { id: "old-1", name: "Morning digest", agentId: "ada" },
      { id: "old-2", name: "Inbox sweep", agentId: "ada" },
    ];
    override = (args) =>
      args[0] === "cron" && (args[1] === "rm" || args[1] === "add")
        ? gatewayDown(args)
        : cronFamily(args);

    const result = await writeOpenClawAgent(makeCtx(), ada(), { ...OPTS, onConflict: "replace" });

    expect(argsOf().filter((args) => args[1] === "rm")).toEqual([
      ["cron", "rm", "old-1", "--json"],
    ]);
    expect(result.items.warnings).toEqual([GATEWAY_WARNING]);
    expect(await text(join(ws, ".openteleport.json"))).toBe(MARKER());
  });

  it("updates without leaving out routines when the Gateway cannot list the jobs", async () => {
    const ws = join(scratch, "their-ada");
    await writeTree(ws, { ".openteleport.json": MARKER() });
    agentRows = [{ id: "ada", workspace: ws }];
    jobs = [{ id: "old-1", name: "Morning digest", agentId: "ada" }];
    override = (args) =>
      args[0] === "cron" && args[1] === "list" ? gatewayDown(args) : cronFamily(args);

    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    // The job of the same name could not be seen, so the routine is added, not left out.
    expect(result.items.skipped).toEqual([]);
    expect(result.items.warnings).toEqual([GATEWAY_WARNING]);
    expect(argsOf().filter((args) => args[1] === "add" && args[0] === "cron")).toEqual([
      cronAdd("Morning digest", "--disabled"),
    ]);
  });

  it("still throws a listing failure that is not the Gateway's, before writing", async () => {
    const ws = join(scratch, "their-ada");
    await writeTree(ws, { "AGENTS.md": "Theirs.\n" });
    agentRows = [{ id: "ada", workspace: ws }];
    override = (args) =>
      args[0] === "cron" && args[1] === "list" ? new Error("database is locked") : cronFamily(args);

    await expect(
      writeOpenClawAgent(makeCtx(), ada(), { ...OPTS, onConflict: "replace" }),
    ).rejects.toThrow("database is locked");
    expect(await listFiles(ws)).toEqual(["AGENTS.md"]);
  });

  it("lists no jobs for an update without routines", async () => {
    const ws = join(scratch, "their-ada");
    await writeTree(ws, { ".openteleport.json": MARKER() });
    agentRows = [{ id: "ada", workspace: ws }];
    override = cronFamily;

    await writeOpenClawAgent(makeCtx(), ada({ routines: [] }), OPTS);

    expect(commands().filter((command) => command.endsWith(" list"))).toEqual(["agents list"]);
  });
});

describe("writeOpenClawAgent: safety", () => {
  it("refuses a bundle with a secret before running or writing anything", async () => {
    const bundle = ada({
      instructions: `Use the key sk-ant-${"a".repeat(30)} for the API.\n`,
    });

    const error = await writeOpenClawAgent(makeCtx(), bundle, OPTS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretsFoundError);
    expect((error as SecretsFoundError).findings).toMatchObject([
      { path: "AGENTS.md", line: 1, kind: "anthropic-api-key" },
    ]);
    expect(calls).toEqual([]);
    expect(await listFiles(stateDir)).toEqual(["openclaw.json"]);
  });

  it("does not mutate the bundle", async () => {
    const bundle = ada({}, { description: "Reads papers." });
    const before = structuredClone(bundle);
    await writeOpenClawAgent(makeCtx(), bundle, { ...OPTS, enableRoutines: true });
    expect(bundle).toEqual(before);
  });

  it("skips unsafe skill, note and avatar paths and writes the rest", async () => {
    const bundle = ada({
      skills: [
        {
          name: "web-brief",
          files: [
            { path: "SKILL.md", bytes: encode("# Web brief\n") },
            { path: "../../escape.md", bytes: encode("out") },
            { path: "con/x.md", bytes: encode("device") },
          ],
        },
        { name: "../evil", files: [{ path: "SKILL.md", bytes: encode("evil") }] },
      ],
      notes: [
        { name: "ok", text: "fine" },
        { name: "../../outside", text: "out" },
      ],
      avatar: { name: "../avatar.png", bytes: PNG },
    });

    const result = await writeOpenClawAgent(makeCtx(), bundle, OPTS);

    const ws = join(stateDir, "workspace-ada");
    expect(result.items.skipped).toEqual([
      { field: "note:../../outside", detail: "unsafe name; not written" },
      { field: "skill:web-brief", detail: "unsafe path '../../escape.md'; not written" },
      { field: "skill:web-brief", detail: "unsafe path 'con/x.md'; not written" },
      { field: "skill:../evil", detail: "unsafe name; not written" },
      { field: "avatar", detail: "unsafe name '../avatar.png'; not written" },
    ]);
    expect(await listFiles(scratch)).toEqual([
        "state/openclaw.json",
        "state/workspace-ada/.openteleport.json",
        "state/workspace-ada/AGENTS.md",
        "state/workspace-ada/IDENTITY.md",
        "state/workspace-ada/MEMORY.md",
        "state/workspace-ada/SOUL.md",
        "state/workspace-ada/memory/ok.md",
        "state/workspace-ada/skills/web-brief/SKILL.md",
    ]);
    // Without the avatar file there is no avatar to name.
    expect(await text(join(ws, "IDENTITY.md"))).not.toContain("Avatar");
    expect(argsOf()[2]).not.toContain("--avatar");
  });

  it.skipIf(!canSymlink)("never writes through a symbolic link in the workspace", async () => {
    const ws = join(scratch, "their-ada");
    const outside = join(scratch, "outside");
    await writeTree(outside, { "soul.md": "Not yours.\n", "skills/keep.md": "Keep.\n" });
    await writeTree(ws, { ".openteleport.json": MARKER() });
    await symlink(join(outside, "soul.md"), join(ws, "SOUL.md"), "file");
    await symlink(join(outside, "skills"), join(ws, "skills"), "dir");
    agentRows = [{ id: "ada", workspace: ws }];

    const result = await writeOpenClawAgent(makeCtx(), ada(), OPTS);

    expect(result.items.skipped).toEqual([
      { field: "persona", detail: "SOUL.md is a symbolic link; not written" },
      {
        field: "skill:web-brief",
        detail: "skills/web-brief/SKILL.md is behind the symbolic link skills; not written",
      },
      {
        field: "skill:web-brief",
        detail:
          "skills/web-brief/templates/brief.md is behind the symbolic link skills; not written",
      },
    ]);
    expect(await text(join(outside, "soul.md"))).toBe("Not yours.\n");
    expect(await listFiles(outside)).toEqual(["skills/keep.md", "soul.md"]);
    expect(await text(join(ws, "AGENTS.md"))).toBe(ada().instructions);
  });
});

/** An npm `cmd-shim` for `openclaw`, as `npm install -g openclaw` writes it on Windows. */
const NPM_SHIM = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\openclaw\openclaw.mjs" %*
`;

describe("OpenClawCli: starting openclaw on Windows", () => {
  /** A PATH directory holding `files`, with the package script the npm shim names. */
  async function binDir(files: Record<string, string>): Promise<{ dir: string; target: string }> {
    const dir = join(scratch, "npm-bin");
    await writeTree(dir, { "node_modules/openclaw/openclaw.mjs": "// OpenClaw\n", ...files });
    return { dir, target: join(dir, "node_modules", "openclaw", "openclaw.mjs") };
  }

  it("runs the script of an npm shim with this node, not through cmd.exe", async () => {
    const { dir, target } = await binDir({ "openclaw.cmd": NPM_SHIM });
    // Windows spells it `Path`; the lookup ignores case.
    const env = { Path: `${join(scratch, "nothing-here")};${dir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

    expect(await resolveOpenClawCommand(env, "win32")).toEqual({
      file: process.execPath,
      prefix: [target],
      viaShell: false,
    });

    const cli = new OpenClawCli(makeCtx({ env }), stateDir, join(stateDir, "openclaw.json"), {
      platform: "win32",
    });
    await cli.agentsList();
    expect(calls).toEqual([
      {
        file: process.execPath,
        args: [target, "agents", "list", "--json"],
        env: expect.objectContaining({ OPENCLAW_STATE_DIR: stateDir }),
      },
    ]);
    expect(await cli.command()).toBe(await cli.command());
  });

  it("runs an openclaw.exe as it is, ahead of a shim beside it", async () => {
    const { dir } = await binDir({ "openclaw.exe": "", "openclaw.cmd": NPM_SHIM });
    expect(await resolveOpenClawCommand({ PATH: dir }, "win32")).toEqual({
      file: join(dir, "openclaw.exe"),
      prefix: [],
      viaShell: false,
    });
  });

  it("falls back to the shim, through cmd.exe, when it names no script", async () => {
    const shim = "@ECHO off\r\nnode C:\\elsewhere\\x.js %*\r\n";
    const { dir } = await binDir({ "openclaw.cmd": shim });
    const shell = { file: "openclaw", prefix: [], viaShell: true };
    expect(await resolveOpenClawCommand({ PATH: dir }, "win32")).toEqual(shell);
    expect(await resolveOpenClawCommand({ PATH: join(scratch, "nothing-here") }, "win32")).toEqual(
      shell,
    );
    expect(await resolveOpenClawCommand({}, "linux")).toEqual({ ...shell, viaShell: false });
  });

  it("refuses a line break that would pass through cmd.exe, running nothing", async () => {
    const cli = new OpenClawCli(makeCtx({ env: {} }), stateDir, join(stateDir, "openclaw.json"), {
      platform: "win32",
    });
    await cli.jobCommand();
    calls = [];

    await expect(cli.automationsAdd(["--message", "Line one.\nLine two."])).rejects.toBeInstanceOf(
      ShimLineBreakError,
    );
    expect(calls).toEqual([]);
  });

  it("skips a multi-line routine instead of letting cmd.exe cut it", async () => {
    pretendPlatform("win32");
    const multiLine: Routine = { ...MORNING_DIGEST, instruction: "Read the mail.\nThen reply." };
    const single: Routine = { ...MORNING_DIGEST, name: "Evening digest" };

    const result = await writeOpenClawAgent(
      makeCtx({ env: { PATH: join(scratch, "nothing-here") } }),
      ada({ routines: [multiLine, single] }),
      OPTS,
    );

    expect(result.items.skipped).toEqual([
      {
        field: "routine:Morning digest",
        detail: "multi-line instructions cannot be passed through the Windows shim",
      },
    ]);
    expect(argsOf().filter((args) => args[0] === "automations" && args[1] === "add")).toEqual([
      expect.arrayContaining(["--name", "Evening digest"]),
    ]);
  });

  it("passes a multi-line routine whole when node runs the shim's script", async () => {
    pretendPlatform("win32");
    const { dir, target } = await binDir({ "openclaw.cmd": NPM_SHIM });
    const multiLine: Routine = { ...MORNING_DIGEST, instruction: "Read the mail.\nThen reply." };

    const result = await writeOpenClawAgent(
      makeCtx({ env: { PATH: dir } }),
      ada({ routines: [multiLine] }),
      OPTS,
    );

    expect(result.items.skipped).toEqual([]);
    expect(calls.every((call) => call.file === process.execPath && call.args[0] === target)).toBe(
      true,
    );
    const add = argsOf().find((args) => args[1] === "automations" && args[2] === "add");
    expect(add?.slice(-2)).toEqual(["--message", "Read the mail.\nThen reply."]);
  });
});

describe("writeOpenClawAgent: failures and capabilities", () => {
  const identityFails = (args: string[]): Reply =>
    args[1] === "set-identity" ? new Error("identity store locked") : undefined;

  it("says where a new agent was created when a later step fails", async () => {
    override = identityFails;

    await expect(writeOpenClawAgent(makeCtx(), ada(), OPTS)).rejects.toThrow(
      `agent 'ada' was created in ${join(stateDir, "workspace-ada")}; identity store locked`,
    );
  });

  it("rethrows a failure over an existing agent as it is", async () => {
    const ws = join(scratch, "their-ada");
    await writeTree(ws, { ".openteleport.json": MARKER() });
    agentRows = [{ id: "ada", workspace: ws }];
    override = identityFails;

    await expect(writeOpenClawAgent(makeCtx(), ada(), OPTS)).rejects.toThrow(
      /^identity store locked$/,
    );
  });

  it("reports declared capabilities as approximated, and nothing without any", async () => {
    const declared = await writeOpenClawAgent(
      makeCtx(),
      ada({}, { capabilities: ["shell"] }),
      OPTS,
    );
    expect(declared.items.approximated).toEqual([CAPABILITIES_ITEM]);

    await rm(join(stateDir, "workspace-ada"), { recursive: true, force: true });
    const none = await writeOpenClawAgent(makeCtx(), ada(), OPTS);
    expect(none.items.approximated).toEqual([]);
  });
});

describe("writeOpenClawAgent: round trip", () => {
  it("writes what readOpenClawAgent reads back", async () => {
    // An OpenClaw that keeps what it is told: `agents add` records the agent and its workspace
    // in the config, jobs are listed back as added and disabled, and `config set` is missing,
    // so model and runtime reach the config through the rewrite.
    override = (args) => {
      const command = args.slice(0, 2).join(" ");
      if (command === "config set") return unknownCommand();
      if (command === "agents add") {
        const config = { agents: { entries: { [args[2] ?? ""]: { workspace: args[4] } } } };
        writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify(config));
        return JSON.stringify({ id: args[2] });
      }
      if (command === "automations add") {
        const flag = (name: string) => args[args.indexOf(name) + 1];
        jobCounter += 1;
        const id = `job-${jobCounter}`;
        jobs.push({
          id,
          name: flag("--name"),
          agentId: flag("--agent"),
          disabled: false,
          schedule: { kind: "cron", expr: flag("--cron"), tz: flag("--tz") },
          payload: { kind: "agentTurn", message: flag("--message") },
        });
        return JSON.stringify({ id });
      }
      if (command === "automations disable") {
        const job = jobs.find((row) => (row as { id: string }).id === args[2]);
        Object.assign(job as object, { disabled: true });
        return "{}";
      }
      return undefined;
    };
    const models = [{ runtime: "claude", provider: "anthropic", model: "claude-opus-5-5" }];
    const written = ada({}, { models });

    await writeOpenClawAgent(makeCtx(), written, OPTS);
    const { bundle, warnings } = await readOpenClawAgent(
      makeCtx({ targetDir: undefined, sourceDir: stateDir }),
      "ada",
    );

    expect(warnings).toEqual([
      "capabilities are assumed; OpenClaw does not declare them per agent",
    ]);
    expect(bundle).toEqual({
      ...written,
      manifest: {
        schemaVersion: "0.1",
        id: "",
        name: "Ada",
        title: "Research assistant",
        models,
        capabilities: ["browser", "shell", "filesystem", "network", "scheduler"],
        origin: { app: "openclaw", exportedAt: NOW.toISOString() },
        "x-openclaw": {
          identity: {
            name: "Ada",
            theme: "Research assistant",
            emoji: "🔎",
            avatar: "avatars/avatar.png",
          },
        },
      },
      // Routines arrive disabled; notes come back sorted by name.
      routines: [{ ...MORNING_DIGEST, enabled: false }],
      notes: [...written.notes].sort((a, b) => (a.name < b.name ? -1 : 1)),
    });
  });
});

describe("openclawAdapter.write", () => {
  it("is writeOpenClawAgent", async () => {
    const result = await openclawAdapter.write(makeCtx(), ada(), OPTS);
    expect(result.outcome).toBe("done");
    expect(result.targetAgentId).toBe("ada");
    expect(await exists(join(stateDir, "workspace-ada", "AGENTS.md"))).toBe(true);
  });
});
