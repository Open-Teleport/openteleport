import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBundle } from "../../src/core/bundle.js";
import type { MoveReport } from "../../src/core/report.js";
import {
  ANSI,
  FAKE_KEY,
  STACK_LINE,
  type Sandbox,
  json,
  run,
  sandbox,
} from "../helpers/cli.js";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

describe("export", () => {
  it("writes <name>.jetpack and move-report.md into the working directory", async () => {
    const result = await run(box, ["export", "--from", "memory", "--agent", "ada"]);
    expect(result.exitCode).toBe(0);

    const bundle = await readBundle(join(box.cwd, "ada.jetpack"));
    expect(bundle.manifest.name).toBe("Ada");
    expect(bundle.manifest.id).toMatch(ULID);
    expect(bundle.facts).toEqual(["Prefers answers in Polish unless the source is in English."]);

    const report = await readFile(join(box.cwd, "move-report.md"), "utf8");
    expect(report).toContain("# Move report");
    expect(report).toContain("**Outcome:** exported");

    expect(result.stdout).toContain("Move report");
    expect(result.stdout).toContain("Outcome: exported");
    expect(result.stdout).toContain(`Report written to ${join(box.cwd, "move-report.md")}`);
    expect(result.stdout).not.toMatch(ANSI);
  });

  it("writes to --out, creating its folder, with the report next to it", async () => {
    const result = await run(box, [
      "export",
      "--from",
      "memory",
      "--agent",
      "ada",
      "--out",
      "out/sub/agent.jetpack",
      "--quiet",
    ]);
    expect(result.exitCode).toBe(0);
    expect((await readdir(join(box.cwd, "out", "sub"))).sort()).toEqual([
      "agent.jetpack",
      "move-report.md",
    ]);
    expect(result.stdout).not.toContain("Report written to");
    expect(result.stderr).toBe("");
  });

  it("keeps the id of an agent across exports", async () => {
    await run(box, ["export", "--from", "memory", "--agent", "ada", "--out", "one.jetpack"]);
    await run(box, ["export", "--from", "memory", "--agent", "ada", "--out", "two.jetpack"]);
    const one = await readBundle(join(box.cwd, "one.jetpack"));
    const two = await readBundle(join(box.cwd, "two.jetpack"));
    expect(two.manifest.id).toBe(one.manifest.id);
  });

  it("finds the agent by name, ignoring case, and keys its id by the agent's id", async () => {
    await run(box, ["export", "--from", "memory", "--agent", "ada", "--out", "by-id.jetpack"]);
    const result = await run(box, [
      "export",
      "--from",
      "memory",
      "--agent",
      "ADA",
      "--out",
      "by-name.jetpack",
    ]);
    expect(result.exitCode).toBe(0);
    const byId = await readBundle(join(box.cwd, "by-id.jetpack"));
    const byName = await readBundle(join(box.cwd, "by-name.jetpack"));
    expect(byName.manifest.id).toBe(byId.manifest.id);
  });

  it("prints the MoveReport with --json", async () => {
    const result = await run(box, ["export", "--from", "memory", "--agent", "ada", "--json"]);
    expect(result.exitCode).toBe(0);
    const report = json<MoveReport>(result);
    expect(report).toMatchObject({
      source: { app: "memory", agent: "ada" },
      outcome: "exported",
      approximated: [],
      skipped: [],
      warnings: [],
    });
    expect(report.moved.map((item) => item.field)).toEqual([
      "instructions",
      "persona",
      "memory.facts",
    ]);
  });

  it("exits 2 without --agent when it cannot ask, listing the agents", async () => {
    const result = await run(box, ["export", "--from", "memory"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing --agent. Available: ada (Ada)");
    expect(await readdir(box.cwd)).toEqual([]);
  });

  it("exits 2 for an agent the adapter does not list", async () => {
    const result = await run(box, ["export", "--from", "memory", "--agent", "bob"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/No agent "bob" in .*memory.*Available: ada \(Ada\)/);
  });

  it("exits 1 listing where the secrets are, never the secret itself", async () => {
    const source = join(box.cwd, "leaky");
    await mkdir(source);
    await writeFile(join(source, "AGENTS.md"), `# Leaky\n\nUse ${FAKE_KEY} for the API.\n`);
    const result = await run(box, [
      "export",
      "--from",
      "folder",
      "--source-dir",
      "leaky",
      "--agent",
      ".",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("AGENTS.md:3 anthropic-api-key");
    expect(result.stderr).toContain(
      "Remove the secret or move it to your app's secret store, then retry.",
    );
    expect(result.stderr).not.toContain(FAKE_KEY);
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(await readdir(box.cwd)).toEqual(["leaky"]);
  });
});
