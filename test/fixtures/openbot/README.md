# OpenBot zip fixtures

Folders, not zips: `test/helpers/zip.ts` packs a folder into an archive inside the test, so a
change shows up in a diff as files and not as bytes. Both layouts come from the design notes and
the source of OpenBot (nightly-labs/openbot), read on 2026-10-28. Neither was made by a real
OpenBot or Grok Bot.

## import-v1/

An `openbot-agent-import` v1 archive, the format the Grok Bot export skill writes and OpenBot's
Server settings, Import reads.

- Sources: Appendix A of `docs/superpowers/plans/2026-10-27-openteleport-v0.1.md` (OpenBot
  notes); G12 `resources/agent-import/grok-bot/SKILL.md` (the layout, the field rules and the
  limits); O2 `src/main/team-api/route-agent-import.ts` and O3
  `packages/contracts/src/team-protocol/agent-import-v1.ts` (the import calls). The manifest
  decoder is `src/main/agent-import-manifest.ts`.
- `ada` has everything: an avatar (a 1x1 PNG), two skills (one with a second file), eight routines
  (one for each schedule shape an import carries, one of them off), three memories and a
  `files` folder. `min` has only the required fields. One channel, which is not moved.
- The `advanced` schedule is the plain form of the design, `months`, `days` and `time`. The export
  skill lists no `advanced` shape, and OpenBot itself writes it nested (see `transfer-v1/`).

## transfer-v1/

An `openbot-instance-transfer` v1 archive, the file OpenBot writes to move a whole instance to
another computer.

- Sources: Appendix A of the v0.1 plan; `src/main/instance-transfer-manifest.ts` (the manifest
  and the agent fields) and `packages/contracts/src/ipc-routines.ts` (the schedule shapes,
  including `advanced` and `once`).
- One agent, `ada`, on the `claude` provider, with two routines that carry `limitPolicy` and
  `missedPolicy`, one `oneTimeRoutines` entry (`once`) and two memories, one with an `inclusion`.
  The `advanced` schedule is nested as OpenBot writes it. `settings` has all its lists empty,
  `shared` is `"shared"` and `shared/readme.txt` stands for the shared files.

## schema.sql and seed.sql

A small OpenBot database for the `openbot` adapter, built in a test with `node:sqlite`
(`test/helpers/openbot-db.ts`): `schema.sql`, then `seed.sql`. Nothing here was read from a real
installation.

- `schema.sql`: the `CREATE TABLE` statements of `schema_migrations`, `projection_agents`,
  `projection_agent_memories`, `projection_agent_routines` and `projection_routine_triggers`,
  copied on 2026-10-28 from `src/backend/openbot-database-schema.ts` of nightly-labs/openbot
  (`BASELINE_V8_SCHEMA_SQL`; the last commit that touched the file is `03ac30a`, 2026-10-27). The
  columns `limit_policy` (migration 27) and `missed_policy` (migration 33) that OpenBot adds with
  `ALTER TABLE` are written into the `CREATE TABLE` of `projection_agent_routines`, where the
  latest schema (`withRoutinePolicies`) puts them. The file ends with the rows of
  `schema_migrations` for versions 8 to 47, the latest known on that day. None of the migrations
  after 8 changes the other four tables.
- `seed.sql`: two agents. `ada` has the fields of `AgentSummary`
  (`packages/contracts/src/ipc-agents.ts`: `provider: "claude"`, `model`, `reasoningEffort`,
  `avatarSeed`, `avatarHue`, `avatarUrl: null`, `workspacePath`), three memories (the third has 600
  characters) and four routines whose `schedule_json` has the shapes `daily`, `weekly`, `interval`
  and `monthly` of `packages/contracts/src/ipc-routines.ts`; the `monthly` one is off and has
  `limit_policy` `skip` and `missed_policy` `run-once`. `min` has only the required fields.
- Not in the fixture: `agent_memory_selections` (`src/backend/agent-memory-selection.ts`), where
  OpenBot keeps whether a memory is `essential` or `searchable`. The adapter does not read it.
