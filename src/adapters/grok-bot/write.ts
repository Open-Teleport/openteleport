// Writes a Bundle for Grok Bot as a folder to hand over: the text a Bot needs to hear to become
// this Bot, one file for each kind of thing, and a README with the five steps. Grok Bot imports
// nothing but memory (spec, section 7.2), so the Bot itself is made in the app, by hand, from
// what is pasted into its chat.
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSafeArchivePath } from "../../core/paths.js";
import type { Item } from "../../core/report.js";
import { describeSchedule, everyToMs } from "../../core/schedule.js";
import type { Bundle, FileEntry, Manifest, Routine, Skill } from "../../core/schema.js";
import { factsToProse, slugify } from "../../core/text.js";
import { isSafeName, replaceFile } from "../fs.js";
import { MARKER_FILE, writeMarker } from "../marker.js";
import { claimFolder } from "../names.js";
import type { Ctx, WriteOpts, WriteResult } from "../types.js";

const FOLDER_SUFFIX = "-for-grok-bot";
const README_FILE = "README.md";
const CHAT_FILE = "1-paste-into-chat.md";
const MEMORY_FILE = "2-memory.txt";
const ROUTINES_FILE = "3-routines.md";
const SKILLS_DIR = "skills";
/** The files of the folder that are made from the Bot; the rest is the user's. */
const GENERATED_FILES = [README_FILE, CHAT_FILE, MEMORY_FILE, ROUTINES_FILE];

// What Grok Bot allows of a Bot's routines (its documentation on skills, routines and automations).
const MAX_ROUTINES = 50;
const MIN_INTERVAL_MINUTES = 5;
const MIN_INTERVAL_MS = MIN_INTERVAL_MINUTES * 60 * 1000;

const SKILLS_WARNING =
  "Grok Bot keeps one set of skills for the whole account, so saving these skills affects every Bot you have";
const MEMORY_WARNING =
  "Grok Bot does not document the format of its memory import; 2-memory.txt is plain text, one fact per line, and may not be accepted";

type Items = WriteResult["items"];

const encoder = new TextEncoder();

/** `value` on one line: each line break, with the blanks around it, becomes one space. */
const oneLine = (value: string): string =>
  value.replace(/\s*[\r\n\v\f\x85\p{Zl}\p{Zp}]+\s*/gu, " ").trim();

// -- The pack ---------------------------------------------------------------------------------

/** The facts, each on one line (a Unicode separator is a break too); blank ones are dropped. */
const factLines = (facts: readonly string[]): string[] =>
  facts.map(oneLine).filter((fact) => fact !== "");

/** A skill is copied whole, so its name and every path in it have to stay inside its folder. */
const isSafeSkill = (skill: Skill): boolean =>
  isSafeName(skill.name) && skill.files.every((file) => isSafeArchivePath(file.path));

/**
 * What the Bot is told first: who it is and how it works (the persona, then the instructions),
 * then the facts to remember. `undefined` when the Bot has none of the three.
 */
function renderChat(bundle: Bundle): string | undefined {
  const sections = [bundle.persona ?? "", bundle.instructions]
    .map((section) => section.trim())
    .filter((section) => section !== "");
  const facts = factsToProse(factLines(bundle.facts));
  if (sections.length === 0 && facts === "") return undefined;
  return `${[
    "From now on, this is who you are and how you work:",
    ...sections,
    ...(facts === "" ? [] : ["Remember these facts:", facts]),
  ].join("\n\n")}\n`;
}

/** The facts for the memory import, one to a line. `undefined` when there are none. */
function renderMemory(facts: readonly string[]): string | undefined {
  const lines = factLines(facts);
  return lines.length === 0 ? undefined : `${lines.join("\n")}\n`;
}

/** One line to paste for each routine, `(paused)` after the ones that are to stay off. */
function renderRoutines(routines: readonly Routine[]): string | undefined {
  if (routines.length === 0) return undefined;
  return `${routines
    .map((routine) => {
      const when = oneLine(describeSchedule(routine.schedule, routine.timezone));
      const name = oneLine(routine.name);
      const line = `Create a routine named "${name}" that runs ${when}: ${oneLine(routine.instruction)}`;
      return routine.enabled ? line : `${line} (paused)`;
    })
    .join("\n")}\n`;
}

type Contents = { chat: boolean; skills: readonly Skill[]; memory: boolean; routines: boolean };

function renderReadme(manifest: Manifest, has: Contents): string {
  const name = oneLine(manifest.name);
  const title = manifest.title === undefined ? "" : oneLine(manifest.title);
  const titled = title === "" ? "" : ` and give it the title "${title}"`;
  const steps = [
    `1. In Grok Bot, create a new Bot named "${name}"${titled}.`,
    has.chat
      ? `2. Paste the whole of \`${CHAT_FILE}\` into the Bot's chat as the first message. It tells the Bot who it is, how it works and which facts to remember.`
      : "2. This Bot has no persona, instructions or facts, so there is nothing to paste.",
    has.skills.length > 0
      ? [
          `3. Paste each skill's \`SKILL.md\` into the chat, together with the message shown next to it. Grok Bot keeps one set of skills for the whole account, so every Bot of yours will see them. Other files in a skill's folder are there for reference.`,
          ...has.skills.map(
            (skill) =>
              `   - \`${SKILLS_DIR}/${skill.name}/SKILL.md\`: Save this as a skill named ${skill.name}`,
          ),
        ].join("\n")
      : "3. This Bot has no skills, so there is nothing to save.",
    has.routines
      ? `4. Paste each line of \`${ROUTINES_FILE}\` into the chat, one message per line. The Bot creates the routine. A line that ends with (paused) is a routine that should stay off: pause it once the Bot has created it. Routines move paused unless OpenTeleport was run with --enable-routines.`
      : "4. This Bot has no routines, so there is nothing to create.",
    has.memory
      ? `5. Optional: in Settings > General > Import, choose Add to Memory and give it \`${MEMORY_FILE}\`. This saves the facts to Grok Bot's memory directly; the first message already asks the Bot to remember them.`
      : `5. This Bot has no facts, so there is no \`${MEMORY_FILE}\` to import.`,
  ];
  return `# ${name} for Grok Bot

Grok Bot cannot import a Bot from a file, so OpenTeleport wrote everything the Bot needs to hear
in a conversation. This folder is not a Bot yet: follow the five steps below.

${steps.join("\n")}

Good to know:

- Grok Bot has no instructions field and no import for Bots, so a Bot keeps what it is told in
  its memory. Ask it what it remembers to check.
- \`${MARKER_FILE}\` lets a later move of the same Bot update this folder in place. Leave it where
  it is.
`;
}

/**
 * The files of the paste pack, in the order they are written. A text file is there only when the
 * Bot has something for it, and the README always is; a skill is copied whole under `skills/`,
 * unless its name or a path in it is not safe to write. `bundle` is not changed.
 */
export function renderPastePack(bundle: Bundle): FileEntry[] {
  const skills = bundle.skills.filter(isSafeSkill);
  const chat = renderChat(bundle);
  const memory = renderMemory(bundle.facts);
  const routines = renderRoutines(bundle.routines);
  const readme = renderReadme(bundle.manifest, {
    chat: chat !== undefined,
    skills,
    memory: memory !== undefined,
    routines: routines !== undefined,
  });
  const texts: [string, string | undefined][] = [
    [README_FILE, readme],
    [CHAT_FILE, chat],
    [MEMORY_FILE, memory],
    [ROUTINES_FILE, routines],
  ];
  return [
    ...texts.flatMap(([path, content]) =>
      content === undefined ? [] : [{ path, bytes: encoder.encode(content) }],
    ),
    ...skills.flatMap((skill) =>
      skill.files.map(({ path, bytes }) => ({ path: `${SKILLS_DIR}/${skill.name}/${path}`, bytes })),
    ),
  ];
}

// -- What Grok Bot cannot hold ----------------------------------------------------------------

/**
 * The routines Grok Bot will take: none that repeats more often than every 5 minutes, and at most
 * 50, the first ones. The others are added to `skipped`. (Only an interval is checked for its
 * rate; a cron expression is taken as it is.)
 */
function fitRoutines(routines: readonly Routine[], skipped: Item[]): Routine[] {
  const skip = (routine: Routine, detail: string): void => {
    skipped.push({ field: `routine:${routine.name}`, detail });
  };
  const slowEnough = routines.filter((routine) => {
    const { schedule } = routine;
    if (schedule.kind !== "every" || everyToMs(schedule.every) >= MIN_INTERVAL_MS) return true;
    skip(
      routine,
      `every ${schedule.every} is shorter than the ${MIN_INTERVAL_MINUTES} minutes Grok Bot allows between runs`,
    );
    return false;
  });
  for (const routine of slowEnough.slice(MAX_ROUTINES)) {
    skip(routine, `Grok Bot allows ${MAX_ROUTINES} routines per Bot`);
  }
  return slowEnough.slice(0, MAX_ROUTINES);
}

// -- Writing ----------------------------------------------------------------------------------

function approximations(bundle: Bundle, pack: readonly FileEntry[]): Item[] {
  const items: Item[] = [];
  const inChat = "pasted into the chat for the Bot to remember; Grok Bot has no";
  if ((bundle.persona ?? "").trim() !== "") {
    items.push({ field: "persona", detail: `${inChat} persona field` });
  }
  if (bundle.instructions.trim() !== "") {
    items.push({ field: "instructions", detail: `${inChat} instructions field` });
  }
  if (pack.some((file) => file.path === MEMORY_FILE)) {
    items.push({
      field: "memory.facts",
      detail: `pasted into the chat and written to ${MEMORY_FILE}; the Bot decides what it keeps in memory`,
    });
  }
  return items;
}

/**
 * Writes the folder `<targetDir ?? cwd>/<slug>-for-grok-bot/` (see `renderPastePack`) and the
 * `.openteleport.json` marker. Every file is replaced in one step. Over an earlier folder of the
 * same Bot only what this adapter generates is replaced (`skills/` whole, so that no skill of an
 * older version stays; the text files, removed when the Bot no longer has anything for them);
 * anything else the user left in it is kept. The result is a `handoff`: the user follows the
 * README. A Bot's routines move paused unless `enableRoutines` is set. `bundle` is not changed.
 */
export async function writeGrokBot(
  ctx: Ctx,
  bundle: Bundle,
  opts: WriteOpts,
): Promise<WriteResult> {
  const items: Items = { approximated: [], skipped: [], warnings: [] };
  const { manifest } = bundle;

  // Everything that can be rendered is rendered before the disk is touched.
  for (const skill of bundle.skills) {
    if (!isSafeSkill(skill)) {
      items.skipped.push({
        field: `skill:${skill.name}`,
        detail: "its name or a file path is not safe to write",
      });
    }
  }
  const routines = fitRoutines(bundle.routines, items.skipped).map((routine) => ({
    ...routine,
    enabled: routine.enabled && opts.enableRoutines,
  }));
  const pack = renderPastePack({ ...bundle, routines });

  const base = resolve(ctx.cwd, ctx.targetDir ?? ".");
  const wanted = join(base, `${slugify(manifest.name, { fallback: "agent" })}${FOLDER_SUFFIX}`);
  const placement = await claimFolder(wanted, bundle, opts.onConflict, items.warnings);
  const { dir } = placement;

  items.approximated.push(...approximations(bundle, pack));
  if (pack.some((file) => file.path.startsWith(`${SKILLS_DIR}/`))) {
    items.warnings.push(SKILLS_WARNING);
  }
  if (pack.some((file) => file.path === MEMORY_FILE)) items.warnings.push(MEMORY_WARNING);

  if (placement.owned) {
    await rm(join(dir, SKILLS_DIR), { recursive: true, force: true });
    const kept = new Set(pack.map((file) => file.path));
    for (const name of GENERATED_FILES) {
      if (!kept.has(name)) await rm(join(dir, name), { force: true });
    }
  }
  await mkdir(dir, { recursive: true });
  // The marker first: a write that stops half way can then be repeated over its own folder.
  await writeMarker(dir, { id: manifest.id, movedAt: new Date().toISOString() });
  for (const { path, bytes } of pack) {
    await replaceFile(join(dir, ...path.split("/")), bytes);
  }

  return {
    outcome: "handoff",
    nextStep: `Open ${join(dir, README_FILE)} and follow the five steps in Grok Bot`,
    artifactPath: dir,
    items,
  };
}
