# Project status

Last updated: 2026-10-29. This page says what exists, what is verified, and what comes next, so a new contributor can pick up work without reading the whole history.

## What is done

### v0.1 (never published on its own; part of 0.2.0)

- **Format `.jetpack` 0.1**: a zip whose unzipped layout is a working agent folder (`jetpack.json`, `AGENTS.md`, `SOUL.md`, `skills/*/SKILL.md`, `MEMORY.md`, `memory/*.md`, `routines/*.json`, `files/`, `avatar.*`). JSON Schema in `schema/jetpack.schema.json`. Hardened zip reading (size and path checks, no symlinks, no device names).
- **Adapters**: `folder` (any agent folder), `openclaw` (read and write through the OpenClaw CLI; supports both the `cron` and the `automations` command families), `claude-code` (read and write of `.claude/agents/*.md`, project skills and project memory).
- **CLI**: `move`, `export`, `import`, `list`, `inspect`, `validate`, `adapters`; `--json` output; exit codes 0/1/2/3; conflict modes `update`/`copy`/`replace`; extra adapters via `OPENTELEPORT_EXTRA_ADAPTER`.
- **Safety**: a secret scanner that blocks exports, imports and moves; routines land disabled; the source is never modified; destructive `--replace` needs confirmation or `--yes`.
- **Docs**: `README.md`, `docs/design.md` (the design and the reasoning), `docs/demo.md` (demo scenario and the end-to-end test), `docs/openclaw-plugin.md` (a proposal for an OpenClaw plugin), `CHANGELOG.md`.
- **Website**: `site/` (Astro), deployed through Vercel.

### v0.2 (merged into `main` on 2026-10-29; version 0.2.0, published to npm on 2026-10-29)

The design is `docs/superpowers/specs/2026-10-28-openteleport-v0.2-design.md`; the research behind it is in `docs/superpowers/research/`.

- **Five adapters**, all read and write, each with fixtures reproduced from documentation and source code, not recorded from an install. Hermes and Codex have since been checked on real installs (see "What is verified").
  - `hermes`: profiles (the Hermes home and `profiles/*`), `SOUL.md`, skills, memory entries, `cron/jobs.json` (written paused). Result: `done`.
  - `codex`: the global setup and the custom agents in `agents/*.toml`; a write makes a custom agent file and puts its skills in `~/.agents/skills`. Result: `done`.
  - `openbot`: reads a copy of `openbot.db` or an export zip; writes an `openbot-agent-import` zip. Result: `handoff` (import the zip in Server settings).
  - `grok-bot`: reads the zip the OpenBot export skill makes; writes a paste pack. Result: `handoff` (the five steps in the pack's README).
  - `letta`: reads `~/.letta` (local backend and Cloud agents' local memory); writes a MemFS folder and a `letta-commands.sh`/`.ps1` script. Result: `handoff` (run the script).
- **The OpenBot zip format** as one module (`src/formats/openbot-zip.ts`) shared by `openbot` and `grok-bot`, with the schedule shapes of OpenBot mapped in `src/core/schedule.ts`.
- **A wizard**: `npx openteleport` with no arguments, in a terminal, picks the source app, the agent and the target, announces a handoff before it asks, then runs `move` or `export`. Without a terminal it prints the help and exits with 2.
- **A simpler CLI**: `export` and `import` default to the current folder; `--help` shows the basic commands and flags, `--help-all` everything.
- **Adapter authoring**: `Adapter.createsOnWrite` and `Adapter.handoff`, the shared helpers in `src/adapters/` (`marker.ts`, `fs.ts`, `skill-files.ts`, `skills.ts`, `names.ts`) and `src/core/` (`zip.ts`, `text.ts`, `schedule.ts`), and a test that every adapter flagged `handoff` ends a write in a handoff.
- **Fixes**: a closed pipe keeps an earlier failure's exit code; the id cache asks for an agent's identity only when the agent has no id; a fact an adapter skipped is no longer counted as moved.
- **Tests**: 2,736 passing, 12 skipped on this machine (the end-to-end test that needs a real OpenClaw, and tests that need a platform feature). CI runs them on Ubuntu, macOS and Windows against the built CLI in a sandbox.

### v0.3 and v0.4 (combined as 0.4.0)

PRs #4, #6 and #7 are merged. This release adds the local MCP preview/apply server, Claude Code plugin, native OpenClaw and Hermes source plugins, memory selection and exclusive wizard exports. Codex copy names and imported-skill re-export are fixed with regression tests.

The combined integration passed 2,719 tests (12 skipped) locally and CI on Ubuntu, macOS and Windows. Native host smoke checks covered Hermes 0.13.0 and OpenClaw 2026.5.28 help, list, export and copy-import with synthetic data. They did not verify live model behavior or Gateway-backed routine execution. See `docs/integrations/` for setup and boundaries.

## What is verified

Hermes Agent and Codex were checked on real installs on 2026-10-29 (Windows). The evidence is `docs/superpowers/research/2026-10-29-real-install-check.md`. OpenClaw was checked the same day by the end-to-end test; the evidence is the table at the end of `docs/demo.md`.

- **Hermes** (0.13.0): import, same-id update, copy and export through the engine, with Hermes's own code reading the result back. It recovered the facts, the skill, the three routines (all paused, none run) and both profiles, and `skills/.bundled_manifest` has `name:hash` lines. Two edge cases came out of it, both fixed on this branch and not yet rechecked on an install:
  - A one-off time without an offset (`once.run_at`, as a hand-written job has it) is read by Hermes in the machine's time zone, not the profile's. The adapter now reads it the same way and warns about the assumption; cron expressions keep the profile's zone.
  - With no `HERMES_HOME`, Hermes falls back to `~/.hermes` on every system, Windows included. On Windows the adapter now takes `~/.hermes` when it holds a profile, else `%LOCALAPPDATA%\hermes` (where the installer puts it).
- **OpenClaw** (2026.5.28 and 2026.10.8, Windows): the end-to-end round trip passed on 2026.10.8 with the Gateway running: a Claude Code project into OpenClaw, back out into a folder, exported as the bundle that left, and two routines landed disabled with a two-line instruction whole. The first run, on 2026.5.28, found two wrong assumptions, fixed since: that version keeps the roster in `agents.list` (an array) and rejects `agents.entries`, which newer versions use, and its `agents list --json` names the workspace `location`. The adapter now reads both forms and sets model and runtime at the path the install keeps the agent under. Not reached in a passing run: the path without a Gateway, and the demo scripts.
- **Codex** (0.165): discovery only. A file in `agents/` is listed as a role named by its `name` field, not by the file name, and skills are read from `~/.agents/skills` and from `<CODEX_HOME>/skills`. The round trip is not verified; see the fixes and remaining verification below.

## Codex fixes

PR #4 fixes duplicate runtime names on copies and preserves associated imported skills on re-export. Regression tests cover both. A complete round trip interpreted by the live Codex application remains to be verified.

## What is not verified yet

- The OpenClaw round trip without a Gateway (the report's `openclaw gateway start` path), the demo scripts end to end, and OpenClaw versions other than 2026.5.28 (first half of the round trip, then the fix checked by hand) and 2026.10.8 (the whole round trip).
- Claude Code memory location for projects inside git worktrees (the adapter keys on the project folder as given).
- **The v0.2 adapters not yet checked on a real install.** Their layouts come from documentation and source code, and their fixtures were not recorded from an install. A verifier should check:
  - **Hermes** (the rest of it): what `hermes cron list` shows for an imported job, that `hermes cron resume <id>` starts one, and the two edge cases above on the fixed code, with `HERMES_HOME` unset and with a hand-written offset-free `once` job.
  - **Codex** (the rest of it): the `@<name>` syntax and `agents.enabled`, and the file names Codex gives its generated memory (`memories/` was empty).
  - **OpenBot**: the schema of `openbot.db` (the adapter knows migration 47; a newer one gets a warning, a missing table or column an error), and that Server settings accepts the import zip it writes, including the `x-openteleport` key in its manifest.
  - **Grok Bot**: the shape of the export zip the OpenBot export skill makes (`source.app`, the agent keys), and whether Settings, General, Import takes the plain-text memory file.
  - **Letta Code**: that `letta memory restore --agent <id> --from <plain folder> --force` accepts a folder that `letta memory backup` did not make, what `letta agents create` prints (the script asks you for the id), and the `crons.json` fields the adapter reads.

## Known small issues (good first fixes)

- A folder whose `files/` exceeds 100 MiB cannot be read even without `--include-files`.
- The literal `MEMORY-prose` (the name of the note that holds a `MEMORY.md`'s prose) is still defined five times: `src/adapters/claude-code/read.ts`, `src/adapters/openclaw/read.ts`, `src/adapters/openclaw/write.ts`, `src/core/bundle.ts` and `src/core/secrets.ts`.
- Codex: an existing agent file that is not valid TOML is overwritten whole by an update, with a warning.
- A wizard run with no app found, or no agents, exits 0, where the same case in command mode exits 3.

## What comes next

1. Run the pilot in `docs/integrations/pilot.md` across technical users, personal assistants and teams.
2. Verify remaining adapter assumptions on real installations.
3. SSH transport (`--to openclaw@server`).
4. An Ed25519 signature in the manifest (the field is reserved).
5. Letta Cloud over REST, once its authorization header and `agents.update` are checked on a real account.
6. Promoting `letta` and `openbot` from `handoff` to `done` after they are verified on real installs, and Codex automations once Codex documents a format.
7. Running the end-to-end test on each OpenClaw release the adapter claims, and the demo scripts end to end.

## Release

The owner chose to skip a separate 0.1.0 and ship 0.2.0 directly. [OpenTeleport 0.2.0](https://www.npmjs.com/package/openteleport/v/0.2.0) was published on 2026-10-29 as the first public version.

The `v0.2.0` tag points to commit `ee4371a52a40cd6f85533344067601c45dc53cac`. [Release workflow 40862578050](https://github.com/Open-Teleport/openteleport/actions/runs/40862578050) checked the version, linted, built, tested and published the package with provenance. npm briefly returned the prior staging version while processing the accepted publication; the public registry now serves 0.2.0.

A fresh-cache check outside the repository ran `npx openteleport@0.2.0 --version`, exported a synthetic folder agent, imported the resulting archive into a fresh folder, and verified that the instructions were preserved. This checks the published CLI path; it does not establish real-application behavior for every adapter.

Users with Node.js 24+ can start with `npx openteleport`. The 0.4.0 release combines the merged session and native plugin milestones. Use `npx openteleport@0.4.0` for its CLI and MCP server; install source plugins from the `v0.4.0` repository tag. Publication is performed by the tag-triggered Release workflow; consult the npm registry and GitHub Release for publication evidence.

## How decisions are recorded

- `docs/design.md` is the design authority for v0.1; the v0.2 spec in `docs/superpowers/specs/` is the authority where it differs. Changes to behaviour that contradict them get a note there.
- `docs/superpowers/plans/` holds the implementation plans; `docs/superpowers/research/` the research behind them.
- `CHANGELOG.md` lists every user-visible change per version.

## Where to ask

Open an issue with one of the templates. For a new adapter, start with the "Adapter request" template so the storage layout is agreed before code.
