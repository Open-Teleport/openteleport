import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAgentFile } from "../../../src/adapters/claude-code/frontmatter.js";
import { claudeCodeAdapter } from "../../../src/adapters/claude-code/index.js";
import { sanitize } from "../../../src/adapters/claude-code/paths.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import { readBundle } from "../../../src/core/bundle.js";
import type { Bundle } from "../../../src/core/schema.js";
import { mergeInstructions } from "../../../src/core/text.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/claude-code", import.meta.url));
const ADA_DIR = fileURLToPath(new URL("../../fixtures/jetpack/ada", import.meta.url));
/** The home fixture keeps its memory under this name; setup renames it for the temp project. */
const PLACEHOLDER = "__project__";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

const UPDATE: WriteOpts = { enableRoutines: false, includeFiles: false, onConflict: "update" };
const COPY: WriteOpts = { ...UPDATE, onConflict: "copy" };
const REPLACE: WriteOpts = { ...UPDATE, onConflict: "replace" };

const encoder = new TextEncoder();
const bytes = (content: string): Uint8Array => encoder.encode(content);
/** Fixtures may be checked out with CRLF line endings on Windows. */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

let root: string;
let project: string;
let home: string;
let ctx: Ctx;

/** The memory directory Claude Code uses for `dir`, inside the temp home. */
const memoryOf = (dir: string): string =>
  join(home, ".claude", "projects", sanitize(resolve(dir)), "memory");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-claude-write-"));
  project = join(root, "project");
  home = join(root, "home");
  await cp(join(FIXTURES, "project"), project, { recursive: true });
  await cp(join(FIXTURES, "home"), home, { recursive: true });
  const projects = join(home, ".claude", "projects");
  await rename(join(projects, PLACEHOLDER), join(projects, sanitize(resolve(project))));
  ctx = { targetDir: project, home, cwd: root, env: {}, exec: noExec, logger: () => {} };
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

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const agentFile = (dir: string, stem: string): string => join(dir, ".claude", "agents", `${stem}.md`);

/** A Bundle with only the fields a test cares about filled in. */
function bundleOf(overrides: Partial<Bundle> & { manifest?: Partial<Bundle["manifest"]> }): Bundle {
  const { manifest, ...rest } = overrides;
  return {
    manifest: { schemaVersion: "0.1", id: "", name: "Ada", models: [], capabilities: [], ...manifest },
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

describe("write", () => {
  it("writes Ada as a subagent with frontmatter and the merged body", async () => {
    const ada = await readBundle(ADA_DIR);

    const result = await claudeCodeAdapter.write(ctx, ada, COPY);

    const file = agentFile(project, "ada");
    expect(result).toMatchObject({ outcome: "done", targetAgentId: "ada", artifactPath: file });
    const parsed = parseAgentFile(await readFile(file, "utf8"));
    expect(parsed).toEqual({
      name: "ada",
      description: "Research assistant",
      model: "claude-opus-5-5",
      body: lf(mergeInstructions(ada.persona, ada.instructions)),
      ignored: [],
    });
    expect(parsed.body.startsWith("# Persona\n\n")).toBe(true);
    expect(parsed.body).toContain("# Instructions\n\n");
  });

  it("appends facts to MEMORY.md without repeating them", async () => {
    const ada = await readBundle(ADA_DIR);
    const memoryFile = join(memoryOf(project), "MEMORY.md");
    const before = lf(await readFile(memoryFile, "utf8"));

    await claudeCodeAdapter.write(ctx, ada, UPDATE);
    await claudeCodeAdapter.write(ctx, ada, UPDATE);

    const after = lf(await readFile(memoryFile, "utf8"));
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(
      [
        "",
        "- Prefers answers in Polish unless the source is in English.",
        "- Reads the digest on a phone, so keep it under five lines.",
        "",
      ].join("\n"),
    );
  });

  it("skips a fact that MEMORY.md already holds verbatim", async () => {
    const bundle = bundleOf({
      facts: ["Prefers reviews that cite the line they are about.", "New fact.", "New fact."],
    });
    const memoryFile = join(memoryOf(project), "MEMORY.md");

    await claudeCodeAdapter.write(ctx, bundle, UPDATE);

    const lines = lf(await readFile(memoryFile, "utf8")).split("\n");
    expect(lines.filter((line) => line === "- Prefers reviews that cite the line they are about.")).toHaveLength(1);
    expect(lines.filter((line) => line === "- New fact.")).toHaveLength(1);
  });

  it("creates the memory directory and MEMORY.md for a project that has none", async () => {
    const fresh = join(root, "fresh");
    await mkdir(fresh);

    await claudeCodeAdapter.write({ ...ctx, targetDir: fresh }, bundleOf({ facts: ["One.", "Two."] }), COPY);

    expect(await readFile(join(memoryOf(fresh), "MEMORY.md"), "utf8")).toBe("- One.\n- Two.\n");
    expect(await exists(agentFile(fresh, "ada"))).toBe(true);
  });

  it("writes notes as imported-<slug>-<note>.md next to MEMORY.md", async () => {
    const ada = await readBundle(ADA_DIR);

    await claudeCodeAdapter.write(ctx, ada, UPDATE);

    const memory = memoryOf(project);
    expect(lf(await readFile(join(memory, "imported-ada-2026-10-20.md"), "utf8"))).toBe(
      lf(await readFile(join(ADA_DIR, "memory", "2026-10-20.md"), "utf8")),
    );
    expect(await readFile(join(memory, "imported-ada-MEMORY-prose.md"), "utf8")).toBe(
      "Ada keeps long-form notes in memory/ and only distils stable facts into this file.",
    );
  });

  it("reports each routine and the avatar as skipped, with the reason", async () => {
    const ada = await readBundle(ADA_DIR);

    const { items } = await claudeCodeAdapter.write(ctx, ada, COPY);

    expect(items.skipped).toContainEqual({
      field: "routine:Morning digest",
      detail: "Claude Code has no file-based routines",
    });
    expect(items.skipped).toContainEqual({
      field: "avatar",
      detail: "Claude Code agents have no avatar",
    });
  });

  it("ignores files unless asked for them, then reports them as skipped", async () => {
    const bundle = bundleOf({ files: [{ path: "data.csv", bytes: bytes("a,b\n") }] });

    const without = await claudeCodeAdapter.write(ctx, bundle, UPDATE);
    const withFiles = await claudeCodeAdapter.write(ctx, bundle, { ...UPDATE, includeFiles: true });

    expect(without.items.skipped).toEqual([]);
    expect(withFiles.items.skipped).toEqual([
      { field: "files", detail: "Claude Code has no per-agent workspace" },
    ]);
  });

  it("writes a copy as ada-2.md, then ada-3.md, and says why", async () => {
    const ada = await readBundle(ADA_DIR);

    await claudeCodeAdapter.write(ctx, ada, COPY);
    const second = await claudeCodeAdapter.write(ctx, ada, COPY);
    const third = await claudeCodeAdapter.write(ctx, ada, COPY);

    expect(second.targetAgentId).toBe("ada-2");
    expect(second.artifactPath).toBe(agentFile(project, "ada-2"));
    expect(parseAgentFile(await readFile(agentFile(project, "ada-2"), "utf8")).name).toBe("ada-2");
    expect(second.items.warnings).toContain(
      "an agent named ada already exists in Claude Code; this one was written as ada-2",
    );
    expect(third.targetAgentId).toBe("ada-3");
    expect(await exists(agentFile(project, "ada"))).toBe(true);
  });

  it("overwrites the agent file on update and on replace", async () => {
    await claudeCodeAdapter.write(ctx, bundleOf({ instructions: "First.\n" }), COPY);
    await claudeCodeAdapter.write(ctx, bundleOf({ instructions: "Second.\n" }), UPDATE);
    expect(parseAgentFile(await readFile(agentFile(project, "ada"), "utf8")).body).toBe("Second.\n");

    const result = await claudeCodeAdapter.write(ctx, bundleOf({ instructions: "Third.\n" }), REPLACE);

    expect(result.targetAgentId).toBe("ada");
    expect(parseAgentFile(await readFile(agentFile(project, "ada"), "utf8")).body).toBe("Third.\n");
    expect(await exists(agentFile(project, "ada-2"))).toBe(false);
  });

  it("overwrites an existing skill on update", async () => {
    const ada = await readBundle(ADA_DIR);

    await claudeCodeAdapter.write(ctx, ada, UPDATE);

    const skills = join(project, ".claude", "skills");
    expect(lf(await readFile(join(skills, "web-brief", "SKILL.md"), "utf8"))).toBe(
      lf(await readFile(join(ADA_DIR, "skills", "web-brief", "SKILL.md"), "utf8")),
    );
    // Update overwrites the files it brings and leaves the others alone.
    expect(await exists(join(skills, "web-brief", "references", "checklist.md"))).toBe(true);
    expect(await exists(join(skills, "web-brief-2"))).toBe(false);
  });

  it.each([
    ["copy", COPY],
    ["replace", REPLACE],
  ])("writes a skill that already exists as <name>-2 on %s", async (_mode, opts) => {
    const ada = await readBundle(ADA_DIR);
    const skills = join(project, ".claude", "skills");
    const original = await readFile(join(skills, "web-brief", "SKILL.md"), "utf8");

    const { items } = await claudeCodeAdapter.write(ctx, ada, opts);

    expect(await readFile(join(skills, "web-brief", "SKILL.md"), "utf8")).toBe(original);
    expect(lf(await readFile(join(skills, "web-brief-2", "SKILL.md"), "utf8"))).toBe(
      lf(await readFile(join(ADA_DIR, "skills", "web-brief", "SKILL.md"), "utf8")),
    );
    expect(items.approximated).toContainEqual({
      field: "skill:web-brief",
      detail: "a skill of that name already exists; written as web-brief-2",
    });
  });

  it("writes every file of a skill, nested ones included", async () => {
    const bundle = bundleOf({
      skills: [
        {
          name: "deploy",
          files: [
            { path: "SKILL.md", bytes: bytes("# Deploy\n") },
            { path: "scripts/run.sh", bytes: bytes("echo hi\n") },
          ],
        },
      ],
    });

    await claudeCodeAdapter.write(ctx, bundle, COPY);

    const dir = join(project, ".claude", "skills", "deploy");
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("# Deploy\n");
    expect(await readFile(join(dir, "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
  });

  it("skips a skill or a note whose name would leave its directory", async () => {
    const bundle = bundleOf({
      skills: [{ name: "../evil", files: [{ path: "SKILL.md", bytes: bytes("x") }] }],
      notes: [{ name: "../../evil", text: "x" }],
    });
    const before = await snapshot(root);

    const { items } = await claudeCodeAdapter.write(ctx, bundle, COPY);

    expect(items.skipped).toEqual([
      { field: "skill:../evil", detail: "its name or a file path is not safe to write" },
      { field: "note:../../evil", detail: "its name is not safe to write" },
    ]);
    const added = Object.keys(await snapshot(root)).filter((path) => !(path in before));
    expect(added).toEqual(["project/.claude/agents/ada.md"]);
  });

  it("keeps the tools of a Claude Code agent and its Anthropic model", async () => {
    const source = await claudeCodeAdapter.read({ ...ctx, sourceDir: project }, "reviewer");
    const target = join(root, "target");
    await mkdir(target);

    const result = await claudeCodeAdapter.write({ ...ctx, targetDir: target }, source.bundle, COPY);

    expect(result.targetAgentId).toBe("reviewer");
    const text = await readFile(agentFile(target, "reviewer"), "utf8");
    expect(text).toContain("\ntools: Read, Grep, Bash\n");
    const parsed = parseAgentFile(text);
    expect(parsed).toMatchObject({
      name: "reviewer",
      description:
        "Reviews pull requests for correctness and style. Use it after every change, before you merge.",
      tools: ["Read", "Grep", "Bash"],
      model: "claude-opus-5-5",
    });
    const again = await claudeCodeAdapter.read({ ...ctx, sourceDir: target }, "reviewer");
    expect(again.bundle.persona).toBe(source.bundle.persona);
    expect(again.bundle.instructions).toBe(source.bundle.instructions);
  });

  it("leaves model out without an Anthropic preference and says so", async () => {
    const bundle = bundleOf({ manifest: { models: [{ provider: "openai", model: "gpt-5.5" }] } });

    const { items } = await claudeCodeAdapter.write(ctx, bundle, COPY);

    const parsed = parseAgentFile(await readFile(agentFile(project, "ada"), "utf8"));
    expect(parsed.model).toBeUndefined();
    expect(items.skipped).toContainEqual({
      field: "models",
      detail: "no Anthropic model preference; the agent uses the session's model",
    });
  });

  it("picks the first Anthropic preference even when it is not the first one", async () => {
    const bundle = bundleOf({
      manifest: {
        models: [
          { provider: "openai", model: "gpt-5.5" },
          { provider: "anthropic", model: "sonnet" },
        ],
      },
    });

    await claudeCodeAdapter.write(ctx, bundle, COPY);

    expect(parseAgentFile(await readFile(agentFile(project, "ada"), "utf8")).model).toBe("sonnet");
  });

  it("says that capabilities without a tools list give the agent every tool", async () => {
    const bundle = bundleOf({ manifest: { capabilities: ["browser", "filesystem"] } });

    const { items } = await claudeCodeAdapter.write(ctx, bundle, COPY);

    expect(parseAgentFile(await readFile(agentFile(project, "ada"), "utf8")).tools).toBeUndefined();
    expect(items.approximated).toContainEqual({
      field: "capabilities",
      detail: "no Claude Code tools list; the agent gets every tool the session allows",
    });
  });

  it("describes an agent without a title by the first sentence of its instructions", async () => {
    const bundle = bundleOf({
      instructions: `# Instructions\n\n- Read the sources first. Then write.\n- ${"Long ".repeat(40)}\n`,
    });

    await claudeCodeAdapter.write(ctx, bundle, COPY);

    const parsed = parseAgentFile(await readFile(agentFile(project, "ada"), "utf8"));
    expect(parsed.description).toBe("Read the sources first.");
  });

  it("cuts a description taken from the instructions to 120 characters", async () => {
    const bundle = bundleOf({ instructions: `${"word ".repeat(40)}end.` });

    await claudeCodeAdapter.write(ctx, bundle, COPY);

    const parsed = parseAgentFile(await readFile(agentFile(project, "ada"), "utf8"));
    expect(parsed.description).toHaveLength(120);
  });

  it("falls back to the name for the description when there is nothing else", async () => {
    await claudeCodeAdapter.write(ctx, bundleOf({ instructions: "" }), COPY);

    const parsed = parseAgentFile(await readFile(agentFile(project, "ada"), "utf8"));
    expect(parsed.description).toBe("Ada");
  });

  it.each([
    ["Ada Lovelace!", "ada-lovelace"],
    ["  Über--Agent  ", "ber-agent"],
    ["!!!", "agent"],
    ["con", "con-agent"],
    ["x".repeat(80), "x".repeat(64)],
  ])("names the file for %j as %s", async (name, slug) => {
    const result = await claudeCodeAdapter.write(ctx, bundleOf({ manifest: { name } }), COPY);

    expect(result.targetAgentId).toBe(slug);
    expect(parseAgentFile(await readFile(agentFile(project, slug), "utf8")).name).toBe(slug);
  });

  it("writes to the working directory without a target directory", async () => {
    const { targetDir: _targetDir, ...noTarget } = ctx;
    const cwd = join(root, "cwd");
    await mkdir(cwd);

    const result = await claudeCodeAdapter.write({ ...noTarget, cwd }, bundleOf({ facts: ["A."] }), COPY);

    expect(result.artifactPath).toBe(agentFile(cwd, "ada"));
    expect(await readFile(join(memoryOf(cwd), "MEMORY.md"), "utf8")).toBe("- A.\n");
  });

  it("never touches <home>/.claude outside the target project's memory directory", async () => {
    const ada = await readBundle(ADA_DIR);
    const target = join(root, "target");
    await mkdir(target);
    const homeBefore = await snapshot(home);
    const sourceBefore = await snapshot(project);

    await claudeCodeAdapter.write({ ...ctx, targetDir: target }, ada, COPY);

    const homeAfter = await snapshot(home);
    const memoryPrefix = `${relative(home, memoryOf(target)).split("\\").join("/")}/`;
    const changed = Object.keys({ ...homeBefore, ...homeAfter }).filter(
      (path) => homeBefore[path] !== homeAfter[path],
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.filter((path) => !path.startsWith(memoryPrefix))).toEqual([]);
    expect(await snapshot(project)).toEqual(sourceBefore);
  });

  it("does not create a memory directory for an agent without facts or notes", async () => {
    const target = join(root, "target");
    await mkdir(target);

    await claudeCodeAdapter.write({ ...ctx, targetDir: target }, bundleOf({}), COPY);

    expect(await exists(memoryOf(target))).toBe(false);
  });

  it("writes memory under CLAUDE_CONFIG_DIR when it is set", async () => {
    const config = join(root, "config");
    const custom = { ...ctx, env: { CLAUDE_CONFIG_DIR: config } };

    await claudeCodeAdapter.write(custom, bundleOf({ facts: ["A."] }), COPY);

    const memory = join(config, "projects", sanitize(resolve(project)), "memory", "MEMORY.md");
    expect(await readFile(memory, "utf8")).toBe("- A.\n");
  });

  it("does not change the Bundle it is given", async () => {
    const ada = await readBundle(ADA_DIR);
    const before = structuredClone(ada);

    await claudeCodeAdapter.write(ctx, ada, COPY);
    await claudeCodeAdapter.write(ctx, ada, UPDATE);

    expect(ada).toEqual(before);
  });

  it("writes a MEMORY.md without a final newline back with one between old and new", async () => {
    const memoryFile = join(memoryOf(project), "MEMORY.md");
    await writeFile(memoryFile, "- Old.");

    await claudeCodeAdapter.write(ctx, bundleOf({ facts: ["New."] }), COPY);

    expect(await readFile(memoryFile, "utf8")).toBe("- Old.\n- New.\n");
  });
});
