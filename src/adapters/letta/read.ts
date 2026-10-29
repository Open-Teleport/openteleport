import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MAX_FACT_CHARS } from "../../core/paths.js";
import type { Bundle, Manifest, ModelPref, Note, Routine } from "../../core/schema.js";
import { oneLine, truncate, withoutMark } from "../../core/text.js";
import { isRecord, nonBlank } from "../../core/values.js";
import { entriesOf, lstatIfAny } from "../fs.js";
import type { AgentRef, Ctx } from "../types.js";
import { readCrons, taskToRoutine, taskWarnings } from "./crons.js";
import { type MemFs, REFERENCE_PREFIX, readMemFs, readPersona } from "./memfs.js";
import { CRONS_FILE, cloudAgentsDir, lettaDir, localBackendDir } from "./paths.js";

const APP = "letta";
const MAX_NAME_CHARS = 80;
const MAX_TITLE_CHARS = 120;
/** The note that carries what `human.md` holds besides bullets. */
const HUMAN_NOTE = "human";
const BULLET = /^\s*[-*]\s+(.*)$/;

type Located = {
  id: string;
  backend: "local" | "cloud";
  /** Where the agent's `memory/` folder is, or would be. */
  memoryDir: string;
  /** The local backend's record of the agent. */
  record?: Record<string, unknown>;
  /** Why the record cannot be used, for a record file that is not a JSON object. */
  problem?: string;
};

/** Agents of the local backend: one `agents/<id>.json` record each. */
async function localAgents(backend: string): Promise<Located[]> {
  const agents: Located[] = [];
  for (const entry of await entriesOf(join(backend, "agents"))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const stem = entry.name.slice(0, -".json".length);
    const file = join(backend, "agents", entry.name);
    const located: Located = {
      id: stem,
      backend: "local",
      memoryDir: join(backend, "memfs", stem, "memory"),
    };
    try {
      const record: unknown = JSON.parse(withoutMark(await readFile(file, "utf8")));
      if (!isRecord(record)) throw new Error("not a JSON object");
      located.record = record;
      located.id = nonBlank(record.id) ?? stem;
    } catch (error) {
      located.problem = `${file}: ${(error as Error).message}`;
    }
    agents.push(located);
  }
  return agents;
}

/** Agents on Letta Cloud that keep a memory folder here: `agents/<agentId>/memory/`. */
async function cloudAgents(letta: string): Promise<Located[]> {
  const agents: Located[] = [];
  for (const entry of await entriesOf(cloudAgentsDir(letta))) {
    if (!entry.isDirectory()) continue;
    const memoryDir = join(cloudAgentsDir(letta), entry.name, "memory");
    if ((await lstatIfAny(memoryDir))?.isDirectory()) {
      agents.push({ id: entry.name, backend: "cloud", memoryDir });
    }
  }
  return agents;
}

/** Every agent, local ones first; a Cloud folder named like a local agent is the same agent. */
async function allAgents(ctx: Ctx): Promise<Located[]> {
  const letta = lettaDir(ctx);
  const local = await localAgents(localBackendDir(ctx, letta));
  const taken = new Set(local.map(({ id }) => id));
  const cloud = (await cloudAgents(letta)).filter(({ id }) => !taken.has(id));
  return [...local, ...cloud];
}

async function locate(ctx: Ctx, agent: string): Promise<Located> {
  const agents = await allAgents(ctx);
  const found = agents.find(({ id }) => id === agent);
  if (found !== undefined) return found;
  const where = lettaDir(ctx);
  throw new Error(
    agents.length === 0
      ? `Letta Code has no agent "${agent}": no agents in ${where}`
      : `Letta Code has no agent "${agent}". Available: ${agents.map(({ id }) => id).join(", ")}`,
  );
}

/** What the agent's `persona.md` says about its name and description, if anything. */
async function personaInfo(memoryDir: string): Promise<{ name?: string; description?: string }> {
  const file = join(memoryDir, "persona.md");
  if (!(await lstatIfAny(file))?.isFile()) return {};
  return readPersona(file, []);
}

/**
 * The agent's name and description. The name is the record's, else the agent's id: the `name` in
 * the frontmatter of persona.md is the label of the memory, not the agent's name. The
 * description is the record's, else the one in that frontmatter.
 */
function identityOf(
  located: Located,
  persona: { description?: string },
): { name: string; description?: string } {
  const description = nonBlank(located.record?.description) ?? persona.description;
  return {
    name: nonBlank(located.record?.name) ?? located.id,
    ...(description === undefined ? {} : { description }),
  };
}

/** The agents of the local backend, then those on Cloud that keep a memory folder here. */
export async function listLettaAgents(ctx: Ctx): Promise<AgentRef[]> {
  const refs: AgentRef[] = [];
  for (const located of await allAgents(ctx)) {
    // A record that cannot be read is still an agent; `read` says what is wrong with it.
    const { name, description } =
      located.problem === undefined
        ? identityOf(located, await personaInfo(located.memoryDir))
        : { name: located.id, description: undefined };
    const title = description === undefined ? undefined : oneLine(description);
    refs.push({
      id: located.id,
      name: oneLine(name),
      ...(title === undefined ? {} : { title: truncate(title, MAX_TITLE_CHARS) }),
      location: located.memoryDir,
    });
  }
  return refs;
}

/**
 * What tells this agent apart from every other: the real path of its `memory/` folder (a
 * folder that is not there is named by the path it would have).
 */
export async function lettaCacheIdentity(ctx: Ctx, agent: string): Promise<string> {
  const { memoryDir } = await locate(ctx, agent);
  try {
    return await realpath(memoryDir);
  } catch {
    return resolve(memoryDir);
  }
}

/**
 * Splits `human.md` into the facts it lists (`- ` and `* ` bullets of at most 500 characters)
 * and the rest. A bullet that is too long stays in the rest, so that nothing is cut.
 */
function splitHuman(human: string): { facts: string[]; rest: string; tooLong: number } {
  const facts: string[] = [];
  const rest: string[] = [];
  let tooLong = 0;
  for (const line of human.split("\n")) {
    const bullet = BULLET.exec(line);
    if (bullet === null) {
      rest.push(line);
      continue;
    }
    const fact = (bullet[1] ?? "").trim();
    if (fact.length > MAX_FACT_CHARS) {
      tooLong += 1;
      rest.push(line);
    } else if (fact !== "") {
      facts.push(fact);
    }
  }
  return { facts, rest: rest.join("\n").replace(/\n{3,}/g, "\n\n").trim(), tooLong };
}

function modelsOf(model: unknown): ModelPref[] {
  const handle = nonBlank(model);
  if (handle === undefined) return [];
  // A handle is `provider/model`; the whole handle is what a Letta agent is created with.
  const slash = handle.indexOf("/");
  return [slash > 0 ? { provider: handle.slice(0, slash), model: handle } : { model: handle }];
}

/**
 * Reads an agent as a Bundle. `agent` is an id from `listLettaAgents`. A local agent's system
 * prompt (else `memory/instructions.md`) is its instructions; the rest comes from its MemFS
 * folder and from the tasks in `crons.json` that belong to it. The id is left empty: nothing in
 * Letta's folders records one.
 */
export async function readLettaAgent(
  ctx: Ctx,
  agent: string,
): Promise<{ bundle: Bundle; warnings: string[] }> {
  const located = await locate(ctx, agent);
  if (located.problem !== undefined) throw new Error(located.problem);
  const warnings: string[] = [];


  const folder = await lstatIfAny(located.memoryDir);
  let memfs: MemFs = { rootNotes: [], referenceNotes: [], skills: [], warnings: [] };
  if (folder?.isDirectory()) {
    memfs = await readMemFs(located.memoryDir);
  } else {
    warnings.push(
      folder === undefined
        ? `no memory folder at ${located.memoryDir}; its memory, skills and notes are empty`
        : `${located.memoryDir} is not a real folder (a link is never followed); not read`,
    );
  }
  warnings.push(...memfs.warnings);

  // Instructions: the system prompt of a local agent. Letta Cloud keeps it on the server, so
  // there the only trace is the file this adapter writes.
  const system = typeof located.record?.system === "string" ? located.record.system : "";
  const fromFile = memfs.instructions?.trim() ?? "";
  const instructions = system.trim() !== "" ? system : fromFile;
  if (system.trim() !== "" && fromFile !== "") {
    warnings.push("memory/instructions.md was not read: the agent has a system prompt of its own");
  }
  if (located.backend === "cloud") {
    warnings.push(
      "Letta Cloud keeps an agent's name, description and system prompt on the server; only its " +
        "memory, skills and routines were read",
    );
  }

  const facts: string[] = [];
  const notes: Note[] = [];
  if (memfs.human !== undefined) {
    const human = splitHuman(memfs.human);
    facts.push(...human.facts);
    if (human.rest !== "") notes.push({ name: HUMAN_NOTE, text: `${human.rest}\n` });
    if (human.tooLong > 0) {
      warnings.push(
        `${human.tooLong} ${human.tooLong === 1 ? "fact" : "facts"} over ${MAX_FACT_CHARS} ` +
          `characters ${human.tooLong === 1 ? "was" : "were"} kept in the note ${HUMAN_NOTE}`,
      );
    }
  }
  notes.push(...memfs.rootNotes);
  notes.push(
    ...memfs.referenceNotes.map(({ name, text: body }) => ({
      name: `${REFERENCE_PREFIX}${name}`,
      text: body,
    })),
  );

  const routines: Routine[] = [];
  const routineExtras: Record<string, Record<string, unknown>> = {};
  const crons = await readCrons(join(lettaDir(ctx), CRONS_FILE));
  if ("error" in crons) {
    warnings.push(`${crons.error}; routines were not exported`);
  } else {
    for (const task of crons.tasks.filter(({ agent_id }) => agent_id === located.id)) {
      warnings.push(...taskWarnings(task));
      const converted = taskToRoutine(task);
      if (converted === null) continue;
      routines.push(converted.routine);
      if (Object.keys(converted.extra).length > 0) {
        routineExtras[converted.routine.name] = converted.extra;
      }
    }
  }

  const identity = identityOf(located, memfs.persona ?? {});
  const description =
    identity.description === undefined ? undefined : oneLine(identity.description);
  const title = description === undefined ? undefined : truncate(description, MAX_TITLE_CHARS);
  const tags = Array.isArray(located.record?.tags)
    ? located.record.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const modelSettings = located.record?.model_settings;
  const manifest: Manifest = {
    schemaVersion: "0.1",
    id: "",
    name: truncate(oneLine(identity.name), MAX_NAME_CHARS),
    ...(title === undefined ? {} : { title }),
    // A description the title had to cut is kept whole, so nothing of it is lost.
    ...(description !== undefined && description !== title ? { description } : {}),
    models: modelsOf(located.record?.model),
    capabilities: [],
    origin: { app: APP, exportedAt: new Date().toISOString() },
    "x-letta": {
      agentId: located.id,
      backend: located.backend,
      ...(tags.length === 0 ? {} : { tags }),
      ...(isRecord(modelSettings) ? { model_settings: modelSettings } : {}),
      routines: routineExtras,
    },
  };

  return {
    bundle: {
      manifest,
      ...(memfs.persona === undefined || memfs.persona.body.trim() === ""
        ? {}
        : { persona: memfs.persona.body.trim() }),
      instructions,
      skills: memfs.skills,
      routines,
      facts,
      notes,
      files: [],
      unknownPaths: [],
    },
    warnings,
  };
}
