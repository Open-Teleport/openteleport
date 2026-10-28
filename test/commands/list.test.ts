import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANSI, STACK_LINE, type Sandbox, json, run, sandbox } from "../helpers/cli.js";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

describe("list", () => {
  it("prints a table of id, name and location", async () => {
    const result = await run(box, ["list", "--from", "memory"]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split(/\r?\n/);
    expect(lines[0]).toMatch(/^id\s+name\s+location$/);
    expect(lines[1]).toMatch(/^ada\s+Ada\b/);
    expect(result.stdout).not.toMatch(ANSI);
    expect(result.stderr).toBe("");
  });

  it("prints the agents as JSON with --json", async () => {
    const result = await run(box, ["list", "--from", "memory", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(json(result)).toEqual([{ id: "ada", name: "Ada" }]);
  });

  it("lists folder agents of --source-dir, resolved against the working directory", async () => {
    const agents = join(box.cwd, "agents");
    await mkdir(join(agents, "bob"), { recursive: true });
    await writeFile(join(agents, "bob", "AGENTS.md"), "# Bob\n");
    const result = await run(box, ["list", "--from", "folder", "--source-dir", "agents", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(json(result)).toEqual([{ id: "bob", name: "bob", location: join(agents, "bob") }]);
  });

  it("exits 2 naming the registered adapters for an unknown one", async () => {
    const result = await run(box, ["list", "--from", "nope"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown adapter "nope"');
    expect(result.stderr).toContain("folder, openclaw, claude-code, hermes, memory");
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(result.stdout).toBe("");
  });

  it("also prints the error as JSON on stdout with --json", async () => {
    const result = await run(box, ["list", "--from", "nope", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(json(result)).toEqual({
      error: { code: 2, message: expect.stringContaining('Unknown adapter "nope"') },
    });
  });

  it("exits 2 when --from is missing", async () => {
    const result = await run(box, ["list"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--from/);
  });

  it("exits 2 for an unknown option", async () => {
    const result = await run(box, ["list", "--from", "memory", "--frm"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unknown option/i);
  });

  it("exits 3 with the adapter's hint when it finds no app", async () => {
    const result = await run(box, ["list", "--from", "folder", "--source-dir", "."]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Pass --source-dir <folder> with an AGENTS.md inside");
    expect(result.stderr).not.toMatch(STACK_LINE);
  });
});
