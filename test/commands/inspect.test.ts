import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBundle, writeBundle } from "../../src/core/bundle.js";
import {
  ADA_DIR,
  ADA_ID,
  NO_MANIFEST_DIR,
  type Sandbox,
  json,
  run,
  sandbox,
} from "../helpers/cli.js";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

describe("inspect", () => {
  it("describes a folder without a manifest", async () => {
    const result = await run(box, ["inspect", NO_MANIFEST_DIR]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split(/\r?\n/);
    expect(lines).toContain("name: no-manifest");
    expect(lines).toContain("id: (none)");
    expect(lines).toContain("skills: 1");
    expect(lines).toContain("facts: 1");
    expect(lines).toContain("routines: 0");
    expect(result.stdout).toMatch(/^size: \d+ bytes$/m);
    expect(lines).toContain("warning: no jetpack.json; manifest would be synthesized");
  });

  it("refuses a .jetpack archive without jetpack.json with exit 1", async () => {
    const file = join(box.root, "bare.jetpack");
    await writeFile(file, zipSync({ "AGENTS.md": new TextEncoder().encode("# Bare\n") }));
    const result = await run(box, ["inspect", file]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing jetpack.json");
  });

  it("describes a .jetpack archive as JSON", async () => {
    const file = join(box.root, "ada.jetpack");
    await writeBundle(await readBundle(ADA_DIR), file);
    const result = await run(box, ["inspect", file, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(json(result)).toEqual({
      name: "Ada",
      id: ADA_ID,
      title: "Research assistant",
      models: [
        { runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" },
        { runtime: "codex", provider: "openai", model: "gpt-5.5" },
      ],
      policy: null,
      counts: { skills: 1, routines: 1, facts: 2, notes: 2, files: 0 },
      bytes: (await stat(file)).size,
      warnings: [],
    });
  });

  it("names the models in the human output", async () => {
    const result = await run(box, ["inspect", ADA_DIR]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "models: claude-code/anthropic/claude-opus-5-5, codex/openai/gpt-5.5",
    );
  });

  it("summarizes the policy, and says none without one", async () => {
    expect((await run(box, ["inspect", ADA_DIR])).stdout).toContain("policy: (none)");
    const bundle = await readBundle(ADA_DIR);
    const policy = {
      mode: "ask" as const,
      rules: [{ effect: "deny" as const, on: "tool" as const, tool: "WebFetch" }],
    };
    const file = join(box.root, "ruled.jetpack");
    await writeBundle({ ...bundle, manifest: { ...bundle.manifest, policy } }, file);
    const result = await run(box, ["inspect", file]);
    expect(result.stdout).toContain("policy: mode ask, 1 rule");
    expect(json(await run(box, ["inspect", file, "--json"])).policy).toEqual(policy);
  });

  it("exits 2 for a path that does not exist", async () => {
    const result = await run(box, ["inspect", "nope"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nope");
  });
});
