import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { execa } from "execa";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexAdapter } from "../../../src/adapters/codex/index.js";
import { readCodexAgent } from "../../../src/adapters/codex/read.js";
import { writeCodexAgent } from "../../../src/adapters/codex/write.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import { exportBundle, importBundle } from "../../../src/core/engine.js";
import { readBundle } from "../../../src/core/bundle.js";
import type { Bundle, Skill } from "../../../src/core/schema.js";

const ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T";
const UPDATE: WriteOpts = { onConflict: "update", includeFiles: false, enableRoutines: false };
const COPY: WriteOpts = { ...UPDATE, onConflict: "copy" };
const skill = (name: string, text = "original"): Skill => ({
  name, files: [
    { path: "SKILL.md", bytes: new TextEncoder().encode("---\nname: " + name + "\ndescription: Synthetic skill\n---\n" + text) },
    { path: "scripts/example.txt", bytes: new TextEncoder().encode("synthetic companion") },
  ],
});
const bundle = (skills: Skill[] = [skill("probe-skill")]): Bundle => ({
  manifest: { schemaVersion: "0.1", id: ID, name: "Probe Agent", models: [], capabilities: [] },
  instructions: "Synthetic instructions", skills, facts: [], notes: [], routines: [], files: [], unknownPaths: [],
});
let root: string, home: string, codex: string, ctx: Ctx;
const agentPath = (slug: string): string => join(codex, "agents", slug + ".toml");
const metadataPath = (slug = "probe-agent"): string => join(codex, "openteleport-skills", slug + ".json");
const skillDir = (name: string): string => join(home, ".agents", "skills", name);
const parsedAgent = async (slug: string) => parse(await readFile(agentPath(slug), "utf8"));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-codex-roundtrip-test-"));
  home = join(root, "user"); codex = join(home, ".codex");
  await mkdir(codex, { recursive: true });
  ctx = { home, cwd: root, env: {}, sourceDir: codex, targetDir: codex,
    exec: (() => { throw new Error("No process expected"); }) as unknown as typeof execa,
    logger: () => {} };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("Codex role identity", () => {
  it("copies distinct roles, updates the original, and reports the actual copy name", async () => {
    await writeCodexAgent(ctx, bundle(), UPDATE);
    const original = await readFile(agentPath("probe-agent"), "utf8");
    const copy = await writeCodexAgent(ctx, bundle(), COPY);
    expect((await parsedAgent("probe-agent")).name).toBe("Probe Agent");
    expect((await parsedAgent("probe-agent-2")).name).toBe("Probe Agent-2");
    expect(copy.items.warnings).toContain('Use the Codex agent named "Probe Agent-2" (file: probe-agent-2.toml)');
    expect(await readFile(agentPath("probe-agent"), "utf8")).toBe(original);
    await writeCodexAgent(ctx, { ...bundle(), instructions: "Updated original" }, UPDATE);
    expect((await parsedAgent("probe-agent")).developer_instructions).toBe("Updated original");
    expect((await parsedAgent("probe-agent-2")).developer_instructions).toBe("Synthetic instructions");
    const exportedCopy = (await readCodexAgent(ctx, "probe-agent-2")).bundle;
    await writeCodexAgent(ctx, { ...exportedCopy, instructions: "Updated copy" }, UPDATE);
    expect((await parsedAgent("probe-agent-2")).name).toBe("Probe Agent-2");
    expect((await parsedAgent("probe-agent-2")).developer_instructions).toBe("Updated copy");
    expect(await readdir(join(codex, "agents"))).toHaveLength(2);
  });

  it("checks runtime names even under unrelated file names", async () => {
    await mkdir(join(codex, "agents"));
    const foreign = 'name = "Probe Agent"\ndescription = "Foreign"\ndeveloper_instructions = "Keep"\n';
    await writeFile(agentPath("unrelated-file"), foreign);
    await writeFile(agentPath("another-file"), foreign.replace('"Probe Agent"', '"Probe Agent-2"'));
    await writeCodexAgent(ctx, bundle([]), UPDATE);
    expect((await parsedAgent("probe-agent")).name).toBe("Probe Agent-3");
    expect(await readFile(agentPath("unrelated-file"), "utf8")).toBe(foreign);
  });

  it("preserves an owned role's edited name when updating", async () => {
    await writeCodexAgent(ctx, bundle([]), UPDATE);
    const text = await readFile(agentPath("probe-agent"), "utf8");
    await writeFile(agentPath("probe-agent"), text.replace('name = "Probe Agent"', 'name = "Renamed"'));
    await writeCodexAgent(ctx, bundle([]), UPDATE);
    expect((await parsedAgent("probe-agent")).name).toBe("Renamed");
  });
});

describe("Codex associated skill export", () => {
  it("round-trips a skill through the engine and archive without collecting unrelated skills", async () => {
    const input = bundle();
    await importBundle({ to: codexAdapter, bundle: input, ctx, write: UPDATE });
    await mkdir(skillDir("unrelated"), { recursive: true });
    await writeFile(join(skillDir("unrelated"), "SKILL.md"), "Do not export");
    const out = join(root, "exported.jetpack");
    const result = await exportBundle({ from: codexAdapter, agent: "probe-agent", ctx, out, includeFiles: false });
    const archive = await readBundle(out);
    expect(archive.skills).toEqual(input.skills);
    expect(result.report.warnings).toEqual([]);
    expect(result.report.moved).toContainEqual({ field: "skills", detail: "1 skill" });
  });

  it("records a renamed folder and reuses it on update while keeping the portable name", async () => {
    await mkdir(skillDir("probe-skill"), { recursive: true });
    await writeFile(join(skillDir("probe-skill"), "SKILL.md"), "Foreign content");
    await writeCodexAgent(ctx, bundle(), UPDATE);
    await writeCodexAgent(ctx, bundle(), UPDATE);
    expect(JSON.parse(await readFile(metadataPath(), "utf8")).skills).toEqual([
      { name: "probe-skill", folder: "probe-skill-2" },
    ]);
    expect((await readCodexAgent(ctx, "probe-agent")).bundle.skills).toEqual(bundle().skills);
    expect(await readdir(join(home, ".agents", "skills"))).toHaveLength(2);
    expect(await readFile(join(skillDir("probe-skill"), "SKILL.md"), "utf8")).toBe("Foreign content");
  });

  it("keeps separate associations for copies and drops withdrawn skills without deleting shared files", async () => {
    await writeCodexAgent(ctx, bundle(), UPDATE);
    await writeCodexAgent(ctx, bundle([skill("other-skill")]), COPY);
    await writeCodexAgent(ctx, bundle([]), UPDATE);
    expect((await readCodexAgent(ctx, "probe-agent")).bundle.skills).toEqual([]);
    expect((await readCodexAgent(ctx, "probe-agent-2")).bundle.skills).toEqual([skill("other-skill")]);
    expect(await readFile(join(skillDir("probe-skill"), "SKILL.md"), "utf8")).toContain("original");
  });

  it("warns when an associated skill disappears", async () => {
    await writeCodexAgent(ctx, bundle(), UPDATE);
    await rm(join(skillDir("probe-skill"), "SKILL.md"));
    const result = await readCodexAgent(ctx, "probe-agent");
    expect(result.bundle.skills).toEqual([]);
    expect(result.warnings).toContain("associated skill 'probe-skill' (probe-skill) is missing or linked; not exported");
  });

  it.each(["missing", "malformed", "traversal", "stale"])("warns about %s metadata without collecting global skills", async (kind) => {
    await writeCodexAgent(ctx, bundle(), UPDATE);
    if (kind === "missing") await rm(metadataPath());
    if (kind === "malformed") await writeFile(metadataPath(), "{");
    if (kind === "traversal") await writeFile(metadataPath(), JSON.stringify({
      version: 1, id: ID, skills: [{ name: "outside", folder: "../../outside" }],
    }));
    if (kind === "stale") await writeFile(metadataPath(), JSON.stringify({
      version: 1, id: "different-id", skills: [{ name: "probe-skill", folder: "probe-skill" }],
    }));
    const result = await readCodexAgent(ctx, "probe-agent");
    expect(result.bundle.skills).toEqual([]);
    expect(result.warnings).toContain("skills for agent 'probe-agent' not exported: no valid OpenTeleport skill associations; shared skills are not included automatically");
  });

  it("does not follow an associated skill directory replaced with a junction", async () => {
    await writeCodexAgent(ctx, bundle(), UPDATE);
    // Remove only this test's known temporary skill directory.
    await rm(skillDir("probe-skill"), { recursive: true });
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), "Private unrelated text");
    await symlink(outside, skillDir("probe-skill"), "junction");
    const result = await readCodexAgent(ctx, "probe-agent");
    expect(result.bundle.skills).toEqual([]);
    expect(result.warnings.join("\n")).toContain("missing or linked");
  });

  it("refuses a redirected metadata directory before creating an agent or skills", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(codex, "openteleport-skills"), "junction");
    await expect(writeCodexAgent(ctx, bundle(), UPDATE)).rejects.toThrow(/metadata directory/);
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(codex)).toEqual(["openteleport-skills"]);
    await expect(readFile(agentPath("probe-agent"))).rejects.toThrow();
  });
});
