import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readBundle, writeBundle } from "../../src/core/bundle.js";
import type { Bundle } from "../../src/core/schema.js";
import type { MoveReport } from "../../src/core/report.js";
import { FAKE_KEY, type Sandbox, json, run, sandbox } from "../helpers/cli.js";

let box: Sandbox;
let source: string;
let target: string;
const fixture = (): Bundle => ({
  manifest: { schemaVersion: "0.1", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "Reviewer", models: [], capabilities: [] },
  instructions: "Review the supplied evidence.", persona: "Patient", facts: ["Private preference"],
  notes: [{ name: "private", text: "Personal note" }], skills: [], routines: [], files: [], unknownPaths: [],
});
beforeEach(async () => {
  box = await sandbox(); source = join(box.cwd, "source"); target = join(box.cwd, "target");
  await writeBundle(fixture(), source, { asDirectory: true });
});
afterEach(async () => { await box.cleanup(); });

it.each(["export", "import", "move"])("%s --no-memory excludes facts and notes, preserving the source", async (operation) => {
  const archive = join(box.cwd, "configuration.jetpack");
  const flags = operation === "export" ? ["--from", "folder", "--agent", ".", "--source-dir", source, "--out", archive]
    : operation === "import" ? [source, "--to", "folder", "--target-dir", target]
      : ["--from", "folder", "--agent", ".", "--source-dir", source, "--to", "folder", "--target-dir", target, "--keep", archive];
  const result = await run(box, [operation, ...flags, "--no-memory", "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const report = json<MoveReport>(result);
  expect(report.skipped.map(item => item.field)).toEqual(expect.arrayContaining(["memory.facts", "memory.notes"]));
  expect(report.warnings.join(" ")).toContain("not anonymization");
  const output = await readBundle(operation === "export" ? archive : target);
  expect(output.facts).toEqual([]); expect(output.notes).toEqual([]);
  expect(output.instructions).toBe(fixture().instructions);
  expect(output.persona).toBe(fixture().persona);
  if (operation === "move") {
    const kept = await readBundle(archive);
    expect(kept.facts).toEqual([]); expect(kept.notes).toEqual([]);
  }
  expect((await readBundle(source)).facts).toEqual(fixture().facts);
  expect((await readBundle(source)).notes).toEqual(fixture().notes);
});

it("retains memory by default and reports its removal when updating without it", async () => {
  const args = ["import", source, "--to", "folder", "--target-dir", target, "--json"];
  expect((await run(box, args)).exitCode).toBe(0);
  expect((await readBundle(target)).facts).toEqual(fixture().facts);
  expect((await readBundle(target)).notes).toEqual(fixture().notes);
  const result = await run(box, [...args, "--no-memory"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(json<MoveReport>(result).warnings.join(" ")).toContain("may remove previously imported");
  expect((await readBundle(target)).facts).toEqual([]);
  expect((await readBundle(target)).notes).toEqual([]);
});

it("scans selected content, allowing excluded memory but refusing retained credentials", async () => {
  const data = { ...fixture(), facts: [FAKE_KEY] };
  await writeBundle(data, source, { asDirectory: true });
  const args = ["export", "--from", "folder", "--agent", ".", "--source-dir", source, "--out", join(box.cwd, "selected.jetpack"), "--json"];
  expect((await run(box, args)).exitCode).not.toBe(0);
  expect((await run(box, [...args, "--no-memory"])).exitCode).toBe(0);
  await writeBundle({ ...data, instructions: FAKE_KEY }, source, { asDirectory: true });
  expect((await run(box, [...args, "--no-memory"])).exitCode).not.toBe(0);
  expect(await readFile(join(source, "AGENTS.md"), "utf8")).toBe(FAKE_KEY);
});
