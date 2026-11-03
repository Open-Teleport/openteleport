# SSH transport: implementation plan

Design: `docs/superpowers/specs/2026-11-03-ssh-transport-design.md`. Branch: `feat/ssh-transport`.
Every task lands with its tests; the suite runs against the fake `ssh`, never a server.

## Task 1: zip bytes in memory

`src/core/bundle.ts`: `bundleToZip(bundle): Uint8Array` (what `writeBundle` writes to a file) and
`readBundleBytes(bytes, label, opts)` (what `readBundle` does for a file, from a buffer).
`src/core/zip.ts`: `readZipEntries` keeps its signature and delegates to a new
`readZipBytes(label, archive, policy)`.

Tests (`test/core/bundle.test.ts`): a bundle round-trips through `bundleToZip` →
`readBundleBytes`; `readBundleBytes` rejects bytes over the archive limit and non-zip bytes with
the label in the message.

## Task 2: `import -` and `export --out -`

`src/commands/import.ts`: the argument `-` reads the whole of stdin as a `.jetpack`
(`readBundleBytes`, manifest required). `src/commands/export.ts`: `--out -` writes the zip to
stdout and prints the report (terminal or `--json`) to stderr, saving the report file under
the home folder.

Tests (`test/commands/import.test.ts`, `export.test.ts`): `import - --to folder` with the
zip piped in writes the folder; `export --out -` prints bytes that `readBundleBytes` reads
back, and keeps stdout free of text.

## Task 3: the target parser and the ssh runner

`src/commands/remote.ts`:

- `parseTarget(text)` → `{ adapter, host? }`, splitting at the first `@`; `UsageError` for a bad
  host (empty, leading `-`, whitespace, control character).
- `shellQuote(arg)` for a POSIX shell.
- `remoteCommand(host, args)` → `{ file: "ssh", args: [host, "npx -y openteleport@<VERSION> ..."] }`.
- `runRemote(ctx, host, args, { input?, output: "json" | "bytes", quiet })` with `ctx.exec`:
  stdin from `input`, stdout as JSON or bytes, stderr piped and forwarded unless `quiet`. Maps
  failures: JSON `{error}` on stdout → `RemoteError` carrying the code; exit 127 or
  `command not found` → `NotDetectedError`; exit 255 → `Error` naming the host; non-JSON stdout
  → `Error` quoting the first line.
- `shared.ts`: `exitCodeOf` honours `RemoteError.exitCode`.

Tests (`test/commands/remote.test.ts`, with a stubbed `exec`): the parser cases; quoting;
the command names `openteleport@<package.json version>`; each error mapping; bytes go to
stdin unchanged and come back from stdout unchanged.

## Task 4: wiring

- `move.ts`: `--to x@host`: local export (`exportBundle`, with `--keep` as before), confirm
  `--replace` locally, `runRemote(... "import --to x - <flags>")`, relabel and print the report.
  `--from x@host`: `runRemote(... "export --from x --agent a --out - ...")`, `readBundleBytes`,
  `importBundle` into the local target with the source labelled `x@host`. Both remote: exit 2.
- `export.ts`: `--from x@host` → remote export, bytes written to `--out` or `<name>.jetpack`,
  report rendered locally.
- `import.ts`: `--to x@host` → read the local file as before, stream to the remote import.
- `list.ts`: `--from x@host` → remote `list --json`, printed as a table or JSON.
- `cli.ts`: the `--from`/`--to` descriptions mention `<adapter>[@host]`; the root help footer
  gets one line on remote hosts.

Tests (`test/commands/ssh.test.ts`, with `test/helpers/fake-ssh.ts` installing the fake on the
sandbox `PATH`): move to `folder@server` writes into the fake remote's folder and prints the
usual report (terminal and `--json`); move from `folder@server` reads the fake remote's
folder; `import --to folder@server`; `export --from folder@server`; `list --from
folder@server`; a secret stops before ssh (the fake records no call); `--replace` without
`--yes` and no terminal is exit 2 before ssh; no `npx` is exit 3; unreachable host is exit 1;
`nosuch@server` is exit 2 without a call; the fake saw `openteleport@<version>`.

## Task 5: docs

`README.md` ("Remote installs over SSH"), `docs/STATUS.md` (done and verified against the
fake only; roadmap item removed), `CHANGELOG.md` under Unreleased, `--help` (checked by
`test/commands/help.test.ts`).

## Task 6: verification

`npm run lint`, `npm run build`, `npm test`. Commit per task as author Story, no trailers.
