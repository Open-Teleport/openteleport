# Session integration (0.4.2)

Requires Node >=24. Install a fixed local runtime once:

    npm install --prefix /absolute/path/to/runtime --ignore-scripts openteleport@0.4.2

Its CLI is /absolute/path/to/runtime/node_modules/openteleport/dist/cli.js.
Use that absolute path in your client or OPENTELEPORT_CLI configuration.
Alternatively, check out the v0.4.2 tag and build with npm ci and npm run build.
The examples below use a built repository path; substitute your installed CLI path when using npm.

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

Plans last ten minutes, are limited to eight per session, and are lost on server restart.
Each snapshot has a 32 MiB accounting budget: binary backing buffers (including unused portions of subarrays), UTF-8 text/keys and a conservative charge
per metadata value. This is not an exact JavaScript heap limit or an archive-size limit. Validation stops
before cloning on budget overflow, more than 100,000 values or nesting deeper than 64 levels.
Binary data is measured directly without expanding it into JSON. Pending reads reserve a slot before accessing the source. Expiry timers release
snapshots even while idle; closing the transport clears retained plans. An already-started write continues
and must be inspected if its client disconnects. Apply consumes a plan before execution, including on failure; writes are serialized within one server session.
A source edited after preview does not change the reviewed snapshot. The destination is not reserved:
conflicts are checked at execution, and adapter writes are not transactional. Inspect partial results before
retrying a failed operation. There is no automatic rollback or exact file-diff preview.

Only update and copy are available. Replace is rejected. Files are excluded and routines disabled by
default. The source is never deleted. Export refuses an existing destination, including one created after
preview. A handoff is returned as such, with nextStep. Successful transfers return the complete report and
save a Markdown copy under OPENTELEPORT_HOME/.openteleport/reports (home by default).

The secret scanner is heuristic. Validation's ok means no detected credential findings, not that every
payload was scanned or that the package is safe to share. Validation returns scan and previews return
secretScan, with counts of oversized files, binary files and avatars that were not scanned. Preview
counts describe the selected snapshot: excluded files do not travel and are not included in those counts.
Names/paths and some metadata are outside the scanner's scope. Personal memory is not automatically anonymized. Previews summarize
capability losses; additional adapter approximations and skips are reported after application.

## Select memory before sharing

Export, import and move accept includeMemory (default true). Set it to false to exclude structured
facts and notes before scanning and retaining the reviewed snapshot. Preview contents show the selected
counts; excluded lists omitted counts and reasons without returning memory text. The final result and
saved report also record those omissions. The source stays unchanged.

This is not anonymization. Instructions, persona, skills, routines, attachments and vendor metadata can
still contain personal information. Review those separately before sharing. When updating an existing
agent, omitted memory may remove previously imported destination memory, depending on the adapter;
use copy to retain the existing agent. This option selects incoming content, not destination fields to
leave untouched. The CLI exposes the same selection as --no-memory on export, import and move (including --keep).
The interactive wizard also asks whether to include facts and notes. When omitting memory for an application transfer, it asks whether to create a separate copy or update the previously imported agent, and explains the memory consequences before confirmation. Native plugin support is described in their setup documentation.

## Destination location disclosure

Previews include destination.writeScope: locations, their purpose, whether they are shared, and
unresolved paths. These reuse the built-in writers' path helpers and respect destination overrides.
Show these locations before requesting approval. An explicit targetDir is not a filesystem boundary:
Codex skills still use the user's shared .agents/skills directory, and Claude Code project memory and
identity metadata use its user configuration directory. Locations are potential write areas, not a list
of files guaranteed to change. A container identifies a parent directory; a candidate may change when
the writer resolves a conflict. The export archive path is fixed and existing files are refused.

OpenClaw's workspace is explicitly unresolved because existing configuration can place it outside the
state directory. Additional adapters without disclosure are marked unavailable. Conflict decisions and
file-level changes remain unresolved until apply; this is not a complete diff, permission boundary or
reservation. OpenTeleport's own identity cache, reports and operation receipts additionally live under
its home directory, as described above and below. No destination writer runs to produce this disclosure.

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

Add the repository marketplace:

    /plugin marketplace add Open-Teleport/openteleport
    /plugin install openteleport@openteleport

The plugin provides its MCP configuration, the openteleport skill, and the namespaced
/openteleport:openteleport command. No personal Claude configuration is changed by the build.
Do not configure the same server both manually and through the plugin unless you want duplicate tools.
The launcher uses the current Node executable and a configured absolute CLI path, with no shell.

## Plugin startup troubleshooting

The plugin launcher checks Node >=24 and that OPENTELEPORT_CLI is an absolute, readable file.
Setup failures go to stderr only, so human-readable diagnostics do not corrupt the MCP stream.
If the CLI file is missing, run npm ci and npm run build in the checkout and set OPENTELEPORT_CLI
to its dist/cli.js. Restart the MCP connection after changing the environment. The variable must be
present in the Claude Code process environment, not only in a terminal opened after Claude started.

If the host starts an older Node from PATH, configure its MCP command with the absolute path of a
supported Node executable. The launcher uses that same executable for the child CLI. Paths containing
spaces are passed as arguments without a shell. A readable file is only a startup check; it does not
prove that the configured build implements MCP. Use the 0.4.2 installed CLI or the built CLI from the v0.4.2 checkout.

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

Cancelling a pending plan discards it before apply. cancel returns cancelled, in_progress or not_pending;
in_progress explicitly means the already-started apply was not stopped. A client timeout, stop button,
or MCP request cancellation does not roll back an operation. The server continues an already-started
write while its process remains alive and records the outcome. Query operation_status rather than
replaying the plan. Killing the server process can still leave an incomplete receipt and partial files.

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

## Distributable verification

After npm run build, run npm run verify:package. The check packs the npm artifact without rerunning
build hooks, installs it with production dependencies in a temporary directory, imports its public API,
and exercises folder transfer, archive export/import, optional attachments, disabled routines, source
preservation and operation receipts through the installed MCP entry point. A synthetic Codex home checks
that unsupported fields are disclosed in both preview and final report. A Grok Bot handoff checks that
the remaining manual step survives in the result and receipt. These checks do not run either host app
or prove that an agent behaves identically after migration. It does
not load adapters from src, publish a package, modify application profiles or install anything globally.
It needs npm registry access (or cached dependencies) and removes its temporary installation afterwards.
CI runs this check on Linux, macOS and Windows. It verifies the root npm package; native plugin releases
still need their separate installation checks and a published dependency version before distribution.

For a synthetic reviewer, repeatable tasks and a private scoring form, see [Agent transfer pilot](pilot.md).

## Release version alignment

After changing the root package.json version, run npm run sync:plugin-versions and review the diff.
This synchronizes the root lockfile, Claude plugin and marketplace, plus OpenClaw package/lockfile and
Hermes manifest when present. It does not choose a version, stage files, publish anything, remove the
OpenClaw private flag or replace its development dependency. Commit the reviewed metadata alongside
the release change. CI runs npm run check:plugin-versions without modifying files.

When a separate release PR changes the root version before this branch merges, rerun synchronization
after incorporating that release. A clean Git merge alone does not prove that plugin versions agree.
