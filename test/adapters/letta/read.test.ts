import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lettaDir, localBackendDir } from "../../../src/adapters/letta/paths.js";
import {
  lettaCacheIdentity,
  listLettaAgents,
  readLettaAgent,
} from "../../../src/adapters/letta/read.js";
import type { Ctx } from "../../../src/adapters/types.js";
import { parseManifest } from "../../../src/core/schema.js";

const FIXTURE = fileURLToPath(new URL("../../fixtures/letta/home/.letta", import.meta.url));
const LOCAL = "agent-local-1111";
const CLOUD = "agent-cloud-2222";

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-letta-read-"));
  home = join(root, "home");
  await mkdir(home);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctxFor(sourceDir?: string, env: NodeJS.ProcessEnv = {}): Ctx {
  return {
    ...(sourceDir === undefined ? {} : { sourceDir }),
    home,
    cwd: root,
    env,
    exec: noExec,
    logger: () => {},
  };
}

/** Every file below `dir` with its bytes, keyed by `/`-separated relative path. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[relative(dir, path).split("\\").join("/")] = (await readFile(path)).toString("base64");
  }
  return out;
}

/** A copy of the fixture's `.letta` in the temp directory, to change. */
async function copyOfFixture(): Promise<string> {
  const letta = join(root, "letta");
  await cp(FIXTURE, letta, { recursive: true });
  return letta;
}

describe("paths", () => {
  it("puts Letta's directory in the home directory unless a directory is given", () => {
    expect(lettaDir(ctxFor())).toBe(join(home, ".letta"));
    expect(lettaDir(ctxFor("/elsewhere"))).toBe("/elsewhere");
    expect(lettaDir({ ...ctxFor(), targetDir: "/target" })).toBe("/target");
    expect(lettaDir({ ...ctxFor("/source"), targetDir: "/target" })).toBe("/source");
  });

  it("takes the local backend from LETTA_LOCAL_BACKEND_DIR, else from inside Letta's directory", () => {
    const env = { LETTA_LOCAL_BACKEND_DIR: "/data/backend" };
    expect(localBackendDir(ctxFor(undefined, env), join(home, ".letta"))).toBe("/data/backend");
    expect(localBackendDir(ctxFor(), "/x/.letta")).toBe(join("/x/.letta", "lc-local-backend"));
    expect(localBackendDir(ctxFor(undefined, { LETTA_LOCAL_BACKEND_DIR: "" }), "/x/.letta")).toBe(
      join("/x/.letta", "lc-local-backend"),
    );
  });

  it("lets a given directory win over the variable", () => {
    const env = { LETTA_LOCAL_BACKEND_DIR: "/data/backend" };
    expect(localBackendDir(ctxFor("/x/.letta", env), "/x/.letta")).toBe(
      join("/x/.letta", "lc-local-backend"),
    );
  });
});

describe("list", () => {
  it("lists the local agent, then the Cloud one", async () => {
    const agents = await listLettaAgents(ctxFor(FIXTURE));
    expect(agents).toEqual([
      {
        id: LOCAL,
        name: "Reviewer",
        title: "Reviews pull requests",
        location: join(FIXTURE, "lc-local-backend", "memfs", LOCAL, "memory"),
      },
      { id: CLOUD, name: CLOUD, location: join(FIXTURE, "agents", CLOUD, "memory") },
    ]);
  });

  it("is empty for a directory without agents", async () => {
    expect(await listLettaAgents(ctxFor(join(root, "nothing")))).toEqual([]);
  });

  it("lists a Cloud agent by its id, with its persona's description as the title", async () => {
    const letta = await copyOfFixture();
    // The `name` here is the label of the memory, not the agent's name.
    await writeFile(
      join(letta, "agents", CLOUD, "memory", "persona.md"),
      "---\nname: persona\ndescription: Answers briefly\n---\nShort.\n",
    );
    expect((await listLettaAgents(ctxFor(letta)))[1]).toEqual({
      id: CLOUD,
      name: CLOUD,
      title: "Answers briefly",
      location: join(letta, "agents", CLOUD, "memory"),
    });
    const { bundle } = await readLettaAgent(ctxFor(letta), CLOUD);
    expect(bundle.manifest).toMatchObject({ name: CLOUD, title: "Answers briefly" });
  });

  it("lists an agent whose record cannot be read under its file name", async () => {
    const letta = await copyOfFixture();
    await writeFile(join(letta, "lc-local-backend", "agents", "agent-local-bad.json"), "{ nope");
    const agents = await listLettaAgents(ctxFor(letta));
    expect(agents.map((agent) => agent.id)).toEqual([LOCAL, "agent-local-bad", CLOUD]);
    expect(agents[1]?.name).toBe("agent-local-bad");
  });

  it("takes the local backend from LETTA_LOCAL_BACKEND_DIR", async () => {
    const letta = join(home, ".letta");
    await cp(FIXTURE, letta, { recursive: true });
    const moved = join(root, "moved-backend");
    await cp(join(letta, "lc-local-backend"), moved, { recursive: true });
    await rm(join(letta, "lc-local-backend"), { recursive: true });

    const ids = async (env: NodeJS.ProcessEnv): Promise<string[]> =>
      (await listLettaAgents(ctxFor(undefined, env))).map((agent) => agent.id);
    expect(await ids({})).toEqual([CLOUD]);
    expect(await ids({ LETTA_LOCAL_BACKEND_DIR: moved })).toEqual([LOCAL, CLOUD]);
  });

  it("lists an agent once when the Cloud folder has the same name as a local agent", async () => {
    const letta = await copyOfFixture();
    await mkdir(join(letta, "agents", LOCAL, "memory"), { recursive: true });
    expect((await listLettaAgents(ctxFor(letta))).map((agent) => agent.id)).toEqual([LOCAL, CLOUD]);
  });
});

describe("read a local agent", () => {
  it("reads the instructions, persona, facts, notes, skills, routines and model", async () => {
    const { bundle, warnings } = await readLettaAgent(ctxFor(FIXTURE), LOCAL);

    expect(bundle.instructions).toBe("You review PRs.");
    expect(bundle.persona).toBe(
      "Calm, direct and short. Reviews code like a colleague who has to maintain it.",
    );
    expect(bundle.facts).toEqual(["Prefers small pull requests", "Works in Europe/Warsaw, answers in the morning"]);
    expect(bundle.notes.map((note) => note.name)).toEqual(["human", "notes", "reference--style"]);
    expect(bundle.notes[0]?.text).toBe("Ada leads the platform team and reviews on Fridays.\n");
    expect(bundle.skills.map((skill) => skill.name)).toEqual(["triage"]);
    expect(bundle.routines.map((routine) => [routine.name, routine.enabled])).toEqual([
      ["Morning review", true],
      ["Weekly digest", false],
    ]);
    expect(bundle.routines[0]).toMatchObject({
      instruction: "List the open pull requests and say which ones need a review.\nStart with the oldest.",
      timezone: "Europe/Warsaw",
      schedule: { kind: "cron", expression: "0 9 * * 1-5" },
    });
    expect(bundle.files).toEqual([]);
    expect(bundle.avatar).toBeUndefined();
    expect(bundle.manifest.models).toEqual([
      { provider: "anthropic", model: "anthropic/claude-sonnet-4-5" },
    ]);
    expect(warnings).toEqual([
      "routine 'Release freeze reminder' was not exported: its status is fired, a one-off task that already ran",
    ]);
  });

  it("describes the agent in the manifest, with Letta's own data under x-letta", async () => {
    const { bundle } = await readLettaAgent(ctxFor(FIXTURE), LOCAL);
    const { manifest } = bundle;
    expect(manifest).toMatchObject({
      schemaVersion: "0.1",
      id: "",
      name: "Reviewer",
      title: "Reviews pull requests",
      capabilities: [],
      origin: { app: "letta" },
    });
    expect(manifest["x-letta"]).toEqual({
      agentId: LOCAL,
      backend: "local",
      tags: ["review"],
      model_settings: { temperature: 0.2 },
      routines: { "Morning review": { description: "Check the open pull requests", conversation_id: "conv-9" } },
    });
    // The manifest is valid once it has an id.
    expect(() => parseManifest({ ...manifest, id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T" })).not.toThrow();
  });

  it("does not modify the fixture", async () => {
    const before = await snapshot(FIXTURE);
    await readLettaAgent(ctxFor(FIXTURE), LOCAL);
    await readLettaAgent(ctxFor(FIXTURE), CLOUD);
    await listLettaAgents(ctxFor(FIXTURE));
    expect(await snapshot(FIXTURE)).toEqual(before);
  });

  it("gives an agent that is not there an error that lists the ones that are", async () => {
    await expect(readLettaAgent(ctxFor(FIXTURE), "agent-nope")).rejects.toThrow(
      `Letta Code has no agent "agent-nope". Available: ${LOCAL}, ${CLOUD}`,
    );
    await expect(readLettaAgent(ctxFor(join(root, "nothing")), "x")).rejects.toThrow(
      /no agents in /,
    );
  });

  it("never reads a path out of an id", async () => {
    await expect(readLettaAgent(ctxFor(FIXTURE), "../../lc-local-backend/agents/x")).rejects.toThrow(
      /has no agent/,
    );
  });

  it("names the record file when it cannot be read", async () => {
    const letta = await copyOfFixture();
    const file = join(letta, "lc-local-backend", "agents", "agent-local-bad.json");
    await writeFile(file, "[1]");
    await expect(readLettaAgent(ctxFor(letta), "agent-local-bad")).rejects.toThrow(
      `${file}: not a JSON object`,
    );
  });

  it("reads the rest of the agent when crons.json is not JSON, and says so", async () => {
    const letta = await copyOfFixture();
    await writeFile(join(letta, "crons.json"), "{ not json");
    const { bundle, warnings } = await readLettaAgent(ctxFor(letta), LOCAL);
    expect(bundle.routines).toEqual([]);
    expect(bundle.instructions).toBe("You review PRs.");
    expect(bundle.facts).toHaveLength(2);
    expect(warnings).toEqual([
      expect.stringContaining(`${join(letta, "crons.json")} is not valid JSON`),
    ]);
    expect(warnings[0]).toMatch(/; routines were not exported$/);
  });

  it("reads no routines when there is no crons.json, and no warning", async () => {
    const letta = await copyOfFixture();
    await rm(join(letta, "crons.json"));
    const { bundle, warnings } = await readLettaAgent(ctxFor(letta), LOCAL);
    expect(bundle.routines).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("falls back to memory/instructions.md when the record has no system prompt", async () => {
    const letta = await copyOfFixture();
    const record = join(letta, "lc-local-backend", "agents", `${LOCAL}.json`);
    const json = JSON.parse(await readFile(record, "utf8")) as Record<string, unknown>;
    json.system = "  ";
    await writeFile(record, JSON.stringify(json));
    await writeFile(
      join(letta, "lc-local-backend", "memfs", LOCAL, "memory", "instructions.md"),
      "Check the tests first.\n",
    );
    const { bundle, warnings } = await readLettaAgent(ctxFor(letta), LOCAL);
    expect(bundle.instructions).toBe("Check the tests first.");
    expect(bundle.notes.map((note) => note.name)).not.toContain("instructions");
    expect(warnings.filter((text) => text.includes("instructions.md"))).toEqual([]);
  });

  it("prefers the system prompt to memory/instructions.md, and says what it left unread", async () => {
    const letta = await copyOfFixture();
    await writeFile(
      join(letta, "lc-local-backend", "memfs", LOCAL, "memory", "instructions.md"),
      "Check the tests first.\n",
    );
    const { bundle, warnings } = await readLettaAgent(ctxFor(letta), LOCAL);
    expect(bundle.instructions).toBe("You review PRs.");
    expect(warnings).toContain(
      "memory/instructions.md was not read: the agent has a system prompt of its own",
    );
  });

  it("says when the agent has no memory folder", async () => {
    const letta = await copyOfFixture();
    await rm(join(letta, "lc-local-backend", "memfs"), { recursive: true });
    const { bundle, warnings } = await readLettaAgent(ctxFor(letta), LOCAL);
    expect(bundle.persona).toBeUndefined();
    expect(bundle.facts).toEqual([]);
    expect(bundle.manifest.name).toBe("Reviewer");
    expect(warnings[0]).toMatch(/^no memory folder at .*memory; its memory, skills and notes are empty$/);
  });

  it("keeps a bullet over 500 characters in the human note and says so", async () => {
    const letta = await copyOfFixture();
    const long = "x".repeat(501);
    await writeFile(
      join(letta, "lc-local-backend", "memfs", LOCAL, "memory", "human.md"),
      `- short\n- ${long}\n* star bullet\n- \n-5 is not a bullet\n`,
    );
    const { bundle, warnings } = await readLettaAgent(ctxFor(letta), LOCAL);
    expect(bundle.facts).toEqual(["short", "star bullet"]);
    expect(bundle.notes[0]).toEqual({ name: "human", text: `- ${long}\n-5 is not a bullet\n` });
    expect(warnings).toContain("1 fact over 500 characters was kept in the note human");
  });

  it("reads an agent whose record has little in it", async () => {
    const letta = await copyOfFixture();
    await writeFile(
      join(letta, "lc-local-backend", "agents", `${LOCAL}.json`),
      JSON.stringify({ id: LOCAL, model: "gpt-5.5" }),
    );
    const { bundle } = await readLettaAgent(ctxFor(letta), LOCAL);
    // The name falls back to the id (the persona's `name` is the memory's label), the title to
    // the persona's description.
    expect(bundle.manifest).toMatchObject({ name: LOCAL, title: "Reviews pull requests" });
    expect(bundle.instructions).toBe("");
    expect(bundle.manifest.models).toEqual([{ model: "gpt-5.5" }]);
    expect(bundle.manifest["x-letta"]).toMatchObject({ backend: "local" });
    expect(bundle.manifest["x-letta"]).not.toHaveProperty("tags");
  });

  it("warns about a task with no valid time zone and about one with no usable schedule", async () => {
    const letta = await copyOfFixture();
    const file = join(letta, "crons.json");
    const json = JSON.parse(await readFile(file, "utf8")) as { tasks: Record<string, unknown>[] };
    json.tasks[1] = { ...json.tasks[1], timezone: "Mars/Olympus" };
    json.tasks[2] = { ...json.tasks[2], status: "active", scheduled_for: null };
    await writeFile(file, JSON.stringify(json));

    const { bundle, warnings } = await readLettaAgent(ctxFor(letta), LOCAL);
    expect(bundle.routines.map((routine) => routine.name)).toEqual(["Morning review", "Weekly digest"]);
    expect(bundle.routines[1]?.timezone).toBe("UTC");
    expect(warnings).toEqual([
      "routine 'Weekly digest' names no valid time zone; UTC was assumed",
      "routine 'Release freeze reminder' was not exported: it has neither a cron expression nor a scheduled_for time",
    ]);
  });

  it("cuts a long name and title and keeps the whole description", async () => {
    const letta = await copyOfFixture();
    const description = "d".repeat(130);
    await writeFile(
      join(letta, "lc-local-backend", "agents", `${LOCAL}.json`),
      JSON.stringify({ id: LOCAL, name: "n".repeat(90), description }),
    );
    const { bundle } = await readLettaAgent(ctxFor(letta), LOCAL);
    expect(bundle.manifest.name).toHaveLength(80);
    expect(bundle.manifest.title).toHaveLength(120);
    expect(bundle.manifest.title?.endsWith("…")).toBe(true);
    expect(bundle.manifest.description).toBe(description);
  });
});

describe("read a Cloud agent", () => {
  it("has no system prompt, no model and no routines, and says where its name comes from", async () => {
    const { bundle, warnings } = await readLettaAgent(ctxFor(FIXTURE), CLOUD);
    expect(bundle.instructions).toBe("");
    expect(bundle.manifest.models).toEqual([]);
    expect(bundle.manifest.name).toBe(CLOUD);
    expect(bundle.persona).toBe("A helpful assistant that keeps answers short.");
    expect(bundle.facts).toEqual([]);
    expect(bundle.notes).toEqual([]);
    expect(bundle.routines).toEqual([]);
    expect(bundle.manifest["x-letta"]).toEqual({ agentId: CLOUD, backend: "cloud", routines: {} });
    expect(warnings).toEqual([
      "Letta Cloud keeps an agent's name, description and system prompt on the server; only its memory, skills and routines were read",
    ]);
  });

  it("reads memory/instructions.md as the instructions, and the tasks of the agent", async () => {
    const letta = await copyOfFixture();
    await writeFile(
      join(letta, "agents", CLOUD, "memory", "instructions.md"),
      "---\ndescription: Rules\n---\nAnswer in two lines.\n",
    );
    const file = join(letta, "crons.json");
    const json = JSON.parse(await readFile(file, "utf8")) as { tasks: Record<string, unknown>[] };
    json.tasks.push({
      id: "cron-9",
      agent_id: CLOUD,
      name: "Cloud task",
      cron: "*/10 * * * *",
      timezone: "UTC",
      recurring: true,
      prompt: "Ping.",
      status: "active",
    });
    await writeFile(file, JSON.stringify(json));

    const { bundle } = await readLettaAgent(ctxFor(letta), CLOUD);
    expect(bundle.instructions).toBe("Answer in two lines.");
    expect(bundle.routines.map((routine) => routine.name)).toEqual(["Cloud task"]);
  });
});

describe("cacheIdentity", () => {
  it("is the real path of the agent's memory folder, different for each agent", async () => {
    const local = await lettaCacheIdentity(ctxFor(FIXTURE), LOCAL);
    const cloud = await lettaCacheIdentity(ctxFor(FIXTURE), CLOUD);
    expect(local).toBe(await realpath(join(FIXTURE, "lc-local-backend", "memfs", LOCAL, "memory")));
    expect(cloud).toBe(await realpath(join(FIXTURE, "agents", CLOUD, "memory")));
    expect(local).not.toBe(cloud);
  });

  it("names the folder an agent without one would have", async () => {
    const letta = await copyOfFixture();
    await rm(join(letta, "lc-local-backend", "memfs"), { recursive: true });
    expect(await lettaCacheIdentity(ctxFor(letta), LOCAL)).toBe(
      join(letta, "lc-local-backend", "memfs", LOCAL, "memory"),
    );
  });
});
