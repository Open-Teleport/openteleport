# Project status

Last updated: 2026-10-29. This page says what exists, what is verified, and what comes next, so a new contributor can pick up work without reading the whole history.

## What is done

### v0.1 (unreleased)

- **Format `.jetpack` 0.1**: a zip whose unzipped layout is a working agent folder (`jetpack.json`, `AGENTS.md`, `SOUL.md`, `skills/*/SKILL.md`, `MEMORY.md`, `memory/*.md`, `routines/*.json`, `files/`, `avatar.*`). JSON Schema in `schema/jetpack.schema.json`. Hardened zip reading (size and path checks, no symlinks, no device names).
- **Adapters**: `folder` (any agent folder), `openclaw` (read and write through the OpenClaw CLI; supports both the `cron` and the `automations` command families), `claude-code` (read and write of `.claude/agents/*.md`, project skills and project memory).
- **CLI**: `move`, `export`, `import`, `list`, `inspect`, `validate`, `adapters`; `--json` output; exit codes 0/1/2/3; conflict modes `update`/`copy`/`replace`; extra adapters via `OPENTELEPORT_EXTRA_ADAPTER`.
- **Safety**: a secret scanner that blocks exports, imports and moves; routines land disabled; the source is never modified; destructive `--replace` needs confirmation or `--yes`.
- **Docs**: `README.md`, `docs/design.md` (the design and the reasoning), `docs/demo.md` (demo scenario and the end-to-end test), `docs/openclaw-plugin.md` (a proposal for an OpenClaw plugin), `CHANGELOG.md`.
- **Website**: `site/` (Astro), not deployed yet.

### v0.2 (unreleased, on the `v0.2` branch)

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
- **Tests**: 2,621 passing, 12 skipped on this machine (the end-to-end test that needs a real OpenClaw, and tests that need a platform feature). CI runs them on Ubuntu, macOS and Windows against the built CLI in a sandbox.

## What is verified

Hermes Agent and Codex were checked on real installs on 2026-10-29 (Windows). The evidence is `docs/superpowers/research/2026-10-29-real-install-check.md`.

- **Hermes** (0.13.0): import, same-id update, copy and export through the engine, with Hermes's own code reading the result back. It recovered the facts, the skill, the three routines (all paused, none run) and both profiles, and `skills/.bundled_manifest` has `name:hash` lines. Two edge cases came out of it, both fixed on this branch and not yet rechecked on an install:
  - A one-off time without an offset (`once.run_at`, as a hand-written job has it) is read by Hermes in the machine's time zone, not the profile's. The adapter now reads it the same way and warns about the assumption; cron expressions keep the profile's zone.
  - With no `HERMES_HOME`, Hermes falls back to `~/.hermes` on every system, Windows included. On Windows the adapter now takes `~/.hermes` when it holds a profile, else `%LOCALAPPDATA%\hermes` (where the installer puts it).
- **Codex** (0.165): discovery only. A file in `agents/` is listed as a role named by its `name` field, not by the file name, and skills are read from `~/.agents/skills` and from `<CODEX_HOME>/skills`. The round trip is not verified; see the open defects below.

## Open defects

Found on the same real install and reproduced through OpenTeleport itself. A fix for both is in progress on a separate branch (the report has the steps). Until it merges, do not call Codex round-trip portability verified.

- **Codex: copies share the runtime `name`.** `--copy`, or a name conflict, writes `<slug>-2.toml` with the same `name = "..."`. Codex keys a role by `name`, so it exposes one role and the original is no longer separately selectable. The `@<slug>` in the Codex hint is also wrong for a name that slugifies differently.
- **Codex: a custom-agent export drops its skills.** Importing an agent reports its skill as moved and Codex finds it, but exporting that custom agent gives a bundle with no skills and no warning. Only the global setup (`--agent default`) exports skills.

## What is not verified yet

- The end-to-end round trip on a real OpenClaw install (`OPENTELEPORT_E2E=1 npx vitest run test/e2e`). The table in `docs/demo.md` lists the assumptions it settles: the JSON printed by `openclaw cron list/add`, routine creation through the Gateway, the Windows `.cmd` shim with multi-line instructions, `config set` with dashed agent ids.
- Claude Code memory location for projects inside git worktrees (the adapter keys on the project folder as given).
- **The v0.2 adapters not yet checked on a real install.** Their layouts come from documentation and source code, and their fixtures were not recorded from an install. A verifier should check:
  - **Hermes** (the rest of it): what `hermes cron list` shows for an imported job, that `hermes cron resume <id>` starts one, and the two edge cases above on the fixed code, with `HERMES_HOME` unset and with a hand-written offset-free `once` job.
  - **Codex** (the rest of it): the `@<name>` syntax and `agents.enabled`, and the file names Codex gives its generated memory (`memories/` was empty).
  - **OpenBot**: the schema of `openbot.db` (the adapter knows migration 47; a newer one gets a warning, a missing table or column an error), and that Server settings accepts the import zip it writes, including the `x-openteleport` key in its manifest.
  - **Grok Bot**: the shape of the export zip the OpenBot export skill makes (`source.app`, the agent keys), and whether Settings, General, Import takes the plain-text memory file.
  - **Letta Code**: that `letta memory restore --agent <id> --from <plain folder> --force` accepts a folder that `letta memory backup` did not make, what `letta agents create` prints (the script asks you for the id), and the `crons.json` fields the adapter reads.
- The first npm release (needs an `NPM_TOKEN` secret and a dated CHANGELOG entry; the release workflow refuses a tag that does not match `package.json`). See "Release" below.

## Known small issues (good first fixes)

- A folder whose `files/` exceeds 100 MiB cannot be read even without `--include-files`.
- The literal `MEMORY-prose` (the name of the note that holds a `MEMORY.md`'s prose) is still defined five times: `src/adapters/claude-code/read.ts`, `src/adapters/openclaw/read.ts`, `src/adapters/openclaw/write.ts`, `src/core/bundle.ts` and `src/core/secrets.ts`.
- Codex: an existing agent file that is not valid TOML is overwritten whole by an update, with a warning.
- Codex (open until its branch merges): copies of one agent share a runtime `name`, and exporting a custom agent drops its skills. See "Open defects".
- A wizard run with no app found, or no agents, exits 0, where the same case in command mode exits 3.

## What comes next (v0.3)

1. A Claude Code plugin and an MCP server (approved by the owner on 2026-10-28), so that an agent can be moved from inside a session.
2. Plugins for OpenClaw (`docs/openclaw-plugin.md`) and Hermes.
3. SSH transport (`--to openclaw@server`).
4. An Ed25519 signature in the manifest (the field is reserved).
5. Letta Cloud over REST, once its authorization header and `agents.update` are checked on a real account.
6. Promoting `letta` and `openbot` from `handoff` to `done` after they are verified on real installs, and Codex automations once Codex documents a format.
7. Running the end-to-end test on a real install and filling the table in `docs/demo.md`.

## Release

`package.json` stays at `0.1.0` until the owner decides. `v0.1.0` has not been released (there is no `NPM_TOKEN` secret yet, and neither the CHANGELOG entry nor a tag has a date). There are two paths:

1. Tag `v0.1.0` on commit `f1ad906` (the commit v0.2 branched from), release it, then bump to `0.2.0` after the merge and release that. Two versions on npm, the second with everything on this page.
2. Skip `0.1.0` and release `0.2.0` directly: set `version` to `0.2.0`, date the CHANGELOG entry, tag `v0.2.0`.

Either way the `NPM_TOKEN` repository secret has to exist first, and the release workflow refuses a tag that does not match `package.json`.

## How decisions are recorded

- `docs/design.md` is the design authority for v0.1; the v0.2 spec in `docs/superpowers/specs/` is the authority where it differs. Changes to behaviour that contradict them get a note there.
- `docs/superpowers/plans/` holds the implementation plans; `docs/superpowers/research/` the research behind them.
- `CHANGELOG.md` lists every user-visible change per version.

## Where to ask

Open an issue with one of the templates. For a new adapter, start with the "Adapter request" template so the storage layout is agreed before code.
