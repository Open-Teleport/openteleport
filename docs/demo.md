# Demo and end-to-end test

Four things live here: the 60-second recording, the demo scripts it is recorded from, scenarios for the five v0.2 adapters that need no app, and the end-to-end round trip that checks OpenTeleport against the OpenClaw and Claude Code installed on a machine.

Versions on the machine the demo and the e2e were written on (from `openclaw --version` and `claude --version`): OpenClaw 2026.5.28 (e932160), Claude Code 2.1.273, Node.js 24.11.1, Windows 11. The e2e prints the versions it ran against; once it has passed, they go in the table at the end.

## The 60-second recording

The story: one person has five agents in a Claude Code project and wants them in OpenClaw too, and one of them as a plain folder that any tool can open. Record `scripts/demo.sh` (or `scripts/demo.ps1`) in a terminal about 110 columns wide. The setup lines it prints first are cut; the rest is shown as it runs, sped up where the five moves repeat.

| Time | On screen | Caption |
| --- | --- | --- |
| 0:00 to 0:08 | `openteleport list --from claude-code --source-dir project`: five agents. | "Five agents in Claude Code. Moving them to another app means rewriting each one by hand." |
| 0:08 to 0:20 | The first `openteleport move --from claude-code ... --to openclaw ... --agent reviewer`. | "One command per agent." |
| 0:20 to 0:32 | The report of that move: Moved, Approximated, Skipped, Warnings. Hold on it. | "Nothing is lost silently: the report says what moved, what was approximated and what was skipped." |
| 0:32 to 0:40 | The other four moves, sped up. | "Routines would land disabled. The source is never touched." |
| 0:40 to 0:48 | `openclaw agents list`: the five agents, now in OpenClaw. | "Five agents, now in OpenClaw." |
| 0:48 to 0:56 | `openteleport move --from openclaw ... --to folder ...`, then `ls agents/reviewer`: `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `skills/` and the rest of the `.jetpack` layout. | "And back out as a plain folder that Codex, Cursor or any AGENTS.md-aware tool can use." |
| 0:56 to 1:00 | The move report file, then the end card. | "Three tools, one format. `npx openteleport`" |

## Running the demo

Both scripts do the same thing. They need Node.js 24+, `openclaw` on `PATH`, and a build of this repository. From the repository root:

```bash
npm ci
npm run build
bash scripts/demo.sh
```

```powershell
npm ci
npm run build
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1   # or: pwsh -File scripts/demo.ps1
```

Each script works in a new temporary folder and prints its path at the start and the end. In it:

- `project/`: a copy of `test/fixtures/claude-code/project` with five agents, its `reviewer` and four copies of it (`planner`, `tester`, `docs-writer`, `release-manager`) that differ only in name and description. The fixture's other agent, `plain`, is left out.
- `home/`: `HOME`, `USERPROFILE`, `OPENTELEPORT_HOME` and `CLAUDE_CONFIG_DIR` for the run, with the project's Claude Code memory from the fixtures, so the moves carry facts as well and nothing falls back to your own home.
- `openclaw/`: a throwaway OpenClaw state directory, set up with `openclaw onboard --non-interactive` (the flags are the ones listed under the e2e below; stdin is closed, so it cannot wait on a prompt, and its output goes to `onboard.log`). `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` point at it for the whole run, so `openclaw agents list` shows this install and not yours. To use a state directory you onboarded yourself, set `OPENTELEPORT_DEMO_OPENCLAW_STATE_DIR`; the five agents are added to it.

As the e2e does, the scripts first clear every `OPENCLAW_*` and `OPENTELEPORT_*` variable they inherit, in any case, so that nothing in your environment leads a command to your own installs. `demo.ps1` puts every variable it changed back when it ends, since it may run inside your PowerShell session; `demo.sh` runs in a shell of its own.
- `agents/reviewer/`: the agent folder the last move writes.

The scripts print every command before running it, stop at the first one that fails, and end by printing the move report of the last move (saved under `home/.openteleport/reports/`; `export` would have written it as `move-report.md` next to the `.jetpack`). Nothing starts a Gateway; the agents carry no routines, so none is needed. Delete the temporary folder when you are done.

## Scenarios for the five v0.2 adapters

One scenario per new adapter, to run from the repository root after `npm run build`. They use the fixtures in `test/fixtures/` and a throwaway folder, so no real app is needed and nothing goes to your home folder: `OPENTELEPORT_HOME` stands in for it. Hermes and Codex are written into copies of their fixtures; the other three make a file or a folder in `out/`. In all of them the source is the `ada` agent of `test/fixtures/jetpack` (a persona, instructions, one skill, two facts, some notes and one enabled routine, which arrives disabled).

```bash
DEMO=$(mktemp -d)
export OPENTELEPORT_HOME="$DEMO/home"
mkdir "$DEMO/out"
cp -r test/fixtures/hermes/home "$DEMO/hermes"
cp -r test/fixtures/codex/home/.codex "$DEMO/codex"
```

```powershell
$demo = Join-Path ([IO.Path]::GetTempPath()) ("openteleport-v02-demo-" + [guid]::NewGuid())
New-Item -ItemType Directory "$demo/out" | Out-Null
$env:OPENTELEPORT_HOME = "$demo/home"
Copy-Item -Recurse test/fixtures/hermes/home "$demo/hermes"
Copy-Item -Recurse test/fixtures/codex/home/.codex "$demo/codex"
```

The commands below are written for bash (`$DEMO`); in PowerShell use `$demo`. The fixtures are rebuilt from documentation and source code, so the results show what OpenTeleport writes, not that the app accepts it; the table at the end of this page lists what a real run has to settle.

| Adapter | Result of a write | What you do after |
| --- | --- | --- |
| `hermes` | `done` | Restart the Hermes gateway if it is running; resume a cron job with `hermes cron resume <id>`. |
| `codex` | `done` | Use the agent in Codex as `@ada`. |
| `openbot` | `handoff` | Import `ada-openbot-import.zip` in OpenBot, under Server settings. |
| `grok-bot` | `handoff` | Follow the five steps in `ada-for-grok-bot/README.md`. |
| `letta` | `handoff` | Run `ada-letta-memory/letta-commands.sh` (or `.ps1`) and give it the agent id. |

### Hermes: a named profile, `done`

```bash
node dist/cli.js move --from folder --source-dir test/fixtures/jetpack --agent ada --to hermes --target-dir "$DEMO/hermes"
```

Expected: `Outcome: done`. A new profile `$DEMO/hermes/profiles/ada/` with `SOUL.md` (persona, then instructions), `skills/web-brief/`, `memories/MEMORY.md` (the two facts), `cron/jobs.json`, `profile.yaml` and `config.yaml`. The default profile and the `reviewer` profile are not touched. The routine is in `jobs.json` with `"enabled": false` and `"state": "paused"`. Approximated: the model (Hermes holds one) and the shared `SOUL.md`; skipped: notes and the avatar. Run it again and the same profile is updated, not copied as `ada-2`, and the old `jobs.json` is kept beside the new one as `jobs.json.bak-<time>`.

### Codex: a custom agent file, `done`

```bash
node dist/cli.js move --from folder --source-dir test/fixtures/jetpack --agent ada --to codex --target-dir "$DEMO/codex"
```

Expected: `Outcome: done`. A new `$DEMO/codex/agents/ada.toml`, next to the fixture's `reviewer.toml`, and the skill in `$OPENTELEPORT_HOME/.agents/skills/web-brief/` (Codex's user skills live under the home folder, not in `CODEX_HOME`). `config.toml` and `AGENTS.md` are byte for byte what they were. Approximated: the persona and the facts, which become one `developer_instructions` text with a `# Facts` section; skipped: the routine (Codex has no format for it), notes and the avatar. Warning: the skills folder is shared by every tool that reads it.

### OpenBot: an import zip, `handoff`

```bash
node dist/cli.js move --from folder --source-dir test/fixtures/jetpack --agent ada --to openbot --target-dir "$DEMO/out"
```

Expected: `Outcome: handoff`, the file `$DEMO/out/ada-openbot-import.zip`, and a last line `Next step: Open OpenBot, go to Server settings, choose Import and pick <the zip>`. The zip holds the instructions (the persona joined to them), the skill, the routine, the facts and the avatar. Skipped: notes and the model, which the import format has no field for. The zip is also a source: `node dist/cli.js list --from openbot --source-dir "$DEMO/out/ada-openbot-import.zip"` lists `ada`, and moving it into Hermes updates the profile above in place.

### Grok Bot: a paste pack, `handoff`

```bash
node dist/cli.js move --from folder --source-dir test/fixtures/jetpack --agent ada --to grok-bot --target-dir "$DEMO/out"
```

Expected: `Outcome: handoff`, the folder `$DEMO/out/ada-for-grok-bot/` with `README.md` (the five steps), `1-paste-into-chat.md`, `2-memory.txt`, `3-routines.md` (a line such as `Create a routine named "Morning digest" that runs every weekday at 08:30 (Europe/Warsaw): ... (paused)`) and `skills/web-brief/`. Approximated: the persona, instructions and facts, which are pasted into the chat; skipped: notes, the avatar and the model. Warnings: Grok Bot keeps one set of skills for the whole account, and the format of its memory import is a guess. Reading goes the other way, from the zip the OpenBot export skill makes: `node dist/cli.js list --from grok-bot --source-dir "$DEMO/out/ada-openbot-import.zip"` (the zip from the OpenBot scenario has the same shape) lists `ada`.

### Letta Code: memory folder and script, `handoff`

```bash
node dist/cli.js move --from folder --source-dir test/fixtures/jetpack --agent ada --to letta --target-dir "$DEMO/out"
```

Expected: `Outcome: handoff`, the folder `$DEMO/out/ada-letta-memory/` with `memory/` (`MEMORY.md`, `persona.md`, `instructions.md`, `human.md`, `reference/`, `skills/`), `routines/morning-digest.txt`, `letta-commands.sh` and `letta-commands.ps1`, and a last line telling you to run the script. The script runs `letta agents create --name "Ada" ... --model "anthropic/claude-opus-5-5"`, asks for the id it printed, runs `letta memory restore --agent "$AGENT_ID" --from <memory folder> --force`, and holds the `letta cron add` line for the routine commented out, because routines move disabled. Approximated: the model handle, the instructions (kept in `instructions.md`, not the system prompt) and the routine's time zone. Warnings: `memory restore` replaces the new agent's whole memory, and restoring from a plain folder is unverified. Reading works on the Letta fixture: `node dist/cli.js list --from letta --source-dir test/fixtures/letta/home/.letta` lists a local agent and a Cloud agent.

Delete the temporary folder when you are done.

## Running the end-to-end test

`test/e2e/roundtrip.test.ts` runs the round trip on the real OpenClaw. Without `OPENTELEPORT_E2E=1` its tests are skipped: `npm test` lists the file as skipped and never starts OpenClaw.

Prerequisites: Node.js 24+, `npm ci`, `npm run build` (the test runs `dist/cli.js`), and `openclaw` on `PATH`. Claude Code is optional: the adapter reads its files, and only its version is recorded.

```bash
npm run build
OPENTELEPORT_E2E=1 npx vitest run test/e2e
```

```powershell
npm run build
$env:OPENTELEPORT_E2E = "1"; npx vitest run test/e2e; Remove-Item Env:OPENTELEPORT_E2E
```

What it does, all in one temporary folder:

1. Copies the Claude Code fixture project, puts its memory under a temporary `CLAUDE_CONFIG_DIR`, and points `OPENTELEPORT_HOME`, `HOME` and `USERPROFILE` of every command it starts at a temporary home, so nothing falls back to your own `~/.openclaw` or `~/.claude`.
2. Onboards a fresh OpenClaw state directory without a prompt, a model provider, a service or a channel, on a free port of its own, so no command reaches a Gateway you run:

   ```bash
   openclaw onboard --non-interactive --accept-risk --mode local --auth-choice skip \
     --workspace <state>/workspace --gateway-port <free port> --gateway-bind loopback \
     --tailscale off --skip-daemon --skip-channels --skip-skills --skip-search --skip-hooks \
     --skip-ui --skip-health --suppress-gateway-token-output --json
   ```

3. **(a)** `move --from claude-code --source-dir <project> --to openclaw --target-dir <state> --agent reviewer --keep first.jetpack`, then checks that `openclaw agents list --json` lists `reviewer`.
4. **(b)** `move --from openclaw --source-dir <state> --to folder --target-dir <tmp>/folder/reviewer --agent reviewer`, and checks for `AGENTS.md` there.
5. **(c)** `export --from folder --source-dir <tmp>/folder/reviewer --agent . --out last.jetpack`, and compares `name`, `instructions`, `facts` and the skill names of the two bundles, leaving out any part the reports of (a) and (b) list as approximated.
6. **(d)** Imports the `ada` fixture renamed to "Ada Lovelace" (OpenClaw id `ada-lovelace`, with a dash) with two routines: its cron one, and an interval one whose instruction has two lines.
   - No job may land enabled.
   - The report must not skip a routine as "cannot be passed through the Windows shim".
   - Either both jobs are listed disabled by `openclaw cron list --json --all`, or the report says to run `openclaw gateway start`.
   - With a Gateway up, both jobs must be listed, and the two-line instruction must arrive whole.
   - Finally it checks that `config set` gave `agents.entries.ada-lovelace` its model and runtime.
7. Checks that your own `openclaw.json` (`OPENCLAW_CONFIG_PATH`, else `$OPENCLAW_STATE_DIR` or `~/.openclaw`) did not change.

Optional variables:

| Variable | Effect |
| --- | --- |
| `OPENTELEPORT_E2E_GATEWAY=1` | Runs `openclaw gateway run --port <the state dir's port> --bind loopback` for the length of the test and stops it afterwards. (d) then requires both jobs to be listed, disabled, with the two-line instruction whole. The Gateway's output goes to `gateway.log` in the temporary folder, never into an error or the diagnostics, since it may print the Gateway token; errors give its exit code, line count and path (keep it with `OPENTELEPORT_E2E_KEEP=1`). |
| `OPENTELEPORT_E2E_OPENCLAW_STATE_DIR=<dir>` | Uses a state directory you onboarded yourself instead of onboarding one. Use a throwaway one: the test adds `reviewer` and `ada-lovelace` to it (a second run updates them in place). With `OPENTELEPORT_E2E_GATEWAY=1` its `gateway.port` is used. |
| `OPENTELEPORT_E2E_KEEP=1` | Keeps the temporary folder; its path is in the diagnostics. |

If `openclaw onboard --non-interactive` cannot run headless on your OpenClaw, onboard a throwaway state directory by hand, choosing local mode, no model provider, no channels, no service, and a Gateway port other than the one you use, then pass it in:

```bash
OPENCLAW_STATE_DIR="$HOME/openclaw-e2e" OPENCLAW_CONFIG_PATH="$HOME/openclaw-e2e/openclaw.json" openclaw onboard
OPENTELEPORT_E2E=1 OPENTELEPORT_E2E_OPENCLAW_STATE_DIR="$HOME/openclaw-e2e" npx vitest run test/e2e
```

Expected output: six passing tests, then the diagnostics block, which the test prints whether it passes or fails. A full run takes a few minutes, as every `openclaw` command starts a large Node program and a job command without a Gateway waits for its timeout.

```
 ✓ test/e2e/roundtrip.test.ts (6 tests)
   ✓ round trip on the installed OpenClaw and Claude Code > (a) moves reviewer from a Claude Code project into OpenClaw
   ✓ round trip on the installed OpenClaw and Claude Code > (b) moves it from OpenClaw into an agent folder
   ✓ round trip on the installed OpenClaw and Claude Code > (c) exports the folder as the bundle that left Claude Code, but for what was approximated
   ✓ round trip on the installed OpenClaw and Claude Code > (d) lands two routines in OpenClaw disabled, or says to start the Gateway
   ✓ round trip on the installed OpenClaw and Claude Code > (d) sets model and runtime of an agent whose id has a dash
   ✓ round trip on the installed OpenClaw and Claude Code > leaves the user's own OpenClaw config as it was

stdout | test/e2e/roundtrip.test.ts > round trip on the installed OpenClaw and Claude Code
OpenTeleport e2e diagnostics (sandbox <tmp>/openteleport-e2e-XXXXXX):
{ "openclawVersion": "OpenClaw 2026.5.28 (e932160)", "claudeCodeVersion": "2.1.273 (Claude Code)", ... }

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

The diagnostics hold what the real install answered: the onboarding exit code, the raw output of `openclaw agents list --json` and `openclaw cron list --json --all`, the files in the `reviewer` workspace, the three reports, the `agents` part of the sandbox `openclaw.json` (never the rest, which holds the Gateway token), and which parts (c) compared. With `OPENTELEPORT_E2E_GATEWAY=1` they also give the Gateway's exit code and log path, and whether its port closed within ten seconds of stopping it. They are what fills the table below.

## What Task 13 could not verify on this machine

The OpenClaw adapter was written against `--help` of OpenClaw 2026.5.28 and its docs; the e2e was not run while it was written, since it starts OpenClaw on the owner's machine. These are the assumptions only a real run settles. Fill in the last column from the diagnostics of the first run.

| What | What the adapter assumes | Where the e2e shows it | Observed |
| --- | --- | --- | --- |
| JSON of `openclaw cron list --json --all` | Jobs as a bare array or under `jobs` or `automations`, each `{ id, name, agentId, disabled, schedule, payload: { message } }`; `enabled` is read when there is no `disabled`. | (d), `cronList` | _to fill_ |
| JSON of `openclaw cron add ... --json` | The new job's id as `id`, `job.id` or `automation.id`; `--disabled` creates the job disabled. | (d) with `OPENTELEPORT_E2E_GATEWAY=1`, `reportD` | _to fill_ |
| Routines that need the Gateway | Without a running Gateway, `cron add` fails with a message that names the Gateway, so the routine is skipped and the report says `openclaw gateway start`. With one, the jobs are created. | (d), `reportD`, `cronList`, `gatewayUp` | _to fill_ |
| `config set` on an id with a dash | `openclaw config set agents.entries.ada-lovelace.model anthropic/claude-opus-5-5` is accepted, and so is `--strict-json` for `runtime`. | (d), `configAgents` | _to fill_ |
| Whether `agents add` seeds `BOOTSTRAP.md` | Not assumed either way: the adapter writes `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, the skills and its marker, and leaves any other file in the workspace alone. | (a), `reviewerWorkspace` | _to fill_ |
| JSON of `openclaw agents list --json` | Rows `{ id, name?, workspace? }`, bare or under `agents`. | (a), `agentsList` | _to fill_ |
| Headless onboarding | `openclaw onboard --non-interactive` with the flags above sets up a state directory without a prompt. | `onboardExitCode` | _to fill_ |
| Where `openclaw.json` keeps agents | Under `agents.entries.<id>`, each with `workspace`, `identity`, `model`, `runtime` and `skills`; the workspace path is worked out from there. If `agents add` records agents elsewhere (a list, say), reading them back in (b) and the config check in (d) break. | (b), (d), `configAgents` | _to fill_ |
| The Windows `.cmd` shim and multi-line routines | The adapter reads the npm `openclaw.cmd` shim and runs the script it names with this node, so a routine instruction with a line break arrives whole. When the shim cannot be read, that routine is skipped as "cannot be passed through the Windows shim" rather than cut. | (d): its interval routine has two lines; the skip fails the test, and with a Gateway the listed job must hold both lines. | _to fill_ |
| The OpenClaw half of `scripts/demo.sh` and `scripts/demo.ps1` | Onboarding with the flags above, the five moves into OpenClaw, `openclaw agents list` on the throwaway install, and the move back into a folder all run. Only the part before onboarding was tried (setup, `list`, an `export`, `openclaw --version`). | Not in the e2e: run both scripts once. | _to fill_ |
| Stopping `openclaw gateway run` on Windows | Killing the node process the test started stops the Gateway. A process the Gateway started itself could outlive it. | `OPENTELEPORT_E2E_GATEWAY=1`, `gatewayPortClosedAfterStop`; after the run, also look for a `node` process left from the sandbox. | _to fill_ |
| Hermes: `cron/jobs.json`, the bundled-skills manifest and the profile | A named profile `profiles/<name>/` with `SOUL.md`, `profile.yaml` and `config.yaml` is one Hermes lists and can select. Its `cron/jobs.json` is `{ "jobs": [...], "updated_at" }` with Hermes's own job fields, each job `enabled: false`, `state: "paused"`, `next_run_at: null`, and `hermes cron resume <id>` starts it. `skills/.bundled_manifest` holds `name` or `name:hash` lines. | Not in the e2e: run the Hermes scenario against a throwaway `HERMES_HOME` and look at `hermes cron list`. | _to fill_ |
| Codex: the agent file and the skills folder | `agents/<name>.toml` with `name`, `description`, `developer_instructions` and `model` is listed and usable as `@<name>` with `agents.enabled` on. `~/.agents/skills/<name>/SKILL.md` is where Codex reads user skills. | Not in the e2e: run the Codex scenario against a throwaway `CODEX_HOME`. | _to fill_ |
| OpenBot: the database and the import zip | `<userData>/openbot.db` is at migration 47 with the four tables the reader needs (`projection_agents`, `projection_agent_memories`, `projection_agent_routines`, `projection_routine_triggers`). Server settings, Import accepts the zip the adapter writes, including the `x-openteleport` key in its manifest, which OpenBot's manifest decoder does not read (read from its source, not tried). | Not in the e2e: `list --from openbot` on a copy of a real database, and the OpenBot scenario's zip imported by hand. | _to fill_ |
| Grok Bot: the export zip and the paste pack | The zip the OpenBot export skill makes is an `openbot-agent-import` v1 archive (`source.app`, `agents[].key`). Pasting `1-paste-into-chat.md` makes a Bot adopt the persona and instructions, and Settings, General, Import takes `2-memory.txt` as plain text, one fact per line. | Not in the e2e: `list --from grok-bot` on a real export, then the Grok Bot scenario's pack pasted into a new Bot. | _to fill_ |
| Letta Code: the commands and the files | `letta agents create --name --description --model` prints an agent id. `letta memory restore --agent <id> --from <folder> --force` accepts a plain memory folder that `letta memory backup` did not make. `letta cron add --prompt --cron --agent` takes the options the script uses. The reader's shapes (`lc-local-backend/agents/<id>.json`, `agents/<id>/memory/`, `crons.json`) match a real `~/.letta`. | Not in the e2e: `list --from letta` on a real `~/.letta`, then the Letta scenario's script with a real `letta`. | _to fill_ |

The last five rows came with v0.2. Their fixtures were rebuilt from documentation and source code, not recorded from an install, so nothing here shows that the apps accept what the adapters write; fill the last column after running the scenarios above against the real app.

Versions of the passing run: OpenClaw _to fill_, Claude Code _to fill_.
