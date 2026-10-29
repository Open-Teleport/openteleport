# OpenClaw plugin (v0.4 source)

This private source package (repository tag v0.4.0) registers openclaw teleport list/export/import.
It uses the public OpenTeleport library. The package is not published.

Build OpenTeleport at the repository root, then install this plugin's local dependencies:

    npm ci
    npm run build
    npm install --prefix plugins/openclaw --ignore-scripts
    openclaw plugins install --link ./plugins/openclaw

Follow OpenClaw's plugin activation/source-approval flow for your selected profile.
The file:../.. dependency intentionally uses this checkout for source installation.
Before publishing a standalone plugin, replace it with a pinned, released OpenTeleport version
containing the required adapters, remove private, and retest the packaged install.

    openclaw teleport --help
    openclaw teleport list
    openclaw teleport export reviewer --out ./reviewer.jetpack
    openclaw teleport import ./reviewer.jetpack --copy

These explicit shell commands execute operations immediately. Use the v0.3 MCP interface when you
want a conversational preview/apply workflow. The plugin does not register chat commands or model tools.
Import defaults to update, excluded files and disabled routines. Replace is unavailable.
Export refuses an existing archive. Every result is JSON with the complete report; handoff and nextStep
remain visible. Successful exports and imports also save a JSON report under
<OPENTELEPORT_HOME or user home>/.openteleport/reports/openclaw-<UUID>.json. The result includes
reportPath and reportSaved. Reports are created exclusively and do not overwrite earlier results.
If saving fails after the transfer, reportSaved is false and the printed result includes a warning;
the successful transfer is not reported as failed. Save that output rather than repeating the transfer.
Reports contain operation metadata and approximations, not a copy of the agent's instructions or memory.
They may still contain private names and paths. These are completion reports, not backups or rollback;
an interrupted operation may have no report.

OpenTeleport uses the selected instance's environment, including OPENCLAW_STATE_DIR and
OPENCLAW_CONFIG_PATH. The wrapper does not force a state directory or substitute workspaceDir for HOME.
Relative paths resolve against the invoking shell's cwd. The adapter may invoke the OpenClaw CLI and
needs the Gateway for operations involving routines. No subprocess or application operation runs during
plugin import, discovery, registration, or help.

Registration uses a plugin-owned root because attaching to agents is not reliably discovered in the
researched host. A conflicting teleport root fails explicitly. See docs/integrations/native-plugins.md
for the tested host versions and the remaining runtime limits.

## Transfer without structured memory

Add `--no-memory` to `teleport export` or `teleport import` to omit facts and notes.
Memory is included by default. Reports list the excluded counts. This does not anonymize
instructions, persona, skills, routines, files or metadata. Updating without memory may remove
previously imported destination memory; use `--copy` to keep the existing agent.
