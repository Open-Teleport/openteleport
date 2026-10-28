import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBundle, writeBundle } from "../../src/core/bundle.js";
import {
  ADA_DIR,
  FAKE_KEY,
  NO_MANIFEST_DIR,
  STACK_LINE,
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

describe("validate", () => {
  it("passes the Ada fixture with exit 0", async () => {
    const result = await run(box, ["validate", ADA_DIR]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${ADA_DIR} is a valid .jetpack`);
  });

  it("passes a .jetpack archive and says so as JSON", async () => {
    const file = join(box.root, "ada.jetpack");
    await writeBundle(await readBundle(ADA_DIR), file);
    const result = await run(box, ["validate", file, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(json(result)).toEqual({ ok: true, findings: [], errors: [] });
  });

  it("fails with exit 1 on a secret, naming where it is", async () => {
    const leaky = join(box.root, "leaky");
    await cp(ADA_DIR, leaky, { recursive: true });
    await writeFile(join(leaky, "SOUL.md"), `Calm.\nMy key is ${FAKE_KEY}\n`);
    const result = await run(box, ["validate", leaky, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(json(result)).toEqual({
      ok: false,
      findings: [{ path: "SOUL.md", line: 2, kind: "anthropic-api-key", preview: "sk-ant…" }],
      errors: [],
    });
    expect(result.stdout).not.toContain(FAKE_KEY);
  });

  it("prints the findings for people, without the secret", async () => {
    const leaky = join(box.root, "leaky");
    await cp(ADA_DIR, leaky, { recursive: true });
    await writeFile(join(leaky, "SOUL.md"), `Calm.\nMy key is ${FAKE_KEY}\n`);
    const result = await run(box, ["validate", leaky]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("SOUL.md:2 anthropic-api-key");
    expect(`${result.stdout}${result.stderr}`).not.toContain(FAKE_KEY);
  });

  it("fails with exit 1 on a schema error", async () => {
    const broken = join(box.root, "broken");
    await cp(ADA_DIR, broken, { recursive: true });
    const manifest = { schemaVersion: "0.1", id: "x", name: "Ada", models: [], capabilities: [] };
    await writeFile(join(broken, "jetpack.json"), JSON.stringify(manifest));
    const result = await run(box, ["validate", broken, "--json"]);
    expect(result.exitCode).toBe(1);
    const report = json<{ ok: boolean; findings: unknown[]; errors: string[] }>(result);
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([expect.stringMatching(/^jetpack\.json is invalid: id:/)]);
  });

  it("fails with exit 1 on a folder without jetpack.json", async () => {
    const result = await run(box, ["validate", NO_MANIFEST_DIR]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("missing jetpack.json");
    expect(result.stderr).not.toMatch(STACK_LINE);
  });

  it("exits 2 for a path that does not exist", async () => {
    const result = await run(box, ["validate", "nope.jetpack"]);
    expect(result.exitCode).toBe(2);
  });
});
