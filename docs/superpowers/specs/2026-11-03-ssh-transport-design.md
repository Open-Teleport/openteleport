# SSH transport

Date: 2026-11-03. Status: design for the implementation in
`docs/superpowers/plans/2026-11-03-ssh-transport.md`.

`docs/design.md` (section 12, point 1) deferred remote installs: export on the laptop, copy the
file, `npx openteleport import` on the server. This design folds those three steps into one
command over plain `ssh`, and nothing else: no daemon, no port, no account.

```bash
openteleport move --from openclaw --to openclaw@server --agent ada
openteleport move --from openclaw@deploy@10.0.0.4 --to folder --agent ada
openteleport export --from hermes@server --agent ada --out ada.jetpack
openteleport import --to openclaw@server ada.jetpack
openteleport list --from openclaw@server
```

## The `<adapter>@<host>` syntax

`--from` and `--to` take `<adapter>` as before, or `<adapter>@<host>`. The text before the
**first** `@` is the adapter name; everything after it is the host. Adapter names never hold an
`@`, and an ssh destination may (`deploy@server`), so `openclaw@deploy@server` is the OpenClaw
on `deploy@server`.

The host is passed to `ssh` as its destination, exactly as typed: `server`, `user@server`,
`ssh://user@server:2222`, or an alias from `~/.ssh/config`. That file is the one place for
ports, identities, jump hosts and the like: there is **no `--ssh-option` passthrough**. One
configuration mechanism that every ssh user already has beats a second one that only
OpenTeleport reads, and it keeps the command line free of anything that must be quoted twice.

A host is refused with exit code 2 when it is empty, starts with `-` (it would be read as an
ssh option), or holds whitespace or a control character. The adapter part is checked against
the registry locally, so `--to nosuch@server` is exit code 2 before anything is spawned.

## The remote command

The local side runs, with no shell in between:

```
ssh <host> npx -y openteleport@<local version> <subcommand> <args> --json --quiet
```

The remote shell is assumed to be POSIX (`sh`, `bash`, `zsh`): every argument after the host is
quoted for it with single quotes, so an agent name with a space or a quote arrives whole.

Version pinning is by construction: the remote command names the local version
(`openteleport@0.4.7`), so both sides always run the same release. A development build whose
version is not on npm cannot reach a remote until it is published; that is deliberate. The
remote `npx` downloads the package into its own cache on first use, as `npx openteleport` on
the server would.

**Remote target** (`--to <adapter>@<host>`, in `move` and `import`):

1. The source is read locally as it is for `export`: the agent gets its id, memory selection
   and `--include-files` are applied, and the secret scan runs. A bundle that holds a secret
   stops here, before `ssh` starts; nothing leaves the machine.
2. The bundle is zipped in memory and streamed to the remote command's **stdin**.
3. The remote runs `import --to <adapter> - --json --quiet` plus the write flags the user gave
   (`--copy`, `--replace --yes`, `--enable-routines`, `--include-files`, `--no-memory`). The
   `-` argument of `import` means stdin. `--replace` is confirmed locally, before ssh, and
   travels as `--replace --yes`.
4. The remote's JSON report comes back on **stdout**; the local side relabels its source
   (`<from adapter> / <agent>`) and target (`<adapter>@<host>`), adds the local read warnings
   and renders it as any other report, with `--json` or in the terminal, and saves it under
   `~/.openteleport/reports/` as usual.

**Remote source** (`--from <adapter>@<host>`, in `move`, `export` and `list`):

1. The remote runs `export --from <adapter> --agent <agent> --out - --quiet` (with
   `--include-files` and `--no-memory` as given). `--out -` means stdout: the zip bytes, and
   nothing else, go to stdout; the report goes to stderr. The remote scans for secrets before
   anything leaves the server.
2. The local side reads the zip from **stdout** with the same hardened reader that reads a
   `.jetpack` file (size limits, path checks, nothing inflated before the listing is checked),
   then writes it into the local target through the import path of the engine, which scans
   for secrets again. The report names the source as `<adapter>@<host> / <agent>`.
3. `--agent` is required for a remote source; there is no interactive pick over ssh. Without it
   the remote `export` answers with its usual list of agents and exit code 2, which is relayed.
4. `list --from <adapter>@<host>` runs the remote `list --json` and prints it.

The warnings of a remote read (what the source adapter said while reading) are not carried
back for a remote source: stdout is the zip and stderr is shared with ssh and npx. They are
printed on the terminal as the remote's stderr, which the local side forwards unless `--quiet`.

## Errors

The remote `--json` protocol is the CLI's own: on failure stdout holds
`{"error": {"code": n, "message": "..."}}`. The local side relays the message and ends with the
same code, so a target app that is not installed on the server is exit code 3 locally too, with
the adapter's own hint.

A remote without `npx` (or without Node at all) is reported as **exit code 3**, the code of a
target that is not there, with the message naming the host and what to install. It is
recognised by exit code 127 from the remote shell, or a `command not found` line on stderr.

`ssh` itself failing (exit 255: no route, refused key, unknown host) is exit code 1 with the
last stderr line of ssh in the message. Output on stdout that is not JSON (a banner from a
shell profile, a wrapper that prints) is exit code 1 with the first line quoted, so the cause
is visible.

The local side never times the remote out: a first `npx` on a slow link may take a minute,
and the user can interrupt. Password and passphrase prompts work as they do for `scp`, since
ssh reads them from the terminal, not from the stdin that carries the zip.

## What is written where

Nothing on the remote is written by the transport itself. The remote runs the same `import`
or `export` the user could run there by hand, so what lands on the server is exactly what that
command writes: what the adapter writes into its app, OpenTeleport's own bookkeeping
(`~/.openteleport/ids.json` and the report under `~/.openteleport/reports/`), and npx's package
cache. No bundle file is left behind on either side unless `--keep` or `--out` asks for one.

Secrets are scanned on the side that reads: locally before a bundle is sent, remotely before
one is sent back, and again locally before a received bundle is written. The transport adds no
exemption.

## Testing

No test needs a server. The suite puts a fake `ssh` executable on the sandbox `PATH` (a `.cmd`
on Windows, a shell script elsewhere, both starting a Node script) that checks the command it
was given (`npx -y openteleport@<version> ...`), records it, and runs the **local built CLI**
with the remote arguments in a "remote" home folder of the sandbox, stdin and stdout passed
through. So a move to `folder@server` really writes a folder in the fake remote's working
directory, the zip really crosses stdin, and the report really comes back as JSON. Environment
variables switch the fake into a host without `npx` (exit 127) and an unreachable host (exit
255). Unit tests cover the `<adapter>@<host>` parser, the shell quoting, the command line
built for each direction and the version pin.

`docs/STATUS.md` says that this is all the verification there is: the transport has not been
run against a real server.

## Out of scope

- Windows as a **remote** host: the remote command is quoted for a POSIX shell and runs `npx`
  by name; a Windows OpenSSH server with `cmd.exe` as its shell will not parse it. Windows as the
  local side works with the OpenSSH client that ships with it.
- `--ssh-option`, agent forwarding, jump hosts and ports on the command line: configure them in
  `~/.ssh/config`.
- `sudo` or any other user than the one ssh logs in as.
- A remote that cannot reach npm: the remote command needs `npx` to resolve the pinned version,
  from its cache or the registry. A global install of the same version on the server is not
  used.
- Both `--from` and `--to` remote in one command (a server-to-server move). Run it from one of
  the two servers, or in two commands through a file.
- The wizard: it offers local apps only.
