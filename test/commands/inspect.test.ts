import { stat } from "node:fs/promises";
import { join } from "node:path";
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
    expect(result.stdout).toMatch(/^warning: no jetpack\.json/m);
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

  it("exits 2 for a path that does not exist", async () => {
    const result = await run(box, ["inspect", "nope"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nope");
  });
});
