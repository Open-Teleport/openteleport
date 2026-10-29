# OpenClaw plugin (v0.4 source)

This private development package registers openclaw teleport list/export/import.
It uses the public OpenTeleport library. The package is not published.

Build OpenTeleport at the repository root, then install this plugin's local dependencies:

    npm ci
    npm run build
    npm install --prefix plugins/openclaw --ignore-scripts
    openclaw plugins install --link ./plugins/openclaw

Follow OpenClaw's plugin activation/source-approval flow for your selected profile.
The file:../.. dependency intentionally uses this checkout while the release is unpublished.
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
remain visible. Reports are printed, not also persisted by this wrapper; redirect stdout to retain one.

OpenTeleport uses the selected instance's environment, including OPENCLAW_STATE_DIR and
OPENCLAW_CONFIG_PATH. The wrapper does not force a state directory or substitute workspaceDir for HOME.
Relative paths resolve against the invoking shell's cwd. The adapter may invoke the OpenClaw CLI and
needs the Gateway for operations involving routines. No subprocess or application operation runs during
plugin import, discovery, registration, or help.

Registration uses a plugin-owned root because attaching to agents is not reliably discovered in the
researched host. A conflicting teleport root fails explicitly. See docs/integrations/native-plugins.md
for the tested host versions and the remaining runtime limits.
