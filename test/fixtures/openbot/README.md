# OpenBot zip fixtures

Folders, not zips: `test/helpers/zip.ts` packs a folder into an archive inside the test, so a
change shows up in a diff as files and not as bytes. Both layouts come from the design notes and
the source of OpenBot (nightly-labs/openbot), read on 2026-10-28. Neither was made by a real
OpenBot or Grok Bot.

## import-v1/

An `openbot-agent-import` v1 archive, the format the Grok Bot export skill writes and OpenBot's
Server settings, Import reads.

- Sources: Appendix A of `docs/superpowers/plans/2026-10-27-openteleport-v0.1.md` (OpenBot
  notes); G12 `resources/agent-import/grok-bot/SKILL.md` (the layout, the field rules and the
  limits); O2 `src/main/team-api/route-agent-import.ts` and O3
  `packages/contracts/src/team-protocol/agent-import-v1.ts` (the import calls). The manifest
  decoder is `src/main/agent-import-manifest.ts`.
- `ada` has everything: an avatar (a 1x1 PNG), two skills (one with a second file), eight routines
  (one for each schedule shape an import carries, one of them off), three memories and a
  `files` folder. `min` has only the required fields. One channel, which is not moved.
- The `advanced` schedule is the plain form of the design, `months`, `days` and `time`. The export
  skill lists no `advanced` shape, and OpenBot itself writes it nested (see `transfer-v1/`).

## transfer-v1/

An `openbot-instance-transfer` v1 archive, the file OpenBot writes to move a whole instance to
another computer.

- Sources: Appendix A of the v0.1 plan; `src/main/instance-transfer-manifest.ts` (the manifest
  and the agent fields) and `packages/contracts/src/ipc-routines.ts` (the schedule shapes,
  including `advanced` and `once`).
- One agent, `ada`, on the `claude` provider, with two routines that carry `limitPolicy` and
  `missedPolicy`, one `oneTimeRoutines` entry (`once`) and two memories, one with an `inclusion`.
  The `advanced` schedule is nested as OpenBot writes it. `settings` has all its lists empty,
  `shared` is `"shared"` and `shared/readme.txt` stands for the shared files.
