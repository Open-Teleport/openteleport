import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import claudeCodeDefault, { claudeCodeAdapter } from "../../../src/adapters/claude-code/index.js";
import { sanitize } from "../../../src/adapters/claude-code/paths.js";
import type { Ctx } from "../../../src/adapters/types.js";

const FIXTURES = fileURLToPath(new URL("../../fixtures/claude-code", import.meta.url));
/** The home fixture keeps its memory under this name; setup renames it for the temp project. */
const PLACEHOLDER = "__project__";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let root: string;
let project: string;
let home: string;
let memory: string;
let ctx: Ctx;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-claude-read-"));
  project = join(root, "project");
  home = join(root, "home");
  await cp(join(FIXTURES, "project"), project, { recursive: true });
  await cp(join(FIXTURES, "home"), home, { recursive: true });
  const projects = join(home, ".claude", "projects");
  await rename(join(projects, PLACEHOLDER), join(projects, sanitize(resolve(project))));
  memory = join(projects, sanitize(resolve(project)), "memory");
  ctx = { sourceDir: project, home, cwd: root, env: {}, exec: noExec, logger: () => {} };
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

/** Fixtures may be checked out with CRLF line endings on Windows. */
const lf = (text: string | undefined): string | undefined => text?.replace(/\r\n/g, "\n");

describe("claude-code adapter", () => {
  it("is exported as a named and a default export", () => {
    expect(claudeCodeDefault).toBe(claudeCodeAdapter);
    expect(claudeCodeAdapter.name).toBe("claude-code");
    expect(claudeCodeAdapter.displayName).toBe("Claude Code");
  });

  it("declares what Claude Code can hold", () => {
    expect(claudeCodeAdapter.capabilities).toEqual({
      persona: true,
      instructions: true,
      skills: true,
      routines: false,
      facts: true,
      notes: true,
      files: false,
      avatar: false,
      models: true,
      schedules: [],
    });
  });
});

describe("read", () => {
  it("reads a project agent with persona, instructions, model, tools, skills and memory", async () => {
    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.persona).toBe(
      "A meticulous senior engineer who explains every finding in plain words.",
    );
    expect(bundle.instructions).toBe(
      [
        "1. Read the diff and every file it touches.",
        "2. Report bugs first, then style, each with the line it is about.",
        "3. Never push or merge.",
      ].join("\n"),
    );
    expect(bundle.manifest.models).toEqual([
      { runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" },
    ]);
    expect(bundle.manifest.models[0]?.model).toBe("claude-opus-5-5");
    expect(bundle.manifest.capabilities).toContain("shell");
    expect(bundle.manifest.capabilities).toContain("filesystem");
    expect(bundle.manifest.capabilities).toEqual(["shell", "filesystem"]);
    expect(bundle.facts.length).toBe(2);
    expect(bundle.facts).toEqual([
      "Prefers reviews that cite the line they are about.",
      "[Release checklist](2026-10-20.md) — run the full test suite before tagging.",
    ]);
    expect(bundle.skills.map((skill) => skill.name)).toEqual(["web-brief"]);
    expect(warnings).toContain("capabilities are derived from the tools list");
    expect(warnings).toContain("Claude Code skills are project-wide; all were exported");
    expect(warnings).not.toContain("model is inherited; not exported");
  });

  it("fills the manifest from the frontmatter", async () => {
    const { bundle } = await claudeCodeAdapter.read(ctx, "reviewer");
    const { exportedAt, ...origin } = bundle.manifest.origin ?? { exportedAt: "" };

    expect(bundle.manifest).toMatchObject({
      schemaVersion: "0.1",
      id: "",
      name: "reviewer",
      title:
        "Reviews pull requests for correctness and style. Use it after every change, before you merge.",
      "x-claude-code": {
        tools: ["Read", "Grep", "Bash"],
        model: "claude-opus-5-5",
        scope: "project",
      },
    });
    expect(bundle.manifest.description).toBeUndefined();
    expect(origin).toEqual({ app: "claude-code" });
    expect(Number.isNaN(Date.parse(exportedAt))).toBe(false);
    expect(bundle.routines).toEqual([]);
    expect(bundle.files).toEqual([]);
    expect(bundle.unknownPaths).toEqual([]);
    expect(bundle.avatar).toBeUndefined();
  });

  it("exports every file of a skill, SKILL.md first, and skips folders without SKILL.md", async () => {
    const { bundle } = await claudeCodeAdapter.read(ctx, "reviewer");
    const [skill] = bundle.skills;

    expect(skill?.files.map((file) => file.path)).toEqual(["SKILL.md", "references/checklist.md"]);
    expect(lf(new TextDecoder().decode(skill?.files[1]?.bytes))).toBe(
      "- Read the page end to end.\n- Note the date it was published.\n",
    );
  });

  it("turns the other lines of MEMORY.md and the other memory files into notes", async () => {
    const { bundle } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.notes.map((note) => note.name)).toEqual(["2026-10-20", "MEMORY-prose"]);
    expect(lf(bundle.notes[0]?.text)).toContain("Run the tests on all three systems, then tag.");
    expect(bundle.notes[1]?.text).toBe(
      "Stable facts about this project; the details live in the other files.",
    );
  });

  it("does not export the project-wide CLAUDE.md", async () => {
    const { bundle } = await claudeCodeAdapter.read(ctx, "reviewer");
    expect(bundle.instructions).not.toContain("Project rules");
    expect(bundle.persona).not.toContain("Project rules");
  });

  it("reads an agent without model, tools or persona headings", async () => {
    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "plain");

    expect(bundle.manifest.models).toEqual([]);
    expect(warnings).toContain("model is inherited; not exported");
    expect(warnings).toContain("tools are not declared; capabilities unknown");
    expect(warnings).not.toContain("capabilities are derived from the tools list");
    expect(bundle.persona).toBeUndefined();
    expect(bundle.instructions).toBe(
      "Answer questions about the build scripts in this repository. Keep every answer short.\n",
    );
    expect(bundle.manifest.capabilities).toEqual([]);
    expect(bundle.manifest["x-claude-code"]).toEqual({ tools: [], scope: "project" });
  });

  it("reads a user agent with a YAML tools list and an inherited model", async () => {
    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "scout");

    expect(bundle.manifest.capabilities).toEqual(["browser", "filesystem", "network"]);
    expect(bundle.manifest.models).toEqual([]);
    expect(warnings).toContain("model is inherited; not exported");
    expect(warnings).toContain("frontmatter fields not exported: color");
    expect(bundle.manifest["x-claude-code"]).toEqual({
      tools: ["WebFetch", "WebSearch", "mcp__claude-in-chrome__navigate", "Glob"],
      model: "inherit",
      scope: "user",
    });
  });

  it("prefers the project agent and reaches the user copy through user:<stem>", async () => {
    const fromProject = await claudeCodeAdapter.read(ctx, "reviewer");
    const fromUser = await claudeCodeAdapter.read(ctx, "user:reviewer");

    expect(fromProject.bundle.manifest["x-claude-code"]).toMatchObject({ scope: "project" });
    expect(fromUser.bundle.manifest["x-claude-code"]).toMatchObject({ scope: "user" });
    expect(fromUser.bundle.manifest.title).toBe(
      "The user-wide reviewer, shadowed by the one in the project.",
    );
    expect(fromUser.bundle.instructions).toBe("Review whatever you are given.\n");
  });

  it("names the available agents when the one asked for is missing", async () => {
    await expect(claudeCodeAdapter.read(ctx, "nope")).rejects.toThrow(
      /"nope".*plain, reviewer, user:reviewer, scout/,
    );
    await expect(claudeCodeAdapter.read(ctx, "user:plain")).rejects.toThrow(/user:plain/);
  });

  it("never reads outside the agents directories", async () => {
    await writeFile(join(project, ".claude", "outside.md"), "---\nname: outside\n---\nNo.\n");
    await expect(claudeCodeAdapter.read(ctx, "../outside")).rejects.toThrow(/Available/);
  });

  it("says when there are no agents at all", async () => {
    const empty = join(root, "empty");
    await mkdir(empty);
    const bare = { ...ctx, sourceDir: empty, home: empty };
    await expect(claudeCodeAdapter.read(bare, "reviewer")).rejects.toThrow(/no agents/);
  });

  it("names a file without frontmatter after its stem", async () => {
    await writeFile(join(project, ".claude", "agents", "bare.md"), "Do the thing.\n");

    const { bundle } = await claudeCodeAdapter.read(ctx, "bare");

    expect(bundle.manifest.name).toBe("bare");
    expect(bundle.instructions).toBe("Do the thing.\n");
    expect(bundle.manifest.title).toBeUndefined();
  });

  it("names the file when its frontmatter is broken", async () => {
    await writeFile(join(project, ".claude", "agents", "broken.md"), "---\nname: [x\n---\n");
    await expect(claudeCodeAdapter.read(ctx, "broken")).rejects.toThrow(/broken\.md/);
  });

  it("cuts a long description to a 120-character title and keeps it whole as the description", async () => {
    const description = `Use this agent when ${"the build needs attention ".repeat(8)}now.`;
    await writeFile(
      join(project, ".claude", "agents", "long.md"),
      `---\nname: long\ndescription: ${description}\n---\nBody\n`,
    );

    const { bundle } = await claudeCodeAdapter.read(ctx, "long");

    expect(bundle.manifest.title).toHaveLength(120);
    expect(bundle.manifest.title?.endsWith("…")).toBe(true);
    expect(bundle.manifest.description).toBe(description);
  });

  it("keeps the raw model value without expanding aliases", async () => {
    await writeFile(
      join(project, ".claude", "agents", "fast.md"),
      "---\nname: fast\ndescription: Quick answers.\nmodel: haiku\n---\nBe quick.\n",
    );

    const { bundle } = await claudeCodeAdapter.read(ctx, "fast");

    expect(bundle.manifest.models).toEqual([
      { runtime: "claude-code", provider: "anthropic", model: "haiku" },
    ]);
  });

  it("maps tool names to capabilities by case-insensitive prefix", async () => {
    await writeFile(
      join(project, ".claude", "agents", "tools.md"),
      [
        "---",
        "name: tools",
        "tools: bash(npm test:*), NotebookEdit, webfetch(domain:example.com), mcp__Claude_Browser__click, BrowserBatch, TodoWrite",
        "---",
        "Body",
      ].join("\n"),
    );

    const { bundle } = await claudeCodeAdapter.read(ctx, "tools");

    expect(bundle.manifest.capabilities).toEqual(["browser", "shell", "filesystem", "network"]);
  });

  it("takes the PowerShell tool for a shell too", async () => {
    await writeFile(
      join(project, ".claude", "agents", "pwsh.md"),
      "---\nname: pwsh\ntools: PowerShell\n---\nBody\n",
    );

    const { bundle } = await claudeCodeAdapter.read(ctx, "pwsh");

    expect(bundle.manifest.capabilities).toEqual(["shell"]);
  });

  it("derives no capability from tools it does not know", async () => {
    await writeFile(
      join(project, ".claude", "agents", "todo.md"),
      "---\nname: todo\ntools: TodoWrite, Task\n---\nBody\n",
    );

    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "todo");

    expect(bundle.manifest.capabilities).toEqual([]);
    expect(warnings).not.toContain("capabilities are derived from the tools list");
    expect(warnings).not.toContain("tools are not declared; capabilities unknown");
  });

  it("exports no facts and warns about nothing when there is no memory", async () => {
    await rm(memory, { recursive: true });

    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.facts).toEqual([]);
    expect(bundle.notes).toEqual([]);
    expect(warnings.filter((warning) => /memory|fact/i.test(warning))).toEqual([]);
  });

  it("keeps a fact over 500 characters as a note and says so", async () => {
    const long = "x".repeat(501);
    await writeFile(join(memory, "MEMORY.md"), `- Short fact.\n- ${long}\n`);

    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.facts).toEqual(["Short fact."]);
    expect(bundle.notes.find((note) => note.name === "MEMORY-long")?.text).toBe(`- ${long}`);
    expect(warnings).toContain("1 fact over 500 characters was kept as the note MEMORY-long");
  });

  it("exports no skills and no skills warning when the project has none", async () => {
    await rm(join(project, ".claude", "skills"), { recursive: true });

    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.skills).toEqual([]);
    expect(warnings).not.toContain("Claude Code skills are project-wide; all were exported");
  });

  it("leaves forbidden files out of a skill and says so", async () => {
    await writeFile(join(project, ".claude", "skills", "web-brief", ".env"), "TOKEN=1\n");

    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.skills[0]?.files.map((file) => file.path)).not.toContain(".env");
    expect(warnings).toContain("skill 'web-brief': left out '.env'");
  });

  /** A folder outside `.claude/skills` that looks like a skill and holds a file not to export. */
  async function elsewhere(): Promise<string> {
    const dir = join(root, "elsewhere");
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), "# Linked\n");
    await writeFile(join(dir, "secret.txt"), "not for export\n");
    return dir;
  }

  /** A file symlink, or a skipped test where the system does not allow one. */
  async function fileLink(target: string, path: string, skip: () => void): Promise<void> {
    try {
      await symlink(target, path, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") skip();
      throw error;
    }
  }

  it("does not follow a linked skill folder and says so", async () => {
    await symlink(await elsewhere(), join(project, ".claude", "skills", "linked"), "junction");

    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.skills.map((skill) => skill.name)).toEqual(["web-brief"]);
    expect(warnings).toContain("skill 'linked' is a symlink; not exported");
  });

  it("leaves a linked folder inside a skill out and says so", async () => {
    const skill = join(project, ".claude", "skills", "web-brief");
    await symlink(await elsewhere(), join(skill, "linked-dir"), "junction");

    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.skills[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/checklist.md",
    ]);
    expect(warnings).toContain("skill 'web-brief': 'linked-dir' is a symlink; not exported");
  });

  it("leaves a linked file inside a skill out and says so", async (context) => {
    const skill = join(project, ".claude", "skills", "web-brief");
    const outside = await elsewhere();
    await fileLink(join(outside, "secret.txt"), join(skill, "linked.txt"), () => context.skip());

    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.skills[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/checklist.md",
    ]);
    expect(warnings).toContain("skill 'web-brief': 'linked.txt' is a symlink; not exported");
  });

  it("does not export a skill whose SKILL.md is a link", async (context) => {
    const dir = join(project, ".claude", "skills", "borrowed");
    await mkdir(dir);
    await fileLink(join(await elsewhere(), "SKILL.md"), join(dir, "SKILL.md"), () => context.skip());

    const { bundle, warnings } = await claudeCodeAdapter.read(ctx, "reviewer");

    expect(bundle.skills.map((skill) => skill.name)).toEqual(["web-brief"]);
    expect(warnings).toContain("skill 'borrowed': 'SKILL.md' is a symlink; not exported");
  });

  it("reads user agents and memory from CLAUDE_CONFIG_DIR", async () => {
    const config = join(root, "config");
    await cp(join(home, ".claude"), config, { recursive: true });
    await rm(join(home, ".claude"), { recursive: true });
    const custom = { ...ctx, env: { CLAUDE_CONFIG_DIR: config } };

    const scout = await claudeCodeAdapter.read(custom, "scout");
    const reviewer = await claudeCodeAdapter.read(custom, "reviewer");

    expect(scout.bundle.manifest.name).toBe("scout");
    expect(reviewer.bundle.facts.length).toBe(2);
  });

  it("never modifies the source", async () => {
    const before = { project: await snapshot(project), home: await snapshot(home) };

    await claudeCodeAdapter.read(ctx, "reviewer");
    await claudeCodeAdapter.read(ctx, "user:reviewer");

    expect({ project: await snapshot(project), home: await snapshot(home) }).toEqual(before);
  });
});

describe("list", () => {
  it("lists project agents, then user agents, the shadowed user copy as user:<stem>", async () => {
    const agents = await claudeCodeAdapter.list(ctx);

    expect(agents).toEqual([
      {
        id: "plain",
        name: "plain",
        title: "Answers questions about the build.",
        location: join(project, ".claude", "agents", "plain.md"),
      },
      {
        id: "reviewer",
        name: "reviewer",
        title:
          "Reviews pull requests for correctness and style. Use it after every change, before you merge.",
        location: join(project, ".claude", "agents", "reviewer.md"),
      },
      {
        id: "user:reviewer",
        name: "reviewer",
        title: "The user-wide reviewer, shadowed by the one in the project.",
        location: join(home, ".claude", "agents", "reviewer.md"),
      },
      {
        id: "scout",
        name: "scout",
        title: "Researches a topic on the web and in the repository.",
        location: join(home, ".claude", "agents", "scout.md"),
      },
    ]);
  });

  it("lists every agent once when the project is the home directory", async () => {
    const atHome = { ...ctx, sourceDir: home };
    const ids = (await claudeCodeAdapter.list(atHome)).map((agent) => agent.id);
    expect(ids).toEqual(["reviewer", "scout"]);
  });

  it("lists an agent with broken frontmatter under its stem", async () => {
    await writeFile(join(project, ".claude", "agents", "broken.md"), "---\nname: [x\n---\n");

    const agents = await claudeCodeAdapter.list(ctx);

    expect(agents.find((agent) => agent.id === "broken")).toEqual({
      id: "broken",
      name: "broken",
      location: join(project, ".claude", "agents", "broken.md"),
    });
  });

  it("is empty when there are no agents", async () => {
    const empty = join(root, "empty");
    await mkdir(empty);
    expect(await claudeCodeAdapter.list({ ...ctx, sourceDir: empty, home: empty })).toEqual([]);
  });
});

describe("detect", () => {
  const versionExec = (stdout: string) => (async () => ({ stdout })) as unknown as typeof execa;
  const failingExec = (async () => {
    throw new Error("spawn claude ENOENT");
  }) as unknown as typeof execa;

  it("finds a project with .claude and reports the CLI version", async () => {
    const found = await claudeCodeAdapter.detect({
      ...ctx,
      exec: versionExec("2.1.273 (Claude Code)\n"),
    });

    expect(found).toEqual({ found: true, location: project, version: "2.1.273" });
  });

  it("finds the user directory alone and leaves the version out when the CLI fails", async () => {
    const bare = join(root, "bare");
    await mkdir(bare);

    const found = await claudeCodeAdapter.detect({ ...ctx, sourceDir: bare, exec: failingExec });

    expect(found).toEqual({ found: true, location: bare });
  });

  it("says how to point at a project when nothing is found", async () => {
    const bare = join(root, "bare");
    await mkdir(bare);

    const found = await claudeCodeAdapter.detect({
      ...ctx,
      sourceDir: bare,
      home: bare,
      exec: failingExec,
    });

    expect(found).toEqual({
      found: false,
      location: bare,
      hint: "Pass --source-dir <project with .claude/agents>",
    });
  });
});
