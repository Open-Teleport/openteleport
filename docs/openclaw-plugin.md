<!-- Ready to paste into a new issue in openclaw/openclaw. Title: the first heading. Body: everything below it. -->

# Plugin proposal: `openclaw agents export` and `import` for portable agent bundles

## Motivation

openclaw/openclaw#97885 ("Add portable Agent Bundles for export/import across OpenClaw instances")
was closed on 24 Oct 2026. The closing comment said that whole-agent export/import would be a
large new portability and credential contract for core, and that a plugin or a fresh, focused
design proposal is the best next step. This is both: a small design for two commands, shipped as
a plugin so that core does not change.

The plugin would be a thin layer over [OpenTeleport](https://github.com/Open-Teleport/openteleport)
(Apache-2.0, npm `openteleport`), which already reads and writes OpenClaw agents through the
`openclaw` CLI and moves agents to and from Claude Code and plain `AGENTS.md` folders.

## Proposed commands

```text
openclaw agents export <id> [--out <file.jetpack>]
openclaw agents import <file.jetpack> [--enable-routines]
```

- `export` saves agent `<id>` as a `.jetpack` file (default `./<name>.jetpack`). The agent is
  only read, never changed.
- `import` creates the agent in this instance, with an id derived from its name. An existing
  agent of that id is updated in place only when it is the same agent; otherwise the import
  lands as a copy (`<id>-2`) and says so. Nothing is overwritten silently.
- `--enable-routines` keeps imported routines enabled. Without it they arrive disabled.
- Both print a report of what was moved, approximated and skipped.

## What the plugin does

It registers the two commands and calls `openteleport` as a library, with its `openclaw` adapter:

```ts
import {
  exportBundle, getAdapter, importBundle, readBundle, registerBuiltinAdapters,
} from "openteleport";

registerBuiltinAdapters();
const openclaw = getAdapter("openclaw");
// ctx: { home, cwd, env, exec, logger }

// openclaw agents export <id> --out <file>
await exportBundle({ from: openclaw, agent: id, ctx, out: file, includeFiles: false });

// openclaw agents import <file> [--enable-routines]
const bundle = await readBundle(file);
await importBundle({
  to: openclaw, bundle, ctx,
  write: { enableRoutines, includeFiles: false, onConflict: "update" },
});
```

The adapter drives the same `openclaw` CLI a user would (`agents add`, `agents set-identity`,
`config set`, and `cron` or `automations` for routines, whichever family the install has) and
writes the workspace files. A marker file in the workspace lets a later import update the same
agent instead of duplicating it. No new core API and no new Gateway method is needed: the plugin
needs the CLI on `PATH` and, for routines, a running Gateway.

## What never leaves the machine

Secrets. A `.jetpack` holds instructions, persona, skills, memory, routine definitions, model
preferences and an optional avatar. Provider keys, auth profiles, channel tokens and `.env` files
are not part of the format. Before a file is written the bundle is also scanned for API keys,
tokens and private keys (OpenAI, Anthropic, GitHub, Slack, AWS and Google keys, JWTs, bearer
tokens, PEM keys). One finding stops the export and names the file and line, never the value.
Import runs the same scan. Channel bindings and accounts stay with the instance.

## What stays disabled

Routines. Every imported routine is created disabled (`cron add --disabled`, or a `disable` right
after `add` where the CLI has no such flag), so an imported agent does not start acting on a
schedule by itself. The user reviews the routines and enables them, or passes
`--enable-routines`. A job that cannot be disabled is removed again and reported, and a failure
to do even that is reported loudly.

## The file format

A `.jetpack` is a plain zip that unpacks to a working agent folder, laid out on the standards
OpenClaw already reads: `AGENTS.md`, `SOUL.md`, `skills/<name>/SKILL.md` (Agent Skills),
`MEMORY.md`, plus `jetpack.json` (manifest) and `routines/<name>.json`. The manifest is described
by [`schema/jetpack.schema.json`](https://github.com/Open-Teleport/openteleport/blob/main/schema/jetpack.schema.json)
(JSON Schema, `schemaVersion` `0.1`). Vendor-specific fields go under `x-<vendor>` keys that other
tools ignore.

## Why a plugin, not core

- Core keeps no new portability or credential contract to maintain. The credential question is
  answered by leaving credentials out of the format, and a scanner refuses what slips in.
- The format is not OpenClaw-specific. It is shared with Claude Code and plain `AGENTS.md`
  folders, so it should change on its own schedule, not with OpenClaw releases.
- It is opt-in: `openclaw plugins install`, distributed through ClawHub (and npm), and pinned to
  a plugin SDK version, which suits an API that is still experimental.
- If it proves useful, core can adopt the two commands later. The file format is already the
  contract, so nothing has to be redone.

## Status and open questions

- The adapter is built and tested against fixtures. Its reading of `openclaw ... --json` output
  follows the docs and `--help` of OpenClaw 2026.5.28, not yet a live install. A maintainer's
  look at the JSON shapes it relies on (`agents list`, `cron list` / `automations list`) would
  help.
- Where the commands live. The plugin manifest documents `cliCommands` as root commands. If a
  plugin cannot add subcommands to the core `agents` command, the fallback is
  `openclaw jetpack export|import`, with the same flags.
- A `--agent <id>` override on import needs a small addition to openteleport's `WriteOpts` (a
  target id). Until then the agent id derives from the bundle name.
- The adapter shells out to the `openclaw` CLI. If the plugin SDK offers in-process equivalents,
  they can replace those calls behind the adapter's interface.
