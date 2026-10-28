import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSchema,
  loadSqlite,
  readDbAgents,
  schemaVersion,
  withDatabaseCopy,
} from "../../../src/adapters/openbot/db.js";
import { DB_FILE } from "../../../src/adapters/openbot/paths.js";
import { buildOpenBotDatabase } from "../../helpers/openbot-db.js";

let root: string;
let userData: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openteleport-openbot-db-"));
  userData = join(root, "OpenBot");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

describe("loadSqlite", () => {
  it("loads node:sqlite and leaves process.emitWarning the object it was", async () => {
    const before = process.emitWarning;
    const sqlite = await loadSqlite();
    expect(typeof sqlite.DatabaseSync).toBe("function");
    expect(process.emitWarning).toBe(before);
    // Asking again is no new import and changes nothing either.
    expect(await loadSqlite()).toBe(sqlite);
    expect(process.emitWarning).toBe(before);
  });

  // What it holds back, restores and does when the import fails: load.test.ts. That Node's
  // notice does not reach stderr of the built CLI: cli.test.ts.
});

describe("withDatabaseCopy", () => {
  it("reads the two agents of the seed with their fields, memories and routines", async () => {
    await buildOpenBotDatabase(userData);
    const agents = await withDatabaseCopy(userData, readDbAgents);

    expect(agents.map(({ id }) => id)).toEqual(["ada", "min"]);
    const [ada, min] = agents;
    expect(ada).toMatchObject({
      id: "ada",
      name: "Ada",
      title: "Research assistant",
      description: "Read the papers first.\nThen summarise them in five lines.",
      provider: "claude",
      model: "claude-opus-5-5",
      reasoningEffort: "high",
      avatarSeed: "ada-seed",
      avatarHue: 210,
      workspacePath: "/home/user/OpenBot/Agents/ada",
      notifications: true,
    });
    expect(ada?.avatar).toBeUndefined();
    expect(ada?.memories).toHaveLength(3);
    expect(ada?.memories[0]).toBe("Prefers short answers.");
    expect(ada?.memories[2]).toHaveLength(600);
    expect(ada?.routines).toEqual([
      {
        id: "routine-daily",
        name: "Morning digest",
        instruction: "Summarise the news.",
        active: true,
        timezone: "Europe/Warsaw",
        schedule: { kind: "daily", time: "08:30" },
        limitPolicy: "wait",
        missedPolicy: "skip",
      },
      expect.objectContaining({
        name: "Weekly review",
        schedule: { kind: "weekly", weekday: 1, time: "09:00" },
      }),
      expect.objectContaining({
        name: "Poll the inbox",
        timezone: "UTC",
        schedule: {
          kind: "interval",
          amount: 2,
          unit: "hours",
          anchorAt: "2026-10-01T06:00:00.000Z",
        },
      }),
      {
        id: "routine-monthly",
        name: "Month end",
        instruction: "Write the month end report.",
        active: false,
        timezone: "America/New_York",
        schedule: { kind: "monthly", day: 28, time: "17:00" },
        limitPolicy: "skip",
        missedPolicy: "run-once",
      },
    ]);

    // The empty title, the null hue and the missing avatar are left out, not set to empty.
    expect(min).toEqual({
      id: "min",
      name: "Min",
      description: "",
      provider: "codex",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      avatarSeed: "min",
      workspacePath: "/home/user/OpenBot/Agents/min",
      notifications: false,
      memories: [],
      routines: [],
    });
  });

  it("opens a copy, in a temporary folder that is gone afterwards", async () => {
    const original = await buildOpenBotDatabase(userData);
    let opened: string | undefined;
    await withDatabaseCopy(userData, (db) => {
      opened = db.location() ?? undefined;
    });
    expect(opened).toBeDefined();
    expect(opened).not.toBe(original);
    expect(existsSync(dirname(opened ?? original))).toBe(false);
  });

  it("removes the copy when the reading fails", async () => {
    await buildOpenBotDatabase(userData);
    let opened: string | undefined;
    await expect(
      withDatabaseCopy(userData, (db) => {
        opened = db.location() ?? undefined;
        throw new Error("reading failed");
      }),
    ).rejects.toThrow("reading failed");
    expect(existsSync(dirname(opened ?? userData))).toBe(false);
  });

  it("reads a database that another connection holds locked, because it opens a copy", async () => {
    const original = await buildOpenBotDatabase(userData);
    const { DatabaseSync } = await loadSqlite();
    const running = new DatabaseSync(original);
    try {
      running.exec("BEGIN EXCLUSIVE");
      // Sanity: the original really cannot be read as a database now.
      const direct = new DatabaseSync(original, { readOnly: true });
      try {
        expect(() => direct.prepare("SELECT COUNT(*) FROM projection_agents").get()).toThrow(
          /locked/,
        );
      } finally {
        direct.close();
      }

      const agents = await withDatabaseCopy(userData, readDbAgents);
      expect(agents.map(({ id }) => id)).toEqual(["ada", "min"]);
    } finally {
      running.exec("ROLLBACK");
      running.close();
    }
  });

  it("does not change the original or leave anything beside it", async () => {
    const original = await buildOpenBotDatabase(userData);
    const before = { hash: await sha256(original), mtime: (await stat(original)).mtimeMs };
    const names = (await readdir(userData)).sort();

    await withDatabaseCopy(userData, readDbAgents);

    expect(await sha256(original)).toBe(before.hash);
    expect((await stat(original)).mtimeMs).toBe(before.mtime);
    expect((await readdir(userData)).sort()).toEqual(names);
  });

  it("reads what the running app has only in its -wal file", async () => {
    const original = await buildOpenBotDatabase(userData);
    const { DatabaseSync } = await loadSqlite();
    const running = new DatabaseSync(original);
    try {
      running.exec("PRAGMA journal_mode = WAL");
      running.exec(
        "INSERT INTO projection_agent_memories(memory_id, agent_id, text, normalized_text, origin, created_at, updated_at, last_event_sequence) " +
          "VALUES ('mem-ada-4', 'ada', 'Only in the log.', 'only in the log.', 'manual', '2026-10-27T09:00:00.000Z', '2026-10-27T09:00:00.000Z', 99)",
      );
      // The newest row has not been written into the main file yet.
      expect(existsSync(`${original}-wal`)).toBe(true);
      expect(existsSync(`${original}-shm`)).toBe(true);
      const names = (await readdir(userData)).sort();

      const agents = await withDatabaseCopy(userData, readDbAgents);

      expect(agents[0]?.memories).toHaveLength(4);
      expect(agents[0]?.memories[3]).toBe("Only in the log.");
      expect((await readdir(userData)).sort()).toEqual(names);
    } finally {
      running.close();
    }
  });

  it("says there is no database when the folder has none", async () => {
    await expect(withDatabaseCopy(userData, readDbAgents)).rejects.toThrow(
      `OpenBot has no database at ${join(userData, DB_FILE)}`,
    );
  });
});

describe("schemaVersion", () => {
  it("is the newest migration the database records", async () => {
    await buildOpenBotDatabase(userData);
    expect(await withDatabaseCopy(userData, schemaVersion)).toBe(47);
  });

  it("follows the newest, however many there are", async () => {
    await buildOpenBotDatabase(userData, {
      after: [
        "INSERT INTO schema_migrations(version, applied_at) VALUES (52, '2026-11-01T00:00:00.000Z')",
      ],
    });
    expect(await withDatabaseCopy(userData, schemaVersion)).toBe(52);
  });

  it("is 0 when the database has no list of migrations", async () => {
    await buildOpenBotDatabase(userData, { after: ["DROP TABLE schema_migrations"] });
    expect(await withDatabaseCopy(userData, schemaVersion)).toBe(0);
  });
});

describe("assertSchema", () => {
  it("accepts the schema of the fixture", async () => {
    await buildOpenBotDatabase(userData);
    await expect(withDatabaseCopy(userData, assertSchema)).resolves.toBeUndefined();
  });

  it("refuses a database without projection_routine_triggers, saying what to do", async () => {
    await buildOpenBotDatabase(userData, { after: ["DROP TABLE projection_routine_triggers"] });
    const failure = withDatabaseCopy(userData, assertSchema);
    await expect(failure).rejects.toThrow(/OpenBot database schema not recognised/);
    await expect(failure).rejects.toThrow(/pass --source-dir <zip>/);
    await expect(failure).rejects.toThrow(/no table projection_routine_triggers/);
  });

  it("refuses a table that lacks a column the adapter reads", async () => {
    await buildOpenBotDatabase(userData, {
      seed: false,
      after: [
        "DROP TABLE projection_agents",
        "CREATE TABLE projection_agents (agent_id TEXT PRIMARY KEY, model TEXT)",
      ],
    });
    await expect(withDatabaseCopy(userData, assertSchema)).rejects.toThrow(
      /schema not recognised.*no column agent_json in projection_agents/,
    );
  });

  it("refuses a file that is not a database", async () => {
    await buildOpenBotDatabase(userData);
    await writeFile(
      join(userData, DB_FILE),
      "This is not an SQLite database, only text.\n".repeat(50),
    );
    await expect(withDatabaseCopy(userData, assertSchema)).rejects.toThrow(
      /schema not recognised/,
    );
  });
});

describe("readDbAgents on other databases", () => {
  it("reads routines of a database from before the policies were added", async () => {
    await buildOpenBotDatabase(userData, {
      after: [
        "ALTER TABLE projection_agent_routines DROP COLUMN limit_policy",
        "ALTER TABLE projection_agent_routines DROP COLUMN missed_policy",
      ],
    });
    const agents = await withDatabaseCopy(userData, (db) => {
      assertSchema(db);
      return readDbAgents(db);
    });
    const routines = agents[0]?.routines ?? [];
    expect(routines).toHaveLength(4);
    for (const routine of routines) {
      expect(routine).not.toHaveProperty("limitPolicy");
      expect(routine).not.toHaveProperty("missedPolicy");
    }
  });

  it("keeps a routine with no trigger, without a schedule", async () => {
    await buildOpenBotDatabase(userData, {
      after: ["DELETE FROM projection_routine_triggers WHERE routine_id = 'routine-weekly'"],
    });
    const agents = await withDatabaseCopy(userData, readDbAgents);
    const weekly = agents[0]?.routines.find(({ id }) => id === "routine-weekly");
    expect(weekly).toBeDefined();
    expect(weekly?.schedule).toBeUndefined();
  });

  it("names an agent whose JSON is not an object by its id", async () => {
    await buildOpenBotDatabase(userData, {
      after: ["UPDATE projection_agents SET agent_json = '[]' WHERE agent_id = 'min'"],
    });
    const agents = await withDatabaseCopy(userData, readDbAgents);
    expect(agents[1]).toMatchObject({ id: "min", name: "min", model: "gpt-5.5" });
  });
});
