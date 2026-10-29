import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
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
  runWithClosedStdout,
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
    expect(json(result)).toEqual({ ok: true, findings: [], errors: [], warnings: [] });
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
      warnings: [],
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

  it("passes an agent folder without jetpack.json, with a warning", async () => {
    const result = await run(box, ["validate", NO_MANIFEST_DIR]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split(/\r?\n/)).toEqual([
      `${NO_MANIFEST_DIR} is a valid agent folder`,
      "warning: no jetpack.json; manifest would be synthesized",
    ]);
  });

  it("says so as JSON, ok and without errors", async () => {
    const result = await run(box, ["validate", NO_MANIFEST_DIR, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(json(result)).toEqual({
      ok: true,
      findings: [],
      errors: [],
      warnings: ["no jetpack.json; manifest would be synthesized"],
    });
  });

  it("still fails with exit 1 on a .jetpack archive without jetpack.json", async () => {
    const file = join(box.root, "bare.jetpack");
    await writeFile(file, zipSync({ "AGENTS.md": new TextEncoder().encode("# Bare\n") }));
    const result = await run(box, ["validate", file]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("missing jetpack.json");
    expect(result.stderr).not.toMatch(STACK_LINE);
  });

  it("exits 2 for a path that does not exist", async () => {
    const result = await run(box, ["validate", "nope.jetpack"]);
    expect(result.exitCode).toBe(2);
  });

  // `validate x | head -1` ends the program when the reader has gone, but not with 0: the file
  // was not valid, and the exit code says so whatever happens to the output.
  it("keeps exit code 1 for an invalid file when stdout is closed early", async () => {
    const file = join(box.root, "broken.jetpack");
    await writeFile(file, "this is not a zip file");

    const { exitCode, stderr } = await runWithClosedStdout(box, ["validate", file], {
      extraAdapter: null,
    });

    expect(exitCode).toBe(1);
    expect(stderr).not.toMatch(STACK_LINE);
    expect(stderr).not.toContain("EPIPE");
  });

  it("keeps exit code 1 for a secret when stdout is closed early", async () => {
    const leaky = join(box.root, "leaky");
    await cp(ADA_DIR, leaky, { recursive: true });
    await writeFile(join(leaky, "SOUL.md"), `Calm.\nMy key is ${FAKE_KEY}\n`);

    const { exitCode } = await runWithClosedStdout(box, ["validate", leaky, "--json"], {
      extraAdapter: null,
    });

    expect(exitCode).toBe(1);
  });

  it("still exits 0 for a valid folder when stdout is closed early", async () => {
    const { exitCode, stderr } = await runWithClosedStdout(box, ["validate", ADA_DIR], {
      extraAdapter: null,
    });

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("EPIPE");
  });
});
