# Native host plugins (v0.4)

Source packages live in plugins/openclaw and plugins/hermes. They expose a plugin-owned
teleport root with list/export/import commands. Both reuse OpenTeleport's engine and report contract;
neither changes adapter serialization. Installation is explicit and profile-specific.

The native CLI commands execute immediately when invoked. They are not chat slash commands or model
tools. Use openteleport mcp from the 0.4.2 npm package for conversational previews and host-approved apply calls.
Plugin discovery/help must not invoke application APIs, spawn OpenTeleport, install packages, or migrate data.

## Runtime contracts

OpenClaw calls the public JavaScript library lazily inside command handlers. It preserves the host's
state/config environment, uses shell cwd for relative paths, and prints the entire result as JSON. Successful transfers also save an exclusive JSON report under the OpenTeleport home; reportPath identifies it. A report-save failure preserves transfer success and adds a warning, rather than encouraging a retry.
It does not add a state-ownership lock around child OpenClaw calls. Its source package has a local OpenTeleport dependency. Install it from the v0.4.2
repository tag; a standalone npm plugin package is not published.

Hermes invokes an explicitly configured local Node/CLI path using Python subprocess argv arrays.
It uses the host's root/profile helpers to choose the source agent and import base. It preserves JSON
reports, stderr and nonzero status, and rejects missing Node/CLI, old Node, invalid output and timeout.
The wrapper does not run a package installer or interpolate a shell command.

Both native plugins refuse to overwrite export archives, including files created while export is
running. Hermes prepares the CLI export in temporary storage, then exclusively copies the archive
and saves a separate <archive>.report.md. A report-save failure is a warning after archive success.
An interrupted copy can leave a partial new archive; neither plugin automatically retries or rolls back.

Both interfaces expose copy/update, not replace. Files and enabled routines require explicit flags.
Both export and import accept --no-memory to exclude structured facts and notes. The report records
omitted counts. This is not anonymization: other fields may contain personal information. An update
without memory may remove previously imported destination memory; use --copy to keep the existing agent.
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
These source integrations are included in the v0.4.2 repository tag, not in the root npm archive.
Their versions match the core package. SSH, signatures and Letta Cloud
remain separate future work.

The test suite requires Python >=3.11 for the Hermes bridge contract tests; CI installs it explicitly.

## Local host checks (2026-10-29)

- Hermes 0.13.0: the actual executable loaded the directory plugin in a synthetic named profile; help, list, export and copy-import passed. The copy landed beside the original profile under the base, not inside it. No model or scheduler was started.
- OpenClaw 2026.5.28: the actual CLI discovered the plugin root; help, list and export passed in an isolated configuration. Importing the Hermes-produced bundle with copy created reviewer-2 beside reviewer, preserving persona and one memory fact. The export reported that routines were not read because the test Gateway was unavailable. These probes used NODE_DISABLE_COMPILE_CACHE=1 after initial cold-start timeouts.
- Full local suite after export collision handling: 2679 passed, 12 skipped, including 11 Python bridge tests invoked by Vitest and a real local CLI export. Typecheck/build passed. The v0.3 PR also passed CI on Linux, macOS and Windows.
