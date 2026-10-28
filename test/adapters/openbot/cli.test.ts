import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBotUserData } from "../../../src/adapters/openbot/paths.js";
import type { Ctx } from "../../../src/adapters/types.js";
import type { MoveReport } from "../../../src/core/report.js";
import { readOpenBotZip } from "../../../src/formats/openbot-zip.js";
import {
  ADA_DIR,
  ADA_ID,
  STACK_LINE,
  type Sandbox,
  json,
  run,
  sandbox,
} from "../../helpers/cli.js";
import { buildOpenBotDatabase } from "../../helpers/openbot-db.js";
import { zipDirectoryToFile } from "../../helpers/zip.js";

const IMPORT_DIR = fileURLToPath(new URL("../../fixtures/openbot/import-v1", import.meta.url));

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

/** Node's notice about the module, which a user must never see on stderr. */
const NOTICE = /ExperimentalWarning|SQLite is an experimental/;

const userData = (): string => join(box.root, "OpenBot");
const artifact = (name = "ada-openbot-import.zip"): string => join(box.cwd, name);

describe("list --from openbot", () => {
  it("lists the agents of an export archive, with nothing on stderr", async () => {
    const zip = await zipDirectoryToFile(IMPORT_DIR, join(box.root, "export.zip"));
    const result = await run(box, ["list", "--from", "openbot", "--source-dir", zip, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(json<{ id: string; name: string; location: string }[]>(result)).toEqual([
      expect.objectContaining({ id: "ada", name: "Ada", location: `${zip}#ada` }),
      expect.objectContaining({ id: "min", name: "Min", location: `${zip}#min` }),
    ]);
  });

  it("lists the agents of a database without Node's notice about node:sqlite on stderr", async () => {
    await buildOpenBotDatabase(userData());
    const result = await run(box, ["list", "--from", "openbot", "--source-dir", userData(), "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(NOTICE);
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(json<{ id: string; name: string }[]>(result).map(({ id, name }) => [id, name])).toEqual([
      ["ada", "Ada"],
      ["min", "Min"],
    ]);
  });

  it("finds the database where OpenBot keeps it under the home of the sandbox", async () => {
    // The sandbox points APPDATA into its home; elsewhere the folder is under the home itself.
    const ctx: Ctx = {
      home: box.home,
      cwd: box.cwd,
      env: { APPDATA: join(box.home, "AppData", "Roaming") },
      exec: noExec,
      logger: () => {},
    };
    await buildOpenBotDatabase(openBotUserData(ctx));

    const result = await run(box, ["list", "--from", "openbot"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(NOTICE);
    expect(result.stdout).toMatch(/^id\s+name\s+location$/m);
    expect(result.stdout).toMatch(/^ada\s+Ada\s+/m);
    expect(result.stdout).toMatch(/^min\s+Min\s+/m);
  });

  it("exits 3 with the hint when there is no database and no archive", async () => {
    const result = await run(box, ["list", "--from", "openbot"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("OpenBot was not detected");
    expect(result.stderr).toContain("pass --source-dir <export.zip>");
    expect(result.stderr).not.toMatch(STACK_LINE);
  });

});

describe("import --to openbot", () => {
  it("writes the archive in the working directory without OpenBot being installed", async () => {
    expect(await readdir(box.home)).toEqual([]);
    const result = await run(box, ["import", "--to", "openbot", ADA_DIR, "--json"]);

    expect(result.exitCode).toBe(0);
    const report = json<MoveReport>(result);
    expect(report).toMatchObject({
      source: { app: "jetpack", agent: "Ada" },
      target: { app: "openbot" },
      outcome: "handoff",
      nextStep: `Open OpenBot, go to Server settings, choose Import and pick ${artifact()}`,
    });
    expect(report.skipped).toContainEqual(expect.objectContaining({ field: "models" }));
    expect(await readdir(box.cwd)).toEqual(["ada-openbot-import.zip"]);

    const { agents } = await readOpenBotZip(artifact());
    expect(agents.map(({ key, bundle }) => [key, bundle.manifest.id])).toEqual([["ada", ADA_ID]]);
    expect(agents[0]?.bundle.routines.map(({ enabled }) => enabled)).toEqual([false]);
  });

  it("prints the next step, then writes over the archive of the same agent, with routines on", async () => {
    const first = await run(box, ["import", "--to", "openbot", ADA_DIR]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Outcome: handoff");
    expect(first.stdout).toContain("Next step: Open OpenBot, go to Server settings");
    expect(first.stdout + first.stderr).not.toMatch(STACK_LINE);

    const again = await run(box, ["import", "--to", "openbot", ADA_DIR, "--enable-routines"]);
    expect(again.exitCode).toBe(0);
    expect(await readdir(box.cwd)).toEqual(["ada-openbot-import.zip"]);
    const { agents } = await readOpenBotZip(artifact());
    expect(agents[0]?.bundle.routines.map(({ enabled }) => enabled)).toEqual([true]);
  });

  it("refuses --replace over a file it did not write, with exit 1 and the file untouched", async () => {
    await mkdir(box.cwd, { recursive: true });
    await writeFile(artifact(), "theirs");
    const result = await run(box, ["import", "--to", "openbot", ADA_DIR, "--replace", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Refusing to replace ");
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(await readFile(artifact(), "utf8")).toBe("theirs");
  });

});

describe("a move from openbot", () => {
  it("moves an agent of the database into an archive, saying what OpenBot cannot hold", async () => {
    await buildOpenBotDatabase(userData());
    const result = await run(box, [
      "move",
      "--from",
      "openbot",
      "--to",
      "openbot",
      "--agent",
      "ada",
      "--source-dir",
      userData(),
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(NOTICE);
    const report = json<MoveReport>(result);
    expect(report).toMatchObject({
      source: { app: "openbot", agent: "ada" },
      target: { app: "openbot" },
      outcome: "handoff",
    });
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "memory.notes" }),
        expect.objectContaining({ field: "models" }),
      ]),
    );
    expect(report.warnings).toContain(
      "skills are not readable from the OpenBot database; export from the app (a transfer zip) carries them",
    );

    const { agents } = await readOpenBotZip(artifact());
    const [ada] = agents;
    expect(ada?.bundle.facts).toEqual(["Prefers short answers.", "Works in the Europe/Warsaw time zone."]);
    expect(ada?.bundle.routines.map(({ name, enabled }) => [name, enabled])).toEqual([
      ["Morning digest", false],
      ["Weekly review", false],
      ["Poll the inbox", false],
      ["Month end", false],
    ]);
    const id = ada?.bundle.manifest.id;
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

    // The same agent again: the id the first move gave it is found again through the cache
    // identity (the data folder and the agent), so the archive is updated, not copied.
    const again = await run(box, [
      "move",
      "--from",
      "openbot",
      "--to",
      "openbot",
      "--agent",
      "ada",
      "--source-dir",
      userData(),
    ]);
    expect(again.exitCode).toBe(0);
    expect(await readdir(box.cwd)).toEqual(["ada-openbot-import.zip"]);
    expect((await readOpenBotZip(artifact())).agents[0]?.bundle.manifest.id).toBe(id);
  });

  it("moves an agent of an export archive, with its skills and files when asked", async () => {
    const zip = await zipDirectoryToFile(IMPORT_DIR, join(box.root, "export.zip"));
    const out = join(box.root, "out");
    const result = await run(box, [
      "move",
      "--from",
      "openbot",
      "--to",
      "openbot",
      "--agent",
      "ada",
      "--source-dir",
      zip,
      "--target-dir",
      out,
      "--include-files",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(NOTICE);
    const written = await readOpenBotZip(join(out, "ada-openbot-import.zip"), { includeFiles: true });
    const [ada] = written.agents;
    expect(ada?.bundle.skills.map(({ name }) => name)).toEqual(["release-notes", "triage"]);
    expect(ada?.bundle.routines).toHaveLength(8);
    expect(ada?.bundle.files.map(({ path }) => path)).toEqual(["notes/todo.md"]);
  });

  it("moves the same agent of an archive again in place, even from a re-exported archive", async () => {
    const out = join(box.root, "out");
    const args = ["move", "--from", "openbot", "--to", "openbot", "--agent", "ada"];
    const one = await zipDirectoryToFile(IMPORT_DIR, join(box.root, "export-1.zip"));
    await run(box, [...args, "--source-dir", one, "--target-dir", out]);
    const id = (await readOpenBotZip(join(out, "ada-openbot-import.zip"))).agents[0]?.bundle.manifest.id;

    // The same bot, exported again under another file name.
    const two = await zipDirectoryToFile(IMPORT_DIR, join(box.root, "export-2.zip"));
    const result = await run(box, [...args, "--source-dir", two, "--target-dir", out]);

    expect(result.exitCode).toBe(0);
    expect(await readdir(out)).toEqual(["ada-openbot-import.zip"]);
    expect((await readOpenBotZip(join(out, "ada-openbot-import.zip"))).agents[0]?.bundle.manifest.id).toBe(id);
  });
});
