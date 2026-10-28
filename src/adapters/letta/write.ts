// Writes a Bundle for Letta Code as a folder to hand over: the agent's memory in MemFS layout, the
// prompt of every routine, and a script that runs the three `letta` commands that load them. The
// agent itself is not created here (see the spec, section 8.4): `letta agents create` takes no
// system prompt, and writing the local backend's files would mean rebuilding an agent record
// from code that is not documented, so the last step stays with the user.
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isReservedDeviceName } from "../../core/paths.js";
import type { Item } from "../../core/report.js";
import { describeSchedule } from "../../core/schedule.js";
import type { Bundle, ModelPref, Routine } from "../../core/schema.js";
import { lstatIfAny } from "../fs.js";
import { MARKER_FILE, carriesMarker, readMarker, writeMarker } from "../marker.js";
import type { Ctx, WriteOpts, WriteResult } from "../types.js";
import { type Shell, cronAddCommand, shellQuote } from "./crons.js";
import { renderMemFs } from "./memfs.js";
import { isRecord, oneLine, text } from "./util.js";

const MAX_SLUG_CHARS = 64;
const FOLDER_SUFFIX = "-letta-memory";
const MEMORY_DIR = "memory";
const ROUTINES_DIR = "routines";
const SH_FILE = "letta-commands.sh";
const PS1_FILE = "letta-commands.ps1";
const README_FILE = "README.md";
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const RESTORE_WARNING =
  "`letta memory restore` replaces the agent's whole memory directory; the script runs it on " +
  "the new agent only";
const UNVERIFIED_WARNING =
  "Letta's `memory restore --from <dir>` is documented for backups made by `memory backup`; a " +
  "plain memory folder is assumed to work (unverified)";

type Items = WriteResult["items"];

/** Lowercase, every run of characters outside `a-z0-9` one `-`, no `-` at either end. */
function slugOf(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-$/, "");
  return slug === "" ? fallback : slug;
}

/**
 * The file stem of each routine's prompt in `routines/`, in the order of `routines`: the name as
 * a slug, `-2`, `-3`... for names that come to the same one; nothing usable gives `routine`, and
 * a Windows device name such as `con` gets `-r`, since it could not be a file there.
 */
export function routineSlugs(routines: readonly Routine[]): string[] {
  const taken = new Set<string>();
  return routines.map(({ name }) => {
    const slug = slugOf(name, "routine");
    const base = isReservedDeviceName(slug) ? `${slug}-r` : slug;
    let candidate = base;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}-${n}`;
    taken.add(candidate);
    return candidate;
  });
}

// -- The model --------------------------------------------------------------------------------

/**
 * The model handle to create the agent with: the first preference naming a provider and a model,
 * as `provider/model` (a model that already starts with `provider/`, as one read from Letta does,
 * is the handle as it is). What cannot be used is added to `approximated`.
 */
function modelHandle(models: readonly ModelPref[], approximated: Item[]): string | undefined {
  const named = (pref: ModelPref): boolean =>
    pref.provider !== undefined || pref.model !== undefined;
  const chosen = models.find(
    (pref) => text(pref.provider) !== undefined && text(pref.model) !== undefined,
  );
  if (chosen === undefined) {
    if (models.some(named)) {
      approximated.push({
        field: "models",
        detail: "no preference names both a provider and a model; Letta's default model applies",
      });
    }
    return undefined;
  }
  const provider = text(chosen.provider) as string;
  const model = text(chosen.model) as string;
  const handle = model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  const others = models.filter((pref) => pref !== chosen && named(pref)).length;
  approximated.push({
    field: "models",
    detail:
      `passed as --model ${handle}; Letta may not know this handle` +
      (others === 0 ? "" : `, and ${others} other preference${others === 1 ? "" : "s"} not used`),
  });
  return handle;
}

// -- The script -------------------------------------------------------------------------------

/** A path as the scripts spell it: with `/`, which both shells and Windows programs accept. */
const scriptPath = (path: string): string => (sep === "\\" ? path.replaceAll("\\", "/") : path);

/**
 * Windows PowerShell 5.1 hands an argument to a program without escaping the double quotes in
 * it, so the program never sees them (a routine's prompt with a quoted phrase would arrive
 * without the quotes). This `letta` function escapes them for the program's command line parser,
 * and only there: PowerShell 6 and later pass arguments on correctly themselves. It runs what
 * PowerShell would have run for `letta` (npm leaves both a `.ps1` and a `.cmd`).
 */
const POWERSHELL_LETTA = [
  "# Windows PowerShell 5.1 passes the double quotes inside an argument to a program without",
  "# escaping them, so the program loses them. This puts the escapes in; PowerShell 6 and later",
  "# do not need it.",
  "function letta {",
  "  $command = Get-Command letta -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1",
  '  if (-not $command) { throw "letta was not found; install Letta Code first (npm i -g @letta-ai/letta-code)" }',
  "  $arguments = foreach ($argument in $args) {",
  "    if ($PSVersionTable.PSVersion.Major -lt 6) { $argument -replace '(\\\\*)\"', '$1$1\\\"' } else { $argument }",
  "  }",
  "  & $command.Source @arguments",
  "}",
];

/** The `description` of the task that an earlier move from Letta kept in the manifest. */
function descriptionOf(bundle: Bundle, routine: Routine): string | undefined {
  const vendor = bundle.manifest["x-letta"];
  const routines = isRecord(vendor) ? vendor.routines : undefined;
  const extra = isRecord(routines) ? routines[routine.name] : undefined;
  return isRecord(extra) ? text(extra.description) : undefined;
}

/** `lines` as comments. A line break inside a line ends the comment too, so each part gets `# `. */
const commented = (lines: readonly string[]): string[] =>
  lines.flatMap((line) => line.split(/\r\n|[\n\r\x85\p{Zl}\p{Zp}]/u).map((part) => `# ${part}`));

/**
 * The script that loads the folder `dir` into Letta Code, for `sh` (bash) or PowerShell: it
 * creates the agent, asks for the id that `letta agents create` printed, restores `memory/` into
 * the new agent and adds the routines. A routine is a live `letta cron add` command only when
 * `enableRoutines` is true and the routine is enabled; any other is left as a comment to
 * uncomment (the CLI has no flag to add one paused). Every value is quoted for the shell, and a
 * line break in a name cannot get out of its quotes or its comment.
 */
export function renderCommands(
  bundle: Bundle,
  dir: string,
  shell: Shell,
  enableRoutines = true,
): string {
  const { manifest } = bundle;
  const quote = (value: string): string => shellQuote(shell, value);
  const root = scriptPath(dir);
  const check = (what: string): string[] =>
    shell === "ps1" ? [`if ($LASTEXITCODE -ne 0) { throw "${what} failed" }`] : [];

  const about = oneLine(manifest.title ?? manifest.description ?? "");
  const handle = modelHandle(manifest.models, []);
  const create = [
    "letta agents create",
    `--name ${quote(oneLine(manifest.name))}`,
    ...(about === "" ? [] : [`--description ${quote(about)}`]),
    ...(handle === undefined ? [] : [`--model ${quote(handle)}`]),
  ].join(" ");

  const sections: string[][] = [
    shell === "sh"
      ? [
          "#!/usr/bin/env bash",
          "# Written by OpenTeleport. Run it as it is, there is nothing to edit: it creates the",
          "# agent in Letta Code, loads the memory folder next to this script into it and adds the",
          "# routines.",
          "set -eu",
        ]
      : [
          "# Written by OpenTeleport. Run it as it is, there is nothing to edit: it creates the",
          "# agent in Letta Code, loads the memory folder next to this script into it and adds the",
          "# routines.",
          '$ErrorActionPreference = "Stop"',
        ],
    ...(shell === "ps1" ? [POWERSHELL_LETTA] : []),
    [create, ...check("letta agents create")],
    shell === "sh"
      ? [
          'read -r -p "Agent id printed above: " AGENT_ID',
          'if [ -z "$AGENT_ID" ]; then',
          '  echo "No agent id given; nothing was loaded into the agent." >&2',
          "  exit 1",
          "fi",
        ]
      : [
          '$AGENT_ID = Read-Host "Agent id printed above"',
          'if ([string]::IsNullOrWhiteSpace($AGENT_ID)) {',
          '  throw "No agent id given; nothing was loaded into the agent."',
          "}",
        ],
    [
      `letta memory restore --agent "$AGENT_ID" --from ${quote(`${root}/${MEMORY_DIR}`)} --force`,
      ...check("letta memory restore"),
    ],
  ];

  const slugs = routineSlugs(bundle.routines);
  for (const [index, routine] of bundle.routines.entries()) {
    const file = `${root}/${ROUTINES_DIR}/${slugs[index]}.txt`;
    const block = [
      cronAddCommand(routine, file, shell, descriptionOf(bundle, routine)),
      ...check("letta cron add"),
    ];
    const when = describeSchedule(routine.schedule, routine.timezone);
    const title = `# ${oneLine(`${routine.name}: ${when}`)}`;
    if (enableRoutines && routine.enabled) {
      sections.push([title, ...block]);
    } else {
      const why = routine.enabled
        ? "# left out because routines move disabled; uncomment to add it"
        : "# paused in the source; uncomment to add it";
      sections.push([title, why, ...commented(block)]);
    }
  }
  return `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}

function renderReadme(bundle: Bundle): string {
  const name = oneLine(bundle.manifest.name);
  return `# ${name} for Letta Code

OpenTeleport wrote this folder. It is not an agent yet: Letta Code has no documented way to
create an agent with a system prompt from files, so the last step is yours.

1. Run \`${SH_FILE}\` (macOS, Linux, Git Bash) or \`${PS1_FILE}\` (Windows PowerShell).
2. The script creates the agent with \`letta agents create\` and prints its id. Type the id at
   the prompt.
3. The script loads \`${MEMORY_DIR}/\` into the new agent with \`letta memory restore\` and adds the
   routines.

What is in this folder:

- \`${MEMORY_DIR}/\`: the agent's memory in Letta Code's MemFS layout (\`persona.md\`, \`human.md\`,
  \`instructions.md\`, \`reference/\`, \`skills/\`).
- \`${ROUTINES_DIR}/\`: the prompt of each routine, one text file each, read by the script.
- \`${SH_FILE}\` and \`${PS1_FILE}\`: the same commands for each shell.
- \`${MARKER_FILE}\`: lets a later move of the same agent update this folder in place.

Good to know:

- \`letta memory restore\` replaces the agent's whole memory directory. The script runs it on the
  new agent only.
- Letta documents \`memory restore --from <dir>\` for backups made by \`memory backup\`. A plain
  memory folder like this one is assumed to work; that has not been verified.
- Routines are commented out in the script when they were paused in the source, or when they
  moved disabled. Uncomment the ones you want.
- The scripts name this folder by its full path. If you move it, move the agent again instead.
`;
}

// -- Where the folder goes --------------------------------------------------------------------

type Placement = {
  dir: string;
  /** The folder is one OpenTeleport wrote before: what it generated can be written again. */
  owned: boolean;
};

/** Free: nothing there, or an empty folder. A link is never free, wherever it leads. */
async function isFree(path: string): Promise<boolean> {
  const info = await lstatIfAny(path);
  return info === undefined || (info.isDirectory() && (await readdir(path)).length === 0);
}

/** The first free `<wanted>-2`, `<wanted>-3`... */
async function freeSibling(wanted: string): Promise<string> {
  for (let n = 2; ; n += 1) {
    if (await isFree(`${wanted}-${n}`)) return `${wanted}-${n}`;
  }
}

/**
 * The `<wanted>-N` folder (lowest N first) that carries the marker of the agent with `id`, as an
 * earlier move may have left it; `undefined` when there is none.
 */
async function ownSibling(wanted: string, id: string): Promise<string | undefined> {
  if (id === "") return undefined;
  let names: string[];
  try {
    names = await readdir(dirname(wanted));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const prefix = `${basename(wanted)}-`;
  const copies = names
    .filter((name) => name.startsWith(prefix) && /^[1-9]\d*$/.test(name.slice(prefix.length)))
    .map((name) => ({ path: join(dirname(wanted), name), n: Number(name.slice(prefix.length)) }))
    .filter(({ n }) => n >= 2)
    .sort((a, b) => a.n - b.n);
  for (const { path } of copies) {
    if ((await lstatIfAny(path))?.isDirectory() && (await carriesMarker(path, id))) return path;
  }
  return undefined;
}

/**
 * Settles where the folder goes. A free `wanted` is taken. When it is taken, `copy` goes to the
 * first free `<wanted>-2`, `<wanted>-3`...; `replace` writes over `wanted` only when it holds a
 * marker (whose agent it was does not matter) and refuses otherwise; `update` writes over it only
 * when its marker is this agent's, or else over the `<wanted>-N` folder that carries it. Any
 * other folder keeps its content and this one goes to the first free `-N`, with a warning. A link
 * is never written through.
 */
async function claimTarget(
  wanted: string,
  bundle: Bundle,
  onConflict: WriteOpts["onConflict"],
  warnings: string[],
): Promise<Placement> {
  if (await isFree(wanted)) return { dir: wanted, owned: false };
  if (onConflict === "copy") return { dir: await freeSibling(wanted), owned: false };

  const info = await lstatIfAny(wanted);
  const marker = info?.isDirectory() === true ? await readMarker(wanted) : undefined;
  if (onConflict === "replace") {
    if (marker !== undefined) return { dir: wanted, owned: true };
    const why = info?.isSymbolicLink()
      ? "it is a symbolic link"
      : info?.isDirectory() === true
        ? `it holds no ${MARKER_FILE}, so it is not a folder OpenTeleport wrote`
        : "it is not a folder";
    throw new Error(`Refusing to replace ${wanted}: ${why}. Delete it yourself if you mean it.`);
  }

  const { id } = bundle.manifest;
  if (marker !== undefined && id !== "" && marker.id === id) return { dir: wanted, owned: true };
  const own = await ownSibling(wanted, id);
  if (own !== undefined) return { dir: own, owned: true };
  const dir = await freeSibling(wanted);
  const why = info?.isSymbolicLink()
    ? "is a symbolic link, which is not written through"
    : marker === undefined
      ? `holds no ${MARKER_FILE} of this agent`
      : "holds a different agent";
  warnings.push(`${wanted} ${why}; written as ${dir}`);
  return { dir, owned: false };
}

// -- Writing ----------------------------------------------------------------------------------

/**
 * Creates `path` with `data`, making its folder first. Whatever is at `path` is removed first
 * (a link is removed, not followed), and the file is created with `wx`, which fails rather than
 * write through anything that appeared since.
 */
async function createFile(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  await writeFile(path, data, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
}

/** The reasons a schedule is not carried over exactly, one `approximated` item per routine. */
function routineApproximations(routines: readonly Routine[]): Item[] {
  const items: Item[] = [];
  for (const { name, schedule, timezone } of routines) {
    const field = `routine:${name}`;
    if (schedule.kind === "every") {
      const exact = everyIsExact(schedule.every);
      items.push({
        field,
        detail:
          `every ${schedule.every} is written as a cron expression` +
          (exact ? "" : "; it fires at fixed times of the clock, not strictly that far apart"),
      });
    } else if (schedule.kind === "cron" && timezone !== "UTC") {
      items.push({
        field,
        detail:
          "letta cron add takes no time zone, so the expression is read in Letta's own zone, " +
          `not ${timezone}`,
      });
    }
  }
  return items;
}

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** Whether a cron expression fires exactly as often as the interval: it divides its unit evenly. */
function everyIsExact(every: string): boolean {
  const count = Number.parseInt(every, 10);
  switch (every.slice(-1)) {
    case "m":
      return MINUTES_PER_HOUR % count === 0;
    case "h":
      return HOURS_PER_DAY % count === 0;
    default:
      return count === 1;
  }
}

/**
 * Writes the folder `<targetDir ?? cwd>/<slug>-letta-memory/`: `memory/` (see `renderMemFs`),
 * `routines/<slug>.txt` with each routine's prompt as it is, `letta-commands.sh` and
 * `letta-commands.ps1`, `README.md` and the `.openteleport.json` marker (outside `memory/`, so
 * it does not become part of the agent's memory). The result is a `handoff`: the user runs the
 * script. Over an earlier folder of the same agent only the parts this adapter generates are
 * replaced (`memory/` and `routines/` whole, so nothing of an older version stays in the agent's
 * memory); anything else the user left in it is kept. `bundle` is not changed.
 */
export async function writeLettaAgent(
  ctx: Ctx,
  bundle: Bundle,
  opts: WriteOpts,
): Promise<WriteResult> {
  const items: Items = { approximated: [], skipped: [], warnings: [] };
  const { manifest } = bundle;

  // Everything that can be rendered is rendered before the disk is touched.
  const memory = renderMemFs(bundle, items.skipped);
  const slugs = routineSlugs(bundle.routines);
  const base = resolve(ctx.cwd, ctx.targetDir ?? ".");
  const wanted = join(base, `${slugOf(manifest.name, "agent")}${FOLDER_SUFFIX}`);
  const placement = await claimTarget(wanted, bundle, opts.onConflict, items.warnings);
  const { dir } = placement;

  const sh = renderCommands(bundle, dir, "sh", opts.enableRoutines);
  const ps1 = renderCommands(bundle, dir, "ps1", opts.enableRoutines);
  modelHandle(manifest.models, items.approximated);
  if (bundle.instructions.trim() !== "") {
    items.approximated.push({
      field: "instructions",
      detail:
        "written to memory/instructions.md, which Letta loads on every turn like core memory; " +
        "it is not the agent's system prompt",
    });
  }
  items.approximated.push(...routineApproximations(bundle.routines));
  if (text(manifest.title) !== undefined && text(manifest.description) !== undefined) {
    items.skipped.push({
      field: "description",
      detail: "Letta has no field for it beside the title, which is used",
    });
  }
  items.warnings.push(RESTORE_WARNING, UNVERIFIED_WARNING);

  if (placement.owned) {
    for (const part of [MEMORY_DIR, ROUTINES_DIR]) {
      await rm(join(dir, part), { recursive: true, force: true });
    }
  }
  await mkdir(dir, { recursive: true });
  // The marker first: a write that stops half way can then be repeated over its own folder.
  await writeMarker(dir, { id: manifest.id, movedAt: new Date().toISOString() });
  for (const { path, bytes } of memory) {
    await createFile(join(dir, MEMORY_DIR, ...path.split("/")), bytes);
  }
  for (const [index, routine] of bundle.routines.entries()) {
    await createFile(join(dir, ROUTINES_DIR, `${slugs[index]}.txt`), routine.instruction);
  }
  await createFile(join(dir, SH_FILE), sh, 0o755);
  // Windows PowerShell 5.1 reads a script without a byte order mark in the system code page.
  await createFile(join(dir, PS1_FILE), `${BYTE_ORDER_MARK}${ps1}`);
  await createFile(join(dir, README_FILE), renderReadme(bundle));

  return {
    outcome: "handoff",
    nextStep:
      `Run ${join(dir, SH_FILE)} (or .ps1): it creates the agent, restores its memory and adds ` +
      "the routines",
    artifactPath: dir,
    items,
  };
}
