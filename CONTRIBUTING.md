# Contributing to OpenTeleport

Thanks for helping make AI agents portable. This page tells you how the project works, how to propose a change, and what a good pull request looks like.

## What OpenTeleport is

One command moves an AI agent (persona, instructions, skills, routines, memory facts, model preferences) between apps through a neutral `.jetpack` file. An unzipped `.jetpack` is itself a working agent folder for any tool that reads `AGENTS.md` and Agent Skills. Three rules never bend:

- **No app is the benchmark.** Every adapter is a peer; the format never gains a field that only one app can use (vendor extras live under `x-<vendor>` keys).
- **Secrets never travel.** Exports stop on known credential patterns, and the format has no field for credentials.
- **The source is never modified.** A move copies a snapshot; imported routines land disabled.

Read [`README.md`](README.md) for usage, [`docs/STATUS.md`](docs/STATUS.md) for what is done and what is next, and [`docs/design.md`](docs/design.md) for the design and the reasoning behind it.

## Before you start

- Node.js 24 or newer, npm.
- `npm ci`, then `npm test` (builds first, then runs the suite). `npm run lint` type-checks `src/`.
- Open an issue before a large change (a new adapter, a format change) so the approach is agreed first. Small fixes can go straight to a pull request.

## How to make a change

1. Fork the repository and create a branch from `main` (`feat/hermes-adapter`, `fix/zip-size-check`).
2. Write the failing test first, then the code. The suite runs against the built CLI in a sandbox: tests must never touch the real home directory or run a real `openclaw`/`claude` binary; use `OPENTELEPORT_HOME`, temp directories and the recording `exec` stubs you will find in the existing adapter tests.
3. Keep `npm run lint && npm run build && npm test` green on your platform; CI runs the suite on Ubuntu, macOS and Windows.
4. Add a line to `CHANGELOG.md` under the unreleased version.
5. Open a pull request against `main` using the template. One topic per pull request.

`main` is protected: changes land only through a pull request with green CI.

## Commit messages

Conventional style, imperative mood, scope in parentheses:

```
feat(hermes): read adapter
fix(bundle): reject stored entries whose sizes disagree
docs(readme): describe --include-files warnings
test(cli): compare real paths on macOS
```

## Writing an adapter

An adapter is one directory under `src/adapters/<app>/` that exports an object implementing `Adapter` from `src/adapters/types.ts`:

| Member | What it does |
|---|---|
| `name`, `displayName` | CLI id (`--from hermes`) and the name shown in reports |
| `capabilities` | which bundle fields the app can hold; the engine strips the rest and reports them as skipped |
| `createsOnWrite` (optional) | `true` when `write` makes its target (a file or a folder), so the app need not be installed on the target side and `detect` is not asked about it; otherwise a target that `detect` does not find ends the command with exit code 3 |
| `handoff` (optional) | `true` when `write` never finishes the move itself: it prepares a file or a folder and returns `outcome: "handoff"` with the one step left to the user. The wizard says so before it asks for a go-ahead, and a test checks that every adapter with the flag does end a write in a handoff |
| `detect(ctx)` | is the app installed, where, which version; a hint when not found |
| `list(ctx)` | the agents the app has |
| `read(ctx, agent)` | build a `Bundle` from the app's files; never modify the source |
| `write(ctx, bundle, opts)` | write into the app; return `done` or `handoff` with one next step; report only your own losses in `items` |
| `cacheIdentity(ctx, agent)` (optional) | a stable key for the id cache when the agent id alone is ambiguous |

The checklist is section 3 of the v0.2 design, [`docs/superpowers/specs/2026-10-28-openteleport-v0.2-design.md`](docs/superpowers/specs/2026-10-28-openteleport-v0.2-design.md) (in Polish): no app binaries, where the app's home comes from, the identity marker, conflict names, atomic writes, unknown fields kept, vendor data under `x-<vendor>`, limits enforced at write time, and how skipped facts are named. Read it before you start; a reviewer checks an adapter against it.

Do not copy the helpers the existing adapters share. Use them:

- `src/adapters/marker.ts`: the identity marker (`.openteleport.json` in the agent's folder: `readMarker`, `writeMarker`, `carriesMarker`) and the ids map for apps that keep agents in one folder (`readIds`, `recordId`). The marker is the only proof that an agent in the target is the one OpenTeleport wrote, which `update` and `replace` rely on.
- `src/adapters/fs.ts`: `lstatIfAny`, `readTextIfAny`, `entriesOf`, `isSafeName`, the atomic `replaceFile` (a temporary file in the same directory, then `rename`, never through a symbolic link), `backUp` for a file the app maintains, and `freeSibling`/`numberedSiblings` for `-2` names.
- `src/adapters/skill-files.ts` and `src/adapters/skills.ts`: reading skill folders, and placing skills in a folder other tools share without overwriting another tool's.
- `src/adapters/names.ts`: the name an agent is written under when its own is taken: the free `-N` name of an agent file (`freeName`), the `-N` name an earlier move gave the same agent (`recordedCopy`), and the folder of a hand-over (`claimFolder`).

Rules that every adapter follows:

- Never follow symlinks when reading skills or avatars, and never write through a symlink.
- Never read or write outside the app's own state directory or the chosen target.
- Honour the three conflict modes (`update`, `copy`, `replace`) and keep an id marker so the same agent updates in place on the next move.
- Do not append `Co-Authored-By` or other attribution trailers to commits.
- Ship fixtures captured from a real installation with personal data removed, plus tests for read, write and a round trip. If you cannot capture one, rebuild the layout from the app's documentation and source, say which sources in the fixture's `README.md`, and list the adapter under "What is not verified yet" in `docs/STATUS.md` until someone checks it on a real install.

Register the adapter in `src/adapters/index.ts` and extend the expected lists in `test/commands/adapters.test.ts`, add a row to the README table (with `done`, or `handoff` and the one step) and a CHANGELOG line. To try an adapter without registering it, point `OPENTELEPORT_EXTRA_ADAPTER` at its module.

## Changing the `.jetpack` format

The format is versioned (`schemaVersion`). Additive, optional fields are fine; anything else needs a new version and a note in the spec. Regenerate `schema/jetpack.schema.json` with `npm run schema` and commit it.

## Reporting bugs and security issues

Use the issue templates. For a security problem (path escape, secret leakage, writes outside the target), open a private security advisory on GitHub instead of a public issue.

## License

Apache-2.0. By contributing you agree that your contribution is licensed under the same terms.
