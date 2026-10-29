# Session integration (v0.3)

This is source for the next release, not a claim that an npm v0.3 package has been published.
Build this checkout with Node >=24 using npm ci and npm run build.

Run the server with:

    node /absolute/path/to/openteleport/dist/cli.js mcp

The same package supplies the CLI and MCP server. The transport is local stdio only.
The server fixes its working directory and environment at startup. Relative paths use that directory.
For clients that start in another directory, supply absolute sourceDir, targetDir, path and out values.

## Tools and write boundary

- openteleport_adapters: supported apps, capabilities, installation detection.
- openteleport_list: source agent IDs.
- openteleport_inspect: bundle metadata and counts, without memory or instruction text.
- openteleport_validate: format checks and secret findings (locations, not values).
- openteleport_export, openteleport_import, openteleport_move: prepare an in-memory source snapshot and return a planId. These are previews, not immediate writes.
- openteleport_apply: apply the reviewed plan with confirmed: true.
- openteleport_cancel: discard a plan.

Present the plan to the user before apply. Configure your client's approval policy to require approval for
openteleport_apply. The boolean and opaque plan ID are not authentication: a model can supply both.
Only trusted local clients should launch the server; it has the launching user's filesystem permissions.
Do not expose this stdio process as an unauthenticated remote service.

Plans last ten minutes, are limited to eight per session and 32 MiB of serialized content each, and are
lost on server restart. Pending reads reserve a slot before accessing the source. Expiry timers release
snapshots even while idle; closing the transport clears retained plans. An already-started write continues
and must be inspected if its client disconnects. Apply consumes a plan before execution, including on failure; writes are serialized.
A source edited after preview does not change the reviewed snapshot. The destination is not reserved:
conflicts are checked at execution, and adapter writes are not transactional. Inspect partial results before
retrying a failed operation. There is no automatic rollback or exact file-diff preview.

Only update and copy are available. Replace is rejected. Files are excluded and routines disabled by
default. The source is never deleted. Export refuses an existing destination, including one created after
preview. A handoff is returned as such, with nextStep. Successful transfers return the complete report and
save a Markdown copy under OPENTELEPORT_HOME/.openteleport/reports (home by default).

The secret scanner is heuristic. Personal memory is not automatically anonymized. Previews summarize
capability losses; additional adapter approximations and skips are reported after application.

## Client configuration

Use the absolute Node executable path if your client does not inherit PATH. Install/build once; the
examples do not run npx or download dependencies on session startup.

Claude Code:

    claude mcp add --transport stdio openteleport -- node /absolute/path/to/dist/cli.js mcp

Codex config.toml:

    [mcp_servers.openteleport]
    command = "node"
    args = ["/absolute/path/to/dist/cli.js", "mcp"]

Hermes config.yaml:

    mcp_servers:
      openteleport:
        command: node
        args: ["/absolute/path/to/dist/cli.js", "mcp"]

For OpenClaw, use its supported MCP bridge/client configuration for your installed version with this same
command and argv. Do not assume a universal top-level mcpServers key: OpenClaw MCP integration depends
on the host version and installed bridge. The native OpenClaw CLI plugin is documented separately in v0.4.

The CLI environment variable OPENTELEPORT_EXTRA_ADAPTER remains supported for explicitly installed
local adapters and isolated tests. It loads executable code; configure it only with a trusted module.
OPENTELEPORT_HOME redirects application lookup/report identity context for tests; isolate application-specific
environment variables too when running against disposable homes.

## Claude Code plugin

Set OPENTELEPORT_CLI to the absolute path of this build's dist/cli.js, then launch Claude Code.
For local testing:

    claude --plugin-dir /absolute/path/to/openteleport/plugins/claude-code

After this branch is merged, the repository marketplace can be added:

    /plugin marketplace add Open-Teleport/openteleport
    /plugin install openteleport@openteleport

The plugin provides its MCP configuration, the openteleport skill, and the namespaced
/openteleport:openteleport command. No personal Claude configuration is changed by the build.
Do not configure the same server both manually and through the plugin unless you want duplicate tools.
The launcher uses the current Node executable and a configured absolute CLI path, with no shell.

## Scope decisions

The original draft proposed immediate export/import/move tools. These now prepare previews, with a separate
apply operation. Optional move keep is deferred: exporting a second artifact has its own reviewed plan.
The public core engine still performs serialization, scanning, conflict handling and transfers.
MCP uses the official v2 SDK, pinned in package.json/lockfile, rather than the maintenance-only v1 package.
