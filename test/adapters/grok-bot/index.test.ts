import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grokBotAdapter } from "../../../src/adapters/grok-bot/index.js";
import { readMarker } from "../../../src/adapters/marker.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import { move } from "../../../src/core/engine.js";
import { describeSchedule } from "../../../src/core/schedule.js";
import { zipDirectoryToFile } from "../../helpers/zip.js";

const IMPORT_DIR = fileURLToPath(new URL("../../fixtures/openbot/import-v1", import.meta.url));

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

const DEFAULT: WriteOpts = { enableRoutines: false, includeFiles: false, onConflict: "update" };

let root: string;
let ctx: Ctx;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-grok-bot-index-"));
  await mkdir(join(root, "home"));
  ctx = { home: join(root, "home"), cwd: root, env: {}, exec: noExec, logger: () => {} };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("grokBotAdapter", () => {
  it("is Grok Bot, made by writing, and always ends in a handoff", () => {
    expect(grokBotAdapter.name).toBe("grok-bot");
    expect(grokBotAdapter.displayName).toBe("Grok Bot");
    expect(grokBotAdapter.createsOnWrite).toBe(true);
    expect(grokBotAdapter.handoff).toBe(true);
    expect(typeof grokBotAdapter.cacheIdentity).toBe("function");
  });

  it("holds a persona, instructions, skills, routines of every schedule kind and facts, and no more", () => {
    expect(grokBotAdapter.capabilities).toEqual({
      persona: true,
      instructions: true,
      skills: true,
      routines: true,
      facts: true,
      notes: false,
      files: false,
      avatar: false,
      models: false,
      schedules: ["cron", "every", "at"],
    });
  });
});

describe("a move from an export zip to Grok Bot", () => {
  const out = (): string => join(root, "out");
  /** The import fixture exported on `exportedAt`, zipped to a file of the temp folder. */
  async function exportZip(name: string, exportedAt: string): Promise<string> {
    const copy = await mkdtemp(join(root, "copy-"));
    await cp(IMPORT_DIR, copy, { recursive: true });
    const manifestPath = join(copy, "openbot-import.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { source: object };
    manifest.source = { app: "grok-bot", exportedAt };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    return zipDirectoryToFile(copy, join(root, name));
  }

  it("writes the paste pack for the Bot, with what the engine took out in the report", async () => {
    const zip = await exportZip("openbot-export-2026-10-28.zip", "2026-10-28T10:00:00.000Z");
    const report = await move({
      from: grokBotAdapter,
      to: grokBotAdapter,
      agent: "ada",
      ctx: { ...ctx, sourceDir: zip, targetDir: out() },
      write: DEFAULT,
    });

    const dir = join(out(), "ada-for-grok-bot");
    expect(report.source).toEqual({ app: "grok-bot", agent: "ada" });
    expect(report.target).toEqual({ app: "grok-bot" });
    expect(report.outcome).toBe("handoff");
    expect(report.nextStep).toBe(`Open ${join(dir, "README.md")} and follow the five steps in Grok Bot`);
    // Grok Bot has no avatar and no model; the engine says so before the adapter writes.
    expect(report.skipped.map((item) => item.field)).toContain("avatar");
    expect(report.moved.map((item) => item.field)).toEqual([
      "instructions",
      "skills",
      "routines",
      "memory.facts",
    ]);

    expect((await readdir(dir)).sort()).toEqual([
      ".openteleport.json",
      "1-paste-into-chat.md",
      "2-memory.txt",
      "3-routines.md",
      "README.md",
      "skills",
    ]);
    expect((await readdir(join(dir, "skills"))).sort()).toEqual(["release-notes", "triage"]);
    const chat = await readFile(join(dir, "1-paste-into-chat.md"), "utf8");
    expect(chat.startsWith("From now on, this is who you are and how you work:\n\nAda keeps releases")).toBe(true);
    expect(chat).toContain("- Bug reports tagged security go to the user first.");

    // Eight routines, every one paused because routines move paused unless asked for.
    const routines = (await readFile(join(dir, "3-routines.md"), "utf8")).trimEnd().split("\n");
    expect(routines).toHaveLength(8);
    expect(routines.every((line) => line.endsWith(" (paused)"))).toBe(true);
    expect(routines[1]).toBe(
      `Create a routine named "Morning digest" that runs ${describeSchedule({ kind: "cron", expression: "30 8 * * *" }, "Europe/Warsaw")}: Summarize yesterday's merged pull requests. (paused)`,
    );
  });

  it("moves a Bot that was exported again to the same folder, not next to it", async () => {
    const first = await exportZip("openbot-export-2026-10-28.zip", "2026-10-28T10:00:00.000Z");
    const firstReport = await move({
      from: grokBotAdapter,
      to: grokBotAdapter,
      agent: "ada",
      ctx: { ...ctx, sourceDir: first, targetDir: out() },
      write: DEFAULT,
    });
    const id = (await readMarker(join(out(), "ada-for-grok-bot")))?.id;
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

    // The same Bot exported another day is another file with another date in it, the same key.
    const again = await exportZip("openbot-export-2026-11-02.zip", "2026-11-02T08:30:00.000Z");
    const secondReport = await move({
      from: grokBotAdapter,
      to: grokBotAdapter,
      agent: "Ada",
      ctx: { ...ctx, sourceDir: again, targetDir: out() },
      write: DEFAULT,
    });

    expect(secondReport.target).toEqual(firstReport.target);
    expect(await readdir(out())).toEqual(["ada-for-grok-bot"]);
    expect((await readMarker(join(out(), "ada-for-grok-bot")))?.id).toBe(id);
    expect(secondReport.warnings.some((warning) => warning.includes("written as"))).toBe(false);
  });

  it("keeps the other Bot of the zip apart", async () => {
    const zip = await exportZip("openbot-export-2026-10-28.zip", "2026-10-28T10:00:00.000Z");
    for (const agent of ["ada", "min"]) {
      await move({
        from: grokBotAdapter,
        to: grokBotAdapter,
        agent,
        ctx: { ...ctx, sourceDir: zip, targetDir: out() },
        write: DEFAULT,
      });
    }
    expect((await readdir(out())).sort()).toEqual(["ada-for-grok-bot", "min-for-grok-bot"]);
    const ids = await Promise.all(
      ["ada", "min"].map(async (key) => (await readMarker(join(out(), `${key}-for-grok-bot`)))?.id),
    );
    expect(new Set(ids).size).toBe(2);
  });
});
