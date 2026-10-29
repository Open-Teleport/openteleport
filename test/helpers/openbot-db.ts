// Builds an OpenBot database for tests the way the fixture says OpenBot has it: the tables of
// `test/fixtures/openbot/schema.sql` filled by `seed.sql`. No real OpenBot database is involved.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSqlite } from "../../src/adapters/openbot/db.js";
import { DB_FILE } from "../../src/adapters/openbot/paths.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/openbot/${name}`, import.meta.url));

export const SCHEMA_SQL = fixture("schema.sql");
export const SEED_SQL = fixture("seed.sql");

/** `value` as a quoted SQL string. */
export const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** SQL that points the `workspacePath` of the agent `id` at `path`. */
export const setWorkspace = (id: string, path: string): string =>
  `UPDATE projection_agents SET agent_json = json_set(agent_json, '$.workspacePath', ${sqlString(path)}) ` +
  `WHERE agent_id = ${sqlString(id)}`;

/**
 * Creates `<userData>/openbot.db` from the schema fixture and, unless `seed` is false, the seed
 * fixture; then runs each of `after` (SQL) in order. The connection is closed on return, so
 * nothing but the main file is left behind.
 */
export async function buildOpenBotDatabase(
  userData: string,
  opts: { seed?: boolean; after?: readonly string[] } = {},
): Promise<string> {
  await mkdir(userData, { recursive: true });
  const path = join(userData, DB_FILE);
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(path);
  try {
    db.exec(await readFile(SCHEMA_SQL, "utf8"));
    if (opts.seed !== false) db.exec(await readFile(SEED_SQL, "utf8"));
    for (const sql of opts.after ?? []) db.exec(sql);
  } finally {
    db.close();
  }
  return path;
}
