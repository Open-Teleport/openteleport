# Project status

Last updated: 2026-10-28. This page says what exists, what is verified, and what comes next, so a new contributor can pick up work without reading the whole history.

## What is done (v0.1, unreleased)

- **Format `.jetpack` 0.1**: a zip whose unzipped layout is a working agent folder (`jetpack.json`, `AGENTS.md`, `SOUL.md`, `skills/*/SKILL.md`, `MEMORY.md`, `memory/*.md`, `routines/*.json`, `files/`, `avatar.*`). JSON Schema in `schema/jetpack.schema.json`. Hardened zip reading (size and path checks, no symlinks, no device names).
- **Adapters**: `folder` (any agent folder), `openclaw` (read and write through the OpenClaw CLI; supports both the `cron` and the `automations` command families), `claude-code` (read and write of `.claude/agents/*.md`, project skills and project memory).
- **CLI**: `move`, `export`, `import`, `list`, `inspect`, `validate`, `adapters`; `--json` output; exit codes 0/1/2/3; conflict modes `update`/`copy`/`replace`; extra adapters via `OPENTELEPORT_EXTRA_ADAPTER`.
- **Safety**: a secret scanner that blocks exports, imports and moves; routines land disabled; the source is never modified; destructive `--replace` needs confirmation or `--yes`.
- **Tests**: about 1,140 tests, run in CI on Ubuntu, macOS and Windows against the built CLI in a sandbox.
- **Docs**: `README.md`, `docs/design.md` (the design and the reasoning), `docs/demo.md` (demo scenario and the end-to-end test), `docs/openclaw-plugin.md` (a proposal for an OpenClaw plugin), `CHANGELOG.md`.
- **Website**: `site/` (Astro), not deployed yet.

## What is not verified yet

- The end-to-end round trip on a real OpenClaw install (`OPENTELEPORT_E2E=1 npx vitest run test/e2e`). The table in `docs/demo.md` lists the assumptions it settles: the JSON printed by `openclaw cron list/add`, routine creation through the Gateway, the Windows `.cmd` shim with multi-line instructions, `config set` with dashed agent ids.
- Claude Code memory location for projects inside git worktrees (the adapter keys on the project folder as given).
- The first npm release (needs an `NPM_TOKEN` secret and a dated CHANGELOG entry; the release workflow refuses a tag that does not match `package.json`).

## Known small issues (good first fixes)

- The EPIPE handler exits with code 0 and can hide a failed `validate` in a pipe (`src/commands/shared.ts`).
- The folder adapter resolves the real path even when the agent already has an id (`src/core/engine.ts`, `withId`).
- Five copies of the slug rule and a few duplicated helpers (`isRecord`, `label`, the `MEMORY-prose` literal) could move to shared modules.
- A folder whose `files/` exceeds 100 MiB cannot be read even without `--include-files`.

## What comes next (v0.2)

1. Adapters, in this order unless research changes it: Hermes, Codex, OpenBot, Grok Bot (through the zip format OpenBot imports), Letta (`.af` import). Research notes land in `docs/superpowers/research/`.
2. A simpler first run: `npx openteleport` with no arguments opens a picker (source app → agent → target), `export`/`import` default to the current folder, `--help` separates basic from advanced flags.
3. The small fixes listed above.
4. Running the end-to-end test on a real install and filling the table in `docs/demo.md`.

Later (v0.3 candidates): SSH transport (`--to openclaw@server`), a target-id override on import, an Ed25519 signature in the manifest (field reserved), the OpenClaw plugin.

## How decisions are recorded

- `docs/design.md` is the design authority. Changes to behaviour that contradict it get a note there.
- `docs/superpowers/plans/` holds the implementation plans; `docs/superpowers/research/` the research behind them.
- `CHANGELOG.md` lists every user-visible change per version.

## Where to ask

Open an issue with one of the templates. For a new adapter, start with the "Adapter request" template so the storage layout is agreed before code.
