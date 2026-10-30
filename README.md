# OpenTeleport

Move your AI agent between apps in one command.

<!-- Demo GIF goes here (recording script: docs/demo.md). -->

## What it does

OpenTeleport reads an agent (its persona, instructions, skills, routines and remembered facts) from one app, writes it into another, and reports what moved, what was approximated and what was skipped. It works with eight apps (see [Supported apps](#supported-apps)) and with any folder that holds an `AGENTS.md`.

## Quick start

```bash
npx openteleport
```

In a terminal, that is all you type. A wizard shows the apps it finds and asks which one the agent is in, which agent it is and where it should go (another app, or a `.jetpack` file in this folder). It says in one sentence what it is about to do and waits for a yes. Routines arrive disabled, and an agent of the same name is updated in place, not copied. A target that cannot be finished by OpenTeleport alone (the `handoff` rows in the table below) needs one more step from you after the move; the wizard says so before it asks, and the report names the step. Without a terminal, `openteleport` with no arguments prints the help and exits with 2.

The same moves as three commands:

```bash
# move an agent from Claude Code to OpenClaw (export and import in one step)
npx openteleport move --from claude-code --to openclaw --agent reviewer

# save an agent from any project folder to a file, to send it or archive it
npx openteleport export --from folder --source-dir ./agents --agent ada --out ada.jetpack

# load an agent from a file into an app
npx openteleport import --to claude-code ada.jetpack
```

## Install

Nothing to install beyond [Node.js](https://nodejs.org) 24 or later:

```bash
npx openteleport --help
```

Or keep it on your PATH with `npm install --global openteleport`. There is no account and no configuration, and OpenTeleport never calls a language model or a remote service.

## Usage

**`move`** reads an agent from one app and writes it into another. The source is only read; `--keep <file.jetpack>` also saves the agent as a file.

```bash
npx openteleport move --from <app> --to <app> --agent <id|name>
```

**`export`** saves an agent as a `.jetpack` file (`--out`, or `<name>.jetpack` in the working folder) and writes `move-report.md` next to it. Without `--from` it exports the agent folder you are in, which needs an `AGENTS.md`.

```bash
npx openteleport export --from <app> --agent <id|name> --out <file.jetpack>
```

**`import`** writes a `.jetpack` file, or an agent folder, into an app. Without `--to` it unpacks the agent into a new folder named after it, in the working folder.

```bash
npx openteleport import --to <app> <file.jetpack|folder>
```

Every app is found where it normally keeps its data; `--source-dir` and `--target-dir` point OpenTeleport somewhere else (another project, a state directory, a mounted volume). After `move` and `import` the report is printed and saved under `~/.openteleport/reports/`. Without `--agent`, a terminal lets you pick from a list; a script gets an error that names the agents there are. `--json` prints the result as JSON on stdout, and `--quiet` leaves out everything but the result.

- `openteleport list --from <app>` lists the agents an app has.
- `openteleport inspect <file|folder>` shows what a `.jetpack` file or an agent folder holds.
- `openteleport validate <file|folder>` checks a bundle against the format and scans it for secrets.
- `openteleport adapters` lists the supported apps and whether each is installed here.

`openteleport --help` lists the commands and flags most people need; `openteleport --help-all` (also after a command, as in `move --help-all`) lists every command and flag, and the two `OPENTELEPORT_` variables; the variables of the apps are under [Environment variables](#environment-variables).

Exit codes: `0` success, `1` an invalid bundle, a secret found or another failure, `2` a bad flag, argument or app name, `3` an app that is not where it was looked for.

## Supported apps

`Result` is what a successful write ends in. `done` means the agent is in the app. `handoff` means OpenTeleport has prepared everything and one step is left to you; the report and the wizard name it.

| Adapter | Read | Write | Result | Notes |
| --- | --- | --- | --- | --- |
| `folder` | yes | yes | done | Any folder with an `AGENTS.md`, with or without `jetpack.json`, in the layout below. That covers every tool that works from `AGENTS.md` and `skills/`, such as Codex, Cursor, Gemini CLI and Cline. A git repository or project folder is fine: only the layout is read, and everything else (`.git`, `node_modules`, `src/`...) is left out and listed by `inspect`. Routines are kept in the folder; nothing runs them from there. |
| `openclaw` | yes | yes | done | The state directory (`~/.openclaw`) and the `openclaw` CLI: agent, identity, workspace files, memory, skills and model. Routines become `openclaw cron` jobs (`openclaw automations` from 2026.6), which go through the Gateway. Each `openclaw` command gets 5 minutes (30 seconds for `--version`); one that takes longer is stopped and named in the error. `files/` is not carried. |
| `claude-code` | yes | yes | done | Subagents in `.claude/agents/<name>.md` (or `~/.claude/agents/`), the project's skills in `.claude/skills/` and its memory in `~/.claude/projects/<project>/memory/`. Imported notes are linked from `MEMORY.md`, which is only ever appended to. Skills are shared by the whole project, so one of the same name with other content is written next to it as `<name>-2`, even with `--replace`. Routines (cloud tasks) and avatars are skipped, and the report says so. |
| `hermes` | yes | yes | done | Hermes Agent, through its files. A profile is the Hermes home itself (`default`) or a folder under `profiles/`; both can be read: `SOUL.md`, skills (not the ones Hermes ships with), memory entries, `cron/jobs.json` and the model from `config.yaml`. A write makes or updates a named profile under `profiles/`, never the default one, and a name Hermes reserves gets `-agent` after it. A memory entry of up to 500 characters is read as a fact with its line breaks folded into one line (the report counts them); a longer one becomes a note. Memory entries stop at the profile's character limit. Cron jobs are always written paused, even with `--enable-routines`, and the report gives the `hermes cron resume` commands. Hermes has no place for notes, so they are skipped. Restart the gateway if it is running. |
| `codex` | yes | yes | done | Codex, through its files. It reads the global setup (`AGENTS.md`, skills from `~/.agents/skills` and from the deprecated `<CODEX_HOME>/skills`, the model in `config.toml`, and `memories/MEMORY.md` as one note) and every custom agent in `agents/*.toml`. A write makes or updates one custom agent file, `agents/<name>.toml`, and puts its skills in `~/.agents/skills`, which every tool that reads that folder shares. Skills always go there, whatever `--target-dir` says. It never writes `config.toml` or `AGENTS.md`; it keeps `<CODEX_HOME>/openteleport-ids.json`, beside `config.toml` and one level above `agents/`, the map that lets a second move update the same agent. Persona and facts are folded into `developer_instructions`. Codex has no documented format for routines, so they are skipped. |
| `openbot` | yes | yes | handoff: import the zip in OpenBot, under Server settings | Reads a copy of `openbot.db` (the file the app uses is never opened), or an export zip that `--source-dir` names (an agent import or an instance transfer). Skills are not stored in the database, only in a transfer zip. A write makes `<name>-openbot-import.zip`, which you import in the app. OpenBot's import has no field for a model or for notes, and the persona is joined with the instructions. Routines can be cron or every. |
| `grok-bot` | yes | yes | handoff: follow the five steps in the README of the paste pack | Grok Bot keeps its Bots in the cloud and has no import, so it is not found on its own: the only source is the zip that the OpenBot export skill makes (`--source-dir <zip>`). A write makes a folder, `<name>-for-grok-bot/`, with text to paste into a new Bot's chat, its memory as a text file, its routines as lines to paste, its skills, and a `README.md` with the five steps. Grok Bot keeps one set of skills for the whole account, and the format of its memory import is a guess; the report says both. |
| `letta` | yes | yes | handoff: run the generated `letta-commands.sh` (or `.ps1`) | Letta Code, through `~/.letta`: agents of the local backend and the local memory of Cloud agents, and their scheduled tasks. A write makes a folder, `<name>-letta-memory/`, with the agent's memory in Letta's layout, a prompt file per routine and a script that runs `letta agents create`, `letta memory restore` and `letta cron add`; you run it. Routines are left commented out in the script unless you pass `--enable-routines` (and then only the ones that were enabled are added). Restoring a plain memory folder is not documented by Letta and has not been tried. Avatars and `files/` have no place in Letta. |

The five newest rows (`hermes` to `letta`) follow the documentation and source code of those apps. What has been checked on real installs (2026-10-29, Windows): `openclaw`, by the end-to-end round trip on OpenClaw 2026.10.8 with its Gateway running (the table at the end of [`docs/demo.md`](docs/demo.md) records it, and what 2026.5.28 showed); `hermes`, through Hermes's own code reading back what OpenTeleport wrote ([report](docs/superpowers/research/2026-10-29-real-install-check.md)); `codex`, for discovery, with the two defects that report found fixed in 0.4.0, while the round trip through the Codex application itself has not been run. `openbot`, `grok-bot` and `letta` are experimental: their layouts come from documentation and source code, and none has been checked on the real app yet. [`docs/STATUS.md`](docs/STATUS.md) lists what is open and what a verifier should look at; help with any of it is welcome.

## Environment variables

An app is found where it normally keeps its data. These variables move it; `--source-dir` and `--target-dir` win over all of them.

| Variable | Effect |
| --- | --- |
| `OPENTELEPORT_HOME` | Stands in for your home folder: reports and agent ids go to `.openteleport` inside it, and apps that keep their data in the home folder are looked for there. |
| `OPENTELEPORT_EXTRA_ADAPTER` | A module whose default export adds an app (see below). |
| `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` | OpenClaw's state directory and config file. |
| `CLAUDE_CONFIG_DIR` | Claude Code's configuration folder, where its memory lives. |
| `HERMES_HOME` | The Hermes home. Without it, `~/.hermes`; on Windows, `~/.hermes` when it holds a profile, else `%LOCALAPPDATA%\hermes` (where the installer puts Hermes and sets this variable). |
| `HERMES_TIMEZONE` | The time zone Hermes reads its cron expressions in; otherwise the profile's `timezone`, then this machine's. A one-off time without an offset is always read in this machine's zone, as Hermes does, and the report says so. |
| `CODEX_HOME` | Codex's home: `~/.codex`. |
| `LETTA_LOCAL_BACKEND_DIR` | The folder of Letta Code's local backend: `~/.letta/lc-local-backend`. |

## The `.jetpack` format

A `.jetpack` file is a zip archive. Unzipped, it is a folder with a fixed layout that reuses the file names tools already share instead of inventing new ones:

```
jetpack.json            manifest: schema version, id, name, title, model and runtime preferences, capabilities
AGENTS.md               how the agent works: its instructions (the AGENTS.md standard)
SOUL.md                 who the agent is: persona and tone (optional; the OpenClaw and Hermes convention)
skills/<name>/SKILL.md  skills in the Agent Skills format
MEMORY.md               remembered facts, one bullet per fact, up to 500 characters each
memory/<name>.md        prose memory (journals, notes), carried as it is
routines/<name>.json    scheduled tasks: prompt, schedule (cron / every / at), time zone, enabled or not
files/                  optional workspace files, only with --include-files
avatar.png              optional, PNG, JPEG or WebP, up to 512 KB
```

An unzipped .jetpack is a working agent folder for any AGENTS.md-aware tool. It works the other way round too: a folder without `jetpack.json` is a valid source, and the `folder` adapter makes up the manifest from what the folder holds.

The manifest is described by a JSON Schema, [`schema/jetpack.schema.json`](schema/jetpack.schema.json), published as `https://openteleport.dev/schema/0.1/jetpack.json`. Its `id` is a ULID given on the first export and kept on every later one, so moving the same agent again updates it in place. `models` lists preferences in order, each with an optional `runtime` (such as `claude-code` or `codex`), and `capabilities` says what the agent needs (`browser`, `shell`, `filesystem`, `network`, `computerUse`, `scheduler`), not what it is granted. Fields only one app understands go under `x-<vendor>` keys, which other apps ignore.

## Remote installs

OpenTeleport works on the local file system. For an app on another machine, carry the file:

```bash
# on your laptop
npx openteleport export --from claude-code --agent reviewer --out reviewer.jetpack
scp reviewer.jetpack server:

# on the server
npx openteleport import --to openclaw reviewer.jetpack
```

For an app in Docker or on a network drive, point `--source-dir` or `--target-dir` at the mounted folder (OpenClaw also needs its `openclaw` CLI on the machine that runs OpenTeleport).

## Safety

- **Secrets block exports.** Before anything is written, the bundle is scanned for credentials of known shapes (OpenAI, Anthropic, GitHub, Slack, AWS and Google keys, JWTs, bearer tokens, private keys). A finding stops the command with exit code 1 and names the file and line, never the secret. `.env*` files, `.git`, `node_modules` and nested archives are never packed. Run `validate` on a file you were sent.
- **Routines land disabled,** so the same task never runs in two apps without you knowing. `--enable-routines` keeps them as they were (Hermes still gets them paused, and the report says how to resume them).
- **The source is never modified.** `move` reads a snapshot and writes a copy; nothing is deleted from the app it came from.
- **Nothing is overwritten by surprise.** An agent of the same name in the target is updated in place only when it is the same agent (same id); otherwise the new one is written next to it as `<name>-2`. `--copy` always writes next to it. `--replace` overwrites it after asking for confirmation, or with `--yes` when there is no terminal to ask in. A `folder` target that already holds files but no earlier export (no `jetpack.json`) is never written into: use `--copy`, or point `--target-dir` at an empty folder. Updating an earlier export replaces its layout (`AGENTS.md`, `skills/`, `memory/`...) and the report names every part it removed; other files in the folder stay.
- **Workspace files stay behind** unless you pass `--include-files`, and then only up to 100 MB; over that, the error names the five largest files. With files on board, the report warns that they may hold personal data, so review them before you share the bundle, and says how many files over 2 MiB were too large to scan for secrets.

## Contributing an adapter

An adapter is one folder, `src/adapters/<name>/`, whose module exports an `Adapter`:

```ts
import type { Adapter } from "openteleport";

const myApp: Adapter = {
  name: "my-app", // what --from and --to take
  displayName: "My App",
  createsOnWrite: false, // true: write makes its target, so the app need not be installed there
  handoff: false, // true: write only prepares a file or folder and returns outcome "handoff"
  // What the app can hold. The engine empties every field marked false and reports it as skipped.
  capabilities: {
    persona: true, instructions: true, skills: true, routines: false, facts: true,
    notes: true, files: false, avatar: false, models: true, schedules: [],
  },
  async detect(ctx) { /* { found, location?, version?, hint? } */ },
  async list(ctx) { /* [{ id, name, title?, location? }] */ },
  async read(ctx, agent) { /* { bundle, warnings }; never modifies the source */ },
  async write(ctx, bundle, opts) { /* { outcome: "done" | "handoff", nextStep?, items } */ },
};

export default myApp;
```

`ctx` carries `sourceDir`, `targetDir`, `home`, `cwd`, `env`, `exec` and `logger`; an adapter reads the home folder and the environment only from there, so tests can point them at a temporary folder. `opts` says whether to keep routines enabled, whether to carry `files/`, and what to do with an agent of the same name (`update`, `replace` or `copy`).

`read` returns the agent's `id` when the app kept the one an earlier move gave it (OpenClaw keeps it in the workspace's `.openteleport.json`, Claude Code beside the project's memory), and an empty `id` otherwise; the engine then takes one from `~/.openteleport/ids.json`, keyed by the agent's id in the app. When that id alone does not tell agents apart (the `folder` adapter's `.` is a different agent in every folder), the optional `cacheIdentity(ctx, agent)` returns what does, such as the folder's real path.

Before you open a pull request:

1. Fixtures recorded from a real install of the app, with personal data removed, live in `test/fixtures/<name>/`.
2. Tests show that `read` on the fixtures gives the expected bundle, that `write` produces what the app itself would, and that a round trip loses nothing the report does not list.
3. `read` never changes the source, and `write` never writes through a symbolic link.
4. Routines land disabled unless `opts.enableRoutines` is set.
5. A second move of the same agent (`bundle.manifest.id`) updates it in place; another agent of the same name is never overwritten without `replace`.
6. Whatever the app cannot hold is reported as approximated, skipped or a warning, never dropped silently.
7. `npm run lint`, `npm run build` and `npm test` pass.

To try an adapter without changing OpenTeleport, build it as an ES module whose default export is the adapter and name it in `OPENTELEPORT_EXTRA_ADAPTER`:

```bash
OPENTELEPORT_EXTRA_ADAPTER=./my-app.js npx openteleport adapters
```

In PowerShell: `$env:OPENTELEPORT_EXTRA_ADAPTER = "./my-app.js"; npx openteleport adapters`.

## License

Apache-2.0.

## From inside Claude Code and MCP clients

The local stdio server and Claude Code plugin support reviewed agent transfers from a session. Introduced in 0.4.0 and included in the current 0.4.1 npm release. See [setup, tools, and the preview/apply workflow](docs/integrations/mcp.md).

## Native OpenClaw and Hermes commands (0.4.0 source plugins)

Source plugins in the `v0.4.0` repository tag add a teleport command group to each host and reuse the existing transfer engine. See [installation, behavior, and verification limits](docs/integrations/native-plugins.md). Install these plugins from the tagged repository; they are not separate npm or pip packages.
