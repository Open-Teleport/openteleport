import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexCacheIdentity,
  detectCodex,
  listCodexAgents,
  parseAgentToml,
  readCodexAgent,
} from "../../../src/adapters/codex/read.js";
import type { Ctx } from "../../../src/adapters/types.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/codex", import.meta.url));

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

const ADA_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
const decoder = new TextDecoder();

let root: string;
let home: string;
let codex: string;
let ctx: Ctx;
let logs: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-codex-read-"));
  home = join(root, "home");
  codex = join(home, ".codex");
  await cp(join(FIXTURES, "home"), home, { recursive: true });
  // The fixture is meant to have Windows line endings; a checkout may have changed them.
  const instructions = join(codex, "AGENTS.md");
  const text = await readFile(instructions, "utf8");
  await writeFile(instructions, text.replace(/\r?\n/g, "\r\n"));
  logs = [];
  ctx = {
    sourceDir: codex,
    home,
    cwd: root,
    env: {},
    exec: noExec,
    logger: (message) => logs.push(message),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file below `dir` with its content, keyed by `/`-separated relative path. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path).split("\\").join("/")] = await readFile(path, "utf8");
  }
  return out;
}

const text = (bytes: Uint8Array | undefined): string => decoder.decode(bytes ?? new Uint8Array());

describe("list", () => {
  it("lists the global setup, then every agent file", async () => {
    const agents = await listCodexAgents(ctx);

    expect(agents).toEqual([
      { id: "default", name: "Codex (global)", location: codex },
      {
        id: "reviewer",
        name: "reviewer",
        title: "Reviews a diff for bugs and style, read-only.",
        location: join(codex, "agents", "reviewer.toml"),
      },
    ]);
  });

  it("lists agent files in name order and names an agent by its name field", async () => {
    const dir = join(codex, "agents");
    const body = 'description = "d"\ndeveloper_instructions = "x"\n';
    await writeFile(join(dir, "zeta.toml"), `name = "Zeta"\n${body}`);
    await writeFile(join(dir, "alpha.toml"), `name = "Alpha Agent"\n${body}`);
    await writeFile(join(dir, "nameless.toml"), body);
    await writeFile(join(dir, "notes.txt"), "not an agent");

    const agents = await listCodexAgents(ctx);

    expect(agents.map(({ id, name }) => [id, name])).toEqual([
      ["default", "Codex (global)"],
      ["alpha", "Alpha Agent"],
      ["nameless", "nameless"],
      ["reviewer", "reviewer"],
      ["zeta", "Zeta"],
    ]);
  });

  it("lists only the global setup when there is no agents folder", async () => {
    await rm(join(codex, "agents"), { recursive: true });

    expect((await listCodexAgents(ctx)).map(({ id }) => id)).toEqual(["default"]);
  });

  it("skips a file that is not valid TOML and says so", async () => {
    await writeFile(join(codex, "agents", "broken.toml"), 'name = "Broken\ndescription =\n');

    const agents = await listCodexAgents(ctx);

    expect(agents.map(({ id }) => id)).toEqual(["default", "reviewer"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("broken.toml");
  });

  it("does not list an agent file that is a link, and says so", async (context) => {
    const outside = join(root, "outside.toml");
    await writeFile(outside, 'name = "Out"\ndescription = "d"\ndeveloper_instructions = "x"\n');
    try {
      await symlink(outside, join(codex, "agents", "linked.toml"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
      throw error;
    }

    expect((await listCodexAgents(ctx)).map(({ id }) => id)).toEqual(["default", "reviewer"]);
    expect(logs.join("\n")).toContain("linked.toml");
  });

  it("does not list a file called default.toml, which the global setup already holds", async () => {
    await writeFile(join(codex, "agents", "default.toml"), 'name = "x"\n');

    expect((await listCodexAgents(ctx)).map(({ id }) => id)).toEqual(["default", "reviewer"]);
    expect(logs.join("\n")).toContain("default.toml");
  });

  it("reads CODEX_HOME from the environment of the context", async () => {
    const { sourceDir: _sourceDir, ...rest } = ctx;

    const agents = await listCodexAgents({ ...rest, env: { CODEX_HOME: codex } });

    expect(agents.map(({ id }) => id)).toEqual(["default", "reviewer"]);
  });
});

describe("read default", () => {
  it("splits persona and instructions in a file with Windows line endings", async () => {
    expect(await readFile(join(codex, "AGENTS.md"), "utf8")).toContain("\r\n");

    const { bundle } = await readCodexAgent(ctx, "default");

    expect(bundle.persona).toBe(
      "Rowan is a careful, dry-humoured pair programmer. He keeps answers short and says when he is guessing.",
    );
    expect(bundle.instructions).toBe(
      [
        "- Read the code before you change it.",
        "- Run the tests before you say a change is done.",
        "- Never push unless you are asked to.",
      ].join("\n"),
    );
  });

  it("splits a file that starts with a byte order mark", async () => {
    const path = join(codex, "AGENTS.md");
    const byteOrderMark = String.fromCharCode(0xfeff);
    await writeFile(path, `${byteOrderMark}${await readFile(path, "utf8")}`);

    const { bundle } = await readCodexAgent(ctx, "default");

    expect(bundle.persona).toMatch(/^Rowan is/);
    expect(bundle.instructions).toMatch(/^- Read the code/);
  });

  it("reads the manifest, models, vendor settings and memory", async () => {
    const { bundle, warnings } = await readCodexAgent(ctx, "default");

    expect(bundle.manifest).toMatchObject({
      schemaVersion: "0.1",
      id: "",
      name: "Codex",
      models: [{ model: "gpt-5.5" }],
      capabilities: [],
      origin: { app: "codex" },
    });
    expect(bundle.manifest["x-codex"]).toEqual({
      reasoningEffort: "high",
      approvalPolicy: "on-request",
    });
    expect(bundle.routines).toEqual([]);
    expect(bundle.facts).toEqual([]);
    expect(bundle.files).toEqual([]);
    expect(bundle.notes).toEqual([
      {
        name: "codex-memory",
        text: await readFile(join(codex, "memories", "MEMORY.md"), "utf8"),
      },
    ]);
    expect(warnings).toContain("Codex memory is machine-generated; carried as a note");
  });

  it("reads the skills of both folders, the user folder winning a name clash", async () => {
    const { bundle, warnings } = await readCodexAgent(ctx, "default");

    expect(bundle.skills.map((skill) => skill.name)).toEqual(["new", "old"]);
    const old = bundle.skills.find((skill) => skill.name === "old");
    expect(old?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(text(old?.files[0]?.bytes)).toContain("kept in ~/.agents/skills");
    expect(warnings).toContain(
      "skill 'old' is in both ~/.agents/skills and the deprecated skills folder; exported the one in ~/.agents/skills",
    );
  });

  it("reads a skill that only the deprecated folder has", async () => {
    await mkdir(join(codex, "skills", "legacy-only"));
    await writeFile(join(codex, "skills", "legacy-only", "SKILL.md"), "# Legacy only\n");

    const { bundle, warnings } = await readCodexAgent(ctx, "default");

    expect(bundle.skills.map((skill) => skill.name)).toEqual(["legacy-only", "new", "old"]);
    expect(warnings.filter((warning) => warning.includes("legacy-only"))).toEqual([]);
  });

  it("leaves hidden folders, such as the bundled .system skills, alone", async () => {
    await mkdir(join(codex, "skills", ".system", "imagegen"), { recursive: true });
    await writeFile(join(codex, "skills", ".system", "imagegen", "SKILL.md"), "# Bundled\n");

    const { bundle, warnings } = await readCodexAgent(ctx, "default");

    expect(bundle.skills.map((skill) => skill.name)).toEqual(["new", "old"]);
    expect(warnings.join("\n")).not.toContain(".system");
  });

  it("does not follow a linked skill folder and says so", async () => {
    const outside = join(root, "outside-skill");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "# Linked\n");
    await symlink(outside, join(home, ".agents", "skills", "linked"), "junction");

    const { bundle, warnings } = await readCodexAgent(ctx, "default");

    expect(bundle.skills.map((skill) => skill.name)).toEqual(["new", "old"]);
    expect(warnings).toContain("skill 'linked' is a symlink; not exported");
  });

  it("keeps the other files of a skill and leaves out what never goes into an archive", async () => {
    const skill = join(home, ".agents", "skills", "new");
    await mkdir(join(skill, "scripts"));
    await writeFile(join(skill, "scripts", "run.sh"), "echo hi\n");
    await writeFile(join(skill, ".env"), "TOKEN=secret\n");

    const { bundle, warnings } = await readCodexAgent(ctx, "default");

    const files = bundle.skills.find((entry) => entry.name === "new")?.files.map((f) => f.path);
    expect(files).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(warnings).toContain("skill 'new': left out '.env'");
  });

  it("prefers a non-empty AGENTS.override.md", async () => {
    await writeFile(join(codex, "AGENTS.override.md"), "Use the override.\n");

    const { bundle } = await readCodexAgent(ctx, "default");

    expect(bundle.instructions).toBe("Use the override.\n");
    expect(bundle.persona).toBeUndefined();
  });

  it("falls back to AGENTS.md when AGENTS.override.md is empty", async () => {
    await writeFile(join(codex, "AGENTS.override.md"), "  \r\n\n");

    const { bundle } = await readCodexAgent(ctx, "default");

    expect(bundle.persona).toMatch(/^Rowan is/);
    expect(bundle.instructions).toContain("Read the code before you change it.");
  });

  it("takes a file in another layout as instructions only", async () => {
    await writeFile(join(codex, "AGENTS.md"), "# Rules\r\n\r\nBe brief.\r\n");

    const { bundle } = await readCodexAgent(ctx, "default");

    expect(bundle.persona).toBeUndefined();
    expect(bundle.instructions).toBe("# Rules\n\nBe brief.\n");
  });

  it("reads a Codex home with nothing in it as an empty agent", async () => {
    const empty = join(root, "empty-codex");
    await mkdir(empty);

    const { bundle, warnings } = await readCodexAgent(
      { ...ctx, home: join(root, "no-home"), sourceDir: empty },
      "default",
    );

    expect(bundle.instructions).toBe("");
    expect(bundle.persona).toBeUndefined();
    expect(bundle.skills).toEqual([]);
    expect(bundle.notes).toEqual([]);
    expect(bundle.manifest.models).toEqual([]);
    expect(bundle.manifest["x-codex"]).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("reads the provider and the sandbox mode of config.toml too", async () => {
    await writeFile(
      join(codex, "config.toml"),
      'model = "gpt-5.5"\nmodel_provider = "azure"\nsandbox_mode = "workspace-write"\n',
    );

    const { bundle } = await readCodexAgent(ctx, "default");

    expect(bundle.manifest.models).toEqual([{ provider: "azure", model: "gpt-5.5" }]);
    expect(bundle.manifest["x-codex"]).toEqual({ sandboxMode: "workspace-write" });
  });

  it("goes on without model settings when config.toml is not valid TOML", async () => {
    await writeFile(join(codex, "config.toml"), 'model = "gpt-5.5\n');

    const { bundle, warnings } = await readCodexAgent(ctx, "default");

    expect(bundle.manifest.models).toEqual([]);
    expect(bundle.persona).toMatch(/^Rowan is/);
    expect(warnings.some((warning) => warning.startsWith("config.toml is not valid TOML"))).toBe(
      true,
    );
  });

  it("refuses a text file over the 2 MiB limit", async () => {
    await writeFile(join(codex, "AGENTS.md"), "x".repeat(2 * 1024 * 1024 + 1));

    await expect(readCodexAgent(ctx, "default")).rejects.toThrow(/AGENTS\.md.*2097152/);
  });

  it("never records the global setup under an id", async () => {
    await writeFile(join(codex, "openteleport-ids.json"), JSON.stringify({ default: ADA_ID }));

    expect((await readCodexAgent(ctx, "default")).bundle.manifest.id).toBe("");
  });
});

describe("read an agent file", () => {
  it("takes the instructions from developer_instructions", async () => {
    const { bundle, warnings } = await readCodexAgent(ctx, "reviewer");

    expect(bundle.persona).toBeUndefined();
    expect(bundle.instructions).toBe(
      [
        "Review the change you are given.",
        "Report bugs first, then style, each with the file and the line.",
        "Never edit files.",
        "",
      ].join("\n"),
    );
    expect(bundle.skills).toEqual([]);
    expect(bundle.notes).toEqual([]);
    expect(bundle.facts).toEqual([]);
    expect(bundle.routines).toEqual([]);
    expect(bundle.manifest).toMatchObject({
      name: "reviewer",
      title: "Reviews a diff for bugs and style, read-only.",
      models: [{ model: "gpt-5.5-mini" }],
    });
    expect(bundle.manifest["x-codex"]).toEqual({ nickname_candidates: ["Atlas", "Delta"] });
    expect(warnings).toEqual([]);
  });

  it("splits a developer_instructions in the persona layout", async () => {
    const instructions = "# Persona\n\nDry and exact.\n\n# Instructions\n\nCheck the diff.\n";
    await writeFile(
      join(codex, "agents", "layered.toml"),
      `name = "Layered"\ndescription = "d"\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`,
    );

    const { bundle } = await readCodexAgent(ctx, "layered");

    expect(bundle.persona).toBe("Dry and exact.");
    expect(bundle.instructions).toBe("Check the diff.");
  });

  it("reads the reasoning effort and the skills config, and names what it leaves out", async () => {
    await writeFile(
      join(codex, "agents", "tuned.toml"),
      [
        'name = "Tuned"',
        'description = "d"',
        'developer_instructions = "Be exact."',
        'model_reasoning_effort = "low"',
        'model_verbosity = "high"',
        "",
        "[features]",
        "memories = true",
        "",
        "[skills]",
        "include_instructions = false",
        "",
        "[[skills.config]]",
        'path = "/skills/web-brief"',
        "enabled = false",
        "",
      ].join("\n"),
    );

    const { bundle, warnings } = await readCodexAgent(ctx, "tuned");

    expect(bundle.manifest["x-codex"]).toEqual({
      reasoningEffort: "low",
      skillsConfig: [{ path: "/skills/web-brief", enabled: false }],
    });
    expect(warnings).toEqual([
      "agent file settings not exported: model_verbosity, features, skills.include_instructions",
    ]);
  });

  it("keeps a description the title had to cut", async () => {
    const description = "a".repeat(130);
    await writeFile(
      join(codex, "agents", "wordy.toml"),
      `name = "Wordy"\ndescription = "${description}"\ndeveloper_instructions = "x"\n`,
    );

    const { bundle } = await readCodexAgent(ctx, "wordy");

    expect(bundle.manifest.title).toBe(`${"a".repeat(119)}…`);
    expect(bundle.manifest.description).toBe(description);
  });

  it("warns about an agent file without developer_instructions", async () => {
    await writeFile(join(codex, "agents", "empty.toml"), 'name = "Empty"\ndescription = "d"\n');

    const { bundle, warnings } = await readCodexAgent(ctx, "empty");

    expect(bundle.instructions).toBe("");
    expect(warnings).toContain("agents/empty.toml has no developer_instructions");
  });

  it("returns the id an earlier move recorded for the file", async () => {
    await writeFile(join(codex, "openteleport-ids.json"), JSON.stringify({ reviewer: ADA_ID }));

    expect((await readCodexAgent(ctx, "reviewer")).bundle.manifest.id).toBe(ADA_ID);
  });

  it("ignores a recorded id that is not a ULID, and a map that cannot be read", async () => {
    await writeFile(join(codex, "openteleport-ids.json"), JSON.stringify({ reviewer: "nope" }));
    expect((await readCodexAgent(ctx, "reviewer")).bundle.manifest.id).toBe("");

    await writeFile(join(codex, "openteleport-ids.json"), "not json");
    expect((await readCodexAgent(ctx, "reviewer")).bundle.manifest.id).toBe("");
  });

  it("names the file when it is not valid TOML", async () => {
    await writeFile(join(codex, "agents", "broken.toml"), 'name = "Broken\ndescription =\n');

    await expect(readCodexAgent(ctx, "broken")).rejects.toThrow(/broken\.toml/);
  });

  it("names the agents there are when asked for one that is not", async () => {
    await expect(readCodexAgent(ctx, "ghost")).rejects.toThrow(
      'Codex has no agent "ghost". Available: default, reviewer',
    );
  });

  it("cannot be led outside the agents folder", async () => {
    await writeFile(join(root, "escape.toml"), 'name = "x"\n');

    await expect(readCodexAgent(ctx, "../../escape")).rejects.toThrow(/Codex has no agent/);
  });
});

describe("parseAgentToml", () => {
  it("returns the agent fields and keeps every other key apart", () => {
    const { agent, rest } = parseAgentToml(
      [
        'name = "Ada"',
        'description = "Reads."',
        'developer_instructions = "Be brief."',
        'model = "gpt-5.5"',
        'model_reasoning_effort = "medium"',
        'nickname_candidates = ["Ad", "Lovelace"]',
        'sandbox_mode = "read-only"',
        "",
        "[features]",
        "memories = true",
        "",
      ].join("\n"),
      "ada.toml",
    );

    expect(agent).toEqual({
      name: "Ada",
      description: "Reads.",
      developer_instructions: "Be brief.",
      model: "gpt-5.5",
      model_reasoning_effort: "medium",
      nickname_candidates: ["Ad", "Lovelace"],
    });
    expect(rest).toEqual({ sandbox_mode: "read-only", features: { memories: true } });
  });

  it("leaves out the optional fields that are not there, and blanks the required ones", () => {
    const { agent, rest } = parseAgentToml("", "empty.toml");

    expect(agent).toEqual({ name: "", description: "", developer_instructions: "" });
    expect(rest).toEqual({});
  });

  it("keeps a field of the wrong type in rest instead of dropping it", () => {
    const { agent, rest } = parseAgentToml(
      'name = "Ada"\nmodel = 5\nnickname_candidates = ["ok", 3]\n',
      "odd.toml",
    );

    expect(agent.model).toBeUndefined();
    expect(agent.nickname_candidates).toBeUndefined();
    expect(rest).toEqual({ model: 5, nickname_candidates: ["ok", 3] });
  });

  it("throws an error that names the file, the problem and the line", () => {
    expect(() => parseAgentToml('name = "x\n', "agents/broken.toml")).toThrow(
      /^agents\/broken\.toml: .*\(line 1\)/,
    );
  });
});

describe("detect", () => {
  async function detectIn(dir: string) {
    return detectCodex({ ...ctx, sourceDir: dir });
  }

  it("finds an installation that has only auth.json", async () => {
    const fresh = join(root, "fresh");
    await mkdir(fresh);
    await writeFile(join(fresh, "auth.json"), "{}");

    expect(await detectIn(fresh)).toEqual({ found: true, location: fresh });
  });

  it.each(["config.toml", "AGENTS.md"])("finds an installation that has only %s", async (file) => {
    const dir = join(root, "partial");
    await mkdir(dir);
    await writeFile(join(dir, file), "");

    expect((await detectIn(dir)).found).toBe(true);
  });

  it.each(["agents", "memories"])("finds an installation that has only a %s folder", async (folder) => {
    const dir = join(root, "partial");
    await mkdir(join(dir, folder), { recursive: true });

    expect((await detectIn(dir)).found).toBe(true);
  });

  it("does not find a folder with none of them, and says what to do", async () => {
    const dir = join(root, "nothing");
    await mkdir(dir);

    expect(await detectIn(dir)).toEqual({
      found: false,
      location: dir,
      hint: "Install Codex or pass --source-dir <CODEX_HOME>",
    });
  });

  it("does not find a folder that is not there", async () => {
    expect((await detectIn(join(root, "missing"))).found).toBe(false);
  });

  it("does not run anything", async () => {
    // noExec throws; reaching this line means detect never called it.
    expect((await detectIn(codex)).found).toBe(true);
  });
});

describe("cacheIdentity", () => {
  it("is the real path of CODEX_HOME for the global setup", async () => {
    expect(await codexCacheIdentity(ctx, "default")).toBe(await realpath(codex));
  });

  it("is the real path of the file for an agent", async () => {
    expect(await codexCacheIdentity(ctx, "reviewer")).toBe(
      await realpath(join(codex, "agents", "reviewer.toml")),
    );
  });
});

describe("read leaves the source alone", () => {
  it("changes nothing in the Codex home or the skills folder", async () => {
    const before = await snapshot(home);

    await listCodexAgents(ctx);
    await readCodexAgent(ctx, "default");
    await readCodexAgent(ctx, "reviewer");
    await codexCacheIdentity(ctx, "default");

    expect(await snapshot(home)).toEqual(before);
    expect(await readdir(codex)).not.toContain("openteleport-ids.json");
  });
});
