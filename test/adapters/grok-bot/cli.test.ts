import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBundle } from "../../../src/core/bundle.js";
import type { MoveReport } from "../../../src/core/report.js";
import {
  ADA_DIR,
  ADA_ID,
  STACK_LINE,
  type Sandbox,
  json,
  run,
  sandbox,
} from "../../helpers/cli.js";
import { zipDirectoryToFile } from "../../helpers/zip.js";

const IMPORT_DIR = fileURLToPath(new URL("../../fixtures/openbot/import-v1", import.meta.url));
const HINT =
  "Grok Bot keeps agents in the cloud. Ask your Bot to run the OpenBot export skill, then run: openteleport list --from grok-bot --source-dir <openbot-export-*.zip>";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

const folder = (): string => join(box.cwd, "ada-for-grok-bot");
const exportZip = (name = "openbot-export-2026-10-28.zip"): Promise<string> =>
  zipDirectoryToFile(IMPORT_DIR, join(box.root, name));

describe("import --to grok-bot", () => {
  it("writes the paste pack in the working directory without Grok Bot being installed", async () => {
    // There is no Grok Bot on the sandbox, and nothing in the home directory.
    expect(await readdir(box.home)).toEqual([]);
    const result = await run(box, ["import", "--to", "grok-bot", ADA_DIR, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/^Report written to /);
    const report = json<MoveReport>(result);
    expect(report).toMatchObject({
      source: { app: "jetpack", agent: "Ada" },
      target: { app: "grok-bot" },
      outcome: "handoff",
      nextStep: `Open ${join(folder(), "README.md")} and follow the five steps in Grok Bot`,
    });
    expect((await readdir(folder())).sort()).toEqual([
      ".openteleport.json",
      "1-paste-into-chat.md",
      "2-memory.txt",
      "3-routines.md",
      "README.md",
      "skills",
    ]);
    expect(JSON.parse(await readFile(join(folder(), ".openteleport.json"), "utf8"))).toMatchObject({
      id: ADA_ID,
    });
    expect(await readFile(join(folder(), "skills", "web-brief", "SKILL.md"), "utf8")).toContain(
      "name: web-brief",
    );
    expect(await readFile(join(folder(), "1-paste-into-chat.md"), "utf8")).toMatch(
      /^From now on, this is who you are and how you work:\n\n# Ada\n\nAda is a calm, curious research assistant\./,
    );
  });

  it("leaves the routines paused unless --enable-routines is given", async () => {
    await run(box, ["import", "--to", "grok-bot", ADA_DIR]);
    const paused = await readFile(join(folder(), "3-routines.md"), "utf8");
    expect(paused).toBe(
      'Create a routine named "Morning digest" that runs every weekday at 08:30 (Europe/Warsaw): Summarise new papers and unread mail into a five-line digest. (paused)\n',
    );

    const enabled = await run(box, ["import", "--to", "grok-bot", ADA_DIR, "--enable-routines"]);
    expect(enabled.exitCode).toBe(0);
    expect(await readFile(join(folder(), "3-routines.md"), "utf8")).toBe(
      paused.replace(" (paused)", ""),
    );
    expect(await readdir(box.cwd)).toEqual(["ada-for-grok-bot"]);
  });

  it("prints the next step once, first in the report, and nothing like a stack trace", async () => {
    const result = await run(box, ["import", "--to", "grok-bot", ADA_DIR]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Outcome: handoff");
    const lines = result.stdout.trimEnd().split(/\r?\n/);
    const next = `Next step: Open ${join(folder(), "README.md")} and follow the five steps in Grok Bot`;
    expect(lines.filter((line) => line.startsWith("Next step:"))).toEqual([next]);
    expect(lines[1]).toBe(next);
    expect(result.stdout + result.stderr).not.toMatch(STACK_LINE);
  });

  it("moving the same Bot again writes over the folder, not next to it", async () => {
    await run(box, ["import", "--to", "grok-bot", ADA_DIR]);
    const second = await run(box, ["import", "--to", "grok-bot", ADA_DIR, "--json"]);
    expect(second.exitCode).toBe(0);
    expect(json<MoveReport>(second).warnings.filter((text) => text.includes("written as"))).toEqual([]);
    expect(await readdir(box.cwd)).toEqual(["ada-for-grok-bot"]);
  });

  it("writes into --target-dir", async () => {
    const out = join(box.root, "out");
    const result = await run(box, ["import", "--to", "grok-bot", ADA_DIR, "--target-dir", out]);
    expect(result.exitCode).toBe(0);
    expect(await readdir(join(out, "ada-for-grok-bot"))).toContain("README.md");
    expect(await readdir(box.cwd)).toEqual([]);
  });

  it("refuses --replace over a folder it did not write, with exit 1 and the hint", async () => {
    await mkdir(folder());
    await writeFile(join(folder(), "theirs.txt"), "theirs");
    const result = await run(box, ["import", "--to", "grok-bot", ADA_DIR, "--replace", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Refusing to replace ");
    expect(result.stderr).toContain("Use --copy, or point --target-dir at an empty folder.");
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(await readdir(folder())).toEqual(["theirs.txt"]);
  });

  it("writes a copy next to the folder with --copy", async () => {
    await run(box, ["import", "--to", "grok-bot", ADA_DIR]);
    const result = await run(box, ["import", "--to", "grok-bot", ADA_DIR, "--copy"]);
    expect(result.exitCode).toBe(0);
    expect((await readdir(box.cwd)).sort()).toEqual(["ada-for-grok-bot", "ada-for-grok-bot-2"]);
  });
});

describe("a move from an export zip", () => {
  it("lists the Bots of --source-dir <zip>", async () => {
    const zip = await exportZip();
    const result = await run(box, ["list", "--from", "grok-bot", "--source-dir", zip, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(json<unknown[]>(result)).toEqual([
      { id: "ada", name: "Ada", title: "Release manager", location: `${zip}#ada` },
      { id: "min", name: "Min", title: "Minimal agent", location: `${zip}#min` },
    ]);
  });

  it("takes the zip relative to the working directory", async () => {
    await exportZip("export.zip").then(() => undefined);
    const result = await run(box, ["list", "--from", "grok-bot", "--source-dir", "../export.zip"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ada");
  });

  it("moves a Bot to Grok Bot, and again from a later export into the same folder", async () => {
    const out = join(box.root, "out");
    const args = (zip: string): string[] => [
      "move",
      "--from",
      "grok-bot",
      "--to",
      "grok-bot",
      "--agent",
      "ada",
      "--source-dir",
      zip,
      "--target-dir",
      out,
      "--json",
    ];
    const first = await run(box, args(await exportZip("openbot-export-2026-10-28.zip")));
    expect(first.exitCode).toBe(0);
    expect(json<MoveReport>(first)).toMatchObject({
      source: { app: "grok-bot", agent: "ada" },
      target: { app: "grok-bot" },
      outcome: "handoff",
    });
    const marker = await readFile(join(out, "ada-for-grok-bot", ".openteleport.json"), "utf8");

    const second = await run(box, args(await exportZip("openbot-export-2026-11-02.zip")));
    expect(second.exitCode).toBe(0);
    expect(await readdir(out)).toEqual(["ada-for-grok-bot"]);
    expect(JSON.parse(await readFile(join(out, "ada-for-grok-bot", ".openteleport.json"), "utf8")).id)
      .toBe(JSON.parse(marker).id);
  });

  it("exports a Bot of the zip as a .jetpack that says where it came from", async () => {
    const zip = await exportZip();
    const result = await run(box, [
      "export",
      "--from",
      "grok-bot",
      "--source-dir",
      zip,
      "--agent",
      "ada",
      "--out",
      "ada.jetpack",
      "--quiet",
    ]);
    expect(result.exitCode).toBe(0);
    const bundle = await readBundle(join(box.cwd, "ada.jetpack"));
    expect(bundle.manifest.origin?.app).toBe("grok-bot");
    expect(bundle.routines).toHaveLength(8);
    expect(bundle.skills.map((skill) => skill.name)).toEqual(["release-notes", "triage"]);
  });

  it("finds no Grok Bot without --source-dir, says where the Bots are, and exits 3", async () => {
    const result = await run(box, ["list", "--from", "grok-bot"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Grok Bot was not detected");
    expect(result.stderr).toContain(HINT);
    expect(result.stderr).not.toMatch(STACK_LINE);
  });

  it("exits 3 for a folder given as --source-dir", async () => {
    const result = await run(box, ["list", "--from", "grok-bot", "--source-dir", box.home]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain(HINT);
  });

  it("exits 1 for a zip that is not an OpenBot archive", async () => {
    const plain = join(box.root, "plain");
    await mkdir(plain);
    await writeFile(join(plain, "hello.txt"), "hello");
    const zip = await zipDirectoryToFile(plain, join(box.root, "plain.zip"));
    const result = await run(box, ["list", "--from", "grok-bot", "--source-dir", zip]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not an OpenBot archive");
    expect(result.stderr).not.toMatch(STACK_LINE);
  });
});
