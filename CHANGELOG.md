# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - unreleased

Five more apps, a wizard for the first run, and a few small fixes.

### Added

- Five adapters, all read and write, each built from the documentation and source code of the app
  and not yet checked on a real install:
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

## [0.1.0] - unreleased

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
- Planned for later releases: OpenBot, Hermes, Codex, Grok Bot and Letta.

[0.2.0]: https://github.com/Open-Teleport/openteleport/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Open-Teleport/openteleport/releases/tag/v0.1.0
