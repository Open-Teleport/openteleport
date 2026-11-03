# Letta Code local-backend verification

Checked Letta Code 0.34.39 with Node 24.22.1 in a disposable Linux Docker container. No host directories or user credentials were mounted. The container network was disconnected before testing. All agents, prompts, routines and memory were synthetic; no model or scheduler was run.

## Findings and fixes

| Assumption | Real behavior | Change |
| --- | --- | --- |
| Record filename is the memory folder name | `agents/<base64url(id)>.json`; MemFS uses `memfs/<id>/memory` | Resolve the validated record ID; reject path-escaping IDs |
| Cron description is optional | `cron add` rejects a missing description | Keep a supplied description or fall back to the routine name |
| Plain memory restore is enough | Accepted, but it replaces `.git` too; `memory status` reports `Not a git repo` | Handoff initializes and commits a local memory snapshot before restoring |
| Agent creation output needs manual inspection | Valid JSON with `id`, name, model and other fields | Documented; current scripts retain their explicit ID prompt |
| Cron schema matches fixtures | Version 1 `tasks`, agent_id/name/description/prompt/status/cron/timezone/recurring fields | Confirmed by a real never-fired task and re-export |

## Completed check

The corrected build generated a Bash handoff. Running that exact script created a new native agent and restored its memory. `letta memory status` succeeded; `memory export` retained instructions, persona, human facts, skill and `.git`. `openteleport list --from letta` found the right memory directory; export to `.jetpack` and import to a folder preserved facts and the skill.

All cron commands were comments by default. One generated command was deliberately exercised separately inside the disconnected container; its description and schema were accepted, fire_count stayed zero, and OpenTeleport re-export retained its prompt. The final folder import disabled that routine.

[Machine-readable evidence](2026-11-03-letta-runtime-evidence.json). The initial public 0.4.5 package reproduced the lookup/description defects; the successful run used the corrected build. These fixes require the next patch release.

## Limits

This verifies the local backend and generated Bash handoff, not Cloud, live model recall, scheduler execution or a real PowerShell handoff. PowerShell script rendering has unit coverage. The adapter still returns `handoff`; verification does not turn it into an automatic API transfer. Imported instructions are core memory, while the native Letta system prompt takes precedence on re-export with an explicit warning. Git is required by the handoff; no remote or global user identity is configured.

Sources: [official quickstart](https://docs.letta.com/quickstart), [App Server local backend](https://docs.letta.com/self-hosting/app-server/quickstart), and the installed CLI's `agents create`, `memory` and `cron` help. The installed CLI's behavior, not help omissions, established the required cron description.
