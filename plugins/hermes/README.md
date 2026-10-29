# Hermes directory plugin (v0.4 source)

Build OpenTeleport once with Node >=24. Set OPENTELEPORT_CLI to its absolute dist/cli.js path.
Set OPENTELEPORT_NODE to an absolute Node executable if node is not on Hermes's PATH.

Copy this directory's plugin.yaml and __init__.py into the selected profile's
<HERMES_HOME>/plugins/openteleport directory, then enable it with:

    hermes plugins enable openteleport

Installation/enabling is profile-specific. This is a directory plugin, not a pip package.
It does not install Node or OpenTeleport. The plugin is not available in a different profile merely
because it was enabled in the default one.

    hermes teleport --help
    hermes teleport list
    hermes teleport export --out ./reviewer.jetpack
    hermes teleport export --agent reviewer --out ./reviewer.jetpack
    hermes teleport import ./reviewer.jetpack --copy

Export without --agent uses the active profile. Import targets a named profile under the base
Hermes home, not profiles nested inside the active profile. Default profile data remains in place.
The bridge resolves that distinction through Hermes's own public constants helpers.

Commands execute immediately, with OpenTeleport CLI semantics. For conversational preview and approval
use the v0.3 MCP server. Import defaults to update; files are excluded and routines disabled.
Replace is not exposed. Export refuses an existing archive, including one created during the export.
The CLI first writes into a private temporary directory; only a successful export is copied to the
requested path with exclusive creation. A failed or interrupted final copy may leave a partial new
file: inspect it before retrying. Export also saves <archive>.report.md without overwriting an existing
report. If saving that report fails, the completed archive remains successful and the JSON result
includes a warning. Import keeps the CLI's normal Markdown report behavior.

Registration/help do not spawn a process. Operations use a fixed local Node/CLI path, argv arrays,
shell=False, an explicit cwd, copied environment, and bounded timeouts. Nonzero child exit status and
JSON reports (including handoff/nextStep) are retained. Invalid JSON and timeout are errors; they do not
mean a partially completed import can be retried safely.

See docs/integrations/native-plugins.md for tested versions and limits.

## Transfer without structured memory

Add `--no-memory` to `teleport export` or `teleport import` to omit facts and notes.
Memory is included by default. Reports list the excluded counts. This does not anonymize
instructions, persona, skills, routines, files or metadata. Updating without memory may remove
previously imported destination memory; use `--copy` to keep the existing agent.
