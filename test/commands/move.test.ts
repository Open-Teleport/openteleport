import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBundle } from "../../src/core/bundle.js";
import type { MoveReport } from "../../src/core/report.js";
import { ADA_DIR, ANSI, type Sandbox, json, run, sandbox } from "../helpers/cli.js";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

describe("move", () => {
  it("prints a MoveReport as JSON with --json", async () => {
    const result = await run(box, [
      "move",
      "--from",
      "memory",
      "--to",
      "folder",
      "--agent",
      "ada",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const report = json<MoveReport>(result);
    expect(Object.keys(report).sort()).toEqual(
      ["approximated", "moved", "outcome", "skipped", "source", "target", "warnings"].sort(),
    );
    expect(report).toMatchObject({
      source: { app: "memory", agent: "ada" },
      target: { app: "folder", agent: join(box.cwd, "ada") },
      outcome: "done",
    });
    expect(report.moved.map((item) => item.field)).toEqual([
      "instructions",
      "persona",
      "memory.facts",
    ]);
    expect(await readFile(join(box.cwd, "ada", "SOUL.md"), "utf8")).toBe("Calm and curious.");
  });

  it("prints the report and where its file went", async () => {
    const result = await run(box, ["move", "--from", "memory", "--to", "folder", "--agent", "Ada"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^Move report\nSource: memory \/ ada\nTarget: folder \/ /);
    const [report] = await readdir(join(box.home, ".openteleport", "reports"));
    expect(report).toMatch(/-ada\.md$/);
    expect(result.stdout).toContain("Report written to ");
    expect(result.stdout).not.toMatch(ANSI);
  });

  it("reads the source from the working folder when only --target-dir is given", async () => {
    await mkdir(join(box.cwd, "bob"));
    await writeFile(join(box.cwd, "bob", "AGENTS.md"), "# Bob\n\nBe brief.\n");
    const result = await run(box, [
      "move",
      "--from",
      "folder",
      "--agent",
      "bob",
      "--to",
      "folder",
      "--target-dir",
      "out",
    ]);
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(box.cwd, "out", "AGENTS.md"), "utf8")).toBe("# Bob\n\nBe brief.\n");
  });

  it("writes to --target-dir, not to --source-dir", async () => {
    await mkdir(join(box.cwd, "src", "bob"), { recursive: true });
    await writeFile(join(box.cwd, "src", "bob", "AGENTS.md"), "# Bob\n");
    const result = await run(box, [
      "move",
      "--from",
      "folder",
      "--source-dir",
      "src",
      "--agent",
      "bob",
      "--to",
      "folder",
      "--target-dir",
      "dst",
    ]);
    expect(result.exitCode).toBe(0);
    expect(await readdir(join(box.cwd, "src"))).toEqual(["bob"]);
    expect(await readFile(join(box.cwd, "dst", "AGENTS.md"), "utf8")).toBe("# Bob\n");
  });

  it("also keeps the bundle with --keep", async () => {
    const result = await run(box, [
      "move",
      "--from",
      "memory",
      "--to",
      "folder",
      "--agent",
      "ada",
      "--keep",
      "kept/ada.jetpack",
      "--quiet",
    ]);
    expect(result.exitCode).toBe(0);
    const kept = await readBundle(join(box.cwd, "kept", "ada.jetpack"));
    const moved = JSON.parse(await readFile(join(box.cwd, "ada", "jetpack.json"), "utf8"));
    expect(kept.manifest.id).toBe(moved.id);
    expect(kept.persona).toBe("Calm and curious.");
    expect(result.stdout).not.toContain("Report written to");
  });

  it("drops what the target cannot hold and says so", async () => {
    await cp(ADA_DIR, join(box.cwd, "agents", "ada"), { recursive: true });
    await mkdir(join(box.home, ".claude"));
    const result = await run(box, [
      "move",
      "--from",
      "folder",
      "--source-dir",
      "agents",
      "--agent",
      "ada",
      "--to",
      "claude-code",
      "--target-dir",
      "project",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const report = json<MoveReport>(result);
    expect(report.skipped).toContainEqual({
      field: "routine:Morning digest",
      detail: "Claude Code does not support routines",
    });
    expect(report.moved.map((item) => item.field)).not.toContain("routines");
    expect(await readdir(join(box.cwd, "project", ".claude", "agents"))).toEqual(["ada.md"]);
    expect((await readdir(join(box.cwd, "agents", "ada"))).sort()).toEqual(
      (await readdir(ADA_DIR)).sort(),
    );
  });

  it("exits 2 without --agent when it cannot ask", async () => {
    const result = await run(box, ["move", "--from", "memory", "--to", "folder"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Missing --agent. Available: ada (Ada)");
    expect(await readdir(box.cwd)).toEqual([]);
  });

  it("exits 2 when --to is missing", async () => {
    const result = await run(box, ["move", "--from", "memory", "--agent", "ada"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--to/);
  });
});
