import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const FIXTURE = fileURLToPath(new URL("../../fixtures/letta/home/.letta", import.meta.url));

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

const folder = (): string => join(box.cwd, "ada-letta-memory");

describe("import --to letta", () => {
  it("writes the folder in the working directory without Letta Code being installed", async () => {
    // There is no ~/.letta in the sandbox home, and the PATH holds no `letta`.
    expect(await readdir(box.home)).toEqual([]);
    const result = await run(box, ["import", "--to", "letta", ADA_DIR, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/^Report written to /);
    const report = json<MoveReport>(result);
    expect(report).toMatchObject({
      source: { app: "jetpack", agent: "Ada" },
      target: { app: "letta" },
      outcome: "handoff",
      nextStep:
        `Run ${join(folder(), "letta-commands.sh")} (or .ps1): it creates the agent, restores ` +
        "its memory and adds the routines",
    });
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("`letta memory restore` replaces")]),
    );
    expect(await readdir(folder())).toEqual(
      expect.arrayContaining([
        ".openteleport.json",
        "README.md",
        "letta-commands.ps1",
        "letta-commands.sh",
        "memory",
        "routines",
      ]),
    );
    expect(JSON.parse(await readFile(join(folder(), ".openteleport.json"), "utf8"))).toMatchObject({
      id: ADA_ID,
    });
    expect(await readFile(join(folder(), "memory", "persona.md"), "utf8")).toContain(
      "name: persona\n",
    );
  });

  it("leaves the routines as comments unless --enable-routines is given", async () => {
    await run(box, ["import", "--to", "letta", ADA_DIR]);
    const script = await readFile(join(folder(), "letta-commands.sh"), "utf8");
    expect(script).toContain("# letta cron add");
    expect(script.split("\n").filter((line) => line.startsWith("letta cron add"))).toEqual([]);

    const enabled = await run(box, ["import", "--to", "letta", ADA_DIR, "--enable-routines"]);
    expect(enabled.exitCode).toBe(0);
    const again = await readFile(join(folder(), "letta-commands.sh"), "utf8");
    expect(again.split("\n").filter((line) => line.startsWith("letta cron add"))).toHaveLength(1);
  });

  it("prints the next step and the report path, and nothing like a stack trace", async () => {
    const result = await run(box, ["import", "--to", "letta", ADA_DIR]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Outcome: handoff");
    expect(result.stdout).toContain("Next step: Run ");
    expect(result.stdout).toContain("letta-commands.sh (or .ps1)");
    expect(result.stdout + result.stderr).not.toMatch(STACK_LINE);
  });

  it("moving the same agent again writes over the folder, not next to it", async () => {
    await run(box, ["import", "--to", "letta", ADA_DIR]);
    const second = await run(box, ["import", "--to", "letta", ADA_DIR, "--json"]);
    expect(second.exitCode).toBe(0);
    expect(json<MoveReport>(second).warnings.filter((text) => text.includes("written as"))).toEqual(
      [],
    );
    expect(await readdir(box.cwd)).toEqual(["ada-letta-memory"]);
  });

  it("writes into --target-dir", async () => {
    const out = join(box.root, "out");
    const result = await run(box, ["import", "--to", "letta", ADA_DIR, "--target-dir", out]);
    expect(result.exitCode).toBe(0);
    expect(await readdir(join(out, "ada-letta-memory"))).toContain("letta-commands.sh");
    expect(await readdir(box.cwd)).toEqual([]);
  });

  it("refuses --replace over a folder it did not write, with exit 1 and the hint", async () => {
    await mkdir(folder());
    await writeFile(join(folder(), "theirs.txt"), "theirs");
    const result = await run(box, ["import", "--to", "letta", ADA_DIR, "--replace", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Refusing to replace ");
    expect(result.stderr).toContain("Use --copy, or point --target-dir at an empty folder.");
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(await readdir(folder())).toEqual(["theirs.txt"]);
  });

  it("writes a copy next to the folder with --copy", async () => {
    await run(box, ["import", "--to", "letta", ADA_DIR]);
    const result = await run(box, ["import", "--to", "letta", ADA_DIR, "--copy"]);
    expect(result.exitCode).toBe(0);
    expect((await readdir(box.cwd)).sort()).toEqual(["ada-letta-memory", "ada-letta-memory-2"]);
  });
});

describe("a move from letta", () => {
  it("lists the agents of --source-dir and reads one", async () => {
    const list = await run(box, ["list", "--from", "letta", "--source-dir", FIXTURE, "--json"]);
    expect(list.exitCode).toBe(0);
    expect(json<{ id: string; name: string }[]>(list).map((agent) => [agent.id, agent.name])).toEqual([
      ["agent-local-1111", "Reviewer"],
      ["agent-cloud-2222", "agent-cloud-2222"],
    ]);

    const moved = await run(box, [
      "move",
      "--from",
      "letta",
      "--to",
      "letta",
      "--agent",
      "agent-local-1111",
      "--source-dir",
      FIXTURE,
      "--target-dir",
      join(box.root, "out"),
      "--json",
    ]);
    expect(moved.exitCode).toBe(0);
    expect(json<MoveReport>(moved)).toMatchObject({
      source: { app: "letta", agent: "agent-local-1111" },
      outcome: "handoff",
    });
    expect(await readdir(join(box.root, "out"))).toEqual(["reviewer-letta-memory"]);
  });

  it("finds nothing to read without Letta's directory, and says what to do (exit 3)", async () => {
    const result = await run(box, ["list", "--from", "letta"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Letta Code was not detected");
    expect(result.stderr).toContain("npm i -g @letta-ai/letta-code");
  });

  it("is listed among the adapters", async () => {
    const result = await run(box, ["adapters", "--json"]);
    const rows = json<{ name: string; found: boolean }[]>(result);
    expect(rows.find((row) => row.name === "letta")).toMatchObject({ found: false });
  });
});
