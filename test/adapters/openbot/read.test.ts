import { mkdir, mkdtemp, readFile, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectOpenBot,
  listOpenBotAgents,
  openBotCacheIdentity,
  readOpenBotAgent,
} from "../../../src/adapters/openbot/read.js";
import { openBotUserData } from "../../../src/adapters/openbot/paths.js";
import type { Ctx } from "../../../src/adapters/types.js";
import { MAX_FILES_BYTES } from "../../../src/core/paths.js";
import { RoutineSchema, parseManifest } from "../../../src/core/schema.js";
import { buildOpenBotDatabase, setWorkspace, sqlString } from "../../helpers/openbot-db.js";
import { zipDirectoryToFile } from "../../helpers/zip.js";

const IMPORT_DIR = fileURLToPath(new URL("../../fixtures/openbot/import-v1", import.meta.url));
const TRANSFER_DIR = fileURLToPath(new URL("../../fixtures/openbot/transfer-v1", import.meta.url));

const noExec = (() => {
  throw new Error("no command expected");
}) as unknown as typeof execa;

let root: string;
let home: string;
let cwd: string;
let userData: string;
let ctx: Ctx;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-openbot-read-"));
  home = join(root, "home");
  cwd = join(root, "cwd");
  userData = join(root, "OpenBot");
  await mkdir(home);
  await mkdir(cwd);
  ctx = { home, cwd, env: {}, exec: noExec, logger: () => {}, sourceDir: userData };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** A database in `userData` (the `--source-dir`), changed by the SQL in `after`. */
const database = (after: readonly string[] = []): Promise<string> =>
  buildOpenBotDatabase(userData, { after });

const importZip = (): Promise<string> => zipDirectoryToFile(IMPORT_DIR, join(root, "import.zip"));
const transferZip = (): Promise<string> =>
  zipDirectoryToFile(TRANSFER_DIR, join(root, "transfer.zip"));

describe("detect", () => {
  it("finds nothing without a database, and says what to do", async () => {
    const found = await detectOpenBot(ctx);
    expect(found).toMatchObject({ found: false, location: userData });
    expect(found.hint).toContain("Install OpenBot, or pass --source-dir <export.zip>");
    expect(found.hint).toContain("Server settings");
  });

  it("finds the database in --source-dir", async () => {
    await database();
    expect(await detectOpenBot(ctx)).toEqual({ found: true, location: userData });
  });

  it("finds the database where the app keeps it, from the home and the environment", async () => {
    const { sourceDir: _sourceDir, ...plain } = ctx;
    await buildOpenBotDatabase(openBotUserData(plain));
    expect(await detectOpenBot(plain)).toMatchObject({ found: true });
  });

  it("finds an export archive named by --source-dir", async () => {
    const zip = await importZip();
    expect(await detectOpenBot({ ...ctx, sourceDir: zip })).toEqual({ found: true, location: zip });
  });

  it("does not count a folder with another database name", async () => {
    await mkdir(userData);
    await writeFile(join(userData, "other.db"), "x");
    expect((await detectOpenBot(ctx)).found).toBe(false);
  });
});

describe("list from the database", () => {
  it("lists the agents with their ids, names and titles", async () => {
    await database();
    expect(await listOpenBotAgents(ctx)).toEqual([
      {
        id: "ada",
        name: "Ada",
        title: "Research assistant",
        location: `${join(userData, "openbot.db")}#ada`,
      },
      { id: "min", name: "Min", location: `${join(userData, "openbot.db")}#min` },
    ]);
  });

  it("is empty for a database without agents", async () => {
    await buildOpenBotDatabase(userData, { seed: false });
    expect(await listOpenBotAgents(ctx)).toEqual([]);
  });

  it("refuses a schema it does not know, telling the user to export from the app", async () => {
    await database(["DROP TABLE projection_routine_triggers"]);
    await expect(listOpenBotAgents(ctx)).rejects.toThrow(
      /OpenBot database schema not recognised; export from the app and pass --source-dir <zip>/,
    );
  });

  it("says so when there is no database", async () => {
    await expect(listOpenBotAgents(ctx)).rejects.toThrow(/OpenBot has no database at /);
  });
});

describe("read from the database", () => {
  it("reads ada: instructions, facts, a long memory as a note, routines and model", async () => {
    await database();
    const { bundle, warnings } = await readOpenBotAgent(ctx, "ada");

    expect(bundle.manifest).toMatchObject({
      schemaVersion: "0.1",
      id: "",
      name: "Ada",
      title: "Research assistant",
      models: [{ runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" }],
      capabilities: [],
      origin: { app: "openbot" },
    });
    // The id is the engine's to give; with one, the manifest is a valid one.
    expect(parseManifest({ ...bundle.manifest, id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T" })).toBeDefined();
    expect(bundle.instructions).toBe("Read the papers first.\nThen summarise them in five lines.");
    expect(bundle.persona).toBeUndefined();
    expect(bundle.facts).toEqual(["Prefers short answers.", "Works in the Europe/Warsaw time zone."]);
    expect(bundle.notes.map(({ name }) => name)).toEqual(["memory-3"]);
    expect(bundle.notes[0]?.text.trim()).toHaveLength(600);
    expect(bundle.skills).toEqual([]);
    expect(bundle.files).toEqual([]);
    expect(bundle.avatar).toBeUndefined();
    expect(bundle.unknownPaths).toEqual([]);

    expect(bundle.routines).toEqual([
      {
        name: "Morning digest",
        instruction: "Summarise the news.",
        enabled: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "cron", expression: "30 8 * * *" },
      },
      {
        name: "Weekly review",
        instruction: "List what changed this week.",
        enabled: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "cron", expression: "0 9 * * 1" },
      },
      {
        name: "Poll the inbox",
        instruction: "Check the inbox for new papers.",
        enabled: true,
        timezone: "UTC",
        schedule: { kind: "every", every: "2h" },
      },
      {
        name: "Month end",
        instruction: "Write the month end report.",
        enabled: false,
        timezone: "America/New_York",
        schedule: { kind: "cron", expression: "0 17 28 * *" },
      },
    ]);
    for (const routine of bundle.routines) expect(RoutineSchema.safeParse(routine).success).toBe(true);

    expect(bundle.manifest["x-openbot"]).toEqual({
      reasoningEffort: "high",
      avatarSeed: "ada-seed",
      avatarHue: 210,
      notifications: true,
      workspacePath: "/home/user/OpenBot/Agents/ada",
      routines: {
        "Morning digest": { limitPolicy: "wait", missedPolicy: "skip" },
        "Weekly review": { limitPolicy: "wait", missedPolicy: "skip" },
        "Poll the inbox": {
          anchorAt: "2026-10-01T06:00:00.000Z",
          limitPolicy: "wait",
          missedPolicy: "skip",
        },
        "Month end": { limitPolicy: "skip", missedPolicy: "run-once" },
      },
    });

    expect(warnings).toEqual(
      expect.arrayContaining([
        "skills are not readable from the OpenBot database; export from the app (a transfer zip) carries them",
        "1 memory is over 500 characters and is kept as a note: memory-3",
      ]),
    );
    expect(warnings.some((warning) => /newer/.test(warning))).toBe(false);
  });

  it("reads min, which has nothing but a name, a model and an empty description", async () => {
    await database();
    const { bundle } = await readOpenBotAgent(ctx, "min");
    expect(bundle.manifest.name).toBe("Min");
    expect(bundle.manifest.title).toBeUndefined();
    expect(bundle.manifest.models).toEqual([
      { runtime: "codex", provider: "openai", model: "gpt-5.5" },
    ]);
    expect(bundle.instructions).toBe("");
    expect(bundle.facts).toEqual([]);
    expect(bundle.notes).toEqual([]);
    expect(bundle.routines).toEqual([]);
    expect(bundle.manifest["x-openbot"]).toEqual({
      reasoningEffort: "medium",
      avatarSeed: "min",
      notifications: false,
      workspacePath: "/home/user/OpenBot/Agents/min",
    });
  });

  it("finds an agent by its name when the id is not one", async () => {
    await database();
    expect((await readOpenBotAgent(ctx, "ADA")).bundle.manifest.name).toBe("Ada");
  });

  it("names the agents there are when it has none of that name", async () => {
    await database();
    await expect(readOpenBotAgent(ctx, "nobody")).rejects.toThrow(
      'OpenBot has no agent "nobody". Available: ada (Ada), min (Min)',
    );
  });

  it("warns when the database is newer than the schema the adapter knows", async () => {
    await database([
      "INSERT INTO schema_migrations(version, applied_at) VALUES (52, '2026-11-01T00:00:00.000Z')",
    ]);
    const { warnings } = await readOpenBotAgent(ctx, "ada");
    expect(warnings).toContain(
      "OpenBot database is newer (schema 52) than this adapter knows (47); check the result",
    );
  });

  it("refuses a schema it does not know", async () => {
    await database(["DROP TABLE projection_routine_triggers"]);
    await expect(readOpenBotAgent(ctx, "ada")).rejects.toThrow(/schema not recognised/);
  });

  it("does not touch the database it reads", async () => {
    const original = await database();
    const before = await readFile(original);
    await readOpenBotAgent(ctx, "ada");
    expect(Buffer.compare(before, await readFile(original))).toBe(0);
  });

  it("keeps a memory on one line", async () => {
    await database([
      "INSERT INTO projection_agent_memories(memory_id, agent_id, text, normalized_text, origin, created_at, updated_at, last_event_sequence) " +
        `VALUES ('mem-ada-9', 'ada', ${sqlString("Likes tea\n  and biscuits.\n")}, 'likes tea and biscuits.', 'manual', '2026-10-30T09:00:00.000Z', '2026-10-30T09:00:00.000Z', 90)`,
    ]);
    const { bundle } = await readOpenBotAgent(ctx, "ada");
    expect(bundle.facts).toContain("Likes tea and biscuits.");
    expect(bundle.notes.map(({ name }) => name)).toEqual(["memory-3"]);
  });

  it("leaves out a routine that cannot be carried and says why", async () => {
    await database([
      "DELETE FROM projection_routine_triggers WHERE routine_id = 'routine-weekly'",
      "UPDATE projection_routine_triggers SET schedule_json = '{\"kind\":\"custom\",\"expression\":\"every now and then\"}' WHERE routine_id = 'routine-interval'",
      "UPDATE projection_agent_routines SET timezone = 'Mars/Olympus' WHERE routine_id = 'routine-monthly'",
    ]);
    const { bundle, warnings } = await readOpenBotAgent(ctx, "ada");
    expect(bundle.routines.map(({ name }) => name)).toEqual(["Morning digest"]);
    expect(warnings).toEqual(
      expect.arrayContaining([
        'the routine "Weekly review" is left out because it has no schedule.',
        'the routine "Poll the inbox" is left out because its schedule cannot be carried over.',
        'the routine "Month end" is left out because "Mars/Olympus" is not a time zone.',
      ]),
    );
    expect(bundle.manifest["x-openbot"]).toMatchObject({
      routines: { "Morning digest": { limitPolicy: "wait", missedPolicy: "skip" } },
    });
  });

  it("carries a one-time routine the way a transfer does", async () => {
    await database([
      "UPDATE projection_routine_triggers SET schedule_json = '{\"kind\":\"once\",\"date\":\"2026-12-01\",\"time\":\"08:00\"}' WHERE routine_id = 'routine-daily'",
    ]);
    const { bundle } = await readOpenBotAgent(ctx, "ada");
    expect(bundle.routines[0]?.schedule).toEqual({ kind: "at", at: "2026-12-01T07:00:00.000Z" });
  });

  it("reads routines of a database from before the policies were added", async () => {
    await database([
      "ALTER TABLE projection_agent_routines DROP COLUMN limit_policy",
      "ALTER TABLE projection_agent_routines DROP COLUMN missed_policy",
    ]);
    const { bundle } = await readOpenBotAgent(ctx, "ada");
    expect(bundle.routines).toHaveLength(4);
    expect(bundle.manifest["x-openbot"]).toMatchObject({
      routines: { "Poll the inbox": { anchorAt: "2026-10-01T06:00:00.000Z" } },
    });
    expect((bundle.manifest["x-openbot"] as { routines: Record<string, object> }).routines)
      .not.toHaveProperty("Morning digest");
  });
});

describe("the workspace and the avatar of a database agent", () => {
  it("reads the files of the workspace, leaving out what a bundle never carries", async () => {
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "notes"), { recursive: true });
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(workspace, "notes", "todo.md"), "- finish the review\n");
    await writeFile(join(workspace, "README.md"), "# Ada\n");
    await writeFile(join(workspace, ".env"), "TOKEN=nothing\n");
    await writeFile(join(workspace, ".git", "config"), "[core]\n");
    await writeFile(join(workspace, "node_modules", "left-pad", "index.js"), "x\n");
    await writeFile(join(workspace, "backup.zip"), "not really a zip");
    await database([setWorkspace("ada", workspace)]);

    const { bundle, warnings } = await readOpenBotAgent(ctx, "ada");

    expect(bundle.files.map(({ path }) => path)).toEqual(["README.md", "notes/todo.md"]);
    expect(new TextDecoder().decode(bundle.files[1]?.bytes)).toBe("- finish the review\n");
    expect(warnings).toContainEqual(
      expect.stringMatching(
        /^4 entries of the workspace were left out because their paths are forbidden: /,
      ),
    );
    expect(warnings.find((warning) => warning.includes("were left out"))).toContain(".env");
    expect(warnings.find((warning) => warning.includes("were left out"))).toContain("node_modules");
  });

  it("says when the workspace is not there", async () => {
    await database([setWorkspace("ada", join(root, "gone"))]);
    const { bundle, warnings } = await readOpenBotAgent(ctx, "ada");
    expect(bundle.files).toEqual([]);
    expect(warnings).toContain(
      `the workspace ${join(root, "gone")} is not there, so no files were read`,
    );
  });

  it("does not read a workspace over the size limit", async () => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "big.bin"), "");
    await truncate(join(workspace, "big.bin"), MAX_FILES_BYTES + 1);
    await writeFile(join(workspace, "small.txt"), "small");
    await database([setWorkspace("ada", workspace)]);

    const { bundle, warnings } = await readOpenBotAgent(ctx, "ada");

    expect(bundle.files).toEqual([]);
    expect(warnings).toContainEqual(
      expect.stringContaining(`over the ${MAX_FILES_BYTES} byte limit, so no files were read`),
    );
  });

  it("reads the avatar when it names a small image file", async () => {
    const png = join(root, "ada.PNG");
    await writeFile(png, await readFile(join(IMPORT_DIR, "agents", "ada", "avatar.png")));
    await database([
      `UPDATE projection_agents SET agent_json = json_set(agent_json, '$.avatar', ${sqlString(png)}) WHERE agent_id = 'ada'`,
    ]);
    const { bundle, warnings } = await readOpenBotAgent(ctx, "ada");
    expect(bundle.avatar?.name).toBe("avatar.png");
    expect(bundle.avatar?.bytes).toEqual(
      new Uint8Array(await readFile(join(IMPORT_DIR, "agents", "ada", "avatar.png"))),
    );
    expect(warnings.some((warning) => warning.includes("avatar"))).toBe(false);
  });

  it("reads the avatar from avatarUrl when it is a file URL", async () => {
    const png = join(root, "ada.png");
    await writeFile(png, await readFile(join(IMPORT_DIR, "agents", "ada", "avatar.png")));
    await database([
      `UPDATE projection_agents SET agent_json = json_set(agent_json, '$.avatarUrl', ${sqlString(pathToFileURL(png).href)}) WHERE agent_id = 'ada'`,
    ]);
    const { bundle } = await readOpenBotAgent(ctx, "ada");
    expect(bundle.avatar?.name).toBe("avatar.png");
  });

  it("leaves an avatar out with a reason when it is not a usable file", async () => {
    const text = join(root, "ada.txt");
    await writeFile(text, "not an image");
    const huge = join(root, "huge.png");
    await writeFile(huge, "");
    await truncate(huge, 600 * 1024);
    await database([
      `UPDATE projection_agents SET agent_json = json_set(agent_json, '$.avatar', ${sqlString(text)}) WHERE agent_id = 'ada'`,
      `UPDATE projection_agents SET agent_json = json_set(agent_json, '$.avatar', ${sqlString(huge)}) WHERE agent_id = 'min'`,
    ]);
    const ada = await readOpenBotAgent(ctx, "ada");
    expect(ada.bundle.avatar).toBeUndefined();
    expect(ada.warnings).toContain(
      "the avatar is left out because it is not a PNG, JPEG or WebP image.",
    );
    const min = await readOpenBotAgent(ctx, "min");
    expect(min.bundle.avatar).toBeUndefined();
    expect(min.warnings).toContain("the avatar is left out because it is over 512 KB.");
  });

  it("ignores an avatar that is a web address", async () => {
    await database([
      "UPDATE projection_agents SET agent_json = json_set(agent_json, '$.avatarUrl', 'https://example.com/ada.png') WHERE agent_id = 'ada'",
    ]);
    const { bundle, warnings } = await readOpenBotAgent(ctx, "ada");
    expect(bundle.avatar).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("avatar"))).toBe(false);
  });
});

describe("list and read from an export archive", () => {
  it("lists the agents of an agent import by key", async () => {
    const zip = await importZip();
    const refs = await listOpenBotAgents({ ...ctx, sourceDir: zip });
    expect(refs).toEqual([
      { id: "ada", name: "Ada", title: "Release manager", location: `${zip}#ada` },
      { id: "min", name: "Min", title: "Minimal agent", location: `${zip}#min` },
    ]);
  });

  it("reads an agent of an agent import, with its skills, routines and workspace", async () => {
    const zip = await importZip();
    const { bundle, warnings } = await readOpenBotAgent({ ...ctx, sourceDir: zip }, "ada");
    expect(bundle.manifest).toMatchObject({ name: "Ada", id: "", origin: { app: "grok-bot" } });
    expect(bundle.routines).toHaveLength(8);
    expect(bundle.skills.map(({ name }) => name)).toEqual(["release-notes", "triage"]);
    expect(bundle.facts).toHaveLength(3);
    expect(bundle.avatar?.bytes.length).toBeGreaterThan(0);
    expect(bundle.files.map(({ path }) => path)).toEqual(["notes/todo.md"]);
    expect(warnings.some((warning) => /channel/.test(warning))).toBe(true);
  });

  it("reads an agent by its name too", async () => {
    const zip = await importZip();
    const { bundle } = await readOpenBotAgent({ ...ctx, sourceDir: zip }, "min");
    expect(bundle.instructions).toBe("Answers in one sentence.");
    expect((await readOpenBotAgent({ ...ctx, sourceDir: zip }, "MIN")).bundle.manifest.name).toBe(
      "Min",
    );
  });

  it("lists and reads an instance transfer", async () => {
    const zip = await transferZip();
    const zipCtx = { ...ctx, sourceDir: zip };
    expect(await listOpenBotAgents(zipCtx)).toEqual([
      { id: "ada", name: "Ada", title: "Release manager", location: `${zip}#ada` },
    ]);
    const { bundle, warnings } = await readOpenBotAgent(zipCtx, "ada");
    expect(bundle.manifest.models).toEqual([
      { runtime: "claude-code", provider: "anthropic", model: "claude-opus-5-5" },
    ]);
    expect(bundle.manifest["x-openbot"]).toMatchObject({ reasoningEffort: "high" });
    expect(bundle.routines).toHaveLength(3);
    expect(warnings.some((warning) => /settings/.test(warning))).toBe(true);
  });

  it("names the agents there are when the archive has none of that name", async () => {
    const zip = await importZip();
    await expect(readOpenBotAgent({ ...ctx, sourceDir: zip }, "nobody")).rejects.toThrow(
      'OpenBot has no agent "nobody". Available: ada (Ada), min (Min)',
    );
  });

  it("reports a file that is not an OpenBot archive", async () => {
    const bogus = join(root, "bogus.zip");
    await writeFile(bogus, "this is not a zip");
    await expect(listOpenBotAgents({ ...ctx, sourceDir: bogus })).rejects.toThrow();
  });
});

describe("cacheIdentity", () => {
  it("is the real path of the folder and the agent id for a database", async () => {
    await database();
    expect(await openBotCacheIdentity(ctx, "ada")).toBe(`${await realpath(userData)}#ada`);
    expect(await openBotCacheIdentity(ctx, "min")).toBe(`${await realpath(userData)}#min`);
  });

  it("is zip, the format and the key for an archive, whatever the file is called", async () => {
    const zip = await importZip();
    expect(await openBotCacheIdentity({ ...ctx, sourceDir: zip }, "ada")).toBe(
      "zip:openbot-agent-import:ada",
    );
    expect(await openBotCacheIdentity({ ...ctx, sourceDir: zip }, "Min")).toBe(
      "zip:openbot-agent-import:min",
    );
    const transfer = await transferZip();
    expect(await openBotCacheIdentity({ ...ctx, sourceDir: transfer }, "ada")).toBe(
      "zip:openbot-instance-transfer:ada",
    );
  });
});
