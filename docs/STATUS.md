# Project status

Last updated: 2026-11-03. This page says what exists, what is verified, and what comes next, so a new contributor can pick up work without reading the whole history.

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

- **Five adapters**, all read and write, each with fixtures reproduced from documentation and source code, not recorded from an install. Hermes, Codex and OpenBot have since been checked on real installs (see "What is verified").
  - `hermes`: profiles (the Hermes home and `profiles/*`), `SOUL.md`, skills, memory entries, `cron/jobs.json` (written paused). Result: `done`.
  - `codex`: the global setup and the custom agents in `agents/*.toml`; a write makes a custom agent file and puts its skills in `~/.agents/skills`. Result: `done`.
  - `openbot`: reads a copy of `openbot.db` (with the agent's skills from its workspace) or an export zip; writes an `openbot-agent-import` zip. Result: `handoff` (import the zip on the server's Import page, Grok Bot entry).
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

- **Hermes** (0.13.0): import, same-id update, copy and export through the engine, with Hermes's own code reading the result back. It recovered the facts, the skill, the three routines (all paused, none run) and both profiles, and `skills/.bundled_manifest` has `name:hash` lines. Two edge cases came out of it, both fixed in the adapter and not yet rechecked on an install:
  - A one-off time without an offset (`once.run_at`, as a hand-written job has it) is read by Hermes in the machine's time zone, not the profile's. The adapter now reads it the same way and warns about the assumption; cron expressions keep the profile's zone.
  - With no `HERMES_HOME`, Hermes falls back to `~/.hermes` on every system, Windows included. On Windows the adapter now takes `~/.hermes` when it holds a profile, else `%LOCALAPPDATA%\hermes` (where the installer puts it).
- **OpenClaw** (2026.5.28 and 2026.10.8, Windows): the end-to-end round trip passed on 2026.10.8 with the Gateway running: a Claude Code project into OpenClaw, back out into a folder, exported as the bundle that left, and two routines landed disabled with a two-line instruction whole. The first run, on 2026.5.28, found two wrong assumptions, fixed since: that version keeps the roster in `agents.list` (an array) and rejects `agents.entries`, which newer versions use, and its `agents list --json` names the workspace `location`. The adapter now reads both forms and sets model and runtime at the path the install keeps the agent under. The no-Gateway path also passed 6/6 on 2026-10-30; routine creation was explicitly skipped with a Gateway-start warning. The demo-script check is recorded separately.
- **OpenBot** (0.58.0, Windows, 2026-11-02): both ways. The import zip went in through the server's Import page (Grok Bot entry) with the skill, the routine, the facts and the avatar; a Hermes profile folder that OpenTeleport wrote went in through the Hermes Agent entry; and `export --from openbot` on a copy of the database returned the instructions, the routine (schedule kept), the facts and, with the 0.4.3 reader, the skill from the workspace. The database is at migration 49 and the warning about a newer schema fired. Two fixes came out of it: the persona layout and the workspace skills (PRs #35 and #36).
- **Folder, as Cursor, Gemini CLI and Cline open it** (2026-11-03, Windows): a folder written with `--to folder` showed its skill in Cursor 3.27.22 (Customize, Skills, under the workspace) and its `AGENTS.md` under Rules; `gemini skills list` (Gemini CLI 0.66.0) and `cline skill list` (the `skills` CLI Cline 3.0.74 forwards to) both listed the skill, from `.agents/skills/`. Update safeguards were also tested with isolated fixtures: same-name foreign or edited skills block the update, edited stale mirrors stay, and linked tool-skill roots are not read or written through. Before this check none of the three saw `skills/`, which is why the adapter now mirrors the skills there and writes the `GEMINI.md` import. Not checked: a model turn in any of the three (each needs a signed-in account), and Gemini CLI's loading of `AGENTS.md` through the `GEMINI.md` import (its docs say `@file` imports are followed; the session did not get past the sign-in prompt).
- **Codex** (0.166.0-alpha.5.1, Windows, 2026-11-03): isolated import/discovery, `agents.enabled` on/off, distinct copied names and associated-skill re-export passed. In an explicitly authorized native-directory follow-up, the imported role was discovered without a registration override, executed its instructions and fact, read the imported shared-user skill (exit 0) and returned its proof phrase. The runtime reported the role model `gpt-6.1-sol` while the parent used `gpt-6-astra`. Both temporary files were removed and `config.toml` stayed byte-identical. UI-specific invocation and generated-memory filenames remain unverified. See [the runtime report](superpowers/research/2026-11-03-codex-runtime-check.md).

## Letta local-backend verification

Letta Code 0.34.39 was checked on Node 24.22.1 in a Linux container disconnected from the network. The full generated Bash handoff restored memory with working Git history; native memory export and OpenTeleport re-export retained facts and skills. Local agent JSON filenames are base64url encoded, while memory directories use the record ID. Cron creation requires a description; the corrected command and real `crons.json` schema were checked without executing a task. The adapter remains `handoff`, and routines remain commented out by default. See [the scoped report](superpowers/research/2026-11-03-letta-runtime-check.md).

## Claude Code repository memory

On 2026-11-03, native Claude Code 2.1.273 loaded the main repository's auto-memory fact from the main checkout, a subfolder, a linked worktree and a worktree subfolder. A plain folder used its own memory. After importing with the corrected adapter, the imported fact appeared in the native CLI's outgoing prompt in all five layouts. A loopback endpoint recorded the synthetic prompt and deliberately rejected it before model execution; no credentials were copied or real model requests made. The adapter keeps agent identity sidecars per checkout, honors the valid project-key environment override and refuses Git lookup failures before writes. See [the scoped report](superpowers/research/2026-11-03-claude-worktree-memory.md).

## Codex fixes

PR #4 fixes duplicate runtime names on copies and preserves associated imported skills on re-export. Regression tests cover both. The 2026-11-03 check also verified distinct names in installed Codex discovery and skill re-export. The authorized follow-up also verified live instruction/fact use, shared-skill execution and the configured child model. UI invocation and generated memories remain outside this check.

## Permission rules (2026-11-03, unreleased)

`policy` in the manifest, the `## Permissions` text fallback and the per-rule report are covered by unit tests and adapter fixtures only (`test/core/policy.test.ts`, `test/core/engine.test.ts`, the adapter tests). No real app has been checked for them yet: whether Claude Code honours a written `permissionMode`/`disallowedTools`, whether OpenClaw accepts the written `tools.allow`/`tools.deny` on an agent entry, and whether Codex loads `features.shell_tool = false` from an agent file are the next things to verify on real installs. The mapping tables are in the design, `superpowers/specs/2026-11-03-permission-rules-design.md`.

## SSH transport (2026-11-03, unreleased)

`--from <app>@<host>` and `--to <app>@<host>` in `move`, `export`, `import` and `list` run `npx -y openteleport@<local version>` on the host over plain `ssh`, with the `.jetpack` streamed over stdin (to a remote target) or stdout (from a remote source); the design is `superpowers/specs/2026-11-03-ssh-transport-design.md`. **Verified only against a fake `ssh`**: the suite (`test/commands/ssh.test.ts`) puts a fake `ssh` on the sandbox `PATH` that runs the built CLI as the "remote" in another home folder, so the archive really crosses the pipe and the remote's JSON report really comes back, and `test/commands/remote.test.ts` covers the `<app>@<host>` parser, the POSIX quoting, the version pin and the error mapping (exit 3 for no `npx`, exit 1 for an unreachable host, the remote's own code for its `--json` errors). **Not verified**: any real ssh server, a real `npx` download on a remote, password or key prompts, and Windows OpenSSH as the local client. Also note that the remote runs the pinned version from npm, so the transport only works once a release with `import -` and `export --out -` is published.

## What is not verified yet

Open verification issues include Grok Bot #17 and Codex roles #20 (labelled help wanted). Letta #18 is closed by PR #47 after the scoped local-backend checks passed. Settled since: #21, #23, #24 by PRs #26 to #30; #19 (Hermes cron) by #32; #22 (the demo scripts) by #33; #16 (OpenBot) by #35 and #36. Closing an issue records the scoped check; the remaining cases below are still unverified.

- OpenClaw versions other than 2026.5.28 (partial round trip and manual checks), 2026.10.8 (full round trip on Windows and Linux) and 2026.10.9 and 2026.10.10 (full Linux compatibility matrix, Gateway on/off).
- Claude Code custom `autoMemoryDirectory` settings and remote-memory overrides remain outside the adapter's default/local memory resolution.
- **Remaining adapter checks.** Initial fixtures were rebuilt from documentation and source code. The real-install checks above cover only the recorded scenarios; a verifier should still check:
  - **Hermes** (the rest of it): the scheduler running a resumed job (`hermes cron list --all` and `hermes cron resume` were checked on 2026-11-01, see `docs/demo.md`), and the two edge cases above on the fixed code, with `HERMES_HOME` unset and with a hand-written offset-free `once` job.
  - **Codex** (the rest of it): UI-specific invocation (do not assume `@<name>` is special syntax) and generated memory filenames (`memories/` was still empty). Named-role spawning, `agents.enabled`, the actual child model and shared-user-skill execution were verified on 2026-11-03.
  - **Grok Bot**: a genuine export ZIP and live memory persistence remain unverified. Inspection of installed 0.78.1 confirms Add to Memory takes pasted text and asks a Bot to save shared user memory, rather than importing a file directly. [Report and UI-test blocker](superpowers/research/2026-11-03-grok-memory-import.md).
  - **Letta Code**: Cloud backend, live model behavior and execution of the PowerShell handoff remain unverified. The local-backend Bash handoff, restore, create JSON, cron schema, list/read and facts/skill round trip passed on 0.34.39; see [the report](superpowers/research/2026-11-03-letta-runtime-check.md).

## Fixes shipped in 0.4.2

PRs #26–#29 fix invalid Codex TOML overwrites, excluded oversized folder attachments (including CLI move), wizard missing-source exit codes, shared memory note naming and cancellation-test deadlines. The combined build passed 2,738 tests (12 skipped) and fresh-install package verification. Real-install follow-up results belong in `docs/demo.md`; unit and package tests do not replace them.

## What comes next

1. Run the pilot in `docs/integrations/pilot.md` across technical users, personal assistants and teams.
2. Verify remaining adapter assumptions on real installations.
3. An Ed25519 signature in the manifest (the field is reserved).
4. Letta Cloud over REST, once its authorization header and `agents.update` are checked on a real account.
5. Automating the remaining manual import steps before promoting `letta` or `openbot` from `handoff` to `done`; real-install verification alone does not remove a handoff. Add Codex automations once Codex documents a format.
7. The [nightly compatibility workflow](../.github/workflows/compatibility.yml) exercises OpenClaw 2026.10.8 and npm latest, with and without a Gateway, at 03:23 Europe/Warsaw. The first [four-job run](https://github.com/Open-Teleport/openteleport/actions/runs/41562041947) passed for 2026.10.8 and latest resolved to 2026.10.9. The first scheduled run caught 2026.10.10's new provider-auth preflight; [PR #46](https://github.com/Open-Teleport/openteleport/pull/46) supplies synthetic loopback-only providers and the [four-job retest](https://github.com/Open-Teleport/openteleport/actions/runs/41645003736) passed without model requests. Review failures before changing the pinned baseline; the workflow does not establish model-turn compatibility. Run the end-to-end test on each additional OpenClaw release the adapter claims. Both demo scripts have passed on Windows (PowerShell on 2026-10-30; Git Bash on 2026-11-01); repeat them when relevant behavior changes.

## Release

**[OpenTeleport 0.4.6](https://www.npmjs.com/package/openteleport/v/0.4.6) is the current npm `latest`, verified on 2026-11-03.** [PR #47](https://github.com/Open-Teleport/openteleport/pull/47) fixes the Letta local-backend handoff; [PR #48](https://github.com/Open-Teleport/openteleport/pull/48) clarifies Grok memory import and aligns release versions. [Release workflow 41648568429](https://github.com/Open-Teleport/openteleport/actions/runs/41648568429) published with provenance from `43f741457a3cf6f3552fb06d8493fe5fe4a04024`, matching registry `gitHead`. Fresh-cache installation passed CLI, folder/mirror safeguards, source preservation and Claude Code shared worktree memory checks. The public npm package also passed the generated Bash handoff, native memory export, facts/skills round trip and never-fired cron schema check with Letta Code 0.34.39 in a disconnected Linux container. CI passed on Linux, macOS and Windows; production returned HTTP 200 and version 0.4.6. See [release evidence](superpowers/research/2026-11-03-release-0.4.6-evidence.json), [Letta evidence](superpowers/research/2026-11-03-letta-published-0.4.6-evidence.json) and [release notes](https://github.com/Open-Teleport/openteleport/releases/tag/v0.4.6).

**[OpenTeleport 0.4.5](https://www.npmjs.com/package/openteleport/v/0.4.5) was verified as npm `latest` before 0.4.6 on 2026-11-03.** [PR #43](https://github.com/Open-Teleport/openteleport/pull/43) adds nightly compatibility checks; [PR #44](https://github.com/Open-Teleport/openteleport/pull/44) fixes shared Claude Code memory and synchronizes release versions. [Release workflow 41564702826](https://github.com/Open-Teleport/openteleport/actions/runs/41564702826) published successfully with provenance. The registry's `gitHead`, `4f587c6c314e3355c9a6ca5a9eec9ce022cd77de`, matches the release tag. A fresh-cache public-package installation passed folder export/import, mirror safeguards and source preservation, plus memory import into a linked worktree and re-export from the shared repository location. Production `openteleport.dev` returned HTTP 200 and version 0.4.5. The final local suite passed 2772 tests (12 skipped), with CI green on Linux, macOS and Windows. See the [sanitized verification record](superpowers/research/2026-11-03-release-0.4.5-evidence.json) and [release notes](https://github.com/Open-Teleport/openteleport/releases/tag/v0.4.5).

**[OpenTeleport 0.4.4](https://www.npmjs.com/package/openteleport/v/0.4.4) was verified as npm `latest` before 0.4.5 on 2026-11-03.** [PR #40](https://github.com/Open-Teleport/openteleport/pull/40) adds folder skill discovery and safeguards; [PR #41](https://github.com/Open-Teleport/openteleport/pull/41) synchronizes the release versions. [Release workflow 41557884961](https://github.com/Open-Teleport/openteleport/actions/runs/41557884961) published successfully with provenance. The registry's `gitHead`, `7f8bccd587bbd227caa7c806de6b7afe61e559b7`, matches the tagged main commit. A fresh-cache installation outside the repository passed CLI version, folder export/import, skill mirror, Gemini import stub, edited-skill conflict protection and source-preservation checks. Production `openteleport.dev` returned HTTP 200 and version 0.4.4. See the [sanitized verification record](superpowers/research/2026-11-03-release-0.4.4-evidence.json) and [release notes](https://github.com/Open-Teleport/openteleport/releases/tag/v0.4.4). These synthetic checks do not add model-turn evidence for Cursor, Gemini CLI or Cline.

Historical 0.4.3 publication snapshot (2026-11-03):

[OpenTeleport 0.4.2](https://www.npmjs.com/package/openteleport/v/0.4.2) was published on 2026-10-30 from `c7237a0` by [Release workflow 41089960970](https://github.com/Open-Teleport/openteleport/actions/runs/41089960970). [OpenTeleport 0.4.3](https://www.npmjs.com/package/openteleport/v/0.4.3) was verified as npm `latest` before 0.4.4 on 2026-11-03. [PR #36](https://github.com/Open-Teleport/openteleport/pull/36) was merged and [Release workflow 41549200654](https://github.com/Open-Teleport/openteleport/actions/runs/41549200654) published successfully with provenance. The registry reports `gitHead` `f514022c4f710b9c00906eed46e623a7c2d10683`, matching the release commit. The production website served version 0.4.3 at that check. A fresh-cache install of the public 0.4.3 package passed the package verifier on 2026-11-03: CLI version, public API, MCP preview/apply, archive round trip, capability-loss reporting, manual handoff, source preservation and operation receipts. This uses synthetic data and does not expand the real-application verification above.

The owner chose to skip a separate 0.1.0 and ship 0.2.0 directly. [OpenTeleport 0.2.0](https://www.npmjs.com/package/openteleport/v/0.2.0) was published on 2026-10-29 as the first public version.

The `v0.2.0` tag points to commit `ee4371a52a40cd6f85533344067601c45dc53cac`. [Release workflow 40862578050](https://github.com/Open-Teleport/openteleport/actions/runs/40862578050) checked the version, linted, built, tested and published the package with provenance. npm briefly returned the prior staging version while processing the accepted publication; the public registry now serves 0.2.0.

A fresh-cache check outside the repository ran `npx openteleport@0.2.0 --version`, exported a synthetic folder agent, imported the resulting archive into a fresh folder, and verified that the instructions were preserved. This checks the published CLI path; it does not establish real-application behavior for every adapter.

Users with Node.js 24+ can start with `npx openteleport`. [OpenTeleport 0.4.1](https://www.npmjs.com/package/openteleport/v/0.4.1) was published on 2026-10-30 by [Release workflow 40978652536](https://github.com/Open-Teleport/openteleport/actions/runs/40978652536) from the `v0.4.1` tag on `235c8bf`. It is the first version with the OpenClaw fixes from PR #12: the roster in both forms, five-minute command limits, and the verification table in `docs/demo.md` filled in. A fresh-cache `npx openteleport@0.4.1 --version` outside the repository printed `0.4.1`, and `npx openteleport@0.4.1 adapters` found OpenClaw 2026.10.8, Claude Code 2.1.273, Hermes and Codex on the machine. The 0.4.0 release combined the merged session and native plugin milestones. For current setup, follow [MCP installation](integrations/mcp.md) and [native plugin installation](integrations/native-plugins.md), keeping the CLI and source plugin versions aligned. Publication is performed by the tag-triggered Release workflow; consult the npm registry and GitHub Release for publication evidence.

The Release workflow authenticates to npm with Trusted Publishing (OpenID Connect from GitHub Actions, configured on npmjs.com for `Open-Teleport/openteleport` and `release.yml`); the workflow does not use an `NPM_TOKEN` secret.

## How decisions are recorded

### Landing and release consistency check (2026-10-30)

Historical snapshot (superseded by the release information above): on 2026-10-30 the public npm registry's `latest` metadata was checked directly: 0.4.1, gitHead `235c8bffb73d396bfcc32ae636ed832f82e19dc2`, matching the local `v0.4.1` tag. The current repository HEAD also includes the subsequent publication-status documentation. No new package publication is needed for landing/brand changes; npm does not include `site/`.

The landing's previous A/B merge omitted A's portal flight and retained B's terminal scatter. The local revision adds a portal transition in both themes, defaults to a clean light theme, adds MCP/native-plugin information, and updates SEO. The website build has its own version (0.1.0), independent of the CLI version. Brand proposals 04–07 await selection. These local changes are not evidence of a live deployment. This focused check does not revalidate the real-app limitations listed above.

- `docs/design.md` is the design authority for v0.1; the v0.2 spec in `docs/superpowers/specs/` is the authority where it differs. Changes to behaviour that contradict them get a note there.
- `docs/superpowers/plans/` holds the implementation plans; `docs/superpowers/research/` the research behind them.
- `CHANGELOG.md` lists every user-visible change per version.

## Where to ask

Open an issue with one of the templates. For a new adapter, start with the "Adapter request" template so the storage layout is agreed before code.
