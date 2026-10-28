import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBundle, writeBundle } from "../../src/core/bundle.js";
import type { MoveReport } from "../../src/core/report.js";
import type { Bundle } from "../../src/core/schema.js";
import {
  ADA_DIR,
  ADA_ID,
  FAKE_KEY,
  STACK_LINE,
  type Sandbox,
  adapterModule,
  json,
  run,
  sandbox,
} from "../helpers/cli.js";

/** Another agent that is also called Ada. */
const OTHER_ID = "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2V";

let box: Sandbox;
beforeEach(async () => {
  box = await sandbox();
});
afterEach(async () => {
  await box.cleanup();
});

/** Ada as a `.jetpack` in the sandbox, changed by `edit`. */
async function adaJetpack(
  name: string,
  edit: (bundle: Bundle) => void = () => {},
): Promise<string> {
  const bundle = await readBundle(ADA_DIR);
  edit(bundle);
  const path = join(box.root, name);
  await writeBundle(bundle, path);
  return path;
}

const reportsDir = (): string => join(box.home, ".openteleport", "reports");

describe("import", () => {
  it("writes a .jetpack into the target and the report into the home folder", async () => {
    const file = await adaJetpack("ada.jetpack");
    const result = await run(box, ["import", "--to", "folder", file]);
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(box.cwd, "ada", "AGENTS.md"), "utf8")).toContain("# Instructions");

    const [report, ...more] = await readdir(reportsDir());
    expect(more).toEqual([]);
    expect(report).toMatch(/^\d{4}-\d\d-\d\dT[\d-]+Z-ada\.md$/);
    const path = join(reportsDir(), report ?? "");
    expect(await readFile(path, "utf8")).toContain("**Target:** folder / ");
    expect(result.stdout).toContain("Outcome: done");
    expect(result.stdout).toContain(`Report written to ${path}`);
  });

  it("imports an agent folder", async () => {
    const result = await run(box, ["import", "--to", "memory", ADA_DIR, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(json<MoveReport>(result)).toMatchObject({
      source: { app: "jetpack", agent: "Ada" },
      target: { app: "memory", agent: "Ada" },
      outcome: "done",
    });
  });

  it("refuses a bundle holding a secret with exit 1 and writes nothing", async () => {
    const file = await adaJetpack("leaky.jetpack", (bundle) => {
      bundle.instructions += `\nUse ${FAKE_KEY} for the API.\n`;
    });
    const result = await run(box, ["import", "--to", "folder", file]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/AGENTS\.md:\d+ anthropic-api-key/);
    expect(result.stderr).not.toContain(FAKE_KEY);
    expect(result.stderr).not.toMatch(STACK_LINE);
    expect(await readdir(box.cwd)).toEqual([]);
  });

  it("puts a different agent of the same name next to the first as -2, saying why", async () => {
    const first = await adaJetpack("ada.jetpack");
    const other = await adaJetpack("other-ada.jetpack", (bundle) => {
      bundle.manifest.id = OTHER_ID;
    });
    expect((await run(box, ["import", "--to", "folder", first])).exitCode).toBe(0);
    const result = await run(box, ["import", "--to", "folder", other, "--json"]);

    expect(result.exitCode).toBe(0);
    const report = json<MoveReport>(result);
    expect(report.target).toEqual({ app: "folder", agent: join(box.cwd, "ada-2") });
    expect(report.warnings).toContainEqual(
      expect.stringMatching(/ada already holds a different agent .*; written as .*ada-2/),
    );
    expect((await readdir(box.cwd)).sort()).toEqual(["ada", "ada-2"]);
    const kept = JSON.parse(await readFile(join(box.cwd, "ada", "jetpack.json"), "utf8"));
    expect(kept.id).toBe(ADA_ID);
  });

  it("updates the same agent in place when it comes again", async () => {
    const file = await adaJetpack("ada.jetpack");
    await run(box, ["import", "--to", "folder", file]);
    const edited = await adaJetpack("ada-edited.jetpack", (bundle) => {
      bundle.instructions = "Fresh instructions.\n";
    });
    const result = await run(box, ["import", "--to", "folder", edited, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(json<MoveReport>(result).target).toEqual({
      app: "folder",
      agent: join(box.cwd, "ada"),
    });
    expect(await readdir(box.cwd)).toEqual(["ada"]);
    expect(await readFile(join(box.cwd, "ada", "AGENTS.md"), "utf8")).toBe(
      "Fresh instructions.\n",
    );
  });

  it("writes a copy with --copy", async () => {
    const file = await adaJetpack("ada.jetpack");
    await run(box, ["import", "--to", "folder", file]);
    const result = await run(box, ["import", "--to", "folder", file, "--copy"]);
    expect(result.exitCode).toBe(0);
    expect((await readdir(box.cwd)).sort()).toEqual(["ada", "ada-2"]);
  });

  it("overwrites a different agent of the same name with --replace --yes", async () => {
    const first = await adaJetpack("ada.jetpack");
    const other = await adaJetpack("other-ada.jetpack", (bundle) => {
      bundle.manifest.id = OTHER_ID;
    });
    await run(box, ["import", "--to", "folder", first]);
    const result = await run(box, ["import", "--to", "folder", other, "--replace", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(await readdir(box.cwd)).toEqual(["ada"]);
    const replaced = JSON.parse(await readFile(join(box.cwd, "ada", "jetpack.json"), "utf8"));
    expect(replaced.id).toBe(OTHER_ID);
  });

  it("exits 2 for --replace without --yes when it cannot ask", async () => {
    const file = await adaJetpack("ada.jetpack");
    const result = await run(box, ["import", "--to", "folder", file, "--replace"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--replace requires --yes when not interactive");
    expect(await readdir(box.cwd)).toEqual([]);
  });

  it("exits 2 for --copy with --replace", async () => {
    const file = await adaJetpack("ada.jetpack");
    const result = await run(box, ["import", "--to", "folder", file, "--copy", "--replace"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--copy and --replace cannot be used together");
    expect(await readdir(box.cwd)).toEqual([]);
  });

  it("says how to go on when --replace is refused for the working folder", async () => {
    const file = await adaJetpack("ada.jetpack");
    await run(box, ["import", "--to", "folder", file, "--target-dir", "."]);
    const result = await run(box, [
      "import",
      "--to",
      "folder",
      file,
      "--target-dir",
      ".",
      "--replace",
      "--yes",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("it is the working folder");
    expect(result.stderr).toContain("Run without --replace to update it in place");
  });

  it("exits 2 for a bundle that does not exist", async () => {
    const result = await run(box, ["import", "--to", "folder", "nope.jetpack"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nope.jetpack");
    expect(result.stderr).not.toMatch(STACK_LINE);
  });

  it("exits 1 for a file that is not a .jetpack", async () => {
    const path = join(box.root, "broken.jetpack");
    await writeFile(path, "this is not a zip archive");
    const result = await run(box, ["import", "--to", "folder", path]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^error: .*not a valid zip archive/m);
    expect(result.stderr).not.toMatch(STACK_LINE);
  });

  it("exits 3 with the hint when the target app is not there", async () => {
    const ghost = await adapterModule(
      box,
      "ghost.mjs",
      { name: "ghost" },
      "{ async detect() {" +
        ' return { found: false, location: "nowhere", hint: "Install Ghost first" }; } }',
    );
    const file = await adaJetpack("ada.jetpack");
    const result = await run(box, ["import", "--to", "ghost", file], { extraAdapter: ghost });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("In-memory ghost was not detected at nowhere");
    expect(result.stderr).toContain("Install Ghost first");
  });

  it("prints an unexpected failure as one line and exits 1", async () => {
    const broken = await adapterModule(
      box,
      "broken.mjs",
      { name: "broken" },
      '{ async write() { throw new Error("disk full"); } }',
    );
    const file = await adaJetpack("ada.jetpack");
    const result = await run(box, ["import", "--to", "broken", file], { extraAdapter: broken });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("error: disk full");
  });

  it("prints the next step last and exits 0 when the target hands the move over", async () => {
    const handoff = await adapterModule(box, "handoff.mjs", {
      name: "inbox",
      outcome: "handoff",
      nextStep: "Open Inbox and drop the file on it.",
    });
    const file = await adaJetpack("ada.jetpack");
    const result = await run(box, ["import", "--to", "inbox", file], { extraAdapter: handoff });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split(/\r?\n/);
    expect(lines.at(-1)).toBe("Next step: Open Inbox and drop the file on it.");
    expect(result.stdout).toContain("Outcome: handoff");
  });

  it("leaves routines disabled unless --enable-routines", async () => {
    const file = await adaJetpack("ada.jetpack");
    await run(box, ["import", "--to", "folder", file, "--target-dir", "off"]);
    await run(box, ["import", "--to", "folder", file, "--target-dir", "on", "--enable-routines"]);
    const routine = async (dir: string) =>
      JSON.parse(await readFile(join(box.cwd, dir, "routines", "morning-digest.json"), "utf8"));
    expect((await routine("off")).enabled).toBe(false);
    expect((await routine("on")).enabled).toBe(true);
  });
});
