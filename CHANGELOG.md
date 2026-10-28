# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/Open-Teleport/openteleport/releases/tag/v0.1.0
