// `openteleport` with no command, and the two sizes of help. `run()` gives the CLI no stdin, so
// it is the run without a terminal: no wizard, the help instead.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANSI, type Sandbox, json, run, sandbox } from "../helpers/cli.js";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

/** What only the full help names. */
const ADVANCED_FLAGS = [
  "--source-dir",
  "--target-dir",
  "--copy",
  "--replace",
  "--yes",
  "--enable-routines",
  "--keep",
  "--quiet",
];
const ADVANCED_COMMANDS = ["validate", "adapters"];

describe("openteleport with no command", () => {
  it("prints the help on stdout and exits 2 without a terminal", async () => {
    const result = await run(box, []);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("More: `openteleport --help-all` lists every command and flag.");
    expect(result.stdout).not.toMatch(ANSI);
    expect(result.stderr).toBe("");
  });

  it("prints an error as JSON with --json, and nothing else on stdout", async () => {
    const result = await run(box, ["--json"]);
    expect(result.exitCode).toBe(2);
    expect(json(result)).toEqual({ error: { code: 2, message: "No command given" } });
    expect(result.stderr).toBe("error: No command given");
  });

  it("still exits 2 for a command that does not exist", async () => {
    const result = await run(box, ["teleport"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unknown command/i);
  });
});

describe("--help", () => {
  it("shows the five commands and the basic transfer flags", async () => {
    const result = await run(box, ["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
    for (const command of ["move", "export", "import", "list", "inspect"]) {
      expect(result.stdout, command).toMatch(new RegExp(`^ {2}${command}\\b`, "m"));
    }
    for (const flag of ["--from", "--to", "--agent", "--out", "--include-files", "--no-memory", "--json"]) {
      expect(result.stdout, flag).toContain(flag);
    }
  });

  it("points at --help-all, and leaves out the rest", async () => {
    const { stdout } = await run(box, ["--help"]);
    expect(stdout.trimEnd().endsWith(
      "More: `openteleport --help-all` lists every command and flag.",
    )).toBe(true);
    for (const name of [...ADVANCED_FLAGS, ...ADVANCED_COMMANDS, "Environment:", "OPENTELEPORT_"]) {
      expect(stdout, name).not.toContain(name);
    }
  });

  it("goes to stdout, and the short -h is the same", async () => {
    const long = await run(box, ["--help"]);
    const short = await run(box, ["-h"]);
    expect(long.stderr).toBe("");
    expect(short.stdout).toBe(long.stdout);
  });
});

describe("--help-all", () => {
  it("shows every command, every flag and the environment variables", async () => {
    const result = await run(box, ["--help-all"]);
    expect(result.exitCode).toBe(0);
    for (const name of [
      "move",
      "export",
      "import",
      "list",
      "inspect",
      "--from",
      "--to",
      "--agent",
      "--out",
      "--include-files",
      "--json",
      ...ADVANCED_FLAGS,
      ...ADVANCED_COMMANDS,
      "Environment:",
      "OPENTELEPORT_HOME",
      "OPENTELEPORT_EXTRA_ADAPTER",
    ]) {
      expect(result.stdout, name).toContain(name);
    }
    expect(result.stdout).not.toContain("More: `openteleport --help-all`");
    expect(result.stderr).toBe("");
  });
});

describe("help of a command", () => {
  it("leaves the advanced flags of move out of --help and shows them with --help-all", async () => {
    const basic = await run(box, ["move", "--help"]);
    expect(basic.exitCode).toBe(0);
    for (const flag of ["--from", "--to", "--agent", "--include-files", "--json"]) {
      expect(basic.stdout, flag).toContain(flag);
    }
    for (const flag of ADVANCED_FLAGS) expect(basic.stdout, flag).not.toContain(flag);

    const full = await run(box, ["move", "--help-all"]);
    expect(full.exitCode).toBe(0);
    for (const flag of ADVANCED_FLAGS) expect(full.stdout, flag).toContain(flag);
  });

  it.each([
    ["export", ["--source-dir", "--target-dir", "--quiet"]],
    ["import", ["--source-dir", "--target-dir", "--copy", "--replace", "--yes", "--enable-routines"]],
    ["list", ["--source-dir", "--target-dir", "--quiet"]],
    ["inspect", ["--quiet"]],
  ])("hides the same flags of %s until --help-all", async (command, hidden) => {
    const basic = await run(box, [command ?? "", "--help"]);
    const full = await run(box, [command ?? "", "--help-all"]);
    for (const flag of hidden) {
      expect(basic.stdout, flag).not.toContain(flag);
      expect(full.stdout, flag).toContain(flag);
    }
  });

  it("still describes a hidden command when asked for its help by name", async () => {
    const validate = await run(box, ["validate", "--help"]);
    expect(validate.exitCode).toBe(0);
    expect(validate.stdout).toContain("Usage: openteleport validate");
    const adapters = await run(box, ["adapters", "--help-all"]);
    expect(adapters.exitCode).toBe(0);
    expect(adapters.stdout).toContain("--source-dir");
  });

  it("keeps accepting the hidden flags", async () => {
    const result = await run(box, ["list", "--from", "memory", "--quiet", "--source-dir", "."]);
    expect(result.exitCode).toBe(0);
  });
});
