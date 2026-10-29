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
- openteleport_operation_status: read an operation receipt after completion, failure or reconnecting.

Present the plan to the user before apply. Configure your client's approval policy to require approval for
openteleport_apply. The boolean and opaque plan ID are not authentication: a model can supply both.
Only trusted local clients should launch the server; it has the launching user's filesystem permissions.
Do not expose this stdio process as an unauthenticated remote service.

Plans last ten minutes, are limited to eight per session and 32 MiB of serialized content each, and are
lost on server restart. Pending reads reserve a slot before accessing the source. Expiry timers release
snapshots even while idle; closing the transport clears retained plans. An already-started write continues
and must be inspected if its client disconnects. Apply consumes a plan before execution, including on failure; writes are serialized within one server session.
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


## Interrupted transfers and operation receipts

The preview exposes operationId (the same UUID as planId). Before any destination write, apply records
a started receipt under <OpenTeleport home>/.openteleport/transfers/<operationId>.json. If that initial
record cannot be written, no destination writer is called. These receipts persist across server restarts.

Use openteleport_operation_status with operationId after a lost response. A completed receipt records
the engine outcome and saved report path. Handoff still means a manual step remains; read the report.
A not_applied receipt means the destination writer was not called. A needs_review receipt means a
destination write was attempted, not that every field was changed. Inspect before retrying.

A leftover started receipt is inconclusive. It does not prove that a process is still running, that the
destination is untouched, or that the operation failed. A connected session reports in_progress only for
its own currently active operation. Another session reports unknown and requires inspection.

Apply errors return structured recovery information without raw exception text. A consumed plan is never
replayed. If final receipt persistence fails after a successful transfer, the successful result remains
available with receiptSaved: false and a warning; save that result. Do not interpret a later inconclusive
receipt as permission to repeat the operation.

Receipts store operation metadata (agent identifiers, application names, paths and status), not prompts,
memory, skill bytes or raw exception messages. Metadata can still be private. Receipts are
local, have restrictive creation permissions where the platform supports them, and remain until removed
by the user. They are not a backup, rollback mechanism, tamper-proof audit log or power-loss transaction.
This receipt workflow currently covers MCP apply; native CLI wrappers keep their documented report behavior.
