import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderPastePack, writeGrokBot } from "../../../src/adapters/grok-bot/write.js";
import { readMarker } from "../../../src/adapters/marker.js";
import type { Ctx, WriteOpts } from "../../../src/adapters/types.js";
import { describeSchedule } from "../../../src/core/schedule.js";
import type { Bundle, Routine } from "../../../src/core/schema.js";
import { ADA_ID, OTHER_ID, adaBundle, bytes } from "./ada.js";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

const ENABLE: WriteOpts = { enableRoutines: true, includeFiles: false, onConflict: "update" };
const DEFAULT: WriteOpts = { ...ENABLE, enableRoutines: false };
const COPY: WriteOpts = { ...ENABLE, onConflict: "copy" };
const REPLACE: WriteOpts = { ...ENABLE, onConflict: "replace" };

/** Whether this machine lets the tests create directory symbolic links. */
const canSymlink = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), "openteleport-symlink-"));
  try {
    await mkdir(join(dir, "target"));
    await symlink(join(dir, "target"), join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

let root: string;
let cwd: string;
let ctx: Ctx;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-grok-bot-write-"));
  cwd = join(root, "cwd");
  await mkdir(join(root, "home"));
  await mkdir(cwd);
  ctx = { home: join(root, "home"), cwd, env: {}, exec: noExec, logger: () => {} };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const text = (path: string): Promise<string> => readFile(path, "utf8");
const lines = (content: string): string[] => content.trimEnd().split("\n");
const routineAt = (bundle: Bundle, index: number): Routine => bundle.routines[index] as Routine;

/** Every file below `dir` as a sorted list of `/`-separated paths. */
async function listing(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      found.push(join(entry.parentPath, entry.name).slice(dir.length + 1).split(sep).join("/"));
    }
  }
  return found.sort();
}

const ADA_DIR = (): string => join(cwd, "ada-for-grok-bot");

/** A Bot that is only a name. */
const bare = (): Bundle => ({
  manifest: { schemaVersion: "0.1", id: ADA_ID, name: "Bare", models: [], capabilities: [] },
  instructions: "",
  skills: [],
  routines: [],
  facts: [],
  notes: [],
  files: [],
  unknownPaths: [],
});

const decode = (files: { path: string; bytes: Uint8Array }[], path: string): string => {
  const file = files.find((entry) => entry.path === path);
  if (file === undefined) throw new Error(`no ${path} in ${files.map((e) => e.path).join(", ")}`);
  return new TextDecoder().decode(file.bytes);
};

describe("renderPastePack", () => {
  it("makes the README, the three text files and every file of every skill", () => {
    const paths = renderPastePack(adaBundle()).map((file) => file.path);
    expect(paths).toEqual([
      "README.md",
      "1-paste-into-chat.md",
      "2-memory.txt",
      "3-routines.md",
      "skills/web-brief/SKILL.md",
      "skills/web-brief/references/checklist.md",
      "skills/triage/SKILL.md",
    ]);
  });

  it("tells the Bot who it is and how it works, then what to remember", () => {
    expect(decode(renderPastePack(adaBundle()), "1-paste-into-chat.md")).toBe(
      [
        "From now on, this is who you are and how you work:",
        "",
        "Curious, precise and brief.",
        "",
        "Read the papers first.",
        "Then summarise them.",
        "",
        "Remember these facts:",
        "",
        "- Prefers short answers",
        "- Works in Europe/Warsaw",
        "- Reads papers on Fridays",
        "",
      ].join("\n"),
    );
  });

  it("leaves out what the Bot does not have, without a gap", () => {
    const onlyInstructions = { ...adaBundle(), facts: [] } as Bundle;
    delete onlyInstructions.persona;
    expect(decode(renderPastePack(onlyInstructions), "1-paste-into-chat.md")).toBe(
      "From now on, this is who you are and how you work:\n\nRead the papers first.\nThen summarise them.\n",
    );
    const onlyFacts: Bundle = { ...adaBundle(), instructions: "  " };
    delete onlyFacts.persona;
    expect(decode(renderPastePack(onlyFacts), "1-paste-into-chat.md")).toBe(
      "From now on, this is who you are and how you work:\n\nRemember these facts:\n\n" +
        "- Prefers short answers\n- Works in Europe/Warsaw\n- Reads papers on Fridays\n",
    );
  });

  it("writes the facts one to a line in the memory file, with no bullets", () => {
    expect(decode(renderPastePack(adaBundle()), "2-memory.txt")).toBe(
      "Prefers short answers\nWorks in Europe/Warsaw\nReads papers on Fridays\n",
    );
  });

  it("keeps a fact on one line and drops blank facts", () => {
    const bundle: Bundle = { ...adaBundle(), facts: ["Two\nlines\r\nhere", "  ", "Plain"] };
    const files = renderPastePack(bundle);
    expect(decode(files, "2-memory.txt")).toBe("Two lines here\nPlain\n");
    expect(decode(files, "1-paste-into-chat.md")).toContain("- Two lines here\n- Plain\n");
  });

  it("writes one line to a routine: its name, its schedule in words, its instruction", () => {
    const routines = lines(decode(renderPastePack(adaBundle()), "3-routines.md"));
    expect(routines).toEqual([
      'Create a routine named "Morning digest" that runs every weekday at 08:00 (Europe/Warsaw): Summarise the news. Keep it to five lines.',
      'Create a routine named "Half hourly check" that runs every 30m (UTC): Check the inbox. (paused)',
      'Create a routine named "Launch day" that runs once at 2026-12-01T07:00:00.000Z (UTC): Post the launch note.',
    ]);
  });

  it("describes each schedule with describeSchedule and the routine's time zone", () => {
    const bundle = adaBundle();
    const routines = lines(decode(renderPastePack(bundle), "3-routines.md"));
    for (const [index, routine] of bundle.routines.entries()) {
      expect(routines[index]).toContain(
        `that runs ${describeSchedule(routine.schedule, routine.timezone)}: `,
      );
    }
  });

  it("puts (paused) after every routine that is off, and only there", () => {
    const routines = lines(decode(renderPastePack(adaBundle()), "3-routines.md"));
    expect(routines.map((line) => line.endsWith(" (paused)"))).toEqual([false, true, false]);
  });

  it("keeps a routine on one line even when its name or instruction spans several", () => {
    const bundle = adaBundle();
    bundle.routines = [
      {
        ...routineAt(bundle, 0),
        name: 'Daily\n"digest"',
        instruction: "First.\r\n\r\n  Second,\nthird.\n",
      },
    ];
    expect(lines(decode(renderPastePack(bundle), "3-routines.md"))).toEqual([
      'Create a routine named "Daily "digest"" that runs every weekday at 08:00 (Europe/Warsaw): First. Second, third.',
    ]);
  });

  it("treats the Unicode line and paragraph separators as line breaks too", () => {
    const bundle = adaBundle();
    const separators = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`;
    bundle.routines = [{ ...routineAt(bundle, 0), instruction: `One${separators}two` }];
    bundle.facts = [`First${String.fromCharCode(0x2028)}second`];
    const files = renderPastePack(bundle);
    expect(lines(decode(files, "3-routines.md"))).toHaveLength(1);
    expect(decode(files, "3-routines.md")).toContain(": One two\n");
    expect(decode(files, "2-memory.txt")).toBe("First second\n");
  });

  it("copies a skill whole, byte for byte", () => {
    const binary = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
    const bundle = adaBundle();
    bundle.skills = [
      {
        name: "web-brief",
        files: [
          { path: "SKILL.md", bytes: bytes("# Skill\n") },
          { path: "assets/blob.bin", bytes: binary },
        ],
      },
    ];
    const files = renderPastePack(bundle);
    expect(files.find((file) => file.path === "skills/web-brief/assets/blob.bin")?.bytes).toEqual(
      binary,
    );
  });

  it("leaves out a skill whose name or file path could reach outside the folder", () => {
    const bundle = adaBundle();
    bundle.skills = [
      { name: "../evil", files: [{ path: "SKILL.md", bytes: bytes("x") }] },
      { name: "con", files: [{ path: "SKILL.md", bytes: bytes("x") }] },
      { name: "ok", files: [{ path: "SKILL.md", bytes: bytes("x") }, { path: "../up.md", bytes: bytes("y") }] },
      { name: "fine", files: [{ path: "SKILL.md", bytes: bytes("x") }] },
    ];
    const paths = renderPastePack(bundle).map((file) => file.path);
    expect(paths.filter((path) => path.startsWith("skills/"))).toEqual(["skills/fine/SKILL.md"]);
    expect(decode(renderPastePack(bundle), "README.md")).not.toContain("evil");
  });

  it("makes only the README for a Bot that is a name and nothing else", () => {
    expect(renderPastePack(bare()).map((file) => file.path)).toEqual(["README.md"]);
  });

  it("does not change the bundle", () => {
    const bundle = adaBundle();
    const before = JSON.stringify(bundle);
    renderPastePack(bundle);
    expect(JSON.stringify(bundle)).toBe(before);
  });
});

describe("renderPastePack: the README", () => {
  const readme = (bundle: Bundle = adaBundle()): string => decode(renderPastePack(bundle), "README.md");

  it("is about the Bot, says there is no import, and gives five numbered steps", () => {
    const content = readme();
    expect(content.startsWith("# Ada for Grok Bot\n")).toBe(true);
    expect(content).toContain("Grok Bot cannot import a Bot from a file");
    for (const step of [1, 2, 3, 4, 5]) expect(content).toMatch(new RegExp(`^${step}\\. `, "m"));
    expect(content).not.toMatch(/^6\. /m);
  });

  it("names the Bot and its title in step 1", () => {
    expect(readme()).toContain('1. In Grok Bot, create a new Bot named "Ada" and give it the title "Research assistant".');
    const untitled = adaBundle();
    delete untitled.manifest.title;
    expect(readme(untitled)).toContain('1. In Grok Bot, create a new Bot named "Ada".\n');
  });

  it("points at the first message in step 2", () => {
    expect(readme()).toContain(
      "2. Paste the whole of `1-paste-into-chat.md` into the Bot's chat as the first message.",
    );
  });

  it("gives the exact message for each skill in step 3, and says skills are shared", () => {
    const content = readme();
    expect(content).toContain("   - `skills/web-brief/SKILL.md`: Save this as a skill named web-brief\n");
    expect(content).toContain("   - `skills/triage/SKILL.md`: Save this as a skill named triage\n");
    expect(content).toContain("one set of skills for the whole account");
  });

  it("explains the lines of 3-routines.md and (paused) in step 4", () => {
    const content = readme();
    expect(content).toContain("4. Paste each line of `3-routines.md` into the chat, one message per line.");
    expect(content).toContain("A line that ends with (paused) is a routine that should stay off");
  });

  it("offers the memory import in step 5 as optional", () => {
    expect(readme()).toContain(
      "5. Optional: in Settings > General > Import, choose Add to Memory and give it `2-memory.txt`.",
    );
  });

  it("says plainly which steps have nothing to do", () => {
    const content = readme(bare());
    expect(content).toContain("2. This Bot has no persona, instructions or facts, so there is nothing to paste.");
    expect(content).toContain("3. This Bot has no skills, so there is nothing to save.");
    expect(content).toContain("4. This Bot has no routines, so there is nothing to create.");
    expect(content).toContain("5. This Bot has no facts, so there is no `2-memory.txt` to import.");
    for (const step of [1, 2, 3, 4, 5]) expect(content).toMatch(new RegExp(`^${step}\\. `, "m"));
  });

  it("explains the marker", () => {
    expect(readme()).toContain("`.openteleport.json`");
  });

  it("is plain ASCII, with no typographic dashes or arrows", () => {
    for (const file of renderPastePack(adaBundle())) {
      if (file.path.startsWith("skills/")) continue;
      expect(new TextDecoder().decode(file.bytes)).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    }
  });
});

describe("writeGrokBot: the folder", () => {
  it("hands over a folder in the working directory", async () => {
    const result = await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect(result.outcome).toBe("handoff");
    expect(result.artifactPath).toBe(ADA_DIR());
    expect(result.targetAgentId).toBeUndefined();
    expect(result.nextStep).toBe(
      `Open ${join(ADA_DIR(), "README.md")} and follow the five steps in Grok Bot`,
    );
    expect((await readdir(ADA_DIR())).sort()).toEqual([
      ".openteleport.json",
      "1-paste-into-chat.md",
      "2-memory.txt",
      "3-routines.md",
      "README.md",
      "skills",
    ]);
    expect(await listing(ADA_DIR())).toEqual([
      ".openteleport.json",
      "1-paste-into-chat.md",
      "2-memory.txt",
      "3-routines.md",
      "README.md",
      "skills/triage/SKILL.md",
      "skills/web-brief/SKILL.md",
      "skills/web-brief/references/checklist.md",
    ]);
  });

  it("writes exactly what renderPastePack makes", async () => {
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    for (const file of renderPastePack(adaBundle())) {
      const written = await readFile(join(ADA_DIR(), ...file.path.split("/")));
      expect(written.equals(file.bytes), file.path).toBe(true);
    }
  });

  it("starts the chat message as the spec says, with the persona, the instructions and 3 facts", async () => {
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    const message = await text(join(ADA_DIR(), "1-paste-into-chat.md"));
    expect(message.startsWith("From now on, this is who you are and how you work:")).toBe(true);
    expect(message).toContain("Curious, precise and brief.");
    expect(message).toContain("Read the papers first.\nThen summarise them.");
    const [, facts] = message.split("Remember these facts:");
    expect((facts as string).trim().split("\n").filter((line) => line.startsWith("- "))).toHaveLength(3);
  });

  it("writes three lines of memory and three lines of routines", async () => {
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect(lines(await text(join(ADA_DIR(), "2-memory.txt")))).toHaveLength(3);
    expect(lines(await text(join(ADA_DIR(), "3-routines.md")))).toHaveLength(3);
  });

  it("keeps the id of the Bot in the marker", async () => {
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    const marker = await readMarker(ADA_DIR());
    expect(marker?.id).toBe(ADA_ID);
    expect(Number.isNaN(Date.parse(marker?.movedAt ?? ""))).toBe(false);
  });

  it("writes into the target directory when there is one, creating it", async () => {
    const out = join(root, "out", "deeper");
    const result = await writeGrokBot({ ...ctx, targetDir: out }, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(join(out, "ada-for-grok-bot"));
    expect(await text(join(out, "ada-for-grok-bot", "2-memory.txt"))).toContain("Prefers short answers");
    // A relative target directory is relative to the working directory.
    const relative = await writeGrokBot({ ...ctx, targetDir: "rel" }, adaBundle(), ENABLE);
    expect(relative.artifactPath).toBe(join(cwd, "rel", "ada-for-grok-bot"));
  });

  it("names the folder after a slug of the Bot's name", async () => {
    const named = (name: string): Bundle => {
      const bundle = adaBundle();
      bundle.manifest.name = name;
      return bundle;
    };
    expect((await writeGrokBot(ctx, named("Ada Lovelace"), ENABLE)).artifactPath).toBe(
      join(cwd, "ada-lovelace-for-grok-bot"),
    );
    expect((await writeGrokBot(ctx, named("***"), ENABLE)).artifactPath).toBe(
      join(cwd, "agent-for-grok-bot"),
    );
    expect((await writeGrokBot(ctx, named("../../evil"), ENABLE)).artifactPath).toBe(
      join(cwd, "evil-for-grok-bot"),
    );
    expect((await writeGrokBot(ctx, named("x".repeat(100)), ENABLE)).artifactPath).toBe(
      join(cwd, `${"x".repeat(64)}-for-grok-bot`),
    );
  });

  it("leaves no temporary file behind", async () => {
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect((await listing(cwd)).filter((path) => path.includes(".tmp"))).toEqual([]);
  });

  it("does not change the bundle it is given", async () => {
    const bundle = adaBundle();
    const before = JSON.stringify(bundle);
    await writeGrokBot(ctx, bundle, DEFAULT);
    expect(JSON.stringify(bundle)).toBe(before);
  });

  it("writes a folder for a Bot with nothing but a name", async () => {
    const result = await writeGrokBot(ctx, bare(), ENABLE);
    expect(await listing(join(cwd, "bare-for-grok-bot"))).toEqual([".openteleport.json", "README.md"]);
    expect(result.items).toEqual({ approximated: [], skipped: [], warnings: [] });
  });

  it("leaves out and reports a skill that cannot be written, and writes nothing outside", async () => {
    const bundle: Bundle = {
      ...adaBundle(),
      skills: [
        { name: "../evil", files: [{ path: "SKILL.md", bytes: bytes("x") }] },
        { name: "fine", files: [{ path: "SKILL.md", bytes: bytes("y") }] },
      ],
    };
    const result = await writeGrokBot(ctx, bundle, ENABLE);
    expect(result.items.skipped).toEqual([
      { field: "skill:../evil", detail: "its name or a file path is not safe to write" },
    ]);
    expect((await listing(cwd)).filter((path) => /evil/.test(path))).toEqual([]);
    expect(await text(join(ADA_DIR(), "skills", "fine", "SKILL.md"))).toBe("y");
  });
});

describe("writeGrokBot: routines", () => {
  it("pauses every routine unless routines are enabled, as in every other adapter", async () => {
    await writeGrokBot(ctx, adaBundle(), DEFAULT);
    const routines = lines(await text(join(ADA_DIR(), "3-routines.md")));
    expect(routines).toHaveLength(3);
    expect(routines.every((line) => line.endsWith(" (paused)"))).toBe(true);
  });

  it("pauses only the routines that are off in the Bot with enableRoutines", async () => {
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    const routines = lines(await text(join(ADA_DIR(), "3-routines.md")));
    expect(routines.map((line) => line.endsWith(" (paused)"))).toEqual([false, true, false]);
  });

  it("skips a routine that repeats more often than Grok Bot allows", async () => {
    const bundle = adaBundle();
    bundle.routines = [
      { ...routineAt(bundle, 1), name: "Too often", schedule: { kind: "every", every: "4m" } },
      { ...routineAt(bundle, 1), name: "Just right", schedule: { kind: "every", every: "5m" } },
      { ...routineAt(bundle, 1), name: "Hourly", schedule: { kind: "every", every: "1h" } },
    ];
    const result = await writeGrokBot(ctx, bundle, ENABLE);
    expect(result.items.skipped).toEqual([
      {
        field: "routine:Too often",
        detail: "every 4m is shorter than the 5 minutes Grok Bot allows between runs",
      },
    ]);
    expect(lines(await text(join(ADA_DIR(), "3-routines.md"))).map((line) => line.split('"')[1])).toEqual([
      "Just right",
      "Hourly",
    ]);
  });

  it("skips the routines beyond the 50 a Bot can have, keeping the first 50", async () => {
    const bundle = adaBundle();
    bundle.routines = Array.from({ length: 52 }, (_unused, index) => ({
      ...routineAt(bundle, 0),
      name: `Routine ${index + 1}`,
    }));
    const result = await writeGrokBot(ctx, bundle, ENABLE);
    expect(result.items.skipped).toEqual([
      { field: "routine:Routine 51", detail: "Grok Bot allows 50 routines per Bot" },
      { field: "routine:Routine 52", detail: "Grok Bot allows 50 routines per Bot" },
    ]);
    const written = lines(await text(join(ADA_DIR(), "3-routines.md")));
    expect(written).toHaveLength(50);
    expect(written[49]).toContain('"Routine 50"');
  });

  it("counts the routines that are too frequent out before it counts the 50", async () => {
    const bundle = adaBundle();
    bundle.routines = [
      { ...routineAt(bundle, 1), name: "Too often", schedule: { kind: "every", every: "1m" } },
      ...Array.from({ length: 50 }, (_unused, index) => ({
        ...routineAt(bundle, 0),
        name: `Routine ${index + 1}`,
      })),
    ];
    const result = await writeGrokBot(ctx, bundle, ENABLE);
    expect(result.items.skipped.map((item) => item.field)).toEqual(["routine:Too often"]);
  });

  it("writes no routines file, and says so in the README, when every routine is skipped", async () => {
    const bundle = adaBundle();
    bundle.routines = [
      { ...routineAt(bundle, 1), name: "Too often", schedule: { kind: "every", every: "1m" } },
    ];
    await writeGrokBot(ctx, bundle, ENABLE);
    expect(await listing(ADA_DIR())).not.toContain("3-routines.md");
    expect(await text(join(ADA_DIR(), "README.md"))).toContain(
      "4. This Bot has no routines, so there is nothing to create.",
    );
  });
});

describe("writeGrokBot: the report", () => {
  it("says what it approximated: the persona, the instructions and the facts", async () => {
    const { items } = await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect(items.approximated).toEqual([
      {
        field: "persona",
        detail: "pasted into the chat for the Bot to remember; Grok Bot has no persona field",
      },
      {
        field: "instructions",
        detail: "pasted into the chat for the Bot to remember; Grok Bot has no instructions field",
      },
      {
        field: "memory.facts",
        detail:
          "pasted into the chat and written to 2-memory.txt; the Bot decides what it keeps in memory",
      },
    ]);
    expect(items.skipped).toEqual([]);
  });

  it("warns that skills are shared by the account and that the memory file is a guess", async () => {
    const { items } = await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect(items.warnings).toEqual([
      "Grok Bot keeps one set of skills for the whole account, so saving these skills affects every Bot you have",
      "Grok Bot does not document the format of its memory import; 2-memory.txt is plain text, one fact per line, and may not be accepted",
    ]);
  });

  it("says nothing about what the Bot does not have", async () => {
    const bundle = adaBundle();
    delete bundle.persona;
    bundle.instructions = "";
    bundle.facts = [];
    bundle.skills = [];
    const { items } = await writeGrokBot(ctx, bundle, ENABLE);
    expect(items).toEqual({ approximated: [], skipped: [], warnings: [] });
  });
});

describe("writeGrokBot: a folder that is already there", () => {
  it("writes over its own folder when the same Bot is moved again, leaving nothing of the old version", async () => {
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    await writeFile(join(ADA_DIR(), "my-own-notes.txt"), "mine");

    const next = adaBundle();
    next.facts = [];
    next.routines = [routineAt(next, 2)];
    next.skills = [(next.skills[1] as Bundle["skills"][number])];
    next.instructions = "Only this now.";
    const result = await writeGrokBot(ctx, next, ENABLE);

    expect(result.artifactPath).toBe(ADA_DIR());
    expect(result.items.warnings.some((warning) => warning.includes("written as"))).toBe(false);
    expect(await listing(ADA_DIR())).toEqual([
      ".openteleport.json",
      "1-paste-into-chat.md",
      "3-routines.md",
      "README.md",
      "my-own-notes.txt",
      "skills/triage/SKILL.md",
    ]);
    expect(await text(join(ADA_DIR(), "1-paste-into-chat.md"))).toContain("Only this now.");
    expect(await text(join(ADA_DIR(), "1-paste-into-chat.md"))).not.toContain("Remember these facts");
    expect(lines(await text(join(ADA_DIR(), "3-routines.md")))).toHaveLength(1);
    expect(await text(join(ADA_DIR(), "my-own-notes.txt"))).toBe("mine");
    expect(await readdir(cwd)).toEqual(["ada-for-grok-bot"]);
  });

  it("writes another Bot of the same name next to a folder with no marker, and says so", async () => {
    await mkdir(ADA_DIR());
    await writeFile(join(ADA_DIR(), "theirs.txt"), "theirs");
    const result = await writeGrokBot(ctx, adaBundle(), ENABLE);

    const second = join(cwd, "ada-for-grok-bot-2");
    expect(result.artifactPath).toBe(second);
    expect(result.nextStep).toBe(`Open ${join(second, "README.md")} and follow the five steps in Grok Bot`);
    expect(result.items.warnings[0]).toBe(
      `${ADA_DIR()} holds no .openteleport.json of this agent; written as ${second}`,
    );
    expect(await listing(ADA_DIR())).toEqual(["theirs.txt"]);
    expect((await readMarker(second))?.id).toBe(ADA_ID);
  });

  it("writes another Bot of the same name next to a folder that carries a different marker", async () => {
    await writeGrokBot(ctx, { ...adaBundle(), manifest: { ...adaBundle().manifest, id: OTHER_ID } }, ENABLE);
    const result = await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(join(cwd, "ada-for-grok-bot-2"));
    expect(result.items.warnings[0]).toBe(
      `${ADA_DIR()} holds a different agent; written as ${join(cwd, "ada-for-grok-bot-2")}`,
    );
    expect((await readMarker(ADA_DIR()))?.id).toBe(OTHER_ID);
  });

  it("finds the -N folder that already holds this Bot and updates that one", async () => {
    await mkdir(ADA_DIR());
    await writeFile(join(ADA_DIR(), "theirs.txt"), "theirs");
    const first = await writeGrokBot(ctx, adaBundle(), ENABLE);
    const again = await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect(first.artifactPath).toBe(join(cwd, "ada-for-grok-bot-2"));
    expect(again.artifactPath).toBe(join(cwd, "ada-for-grok-bot-2"));
    expect((await readdir(cwd)).sort()).toEqual(["ada-for-grok-bot", "ada-for-grok-bot-2"]);
  });

  it("looks past a -N folder of yet another Bot, and stops at the first free number", async () => {
    const other = { ...adaBundle(), manifest: { ...adaBundle().manifest, id: OTHER_ID } };
    await writeGrokBot(ctx, other, ENABLE);
    await writeGrokBot(ctx, other, COPY); // ada-for-grok-bot-2
    await mkdir(join(cwd, "ada-for-grok-bot-4"));
    await writeFile(join(cwd, "ada-for-grok-bot-4", "x"), "x");
    const result = await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(join(cwd, "ada-for-grok-bot-3"));
  });

  it("uses an empty folder of the name", async () => {
    await mkdir(ADA_DIR());
    const result = await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(ADA_DIR());
    expect(result.items.warnings.some((warning) => warning.includes("written as"))).toBe(false);
  });

  it("always writes a copy next to the folder with copy, with no warning about it", async () => {
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    const first = await writeGrokBot(ctx, adaBundle(), COPY);
    const second = await writeGrokBot(ctx, adaBundle(), COPY);
    expect(first.artifactPath).toBe(join(cwd, "ada-for-grok-bot-2"));
    expect(second.artifactPath).toBe(join(cwd, "ada-for-grok-bot-3"));
    expect(first.items.warnings.some((warning) => warning.includes("written as"))).toBe(false);
  });

  it("refuses to replace a folder with no marker, and leaves it as it is", async () => {
    await mkdir(ADA_DIR());
    await writeFile(join(ADA_DIR(), "theirs.txt"), "theirs");
    await expect(writeGrokBot(ctx, adaBundle(), REPLACE)).rejects.toThrow(
      `Refusing to replace ${ADA_DIR()}: it holds no .openteleport.json, so it is not a folder ` +
        "OpenTeleport wrote. Delete it yourself if you mean it.",
    );
    expect(await listing(ADA_DIR())).toEqual(["theirs.txt"]);
    expect(await readdir(cwd)).toEqual(["ada-for-grok-bot"]);
  });

  it("refuses to replace something that is not a folder", async () => {
    await writeFile(ADA_DIR(), "a file");
    await expect(writeGrokBot(ctx, adaBundle(), REPLACE)).rejects.toThrow(
      /^Refusing to replace .*: it is not a folder\. Delete it yourself if you mean it\.$/,
    );
    expect(await text(ADA_DIR())).toBe("a file");
  });

  it("replaces a folder that carries a marker, whichever Bot's", async () => {
    await writeGrokBot(ctx, { ...adaBundle(), manifest: { ...adaBundle().manifest, id: OTHER_ID } }, ENABLE);
    const result = await writeGrokBot(ctx, adaBundle(), REPLACE);
    expect(result.artifactPath).toBe(ADA_DIR());
    expect((await readMarker(ADA_DIR()))?.id).toBe(ADA_ID);
    expect(await readdir(cwd)).toEqual(["ada-for-grok-bot"]);
  });

  it("updates a folder written without an id only by writing next to it", async () => {
    const bundle = adaBundle();
    bundle.manifest.id = "";
    await writeGrokBot(ctx, bundle, ENABLE);
    const result = await writeGrokBot(ctx, bundle, ENABLE);
    expect(result.artifactPath).toBe(join(cwd, "ada-for-grok-bot-2"));
  });

  it.skipIf(!canSymlink)("never writes through a link that is in the way", async () => {
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "keep.txt"), "keep");
    await symlink(elsewhere, ADA_DIR(), "dir");

    const result = await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect(result.artifactPath).toBe(join(cwd, "ada-for-grok-bot-2"));
    expect(result.items.warnings[0]).toBe(
      `${ADA_DIR()} is a symbolic link, which is not written through; written as ${join(cwd, "ada-for-grok-bot-2")}`,
    );
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);

    await expect(writeGrokBot(ctx, adaBundle(), REPLACE)).rejects.toThrow(
      /^Refusing to replace .*: it is a symbolic link\. Delete it yourself if you mean it\.$/,
    );
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);
  });

  it.skipIf(!canSymlink)("replaces a link in place of skills/ or a file without following it", async () => {
    await writeGrokBot(ctx, adaBundle(), ENABLE);
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "keep.txt"), "keep");
    await writeFile(join(elsewhere, "notes.txt"), "original");
    await rm(join(ADA_DIR(), "skills"), { recursive: true });
    await symlink(elsewhere, join(ADA_DIR(), "skills"), "dir");
    await rm(join(ADA_DIR(), "2-memory.txt"));
    await symlink(join(elsewhere, "notes.txt"), join(ADA_DIR(), "2-memory.txt"), "file").catch(() => {});

    await writeGrokBot(ctx, adaBundle(), ENABLE);
    expect((await readdir(elsewhere)).sort()).toEqual(["keep.txt", "notes.txt"]);
    expect(await text(join(elsewhere, "notes.txt"))).toBe("original");
    expect(await text(join(ADA_DIR(), "skills", "triage", "SKILL.md"))).toContain("# Triage");
    expect(await text(join(ADA_DIR(), "2-memory.txt"))).toContain("Prefers short answers");
  });
});
