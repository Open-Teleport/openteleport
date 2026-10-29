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

- **Five adapters**, all read and write, each with fixtures reproduced from documentation and source code (layout from documentation and source code, not yet verified on a real install).
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
- **Tests**: 2,603 passing, 12 skipped on this machine (the end-to-end test that needs a real OpenClaw, and tests that need a platform feature). CI runs them on Ubuntu, macOS and Windows against the built CLI in a sandbox.

## What is not verified yet

- The end-to-end round trip on a real OpenClaw install (`OPENTELEPORT_E2E=1 npx vitest run test/e2e`). The table in `docs/demo.md` lists the assumptions it settles: the JSON printed by `openclaw cron list/add`, routine creation through the Gateway, the Windows `.cmd` shim with multi-line instructions, `config set` with dashed agent ids.
- Claude Code memory location for projects inside git worktrees (the adapter keys on the project folder as given).
- **The five v0.2 adapters on a real install.** None of the five apps was used to record fixtures; every layout comes from documentation and source code. A verifier should check:
  - **Hermes**: the fields of `cron/jobs.json` that `hermes cron list` shows for an imported job (`id`, `schedule`, `enabled`, `state: "paused"`, `next_run_at`), that `hermes cron resume <id>` starts one, and the format of `skills/.bundled_manifest` (the adapter reads `name` or `name:hash` lines).
  - **Codex**: that an `agents/<name>.toml` the adapter writes is listed and usable as `@<name>` (the keying and the fields Codex requires), and that `~/.agents/skills` is where Codex looks for user skills.
  - **OpenBot**: the schema of `openbot.db` (the adapter knows migration 47; a newer one gets a warning, a missing table or column an error), and that Server settings accepts the import zip it writes, including the `x-openteleport` key in its manifest.
  - **Grok Bot**: the shape of the export zip the OpenBot export skill makes (`source.app`, the agent keys), and whether Settings, General, Import takes the plain-text memory file.
  - **Letta Code**: that `letta memory restore --agent <id> --from <plain folder> --force` accepts a folder that `letta memory backup` did not make, what `letta agents create` prints (the script asks you for the id), and the `crons.json` fields the adapter reads.
- The first npm release (needs an `NPM_TOKEN` secret and a dated CHANGELOG entry; the release workflow refuses a tag that does not match `package.json`). See "Release" below.

## Known small issues (good first fixes)

- A folder whose `files/` exceeds 100 MiB cannot be read even without `--include-files`.
- The literal `MEMORY-prose` (the name of the note that holds a `MEMORY.md`'s prose) is still defined five times: `src/adapters/claude-code/read.ts`, `src/adapters/openclaw/read.ts`, `src/adapters/openclaw/write.ts`, `src/core/bundle.ts` and `src/core/secrets.ts`.
- Codex: an existing agent file that is not valid TOML is overwritten whole by an update, with a warning.
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
