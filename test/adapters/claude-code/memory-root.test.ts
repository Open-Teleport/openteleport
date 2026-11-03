import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../../../src/adapters/claude-code/index.js";
import { claudeMemoryDir, claudePaths, sanitize } from "../../../src/adapters/claude-code/paths.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import { readBundle } from "../../../src/core/bundle.js";

const ADA = fileURLToPath(new URL("../../fixtures/jetpack/ada", import.meta.url));
const WRITE: WriteOpts = { onConflict: "update", includeFiles: false, enableRoutines: false };
let root: string;
let home: string;
let repo: string;
let linked: string;
let sharedMemory: string;
let ctx: Ctx;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-claude-git-"));
  home = join(root, "home");
  repo = join(root, "repo");
  linked = join(root, "linked");
  await mkdir(home);
  // Keep only process-launch essentials: no inherited Claude directories, credentials or Git config.
  const launchEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP)$/i.test(name),
  ));
  const env = { ...launchEnv, HOME: home, USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  const git = (...args: string[]) => execa("git", args, { cwd: root, env });
  await git("init", "-b", "main", repo);
  await git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  await git("-C", repo, "worktree", "add", "--detach", linked, "HEAD");
  sharedMemory = join(home, ".claude", "projects", sanitize(repo), "memory");
  await mkdir(sharedMemory, { recursive: true });
  await writeFile(join(sharedMemory, "MEMORY.md"), "- Shared repository fact.\n");
  ctx = { home, cwd: root, env, exec: execa, logger: () => {} };
});

afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 3 }); });

async function location(which: string): Promise<string> {
  const dir = which.startsWith("worktree") ? linked : repo;
  const project = which.endsWith("subfolder") ? join(dir, "nested") : dir;
  await mkdir(join(project, ".claude", "agents"), { recursive: true });
  await writeFile(join(project, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Synthetic reviewer\n---\nReview changes.\n");
  return project;
}

describe("Claude Code repository memory", () => {
  it.each(["main", "subfolder", "worktree", "worktree-subfolder"])("reads the shared memory from %s", async (which) => {
    const project = await location(which);
    const result = await claudeCodeAdapter.read({ ...ctx, sourceDir: project }, "reviewer");
    expect(result.bundle.facts).toContain("Shared repository fact.");
    expect(await readFile(join(sharedMemory, "MEMORY.md"), "utf8")).toBe("- Shared repository fact.\n");
  });

  it.each(["subfolder", "worktree", "worktree-subfolder"])("appends memory to the shared root when importing into %s", async (which) => {
    const project = await location(which);
    const bundle = { ...await readBundle(ADA), facts: ["Imported worktree fact."], notes: [], skills: [], routines: [] };
    const result = await claudeCodeAdapter.write({ ...ctx, targetDir: project }, bundle, WRITE);
    const memory = await readFile(join(sharedMemory, "MEMORY.md"), "utf8");
    expect(memory).toContain("Shared repository fact.");
    expect(memory).toContain("Imported worktree fact.");
    expect(await readFile(join(project, ".claude", "agents", `${result.targetAgentId}.md`), "utf8")).toContain(bundle.instructions);
    await expect(readFile(join(home, ".claude", "projects", sanitize(project), "memory", "MEMORY.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a Git lookup failure before creating an agent or changing memory", async () => {
    const project = join(linked, "not-created");
    const exec = (async () => { throw new Error("Git unavailable"); }) as unknown as Ctx["exec"];
    await expect(claudeCodeAdapter.write({ ...ctx, exec, targetDir: project }, await readBundle(ADA), WRITE)).rejects.toThrow(/Git lookup failed/);
    await expect(readFile(join(project, ".claude", "agents", "ada-lovelace.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(sharedMemory, "MEMORY.md"), "utf8")).toBe("- Shared repository fact.\n");
  });

  it("ignores inherited Git routing variables when finding memory", async () => {
    const project = await location("worktree-subfolder");
    const env = { ...ctx.env, GIT_DIR: join(root, "not-a-repo"), GIT_WORK_TREE: root };
    const read = await claudeCodeAdapter.read({ ...ctx, env, sourceDir: project }, "reviewer");
    expect(read.bundle.facts).toContain("Shared repository fact.");
  });

  it("honors a valid project-key override only beside CLAUDE_CONFIG_DIR", async () => {
    const project = await location("worktree");
    const key = "shared-project_42";
    const config = join(home, ".claude");
    await mkdir(join(config, "projects", key, "memory"), { recursive: true });
    await writeFile(join(config, "projects", key, "memory", "MEMORY.md"), "- Explicit shared memory.\n");
    const env = { ...ctx.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: key };
    const read = await claudeCodeAdapter.read({ ...ctx, env, sourceDir: project }, "reviewer");
    expect(read.bundle.facts).toEqual(["Explicit shared memory."]);
    const unpaired = await claudeCodeAdapter.read({ ...ctx, env: { ...ctx.env, CLAUDE_CODE_PROJECT_DIR_NAME: key }, sourceDir: project }, "reviewer");
    expect(unpaired.bundle.facts).toContain("Shared repository fact.");
  });

  it.each(["../outside", "CON", "a".repeat(65)])("uses the normal memory root for an invalid project key: %s", async (key) => {
    const context = { ...ctx, sourceDir: linked, env: { ...ctx.env, CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_CODE_PROJECT_DIR_NAME: key } };
    expect(await claudeMemoryDir(context, claudePaths(context))).toBe(sharedMemory);
  });

  it("keeps plain folders independent and needs no Git command", async () => {
    const project = join(root, "plain");
    await mkdir(project);
    const exec = (() => { throw new Error("No command expected"); }) as unknown as Ctx["exec"];
    const context = { ...ctx, exec, sourceDir: project };
    expect(await claudeMemoryDir(context, claudePaths(context))).toBe(join(home, ".claude", "projects", sanitize(project), "memory"));
  });

  it("uses the nearest repository when repositories are nested", async () => {
    const inner = join(repo, "inner");
    await execa("git", ["init", "-b", "main", inner], { cwd: root, env: ctx.env });
    const context = { ...ctx, sourceDir: inner };
    expect(await claudeMemoryDir(context, claudePaths(context))).toBe(join(home, ".claude", "projects", sanitize(inner), "memory"));
  });

  it("keeps agent identities separate between checkouts that share memory", async () => {
    const bundle = { ...await readBundle(ADA), notes: [], skills: [], routines: [] };
    const other = { ...bundle, manifest: { ...bundle.manifest, id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2V" } };
    const main = await claudeCodeAdapter.write({ ...ctx, targetDir: repo }, bundle, WRITE);
    const copy = await claudeCodeAdapter.write({ ...ctx, targetDir: linked }, other, WRITE);
    expect(copy.targetAgentId).toBe(main.targetAgentId);
    expect((await claudeCodeAdapter.read({ ...ctx, sourceDir: repo }, main.targetAgentId!)).bundle.manifest.id).toBe(bundle.manifest.id);
    expect((await claudeCodeAdapter.read({ ...ctx, sourceDir: linked }, copy.targetAgentId!)).bundle.manifest.id).toBe(other.manifest.id);
  });
});
