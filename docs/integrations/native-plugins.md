# Native host plugins (v0.4)

Source packages live in plugins/openclaw and plugins/hermes. They expose a plugin-owned
teleport root with list/export/import commands. Both reuse OpenTeleport's engine and report contract;
neither changes adapter serialization. Installation is explicit and profile-specific.

The native CLI commands execute immediately when invoked. They are not chat slash commands or model
tools. Use openteleport mcp from v0.3 for conversational previews and host-approved apply calls.
Plugin discovery/help must not invoke application APIs, spawn OpenTeleport, install packages, or migrate data.

## Runtime contracts

OpenClaw calls the public JavaScript library lazily inside command handlers. It preserves the host's
state/config environment, uses shell cwd for relative paths, and prints the entire result as JSON.
It does not add a state-ownership lock around child OpenClaw calls. Its development package has a
local OpenTeleport dependency until a suitable version is published.

Hermes invokes an explicitly configured local Node/CLI path using Python subprocess argv arrays.
It uses the host's root/profile helpers to choose the source agent and import base. It preserves JSON
reports, stderr and nonzero status, and rejects missing Node/CLI, old Node, invalid output and timeout.
The wrapper does not run a package installer or interpolate a shell command.

Both interfaces expose copy/update, not replace. Files and enabled routines require explicit flags.
The source remains unchanged. A successful command can return handoff; always follow nextStep.
A secret scanner is not a guarantee that personal memory is safe to share.

## Verification boundaries

The accompanying automated tests cover registration without side effects, command collisions,
argv construction, profile mapping, core-engine round trips, disabled-routine options, handoffs,
malformed output and failures in disposable homes. Host-specific smoke results are recorded in
the PR; do not infer a tested host range from the earlier source research.

OpenClaw adapters still need the host CLI and may need a running Gateway. Registration/help and a
no-routine export do not establish correctness of Gateway-backed imports or routine execution.
Hermes tests use synthetic profile contents and do not invoke a language model or resume a scheduler.

Installation details: plugins/openclaw/README.md and plugins/hermes/README.md.
These are development integrations, not published plugin releases. Release numbers remain aligned
with the repository package pending the owner's release process. SSH, signatures and Letta Cloud
remain separate future work.

The test suite requires Python >=3.11 for the Hermes bridge contract tests; CI installs it explicitly.

## Local host checks (2026-10-29)

- Hermes 0.13.0: the actual executable loaded the directory plugin in a synthetic named profile; help, list, export and copy-import passed. The copy landed beside the original profile under the base, not inside it. No model or scheduler was started.
- OpenClaw 2026.5.28: the actual CLI discovered the plugin root; help, list and export passed in an isolated configuration. Importing the Hermes-produced bundle with copy created reviewer-2 beside reviewer, preserving persona and one memory fact. The export reported that routines were not read because the test Gateway was unavailable. These probes used NODE_DISABLE_COMPILE_CACHE=1 after initial cold-start timeouts.
- Full local suite: 2641 passed, 12 skipped, including the Python bridge tests invoked by Vitest. Typecheck/build passed. The v0.3 PR also passed CI on Linux, macOS and Windows.
