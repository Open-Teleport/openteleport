# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-10-30

### Fixed

- OpenClaw: the adapter reads the agent roster in both forms OpenClaw has used, `agents.list` (an array, up to 2026.5.28) and `agents.entries` (keyed by id, from 2026.6), and sets an agent's model and runtime at the path the install keeps it under (`agents.list[<index>]` or `agents.entries.<id>`). On 2026.5.28 a move used to create the agent and then fail with `Config validation failed: agents: Invalid input`, and reading an agent back failed with `no workspace at ...`. Checked on 2026.5.28 and 2026.10.8.
- OpenClaw: `agents list --json` rows that call the workspace `location` (2026.5.28) are read; the default agent's workspace is `agents.defaults.workspace` itself, as OpenClaw resolves it; a job without an agent belongs to the default agent, not always `main`.
- The end-to-end test no longer passes the test runner's own variables (`VITEST`, `TEST`, `NODE_ENV`) on to the CLI and to OpenClaw, which runs in a test mode of its own under `VITEST` and prints nothing for `agents list --json`.

### Changed

- OpenClaw: a command may take 5 minutes instead of 90 seconds (`--version` 30 seconds instead of 10), and the probe for the job command family gets the full time too. On a loaded Windows machine `agents add` through the Gateway exceeded 90 seconds, and a probe cut short would have left `automations` for an OpenClaw that has `cron`.
- README and the landing page say which adapters are checked on real installs (`openclaw`, `hermes`; `codex` for discovery) and which are experimental (`openbot`, `grok-bot`, `letta`).

## [0.4.0] - 2026-10-29

Combines the v0.3 session integration and v0.4 native plugin milestones. There was no separate npm 0.3.0 release.

### Added

- Local stdio MCP server (`openteleport mcp`) in the main npm package: preview transfers, review destination locations and capability losses, then apply a confirmed plan. Durable operation receipts support checking outcomes after reconnecting.
- Claude Code plugin and marketplace entry, plus OpenClaw and Hermes native command plugins in the tagged repository. Native plugins are source installations, not separate npm or pip releases.
- Structured memory selection through `--no-memory`, MCP, the terminal wizard and native commands, with omissions recorded in transfer reports.
- Exclusive export mode (`--no-overwrite`); wizard and session exports refuse existing archives.

### Fixed

- Codex copies receive distinct runtime names. Exporting an imported custom agent retains its associated skills.
- Wizard cancellation leaves the destination untouched; memory exclusion explains the effects of updating an existing agent and offers a separate copy.

### Limits

- Memory selection is not anonymization. Transfer previews are not exact file diffs, writes are not transactional, and there is no automatic rollback.
- OpenBot, Grok Bot and Letta still require the manual completion step reported by their adapters. Real-application validation remains incomplete; see `docs/STATUS.md`.

## [0.2.0] - 2026-10-29

The first published release. It carries everything listed under 0.1.0 below, which was never published on its own.

Five more apps, a wizard for the first run, and a few small fixes.

### Added

- Five adapters, all read and write, each built from the documentation and source code of the app.
  Hermes and Codex were then checked on real installs: Hermes passed, and Codex has two open
  defects (copies of one agent share a runtime `name`, and exporting a custom agent drops its
  skills); the other three have not been checked yet:
  - `hermes` (Hermes Agent): profiles, `SOUL.md`, skills, memory entries and cron jobs. A write
    makes or updates a named profile and writes its cron jobs paused. Result: done.
  - `codex` (Codex): the global setup and the custom agents in `agents/*.toml`. A write makes a
    custom agent file and puts its skills in `~/.agents/skills`; `config.toml` and `AGENTS.md`
    are never touched. Result: done.
  - `openbot` (OpenBot): reads a copy of `openbot.db` or an export zip, writes an
    `openbot-agent-import` zip. Result: handoff (import the zip in Server settings).
  - `grok-bot` (Grok Bot): reads the zip that the OpenBot export skill makes, writes a folder of
    text to paste into a new Bot. Result: handoff (the five steps in the pack's README).
  - `letta` (Letta Code): reads the local backend and the local memory of Cloud agents, writes a
    folder with the memory in MemFS layout and a script (`letta-commands.sh` or `.ps1`) that
    creates the agent, restores its memory and adds its routines, which stay commented out in the
    script unless `--enable-routines` is given (for the enabled ones). Result: handoff.
- A wizard: `npx openteleport` with no arguments, in a terminal, asks for the source app, the
  agent and the target, says in one sentence what it will do, and asks before it does it. Without
  a terminal, it prints the help and exits with 2.
- `--help-all`, which lists every command and flag and the two `OPENTELEPORT_` variables. `--help` now shows the
  commands and flags most people need.
- `export` without `--from` exports the agent folder you are in; `import` without `--to`
  unpacks into a new folder named after the agent.
- For adapter authors: `Adapter.createsOnWrite` (the target is made by `write`, so the app need
  not be installed there) and `Adapter.handoff` (`write` only prepares a file or folder and
  ends in a handoff, which the wizard announces before it asks).
- The OpenBot zip format as a module of its own (`src/formats/openbot-zip.ts`): it reads
  `openbot-agent-import` and `openbot-instance-transfer` and writes `openbot-agent-import`.
  `openbot` and `grok-bot` both use it.
- Shared helper modules the new adapters use: the identity marker and the ids map
  (`src/adapters/marker.ts`), atomic file writes (`src/adapters/fs.ts`), skill folders
  (`src/adapters/skill-files.ts`), conflict names (`src/adapters/names.ts`), a safe zip reader
  (`src/core/zip.ts`), text and schedule helpers (`src/core/text.ts`, `src/core/schedule.ts`).
- Environment variables `HERMES_HOME`, `HERMES_TIMEZONE`, `CODEX_HOME` and
  `LETTA_LOCAL_BACKEND_DIR`; `--source-dir` and `--target-dir` still win over them.

### Fixed

- A closed pipe (`openteleport ... | head`) no longer replaces the exit code of a failure that
  came before it: `validate` on a bad bundle in a pipe ends with 1, not 0.
- The id cache looks up an agent's identity (`cacheIdentity`) only for an agent that has no id
  yet, so the `folder` adapter no longer resolves a real path it does not need.
- The report no longer counts a fact an adapter skipped as moved; a line with no fact left is
  left out.

### Changed

- The test timeout is 30 seconds instead of 5, since the CLI tests start the built program.

## [0.1.0] - not published (folded into 0.2.0)

First release.

### Added

- The `.jetpack` format, version 0.1: a zip archive that unpacks to a working agent folder, laid
  out on existing standards rather than new file names. `AGENTS.md` holds the instructions,
  `SOUL.md` the persona, `skills/<name>/SKILL.md` the skills (Agent Skills), `MEMORY.md` the
  remembered facts (one bullet per fact, 500 characters at most) and `memory/<name>.md` notes in
  prose. `jetpack.json` is the manifest, `routines/<name>.json` the scheduled tasks, `files/` the
  optional workspace files (only with `--include-files`) and `avatar.png` the optional avatar.
  `schema/jetpack.schema.json` describes the manifest.
- Adapters, the apps an agent can be read from and written to:
  - `folder`: any directory that holds an agent (`AGENTS.md`, `SOUL.md`, skills, memory), with or
    without a `jetpack.json`. It works for every tool that reads `AGENTS.md`.
  - `openclaw`: read and write, through the `openclaw` CLI and the state directory. Scheduled
    jobs go through whichever command family the installed OpenClaw has, `openclaw cron` or
    `openclaw automations`.
  - `claude-code`: read and write of a project's subagents (`.claude/agents`), skills and project
    memory. Claude Code has no place for scheduled tasks, so routines are skipped in the report.
- Commands: `list`, `export`, `import`, `move` (read and write in one step, with `--keep` to also
  save a `.jetpack`), `inspect`, `validate` and `adapters`. All take `--json` and `--quiet`;
  `--source-dir` and `--target-dir` point an adapter at another folder than the app's own.
- A secret scanner. An export, a move or an import stops when the agent holds an API key, token,
  private key or similar credential, and names the file and line. Known credential patterns (API
  keys, tokens, private keys) are refused at export; the format has no field for credentials. The
  scanner is pattern-based and can miss unknown secret shapes.
- Routines arrive disabled. `--enable-routines` keeps the ones that were enabled.
- Conflict handling when the target already has an agent of that name: `update` in place (the
  default, only for the same agent), `--copy` for a numbered copy, `--replace` to overwrite it
  (asks first unless `--yes`). Claude Code skills belong to the whole project and are never
  overwritten: one with other content gets a numbered copy in every mode.
- A report for every move and import: what was moved, approximated and skipped, with the Markdown
  copy saved under `~/.openteleport/reports/`. The source is never modified.
- A library API (`readBundle`, `writeBundle`, `exportBundle`, `importBundle`, `move`, `getAdapter`,
  `registerAdapter`, `scanSecrets`, `parseManifest`), so that other tools can embed it.
- Extra adapters: `OPENTELEPORT_EXTRA_ADAPTER` names an ES module whose default export is an
  adapter, so that an app can be supported without a change to this package.

### Known limitations

- The JSON that `openclaw` prints (`agents list`, `cron list`, `automations list`) is not
  documented, and the OpenClaw adapter reads it tolerantly from what the docs and `--help` show.
  It has not been checked against a live install.
- The Claude Code adapter looks for a project's memory under the project folder as given, while
  Claude Code keys it on the root of the git repository. For a project inside a git worktree or a
  subfolder of a repository, memory is read from, and written to, a place Claude Code does not use.
- There is no SSH transport. To move an agent to another machine, export it, copy the file and
  import it there.

[0.4.0]: https://github.com/Open-Teleport/openteleport/compare/v0.2.0...v0.4.0
[0.2.0]: https://github.com/Open-Teleport/openteleport/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Open-Teleport/openteleport/releases/tag/v0.1.0
