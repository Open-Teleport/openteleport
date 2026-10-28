import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

const ADA_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
/** Another agent that is also called Ada. */
const OTHER_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2V";

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

/** Where the adapter records which agent each agent file of `dir` holds, beside its memory. */
const idsOf = (dir: string): string =>
  join(home, ".claude", "projects", sanitize(resolve(dir)), "openteleport-ids.json");

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

/** Ada's `web-brief/SKILL.md`, as the fixture holds it. */
const adaSkill = (): Promise<string> =>
  readFile(join(ADA_DIR, "skills", "web-brief", "SKILL.md"), "utf8");

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
      description: "Reads papers and web pages so you do not have to.",
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
    const ada = (instructions: string) => bundleOf({ manifest: { id: ADA_ID }, instructions });
    await claudeCodeAdapter.write(ctx, ada("First.\n"), COPY);
    await claudeCodeAdapter.write(ctx, ada("Second.\n"), UPDATE);
    expect(parseAgentFile(await readFile(agentFile(project, "ada"), "utf8")).body).toBe("Second.\n");

    const result = await claudeCodeAdapter.write(ctx, ada("Third.\n"), REPLACE);

    expect(result.targetAgentId).toBe("ada");
    expect(parseAgentFile(await readFile(agentFile(project, "ada"), "utf8")).body).toBe("Third.\n");
    expect(await exists(agentFile(project, "ada-2"))).toBe(false);
  });

  describe("telling agents of the same name apart", () => {
    const ada = (id: string, instructions = "Answer briefly.\n") =>
      bundleOf({ manifest: { id }, instructions });
    const bodyOf = async (stem: string) =>
      parseAgentFile(await readFile(agentFile(project, stem), "utf8")).body;
    const ids = async () => JSON.parse(await readFile(idsOf(project), "utf8"));

    it("updates the same agent in place when it is moved again", async () => {
      const first = await claudeCodeAdapter.write(ctx, ada(ADA_ID, "First.\n"), UPDATE);
      const second = await claudeCodeAdapter.write(ctx, ada(ADA_ID, "Second.\n"), UPDATE);

      expect([first.targetAgentId, second.targetAgentId]).toEqual(["ada", "ada"]);
      expect(second.items.warnings).toEqual([]);
      expect(await bodyOf("ada")).toBe("Second.\n");
      expect(await exists(agentFile(project, "ada-2"))).toBe(false);
    });

    it("writes a different agent of the same name as -2 on update, keeping the first", async () => {
      await claudeCodeAdapter.write(ctx, ada(ADA_ID, "First.\n"), UPDATE);
      const other = await claudeCodeAdapter.write(ctx, ada(OTHER_ID, "Other.\n"), UPDATE);

      expect(other.targetAgentId).toBe("ada-2");
      expect(other.items.warnings).toContain("agent 'ada' already exists; written as 'ada-2'");
      expect(await bodyOf("ada")).toBe("First.\n");
      expect(await bodyOf("ada-2")).toBe("Other.\n");
      expect(await ids()).toEqual({ ada: ADA_ID, "ada-2": OTHER_ID });
    });

    it("counts an agent file it has no id for as another agent on update", async () => {
      const before = await readFile(agentFile(project, "reviewer"), "utf8");
      const reviewer = bundleOf({ manifest: { id: ADA_ID, name: "Reviewer" } });

      const result = await claudeCodeAdapter.write(ctx, reviewer, UPDATE);

      expect(result.targetAgentId).toBe("reviewer-2");
      expect(result.items.warnings).toContain(
        "agent 'reviewer' already exists; written as 'reviewer-2'",
      );
      expect(await readFile(agentFile(project, "reviewer"), "utf8")).toBe(before);
    });

    it("never takes an empty id for the agent that is there", async () => {
      await claudeCodeAdapter.write(ctx, bundleOf({}), UPDATE);
      const second = await claudeCodeAdapter.write(ctx, bundleOf({}), UPDATE);

      expect(second.targetAgentId).toBe("ada-2");
      expect(await exists(idsOf(project))).toBe(false);
    });

    it("writes over another agent on replace and records the new one", async () => {
      await claudeCodeAdapter.write(ctx, ada(ADA_ID, "First.\n"), UPDATE);
      const result = await claudeCodeAdapter.write(ctx, ada(OTHER_ID, "Other.\n"), REPLACE);

      expect(result.targetAgentId).toBe("ada");
      expect(await bodyOf("ada")).toBe("Other.\n");
      expect(await ids()).toEqual({ ada: OTHER_ID });
    });

    it("keeps the ids beside the memory directory, never inside it", async () => {
      await claudeCodeAdapter.write(ctx, ada(ADA_ID), UPDATE);

      expect(dirname(idsOf(project))).toBe(dirname(memoryOf(project)));
      expect(await ids()).toEqual({ ada: ADA_ID });
      expect(await readdir(memoryOf(project))).not.toContain("openteleport-ids.json");
    });

    it("starts over from an id map that is not JSON", async () => {
      await mkdir(dirname(idsOf(project)), { recursive: true });
      await writeFile(idsOf(project), "{ not json");

      const result = await claudeCodeAdapter.write(ctx, ada(ADA_ID), UPDATE);

      expect(result.targetAgentId).toBe("ada");
      expect(await ids()).toEqual({ ada: ADA_ID });
    });
  });

  it.each([
    ["update", UPDATE],
    ["copy", COPY],
  ])("writes a skill that exists with other content as <name>-2 on %s, and says so", async (_mode, opts) => {
    const skills = join(project, ".claude", "skills");
    const before = await snapshot(join(skills, "web-brief"));

    const { items } = await claudeCodeAdapter.write(ctx, await readBundle(ADA_DIR), opts);

    expect(await snapshot(join(skills, "web-brief"))).toEqual(before);
    expect(await snapshot(join(skills, "web-brief-2"))).toEqual({ "SKILL.md": await adaSkill() });
    expect(items.warnings).toContain(
      "skill 'web-brief' already exists with different content; written as 'web-brief-2'",
    );
    expect(items.approximated.filter(({ field }) => field.startsWith("skill:"))).toEqual([]);
  });

  it.each([
    ["update", UPDATE],
    ["copy", COPY],
    ["replace", REPLACE],
  ])("reuses a skill with the same files and bytes on %s, writing nothing", async (_mode, opts) => {
    const skills = join(project, ".claude", "skills");
    await rm(join(skills, "web-brief"), { recursive: true });
    await cp(join(ADA_DIR, "skills", "web-brief"), join(skills, "web-brief"), { recursive: true });
    const skillFile = join(skills, "web-brief", "SKILL.md");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(skillFile, old, old);

    const { items } = await claudeCodeAdapter.write(ctx, await readBundle(ADA_DIR), opts);

    expect((await stat(skillFile)).mtimeMs).toBe(old.getTime());
    expect(await exists(join(skills, "web-brief-2"))).toBe(false);
    expect(items.warnings.filter((warning) => warning.includes("web-brief"))).toEqual([]);
  });

  it("replaces a skill in place on replace, leaving none of its old files", async () => {
    const skills = join(project, ".claude", "skills");

    const { items } = await claudeCodeAdapter.write(ctx, await readBundle(ADA_DIR), REPLACE);

    expect(await snapshot(join(skills, "web-brief"))).toEqual({ "SKILL.md": await adaSkill() });
    expect(await exists(join(skills, "web-brief-2"))).toBe(false);
    expect(items.warnings.filter((warning) => warning.includes("web-brief"))).toEqual([]);
  });

  it("does not follow a link inside the skill folder it replaces", async () => {
    const skills = join(project, ".claude", "skills");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "KEEP\n");
    await symlink(outside, join(skills, "web-brief", "linked"), "junction");

    await claudeCodeAdapter.write(ctx, await readBundle(ADA_DIR), REPLACE);

    expect(await snapshot(outside)).toEqual({ "keep.txt": "KEEP\n" });
    expect(await snapshot(join(skills, "web-brief"))).toEqual({ "SKILL.md": await adaSkill() });
  });

  it.each([
    ["update", UPDATE],
    ["copy", COPY],
    ["replace", REPLACE],
  ])("never writes through a linked skill folder on %s", async (_mode, opts) => {
    const skills = join(project, ".claude", "skills");
    const outside = join(root, "outside-skill");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "ORIGINAL\n");
    await rm(join(skills, "web-brief"), { recursive: true });
    await symlink(outside, join(skills, "web-brief"), "junction");

    const { items } = await claudeCodeAdapter.write(ctx, await readBundle(ADA_DIR), opts);

    expect(await snapshot(outside)).toEqual({ "SKILL.md": "ORIGINAL\n" });
    expect((await lstat(join(skills, "web-brief"))).isSymbolicLink()).toBe(true);
    expect(await snapshot(join(skills, "web-brief-2"))).toEqual({ "SKILL.md": await adaSkill() });
    expect(items.warnings).toContain(
      "skill 'web-brief' already exists with different content; written as 'web-brief-2'",
    );
  });

  // The link is never followed, so not even its content is compared.
  it("treats a linked folder with the very same files as different", async () => {
    const skills = join(project, ".claude", "skills");
    const outside = join(root, "outside-skill");
    await cp(join(ADA_DIR, "skills", "web-brief"), outside, { recursive: true });
    await rm(join(skills, "web-brief"), { recursive: true });
    await symlink(outside, join(skills, "web-brief"), "junction");

    await claudeCodeAdapter.write(ctx, await readBundle(ADA_DIR), UPDATE);

    expect(await exists(join(skills, "web-brief-2", "SKILL.md"))).toBe(true);
  });

  it.each([
    ["update", UPDATE],
    ["copy", COPY],
  ])("reuses its own <name>-2 when the same agent moves in again on %s", async (_mode, opts) => {
    const skills = join(project, ".claude", "skills");

    const first = await claudeCodeAdapter.write(ctx, await readBundle(ADA_DIR), opts);
    const skillFile = join(skills, "web-brief-2", "SKILL.md");
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(skillFile, old, old);
    const second = await claudeCodeAdapter.write(ctx, await readBundle(ADA_DIR), opts);

    expect(first.items.warnings).toContain(
      "skill 'web-brief' already exists with different content; written as 'web-brief-2'",
    );
    expect(second.items.warnings.filter((warning) => warning.includes("web-brief"))).toEqual([]);
    expect((await stat(skillFile)).mtimeMs).toBe(old.getTime());
    expect(await exists(join(skills, "web-brief-3"))).toBe(false);
  });

  it("skips a <name>-N that differs and reuses a later one that matches", async () => {
    const skills = join(project, ".claude", "skills");
    await mkdir(join(skills, "web-brief-2"));
    await writeFile(join(skills, "web-brief-2", "SKILL.md"), "Someone else's.\n");
    await cp(join(ADA_DIR, "skills", "web-brief"), join(skills, "web-brief-3"), { recursive: true });

    const { items } = await claudeCodeAdapter.write(ctx, await readBundle(ADA_DIR), COPY);

    expect(await readFile(join(skills, "web-brief-2", "SKILL.md"), "utf8")).toBe("Someone else's.\n");
    expect(await exists(join(skills, "web-brief-4"))).toBe(false);
    expect(items.warnings.filter((warning) => warning.includes("web-brief"))).toEqual([]);
  });

  it.for([
    ["update", UPDATE],
    ["replace", REPLACE],
  ] as const)("writes <slug>-2.md instead of through a linked agent file on %s", async ([, opts], context) => {
    const outside = join(root, "outside.md");
    await writeFile(outside, "ORIGINAL\n");
    await mkdir(join(project, ".claude", "agents"), { recursive: true });
    await fileLink(outside, agentFile(project, "ada"), () => context.skip());

    const result = await claudeCodeAdapter.write(ctx, bundleOf({}), opts);

    expect(await readFile(outside, "utf8")).toBe("ORIGINAL\n");
    expect((await lstat(agentFile(project, "ada"))).isSymbolicLink()).toBe(true);
    expect(result.targetAgentId).toBe("ada-2");
    expect(result.artifactPath).toBe(agentFile(project, "ada-2"));
    expect(parseAgentFile(await readFile(agentFile(project, "ada-2"), "utf8")).name).toBe("ada-2");
    expect(result.items.warnings).toContain("agent file 'ada.md' is a symlink; written as 'ada-2.md'");
  });

  it("does not append facts through a linked MEMORY.md", async (context) => {
    const outside = join(root, "outside-memory.md");
    await writeFile(outside, "- Elsewhere.\n");
    const memoryFile = join(memoryOf(project), "MEMORY.md");
    await rm(memoryFile);
    await fileLink(outside, memoryFile, () => context.skip());

    const { items } = await claudeCodeAdapter.write(ctx, bundleOf({ facts: ["New."] }), COPY);

    expect(await readFile(outside, "utf8")).toBe("- Elsewhere.\n");
    expect(items.skipped).toContainEqual({
      field: "memory.facts",
      detail: `${memoryFile} is a symlink; not written`,
    });
  });

  it("does not write a note through a linked file and still writes the others", async (context) => {
    const outside = join(root, "outside-note.md");
    await writeFile(outside, "ORIGINAL\n");
    const linked = join(memoryOf(project), "imported-ada-first.md");
    await fileLink(outside, linked, () => context.skip());
    const bundle = bundleOf({
      notes: [
        { name: "first", text: "One.\n" },
        { name: "second", text: "Two.\n" },
      ],
    });

    const { items } = await claudeCodeAdapter.write(ctx, bundle, COPY);

    expect(await readFile(outside, "utf8")).toBe("ORIGINAL\n");
    expect(await readFile(join(memoryOf(project), "imported-ada-second.md"), "utf8")).toBe("Two.\n");
    expect(items.skipped).toContainEqual({
      field: "memory.notes",
      detail: `${linked} is a symlink; not written`,
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

  it("keeps all 300 characters of a Claude Code description on a move to another project", async () => {
    const full = `Use this agent when ${"a long review is needed ".repeat(12)}`.slice(0, 299) + ".";
    expect(full).toHaveLength(300);
    await writeFile(
      join(project, ".claude", "agents", "long.md"),
      `---\nname: long\ndescription: ${full}\n---\nReview it.\n`,
    );
    const source = await claudeCodeAdapter.read({ ...ctx, sourceDir: project }, "long");
    const target = join(root, "target");
    await mkdir(target);

    await claudeCodeAdapter.write({ ...ctx, targetDir: target }, source.bundle, COPY);

    const parsed = parseAgentFile(await readFile(agentFile(target, "long"), "utf8"));
    expect(parsed.description).toBe(full);
    expect(parsed.description).toHaveLength(300);
  });

  it("prefers the description to the title, and the title to the instructions", async () => {
    const both = bundleOf({
      manifest: { title: "Short title", description: "The whole description, never cut." },
      instructions: "From the instructions.\n",
    });
    const titleOnly = bundleOf({
      manifest: { name: "Bea", title: "Short title" },
      instructions: "From the instructions.\n",
    });

    await claudeCodeAdapter.write(ctx, both, COPY);
    await claudeCodeAdapter.write(ctx, titleOnly, COPY);

    const description = async (stem: string) =>
      parseAgentFile(await readFile(agentFile(project, stem), "utf8")).description;
    expect(await description("ada")).toBe("The whole description, never cut.");
    expect(await description("bea")).toBe("Short title");
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

  it("never touches <home>/.claude outside the target project's memory and ids", async () => {
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
    const idsFile = relative(home, idsOf(target)).split("\\").join("/");
    const elsewhere = changed.filter((path) => !path.startsWith(memoryPrefix) && path !== idsFile);
    expect(elsewhere).toEqual([]);
    expect(changed).toContain(idsFile);
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
