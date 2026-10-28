import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import codexDefault, { codexAdapter } from "../../../src/adapters/codex/index.js";
import { type CodexAgentFile, parseAgentToml, readCodexAgent } from "../../../src/adapters/codex/read.js";
import { agentSlug, renderAgentToml, writeCodexAgent } from "../../../src/adapters/codex/write.js";
import { folderAdapter } from "../../../src/adapters/folder/index.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import { move } from "../../../src/core/engine.js";
import type { MoveReport } from "../../../src/core/report.js";
import type { Bundle, Skill } from "../../../src/core/schema.js";
import { mergeInstructions } from "../../../src/core/text.js";
import { type Sandbox, json, run, sandbox } from "../../helpers/cli.js";

const ADA_DIR = fileURLToPath(new URL("../../fixtures/jetpack/ada", import.meta.url));

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

const ADA_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
/** Another agent that is also called Ada. */
const OTHER_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2V";

const UPDATE: WriteOpts = { enableRoutines: false, includeFiles: false, onConflict: "update" };
const COPY: WriteOpts = { ...UPDATE, onConflict: "copy" };
const REPLACE: WriteOpts = { ...UPDATE, onConflict: "replace" };

/** What the user's config.toml holds in these tests: a comment, a table and unknown keys. */
const CONFIG = [
  "# My Codex setup, edited by hand.",
  'model = "gpt-5.5"',
  "unknown_future_key = [1, 2, 3]",
  "",
  "[mcp_servers.x]",
  'command = "npx"',
  "",
].join("\r\n");

const encoder = new TextEncoder();
const skillOf = (name: string, body: string): Skill => ({
  name,
  files: [{ path: "SKILL.md", bytes: encoder.encode(body) }],
});

let root: string;
let home: string;
let codex: string;
let ctx: Ctx;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-codex-write-"));
  home = join(root, "home");
  codex = join(home, ".codex");
  await mkdir(codex, { recursive: true });
  await writeFile(join(codex, "config.toml"), CONFIG);
  ctx = { targetDir: codex, home, cwd: root, env: {}, exec: noExec, logger: () => {} };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const agentPath = (stem: string): string => join(codex, "agents", `${stem}.toml`);
const skillsDir = (): string => join(home, ".agents", "skills");
const idsPath = (): string => join(codex, "openteleport-ids.json");

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const readAgentFile = async (stem: string): Promise<Record<string, unknown>> =>
  parse(await readFile(agentPath(stem), "utf8"));

/** A file symlink, or a skipped test where the system does not allow one. */
async function fileLink(target: string, path: string, skip: () => void): Promise<void> {
  try {
    await symlink(target, path, "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") skip();
    throw error;
  }
}

/** A Bundle with only the fields a test cares about filled in. */
function bundleOf(
  overrides: Omit<Partial<Bundle>, "manifest"> & { manifest?: Partial<Bundle["manifest"]> },
): Bundle {
  const { manifest, ...rest } = overrides;
  return {
    manifest: { schemaVersion: "0.1", id: ADA_ID, name: "Ada", models: [], capabilities: [], ...manifest },
    instructions: "Answer briefly.\n",
    skills: [],
    routines: [],
    facts: [],
    notes: [],
    files: [],
    unknownPaths: [],
    ...rest,
  };
}

/** Ada as the brief describes her: persona, instructions, two skills, three facts, a model. */
function ada(): Bundle {
  return bundleOf({
    manifest: {
      title: "Research assistant",
      models: [{ provider: "openai", model: "gpt-5.5" }],
      "x-codex": { reasoningEffort: "medium" },
    },
    persona: "Calm and curious.",
    instructions: "Read the sources first.\nQuote briefly.",
    skills: [skillOf("web-brief", "# Web brief\n"), skillOf("note-taker", "# Note taker\n")],
    facts: ["Prefers answers in Polish.", "Reads on a phone.", "Keeps notes short."],
  });
}

describe("the adapter", () => {
  it("is exported as a named and a default export", () => {
    expect(codexDefault).toBe(codexAdapter);
    expect(codexAdapter.name).toBe("codex");
    expect(codexAdapter.displayName).toBe("Codex");
  });

  it("declares what a Codex agent file can hold", () => {
    expect(codexAdapter.capabilities).toEqual({
      persona: true,
      instructions: true,
      skills: true,
      routines: false,
      facts: true,
      notes: false,
      files: false,
      avatar: false,
      models: true,
      schedules: [],
    });
  });

  it("needs Codex to be there, since it writes into its folder", () => {
    expect(codexAdapter.createsOnWrite).toBe(false);
  });

  it("finds Codex through its detect, and reads and writes through its own functions", async () => {
    expect((await codexAdapter.detect(ctx)).found).toBe(true);
    await codexAdapter.write(ctx, ada(), UPDATE);
    expect((await codexAdapter.list(ctx)).map(({ id }) => id)).toEqual(["default", "ada"]);
    const { bundle } = await codexAdapter.read(ctx, "ada");
    expect(bundle.manifest.id).toBe(ADA_ID);
    expect(await codexAdapter.cacheIdentity?.(ctx, "ada")).toContain("ada.toml");
  });
});

describe("agentSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(agentSlug("Ada")).toBe("ada");
    expect(agentSlug("Ada Lovelace")).toBe("ada-lovelace");
    expect(agentSlug("  --Code Reviewer v2!  ")).toBe("code-reviewer-v2");
  });

  it("cuts a long name to 64 characters, ending in a letter or a digit", () => {
    expect(agentSlug("a".repeat(100))).toBe("a".repeat(64));
    expect(agentSlug(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
  });

  it("refuses a name with no letter or digit in it", () => {
    expect(() => agentSlug("***")).toThrow(/"\*\*\*".*no letters or digits/);
    expect(() => agentSlug("")).toThrow(/no letters or digits/);
    expect(() => agentSlug("Привет")).toThrow(/no letters or digits/);
  });

  it("refuses default, which is the global setup", () => {
    expect(() => agentSlug("default")).toThrow(/global/);
    expect(() => agentSlug("Default!")).toThrow(/global/);
  });

  it("gives a name Windows reserves for devices another one", () => {
    expect(agentSlug("Con")).toBe("con-agent");
    expect(agentSlug("nul")).toBe("nul-agent");
  });
});

describe("renderAgentToml", () => {
  const trouble = [
    'He said "stop" and left.',
    "A backslash \\ and a path C:\\Users\\ada and a literal \\n.",
    'Three quotes """ and two "" and single quotes \'\'\' here.',
    "",
    "- a bullet",
    "\ta tab, and a CRLF line\r\nand a lone carriage return\rhere.",
    "",
  ].join("\n");

  it("gives back every field, however awkward the instructions are", () => {
    const agent: CodexAgentFile = {
      name: 'Ada "the" Brave',
      description: "Reads papers.",
      developer_instructions: trouble,
      model: "gpt-5.5",
      model_reasoning_effort: "medium",
      nickname_candidates: ["Ada", "A-1"],
    };

    const text = renderAgentToml(agent);

    expect(parseAgentToml(text, "ada.toml")).toEqual({ agent, rest: {} });
    expect(parse(text).developer_instructions).toBe(trouble);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("writes the rest too, and the agent's own fields win over it", () => {
    const agent: CodexAgentFile = { name: "Ada", description: "d", developer_instructions: "x" };
    const rest = { name: "Not me", skills: { config: [{ path: "/s", enabled: false }] } };

    const parsed = parse(renderAgentToml(agent, rest));

    expect(parsed).toEqual({ ...agent, skills: { config: [{ path: "/s", enabled: false }] } });
  });

  it("leaves out an optional field that is not set", () => {
    const text = renderAgentToml({ name: "Ada", description: "d", developer_instructions: "x" });

    expect(Object.keys(parse(text))).toEqual(["name", "description", "developer_instructions"]);
  });
});

describe("write a new agent", () => {
  it("writes agents/<slug>.toml with every field", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);

    expect(await readAgentFile("ada")).toEqual({
      name: "Ada",
      description: "Research assistant",
      developer_instructions: `${mergeInstructions("Calm and curious.", "Read the sources first.\nQuote briefly.")}\n\n# Facts\n- Prefers answers in Polish.\n- Reads on a phone.\n- Keeps notes short.`,
      model: "gpt-5.5",
      model_reasoning_effort: "medium",
    });
  });

  it("puts the persona and the instructions in the layout read splits again", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);

    const { bundle } = await readCodexAgent(ctx, "ada");

    expect(bundle.persona).toBe("Calm and curious.");
    expect(bundle.instructions).toBe(
      "Read the sources first.\nQuote briefly.\n\n\n# Facts\n- Prefers answers in Polish.\n- Reads on a phone.\n- Keeps notes short.",
    );
    expect(bundle.manifest).toMatchObject({
      id: ADA_ID,
      name: "Ada",
      title: "Research assistant",
      models: [{ model: "gpt-5.5" }],
      "x-codex": { reasoningEffort: "medium" },
    });
  });

  it("records the id in openteleport-ids.json, beside the agents folder", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);

    expect(JSON.parse(await readFile(idsPath(), "utf8"))).toEqual({ ada: ADA_ID });
    expect(await readdir(join(codex, "agents"))).toEqual(["ada.toml"]);
  });

  it("writes every skill to ~/.agents/skills", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);

    expect(await readFile(join(skillsDir(), "web-brief", "SKILL.md"), "utf8")).toBe("# Web brief\n");
    expect(await readFile(join(skillsDir(), "note-taker", "SKILL.md"), "utf8")).toBe(
      "# Note taker\n",
    );
  });

  it("keeps the skills in ~/.agents/skills when the Codex home is somewhere else", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);

    await writeCodexAgent({ ...ctx, targetDir: elsewhere }, ada(), UPDATE);

    expect(await exists(join(elsewhere, "agents", "ada.toml"))).toBe(true);
    expect(await exists(join(skillsDir(), "web-brief", "SKILL.md"))).toBe(true);
    expect(await exists(join(elsewhere, "skills"))).toBe(false);
  });

  it("never touches the user's config.toml, and does not make an AGENTS.md", async () => {
    const before = await readFile(join(codex, "config.toml"));

    await writeCodexAgent(ctx, ada(), UPDATE);

    expect((await readFile(join(codex, "config.toml"))).equals(before)).toBe(true);
    expect((await readdir(codex)).sort()).toEqual(["agents", "config.toml", "openteleport-ids.json"]);
    expect(await exists(join(codex, "memories"))).toBe(false);
    expect(await exists(join(codex, "skills"))).toBe(false);
  });

  it("reports what it approximated and warns about the shared skills and how to use the agent", async () => {
    const result = await writeCodexAgent(ctx, ada(), UPDATE);

    expect(result.outcome).toBe("done");
    expect(result.nextStep).toBeUndefined();
    expect(result.targetAgentId).toBe("ada");
    expect(result.artifactPath).toBe(agentPath("ada"));
    expect(result.items.approximated).toEqual([
      { field: "persona", detail: "persona and instructions share one field, developer_instructions" },
      {
        field: "memory.facts",
        detail: "facts are written as a Facts section at the end of developer_instructions",
      },
    ]);
    expect(result.items.skipped).toEqual([]);
    expect(result.items.warnings).toEqual([
      "Codex skills are shared by every tool reading ~/.agents/skills",
      "Use the agent in Codex as @ada (custom agents need `agents.enabled`, on by default)",
    ]);
  });

  it("does not warn about shared skills when there are none, and approximates nothing then", async () => {
    const bundle = bundleOf({ instructions: "Be brief." });

    const result = await writeCodexAgent(ctx, bundle, UPDATE);

    expect(result.items.approximated).toEqual([]);
    expect(result.items.warnings).toEqual([
      "Use the agent in Codex as @ada (custom agents need `agents.enabled`, on by default)",
    ]);
    expect(await exists(join(home, ".agents"))).toBe(false);
    expect((await readAgentFile("ada")).developer_instructions).toBe("Be brief.");
  });

  it("creates the Codex home and the agents folder when they are not there", async () => {
    const fresh = join(root, "fresh-codex");

    await writeCodexAgent({ ...ctx, targetDir: fresh }, bundleOf({}), UPDATE);

    expect(await readdir(join(fresh, "agents"))).toEqual(["ada.toml"]);
  });

  it("takes the Codex home from CODEX_HOME when no directory is given", async () => {
    const { targetDir: _targetDir, ...rest } = ctx;

    await writeCodexAgent({ ...rest, env: { CODEX_HOME: codex } }, bundleOf({}), UPDATE);

    expect(await exists(agentPath("ada"))).toBe(true);
  });

  it("leaves no temporary file behind", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);
    await writeCodexAgent(ctx, ada(), UPDATE);

    expect(await readdir(join(codex, "agents"))).toEqual(["ada.toml"]);
    expect((await readdir(codex)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not change the Bundle", async () => {
    const bundle = ada();
    const copy = structuredClone(bundle);

    await writeCodexAgent(ctx, bundle, UPDATE);

    expect(bundle).toEqual(copy);
  });

  it("refuses a name that has no letter or digit, before writing anything", async () => {
    await expect(
      writeCodexAgent(ctx, { ...ada(), manifest: { ...ada().manifest, name: "***" } }, UPDATE),
    ).rejects.toThrow(/no letters or digits/);

    expect(await readdir(codex)).toEqual(["config.toml"]);
    expect(await exists(join(home, ".agents"))).toBe(false);
  });

  it("refuses the name default, before writing anything", async () => {
    await expect(
      writeCodexAgent(ctx, { ...ada(), manifest: { ...ada().manifest, name: "Default" } }, UPDATE),
    ).rejects.toThrow(/global/);

    expect(await readdir(codex)).toEqual(["config.toml"]);
  });

  it("stops before writing when the map of ids cannot be read", async () => {
    await mkdir(idsPath());

    await expect(writeCodexAgent(ctx, ada(), UPDATE)).rejects.toThrow();

    expect(await exists(join(codex, "agents"))).toBe(false);
    expect(await exists(join(home, ".agents"))).toBe(false);
  });

  it("keeps what the map of ids already records for other agents", async () => {
    await writeFile(idsPath(), JSON.stringify({ reviewer: OTHER_ID }));

    await writeCodexAgent(ctx, ada(), UPDATE);

    expect(JSON.parse(await readFile(idsPath(), "utf8"))).toEqual({
      reviewer: OTHER_ID,
      ada: ADA_ID,
    });
  });
});

describe("the description", () => {
  const descriptionFor = async (bundle: Bundle): Promise<unknown> => {
    await writeCodexAgent(ctx, bundle, UPDATE);
    return (await readAgentFile("ada")).description;
  };

  it("is the title", async () => {
    expect(await descriptionFor(ada())).toBe("Research assistant");
  });

  it("is the first line of the instructions without a title, headings and list markers left off", async () => {
    const bundle = bundleOf({ instructions: "# Instructions\n\n- Read the sources first.\n- Quote." });

    expect(await descriptionFor(bundle)).toBe("Read the sources first.");
  });

  it("is cut to 120 characters", async () => {
    const bundle = bundleOf({ instructions: `${"word ".repeat(60)}\nsecond line` });

    const description = await descriptionFor(bundle);

    expect(description).toBe(`${"word ".repeat(60).trim().slice(0, 119)}…`);
    expect(String(description)).toHaveLength(120);
  });

  it("falls back to the description, then to the name, when the instructions say nothing", async () => {
    const empty = { instructions: "" };
    expect(
      await descriptionFor(bundleOf({ ...empty, manifest: { description: "Reads papers." } })),
    ).toBe("Reads papers.");
    expect(await descriptionFor(bundleOf({ ...empty, instructions: "# Only a heading\n" }))).toBe(
      "Ada",
    );
  });
});

describe("developer_instructions", () => {
  const instructionsOf = async (bundle: Bundle): Promise<unknown> => {
    await writeCodexAgent(ctx, bundle, UPDATE);
    return (await readAgentFile("ada")).developer_instructions;
  };

  it("keeps quotes, backslashes and triple quotes, and reads back the same text", async () => {
    const awkward = [
      'She said "no" and left.',
      "Paths: C:\\Users\\ada\\notes and a literal \\n and \\u0041.",
      'Triple """ quotes and \'\'\' here.',
      "",
    ].join("\n");

    expect(await instructionsOf(bundleOf({ instructions: awkward }))).toBe(awkward);
    const { bundle } = await readCodexAgent(ctx, "ada");
    expect(bundle.instructions).toBe(awkward);
  });

  it("is the instructions as they are without a persona and without facts", async () => {
    expect(await instructionsOf(bundleOf({ instructions: "Be brief.\n" }))).toBe("Be brief.\n");
  });

  it("adds the facts after the persona layout", async () => {
    const bundle = bundleOf({ persona: "Calm.", instructions: "Be brief.", facts: ["A.", "B."] });

    expect(await instructionsOf(bundle)).toBe(
      `${mergeInstructions("Calm.", "Be brief.")}\n\n# Facts\n- A.\n- B.`,
    );
  });

  it("is only the facts when there are no instructions", async () => {
    expect(await instructionsOf(bundleOf({ instructions: "", facts: ["Only a fact."] }))).toBe(
      "# Facts\n- Only a fact.",
    );
  });

  it("keeps a fact on one line and leaves a blank fact out", async () => {
    const bundle = bundleOf({ instructions: "Hi.", facts: ["One\nsplit fact.", "  ", "Two."] });

    expect(await instructionsOf(bundle)).toBe("Hi.\n\n# Facts\n- One split fact.\n- Two.");
  });

  it("adds no Facts section, and approximates nothing about facts, when every fact is blank", async () => {
    const result = await writeCodexAgent(ctx, bundleOf({ instructions: "Hi.", facts: ["", " "] }), UPDATE);

    expect((await readAgentFile("ada")).developer_instructions).toBe("Hi.");
    expect(result.items.approximated).toEqual([]);
  });
});

describe("the model", () => {
  const modelOf = async (models: Bundle["manifest"]["models"]) => {
    const result = await writeCodexAgent(ctx, bundleOf({ manifest: { models } }), COPY);
    return { model: (await readAgentFile("ada")).model, result };
  };

  it("is the first preference Codex can use", async () => {
    const { model } = await modelOf([
      { runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" },
      { runtime: "codex", provider: "openai", model: "gpt-5.5" },
      { provider: "openai", model: "gpt-5.5-mini" },
    ]);

    expect(model).toBe("gpt-5.5");
  });

  it.each([
    ["an OpenAI model", { provider: "openai", model: "gpt-5.5" }],
    ["a model for the codex runtime", { runtime: "codex", model: "gpt-5.5" }],
    ["a model with no vendor", { model: "gpt-5.5" }],
  ])("accepts %s", async (_label, pref) => {
    expect((await modelOf([pref])).model).toBe("gpt-5.5");
  });

  it("leaves model out and says so when no preference is for Codex", async () => {
    const { model, result } = await modelOf([
      { runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" },
      { provider: "openai" },
    ]);

    expect(model).toBeUndefined();
    expect(result.items.skipped).toEqual([
      {
        field: "models",
        detail: "no model preference Codex can use; the agent uses the session's model",
      },
    ]);
  });

  it("is silent when the Bundle names no model at all", async () => {
    const { model, result } = await modelOf([]);

    expect(model).toBeUndefined();
    expect(result.items.skipped).toEqual([]);
  });
});

describe("what comes along in x-codex", () => {
  it("writes the nicknames and the skills config of an agent that came from Codex", async () => {
    const skillsConfig = [{ path: "/skills/web-brief", enabled: false }];
    const bundle = bundleOf({
      manifest: {
        "x-codex": { reasoningEffort: "low", nickname_candidates: ["Atlas", "Delta 2"], skillsConfig },
      },
    });

    await writeCodexAgent(ctx, bundle, UPDATE);

    expect(await readAgentFile("ada")).toMatchObject({
      model_reasoning_effort: "low",
      nickname_candidates: ["Atlas", "Delta 2"],
      skills: { config: skillsConfig },
    });
  });

  it("drops nicknames Codex would refuse, and says so", async () => {
    const bundle = bundleOf({
      manifest: { "x-codex": { nickname_candidates: ["Atlas", "Zoë", "Atlas"] } },
    });

    const { items } = await writeCodexAgent(ctx, bundle, UPDATE);

    expect((await readAgentFile("ada")).nickname_candidates).toBeUndefined();
    expect(items.warnings).toContain(
      "nickname_candidates not written: Codex takes only unique names of letters, digits, spaces, - and _",
    );
  });

  it("ignores values of the wrong type without a word", async () => {
    const bundle = bundleOf({
      manifest: { "x-codex": { reasoningEffort: 3, skillsConfig: "nope" }, "x-hermes": { a: 1 } },
    });

    const { items } = await writeCodexAgent(ctx, bundle, UPDATE);

    expect(Object.keys(await readAgentFile("ada"))).toEqual(["name", "description", "developer_instructions"]);
    expect(items.warnings).toHaveLength(1);
  });

  it("does not write the approval policy or the sandbox mode, which only config.toml sets", async () => {
    const bundle = bundleOf({
      manifest: { "x-codex": { approvalPolicy: "never", sandboxMode: "danger-full-access" } },
    });

    await writeCodexAgent(ctx, bundle, UPDATE);

    expect(Object.keys(await readAgentFile("ada"))).toEqual(["name", "description", "developer_instructions"]);
  });
});

describe("an agent file that is already there", () => {
  const foreign = 'name = "Ada"\ndescription = "Written by hand."\ndeveloper_instructions = "Mine."\n';

  it("writes the same agent in place, and not twice", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);
    const edited = { ...ada(), instructions: "Changed." };

    const second = await writeCodexAgent(ctx, edited, UPDATE);

    expect(second.targetAgentId).toBe("ada");
    expect(await readdir(join(codex, "agents"))).toEqual(["ada.toml"]);
    expect(String((await readAgentFile("ada")).developer_instructions)).toContain("Changed.");
    expect(second.items.warnings.filter((warning) => warning.includes("already exists"))).toEqual([]);
  });

  it("writes a copy next to an agent file that is not its own, and leaves that one alone", async () => {
    await mkdir(join(codex, "agents"));
    await writeFile(agentPath("ada"), foreign);

    const result = await writeCodexAgent(ctx, ada(), UPDATE);

    expect(result.targetAgentId).toBe("ada-2");
    expect(result.artifactPath).toBe(agentPath("ada-2"));
    expect(await readFile(agentPath("ada"), "utf8")).toBe(foreign);
    expect((await readAgentFile("ada-2")).name).toBe("Ada");
    expect(JSON.parse(await readFile(idsPath(), "utf8"))).toEqual({ "ada-2": ADA_ID });
    expect(result.items.warnings).toContain("agent 'ada' already exists; written as 'ada-2'");
    expect(result.items.warnings).toContain(
      "Use the agent in Codex as @ada-2 (custom agents need `agents.enabled`, on by default)",
    );
  });

  it("updates the copy it made earlier instead of making a third", async () => {
    await mkdir(join(codex, "agents"));
    await writeFile(agentPath("ada"), foreign);
    await writeCodexAgent(ctx, ada(), UPDATE);

    const second = await writeCodexAgent(ctx, { ...ada(), instructions: "Changed." }, UPDATE);

    expect(second.targetAgentId).toBe("ada-2");
    expect((await readdir(join(codex, "agents"))).sort()).toEqual(["ada-2.toml", "ada.toml"]);
    expect(String((await readAgentFile("ada-2")).developer_instructions)).toContain("Changed.");
    expect(second.items.warnings.filter((warning) => warning.includes("already exists"))).toEqual([]);
  });

  it("treats another agent of the same name as foreign", async () => {
    await writeCodexAgent(ctx, bundleOf({ manifest: { id: OTHER_ID } }), UPDATE);

    const result = await writeCodexAgent(ctx, ada(), UPDATE);

    expect(result.targetAgentId).toBe("ada-2");
    expect(JSON.parse(await readFile(idsPath(), "utf8"))).toEqual({ ada: OTHER_ID, "ada-2": ADA_ID });
  });

  it("does not take a Bundle without an id for the agent that is there", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);

    const result = await writeCodexAgent(ctx, bundleOf({ manifest: { id: "" } }), UPDATE);

    expect(result.targetAgentId).toBe("ada-2");
    expect(JSON.parse(await readFile(idsPath(), "utf8"))).toEqual({ ada: ADA_ID });
  });

  it("writes a copy on --copy even over its own agent, and says so", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);

    const result = await writeCodexAgent(ctx, ada(), COPY);

    expect(result.targetAgentId).toBe("ada-2");
    expect((await readdir(join(codex, "agents"))).sort()).toEqual(["ada-2.toml", "ada.toml"]);
    expect(result.items.warnings).toContain(
      "an agent named ada already exists in Codex; this one was written as ada-2",
    );
  });

  it("takes the first free name for a copy", async () => {
    await mkdir(join(codex, "agents"));
    await writeFile(agentPath("ada"), foreign);
    await writeFile(agentPath("ada-2"), foreign);

    const result = await writeCodexAgent(ctx, ada(), COPY);

    expect(result.targetAgentId).toBe("ada-3");
  });

  it("refuses to replace an agent file it did not write, and writes nothing", async () => {
    await mkdir(join(codex, "agents"));
    await writeFile(agentPath("ada"), foreign);

    await expect(writeCodexAgent(ctx, ada(), REPLACE)).rejects.toThrow(
      `Refusing to replace ${agentPath("ada")}: OpenTeleport did not write it. Delete it yourself if you mean it.`,
    );

    expect(await readFile(agentPath("ada"), "utf8")).toBe(foreign);
    expect(await readdir(codex)).not.toContain("openteleport-ids.json");
    expect(await exists(join(home, ".agents"))).toBe(false);
  });

  it("replaces an agent file it wrote, whichever agent it held", async () => {
    await writeCodexAgent(ctx, bundleOf({ manifest: { id: OTHER_ID }, instructions: "Old." }), UPDATE);

    const result = await writeCodexAgent(ctx, { ...ada(), instructions: "New." }, REPLACE);

    expect(result.targetAgentId).toBe("ada");
    expect(await readdir(join(codex, "agents"))).toEqual(["ada.toml"]);
    expect(String((await readAgentFile("ada")).developer_instructions)).toContain("New.");
    expect(JSON.parse(await readFile(idsPath(), "utf8"))).toEqual({ ada: ADA_ID });
  });

  it("writes to a free name on --replace, as nothing is there to replace", async () => {
    const result = await writeCodexAgent(ctx, ada(), REPLACE);

    expect(result.targetAgentId).toBe("ada");
  });

  it("does not write through a linked agent file: update writes a copy, replace refuses", async (context) => {
    const outside = join(root, "outside.toml");
    await writeFile(outside, "ORIGINAL\n");
    await mkdir(join(codex, "agents"));
    await fileLink(outside, agentPath("ada"), () => context.skip());

    const updated = await writeCodexAgent(ctx, ada(), UPDATE);
    await expect(writeCodexAgent(ctx, ada(), REPLACE)).rejects.toThrow(
      `Refusing to replace ${agentPath("ada")}: it is a symbolic link. Delete it yourself if you mean it.`,
    );

    expect(await readFile(outside, "utf8")).toBe("ORIGINAL\n");
    expect((await lstat(agentPath("ada"))).isSymbolicLink()).toBe(true);
    expect(updated.targetAgentId).toBe("ada-2");
    expect(updated.items.warnings).toContain("agent file 'ada.toml' is a symlink; written as 'ada-2.toml'");
  });

  it("does not write over a folder called ada.toml", async () => {
    await mkdir(agentPath("ada"), { recursive: true });

    const updated = await writeCodexAgent(ctx, ada(), UPDATE);
    await expect(writeCodexAgent(ctx, ada(), REPLACE)).rejects.toThrow(
      /Refusing to replace .*: it is not a regular file/,
    );

    expect(updated.targetAgentId).toBe("ada-2");
  });
});

describe("rewriting its own agent file", () => {
  /** Ada written once, then edited by hand: a comment, a model, two settings and a table. */
  async function editedByHand(extra = ""): Promise<void> {
    await writeCodexAgent(ctx, ada(), UPDATE);
    const own = await readFile(agentPath("ada"), "utf8");
    await writeFile(
      agentPath("ada"),
      `# Tuned by hand.\n${own.replace('model = "gpt-5.5"', 'model = "old-model"')}sandbox_mode = "workspace-write"\nmodel_verbosity = "low"\n${extra}\n[features]\nmemories = true\n`,
    );
  }

  const changed = (): Bundle => ({ ...ada(), instructions: "Changed." });

  it("keeps the settings the Bundle has no place for, and updates the rest", async () => {
    await editedByHand();

    await writeCodexAgent(ctx, changed(), UPDATE);

    const written = await readAgentFile("ada");
    expect(written).toMatchObject({
      sandbox_mode: "workspace-write",
      model_verbosity: "low",
      features: { memories: true },
      name: "Ada",
      model: "gpt-5.5",
      model_reasoning_effort: "medium",
    });
    expect(String(written.developer_instructions)).toContain("Changed.");
    expect(await readFile(agentPath("ada"), "utf8")).not.toContain("Tuned by hand");
  });

  it("says that it rewrote the file and that comments may be lost", async () => {
    await editedByHand();

    const { items } = await writeCodexAgent(ctx, changed(), UPDATE);

    expect(items.warnings).toContain("agents/ada.toml rewritten; comments may be lost");
  });

  it("keeps them on replace too", async () => {
    await editedByHand();

    const { items } = await writeCodexAgent(ctx, changed(), REPLACE);

    expect(await readAgentFile("ada")).toMatchObject({
      sandbox_mode: "workspace-write",
      features: { memories: true },
    });
    expect(items.warnings).toContain("agents/ada.toml rewritten; comments may be lost");
  });

  it("keeps them in a copy of its own that it updates", async () => {
    await mkdir(join(codex, "agents"));
    await writeFile(agentPath("ada"), 'name = "Ada"\ndescription = "d"\ndeveloper_instructions = "Mine."\n');
    await writeCodexAgent(ctx, ada(), UPDATE);
    const own = await readFile(agentPath("ada-2"), "utf8");
    await writeFile(agentPath("ada-2"), `${own}sandbox_mode = "read-only"\n`);

    const { items } = await writeCodexAgent(ctx, changed(), UPDATE);

    expect(await readAgentFile("ada-2")).toMatchObject({ sandbox_mode: "read-only" });
    expect(items.warnings).toContain("agents/ada-2.toml rewritten; comments may be lost");
  });

  it("lets the Bundle's skills config replace the file's, and keeps its other skills settings", async () => {
    await editedByHand(
      'skills = { include_instructions = false, config = [{ path = "/old", enabled = true }] }\n',
    );
    const bundle = {
      ...changed(),
      manifest: {
        ...ada().manifest,
        "x-codex": { skillsConfig: [{ path: "/new", enabled: false }] },
      },
    };

    await writeCodexAgent(ctx, bundle, UPDATE);

    expect((await readAgentFile("ada")).skills).toEqual({
      include_instructions: false,
      config: [{ path: "/new", enabled: false }],
    });
  });

  it("keeps the file's skills config when the Bundle has none", async () => {
    await editedByHand('skills = { config = [{ path = "/old", enabled = true }] }\n');

    await writeCodexAgent(ctx, changed(), UPDATE);

    expect((await readAgentFile("ada")).skills).toEqual({ config: [{ path: "/old", enabled: true }] });
  });

  it("does not keep model settings the Bundle does not carry", async () => {
    await editedByHand();
    const bundle = { ...changed(), manifest: { ...ada().manifest, models: [], "x-codex": {} } };

    await writeCodexAgent(ctx, bundle, UPDATE);

    const written = await readAgentFile("ada");
    expect(written.model).toBeUndefined();
    expect(written.model_reasoning_effort).toBeUndefined();
    expect(written.sandbox_mode).toBe("workspace-write");
  });

  it("writes a file that is not TOML over whole, and says so", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);
    await writeFile(agentPath("ada"), 'name = "Ada\nsandbox_mode =\n');

    const { items } = await writeCodexAgent(ctx, changed(), UPDATE);

    expect(Object.keys(await readAgentFile("ada"))).toEqual([
      "name",
      "description",
      "developer_instructions",
      "model",
      "model_reasoning_effort",
    ]);
    expect(items.warnings).toContainEqual(
      expect.stringMatching(/^agents\/ada\.toml: .*; rewritten without its old settings$/),
    );
    expect(items.warnings).not.toContain("agents/ada.toml rewritten; comments may be lost");
  });

  it("says nothing of the kind for a file it writes for the first time", async () => {
    const { items } = await writeCodexAgent(ctx, ada(), UPDATE);

    expect(items.warnings.filter((warning) => warning.includes("rewritten"))).toEqual([]);
  });

  it("takes nothing from a file that is not its own when it writes a copy beside it", async () => {
    await mkdir(join(codex, "agents"));
    const foreign = 'name = "Ada"\ndescription = "d"\ndeveloper_instructions = "Mine."\nsandbox_mode = "read-only"\n';
    await writeFile(agentPath("ada"), foreign);

    const { items } = await writeCodexAgent(ctx, ada(), UPDATE);

    expect((await readAgentFile("ada-2")).sandbox_mode).toBeUndefined();
    expect(await readFile(agentPath("ada"), "utf8")).toBe(foreign);
    expect(items.warnings.filter((warning) => warning.includes("rewritten"))).toEqual([]);
  });
});

describe("an agent called Constructor", () => {
  const foreign = 'name = "Constructor"\ndescription = "d"\ndeveloper_instructions = "Mine."\n';
  const named = (): Bundle => ({ ...ada(), manifest: { ...ada().manifest, name: "Constructor" } });

  it("is not taken for one OpenTeleport wrote just because every object has a constructor", async () => {
    await mkdir(join(codex, "agents"));
    await writeFile(agentPath("constructor"), foreign);

    await expect(writeCodexAgent(ctx, named(), REPLACE)).rejects.toThrow(
      `Refusing to replace ${agentPath("constructor")}: OpenTeleport did not write it.`,
    );

    expect(await readFile(agentPath("constructor"), "utf8")).toBe(foreign);
  });

  it("gets a copy on update, and the file that is there stays", async () => {
    await mkdir(join(codex, "agents"));
    await writeFile(agentPath("constructor"), foreign);

    const result = await writeCodexAgent(ctx, named(), UPDATE);

    expect(result.targetAgentId).toBe("constructor-2");
    expect(await readFile(agentPath("constructor"), "utf8")).toBe(foreign);
  });

  it("is updated in place when it is its own", async () => {
    await writeCodexAgent(ctx, named(), UPDATE);

    const second = await writeCodexAgent(ctx, named(), UPDATE);

    expect(second.targetAgentId).toBe("constructor");
    expect(JSON.parse(await readFile(idsPath(), "utf8"))).toEqual({ constructor: ADA_ID });
  });
});

describe("the skills", () => {
  const skillFile = (name: string): string => join(skillsDir(), name, "SKILL.md");

  it("writes a skill of the same name and other content as <name>-2, leaving the original", async () => {
    await mkdir(join(skillsDir(), "web-brief"), { recursive: true });
    await writeFile(skillFile("web-brief"), "Someone else's.\n");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(skillFile("web-brief"), old, old);

    const { items } = await writeCodexAgent(ctx, ada(), UPDATE);

    expect(await readFile(skillFile("web-brief"), "utf8")).toBe("Someone else's.\n");
    expect((await stat(skillFile("web-brief"))).mtimeMs).toBe(old.getTime());
    expect(await readFile(skillFile("web-brief-2"), "utf8")).toBe("# Web brief\n");
    expect(items.warnings).toContain(
      "skill 'web-brief' already exists with different content; written as 'web-brief-2'",
    );
  });

  it("reuses a skill that is already there with the same content, and does not write it again", async () => {
    await mkdir(join(skillsDir(), "web-brief"), { recursive: true });
    await writeFile(skillFile("web-brief"), "# Web brief\n");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(skillFile("web-brief"), old, old);

    const { items } = await writeCodexAgent(ctx, ada(), UPDATE);

    expect((await stat(skillFile("web-brief"))).mtimeMs).toBe(old.getTime());
    expect(await exists(join(skillsDir(), "web-brief-2"))).toBe(false);
    expect(items.warnings.filter((warning) => warning.includes("web-brief"))).toEqual([]);
  });

  it("never removes a skill, not even on replace", async () => {
    await writeCodexAgent(ctx, ada(), UPDATE);
    await mkdir(join(skillsDir(), "keep-me"), { recursive: true });
    await writeFile(skillFile("keep-me"), "Mine.\n");

    await writeCodexAgent(ctx, bundleOf({ instructions: "No skills now." }), REPLACE);

    expect(await readFile(skillFile("keep-me"), "utf8")).toBe("Mine.\n");
    expect(await exists(skillFile("web-brief"))).toBe(true);
  });

  it("skips a skill whose name would leave its folder, and names it", async () => {
    const bundle = bundleOf({ skills: [skillOf("../evil", "x")] });

    const { items } = await writeCodexAgent(ctx, bundle, UPDATE);

    expect(items.skipped).toEqual([
      { field: "skill:../evil", detail: "its name or a file path is not safe to write" },
    ]);
    expect(await exists(join(home, ".agents", "evil"))).toBe(false);
  });

  it("writes every file of a skill, nested ones included", async () => {
    const skill: Skill = {
      name: "deploy",
      files: [
        { path: "SKILL.md", bytes: encoder.encode("# Deploy\n") },
        { path: "scripts/run.sh", bytes: encoder.encode("echo hi\n") },
      ],
    };

    await writeCodexAgent(ctx, bundleOf({ skills: [skill] }), UPDATE);

    expect(await readFile(join(skillsDir(), "deploy", "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
  });
});

describe("through the engine", () => {
  it("moves Ada from a folder and reports what Codex could not hold", async () => {
    const report = await move({
      from: folderAdapter,
      to: codexAdapter,
      agent: ".",
      ctx: { ...ctx, sourceDir: ADA_DIR, targetDir: codex },
      write: UPDATE,
    });

    expect(report.outcome).toBe("done");
    expect(report.target).toEqual({ app: "codex", agent: "ada" });
    expect(report.skipped.map(({ field }) => field)).toEqual([
      "routine:Morning digest",
      "memory.notes",
      "avatar",
    ]);
    expect(report.approximated.map(({ field }) => field)).toEqual(["persona", "memory.facts"]);
    expect(report.moved.map(({ field }) => field)).toEqual([
      "instructions",
      "persona",
      "skills",
      "memory.facts",
      "models",
    ]);
    const written = await readAgentFile("ada");
    expect(written).toMatchObject({
      name: "Ada",
      description: "Research assistant",
      model: "gpt-5.5",
    });
    expect(String(written.developer_instructions)).toContain("# Persona");
    expect(await exists(join(skillsDir(), "web-brief", "SKILL.md"))).toBe(true);
  });

  it("moves an agent file to another Codex home and back to the same id", async () => {
    await codexAdapter.write(ctx, ada(), UPDATE);
    const other = join(root, "other-codex");
    await mkdir(other);

    await move({
      from: codexAdapter,
      to: codexAdapter,
      agent: "ada",
      ctx: { ...ctx, sourceDir: codex, targetDir: other },
      write: UPDATE,
    });

    const { bundle } = await readCodexAgent({ ...ctx, targetDir: undefined, sourceDir: other }, "ada");
    expect(bundle.manifest.id).toBe(ADA_ID);
    expect(bundle.persona).toBe("Calm and curious.");
  });
});

describe("move through the CLI", () => {
  let box: Sandbox;
  beforeEach(async () => {
    box = await sandbox();
  });
  afterEach(async () => {
    await box.cleanup();
  });

  it("writes the agent file into CODEX_HOME and the skills into ~/.agents/skills", async () => {
    await mkdir(join(box.home, ".codex"));
    await writeFile(join(box.home, ".codex", "config.toml"), CONFIG);

    const result = await run(box, ["move", "--from", "folder", "--source-dir", ADA_DIR, "--agent", ".", "--to", "codex", "--json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    const report = json<MoveReport>(result);
    expect(report.target).toEqual({ app: "codex", agent: "ada" });
    expect(report.outcome).toBe("done");
    const file = join(box.home, ".codex", "agents", "ada.toml");
    expect(parse(await readFile(file, "utf8"))).toMatchObject({ name: "Ada", model: "gpt-5.5" });
    expect(await readFile(join(box.home, ".agents", "skills", "web-brief", "SKILL.md"), "utf8")).toContain(
      "web-brief",
    );
    expect(await readFile(join(box.home, ".codex", "config.toml"), "utf8")).toBe(CONFIG);
    const ids = JSON.parse(await readFile(join(box.home, ".codex", "openteleport-ids.json"), "utf8"));
    expect(ids).toEqual({ ada: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T" });
  });

  it("moves it again in place", async () => {
    await mkdir(join(box.home, ".codex"));
    await writeFile(join(box.home, ".codex", "auth.json"), "{}");
    const args = ["move", "--from", "folder", "--source-dir", ADA_DIR, "--agent", ".", "--to", "codex", "--quiet"];
    const first = await run(box, args);
    expect(first.exitCode, first.stderr).toBe(0);

    const second = await run(box, args);

    expect(second.exitCode, second.stderr).toBe(0);
    expect(await readdir(join(box.home, ".codex", "agents"))).toEqual(["ada.toml"]);
  });

  it("exits 3 with a hint when Codex is not there", async () => {
    const result = await run(box, ["move", "--from", "folder", "--source-dir", ADA_DIR, "--agent", ".", "--to", "codex"]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Codex was not detected at ");
    expect(result.stderr).toContain("Install Codex or pass --source-dir <CODEX_HOME>");
    expect(await exists(join(box.home, ".codex"))).toBe(false);
  });
});
