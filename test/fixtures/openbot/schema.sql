-- The tables the OpenBot adapter reads, as OpenBot (nightly-labs/openbot) creates them.
--
-- Source: src/backend/openbot-database-schema.ts, read on 2026-10-28 (last commit that touched
-- the file: 03ac30a, 2026-10-27). The CREATE TABLE statements are copied from
-- BASELINE_V8_SCHEMA_SQL. OpenBot adds two columns to projection_agent_routines later (migration
-- 27, limit_policy, and migration 33, missed_policy); here they are part of the CREATE TABLE, in
-- the place the latest schema (LATEST_SCHEMA_SQL, withRoutinePolicies) puts them. Nothing else of
-- the 47 migrations touches these five tables. The rest of the database (threads, turns,
-- channels, skills and so on) is not needed and not reproduced.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS projection_agents (
    agent_id TEXT PRIMARY KEY,
    thread_id TEXT,
    model TEXT NOT NULL,
    updated_at TEXT,
    sort_order INTEGER NOT NULL,
    agent_json TEXT NOT NULL CHECK(json_valid(agent_json)),
    last_event_sequence INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS projection_agent_memories (
    memory_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    text TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('automatic', 'manual')),
    source_turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(agent_id, normalized_text)
  );

CREATE TABLE IF NOT EXISTS projection_agent_routines (
    routine_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    instruction TEXT NOT NULL,
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    timezone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    limit_policy TEXT NOT NULL DEFAULT 'wait' CHECK(limit_policy IN ('wait', 'skip')),
    missed_policy TEXT NOT NULL DEFAULT 'skip' CHECK(missed_policy IN ('skip', 'run-once'))
  );

CREATE TABLE IF NOT EXISTS projection_routine_triggers (
    trigger_id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES projection_agent_routines(routine_id) ON DELETE CASCADE,
    schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json)),
    next_run_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_event_sequence INTEGER NOT NULL,
    UNIQUE(routine_id)
  );

-- A database that is up to date: OpenBot records versions 8 to 47 (the latest known on the day
-- the schema was read).
WITH RECURSIVE versions(version) AS (
  SELECT 8 UNION ALL SELECT version + 1 FROM versions WHERE version < 47
)
INSERT INTO schema_migrations(version, applied_at)
  SELECT version, '2026-10-01T00:00:00.000Z' FROM versions;
