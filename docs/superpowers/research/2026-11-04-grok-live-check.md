# Grok Bot live verification — 2026-11-04

Grok Bot 0.78.4 on Windows and a local build of OpenTeleport 0.4.7 at `aeadcf0` passed the scoped live handoff and export checks for issue #17. The earlier UI initialization blocker cleared after restarting the desktop app. [Sanitized evidence](2026-11-04-grok-live-evidence.json) and the [unchanged genuine export](fixtures/grok-live-2026-11-04/README.md) are preserved.

Version provenance: Windows executable metadata reports 0.78.4 (the executable timestamp predates this process launch). The earlier blocked/source-inspection runs used 0.78.1; they are not the version of this live retry.

## Observed results

| Check | Result |
| --- | --- |
| Paste the generated first message into a new synthetic Bot | Passed: `GROK_PORTABLE_CEDAR`, project color violet and checkpoint compass were returned without providing their values in the check question. |
| Settings > General > Import > Add to Memory | Accepted the generated `2-memory.txt` as pasted text. The app sent it to the main Bot, despite a test Bot being open. The main Bot confirmed that all three synthetic facts were saved in shared memory. |
| Fresh-Bot recall | A newly created second Bot returned violet, compass and `lantern-47` from existing memory. The check prompt contained none of these values and prohibited reading other Bots/conversations. The checksum had only been submitted through Add to Memory, not through the original Bot's chat. |
| Actual Grok-produced export ZIP | The second Bot exported only the first synthetic Bot using the public OpenBot format. The app supplied a downloadable 618-byte ZIP containing one manifest and one agent. |
| OpenTeleport list and export | Listed the real export and produced a `.jetpack` with the exact instructions and three facts. |
| Folder round trip | Import to a folder, list, export back and inspect all passed. `AGENTS.md` and `MEMORY.md` were byte-identical through the folder, and the generated OpenTeleport identity/name remained stable. |
| Return Grok paste pack | All three facts were written back to `2-memory.txt` exactly. It remains a handoff, not an automatic Bot import. |
| Source preservation | The downloaded original and test copy remained byte-identical. |

## Method and scope

The first Bot received [the existing synthetic paste pack](fixtures/grok-probe-2026-11-04/README.md). A separate OpenTeleport-generated memory file added a third fictional fact: the Cedar memory-import checksum is `lantern-47`. This control was not supplied to the fresh Bot in its recall question. Memory persistence here means recall by a newly created Bot; persistence across an application restart or a long retention interval was not tested.

The General import action selected the main Bot automatically. That Bot received only the three synthetic facts. This route changes shared user memory across Bots, not an isolated memory file. The current generated handoff already warns about shared scope; README/demo still had older "format is a guess" text, corrected with this evidence.

The export request was restricted to the synthetic source Bot and Cedar facts. It expressly excluded other agents, personal context, workspace files, avatar, skills, routines and group chats, and used [OpenBot's public export instructions](https://github.com/nightly-labs/openbot/blob/main/resources/agent-import/grok-bot/SKILL.md) only as a format guide. The exporter reported that instructions came from the test Bot conversation, the first two facts from that conversation, and the checksum from shared memory. It could not access the profile title and omitted it. It generated the ZIP in its cloud workspace. This verifies an actual Bot-produced OpenBot-format export, not a native profile dump or every export field.

The only folder re-export warning was `SOUL.md not found`: this test agent had no separate persona. Exported instructions/facts were retained; the title was already absent from the source ZIP. Avatar, files, skills, routines, channels, models and permission enforcement are outside this live check.

## Reproduce the archive check

Run from the repository root after building, with an isolated `OPENTELEPORT_HOME` and a new empty output directory. Use the fixture ZIP as `--source-dir`:

1. `list --from grok-bot --source-dir <fixture.zip>`.
2. `export --from grok-bot --source-dir <fixture.zip> --agent openteleport-probe-20261104 --out <first.jetpack>`.
3. `import <first.jetpack> --to folder --target-dir <empty-folder>`.
4. `export --from folder --source-dir <empty-folder> --agent "OpenTeleport Probe 20261104" --out <second.jetpack>`.
5. Inspect both archives and compare instructions, facts and identity; import the second archive `--to grok-bot --target-dir <empty-output>` and compare its memory text.

All eight CLI checks, including list/inspect steps, exited 0. Separately, the adapter regression suites passed 277/277 tests (175 Codex, 102 Grok Bot), with a successful build. Automated fixtures do not stand in for the live observations above.

## Codex #20

The current CLI remains 0.166.0-alpha.5.1. After the restart, `memories/` still contains no files recursively and `memories_v2/` is absent. The user configuration does not explicitly set the memory feature/options; that is not proof of the complete effective configuration. No personal memory content was read and no settings were changed.

The earlier native role, instruction, fact, shared-skill execution and model evidence remains valid for its recorded version. The user supplied a screenshot of the `@` menu: its visible portion showed files, integrations and modes, with no custom-agent selector visible. This does not establish the behavior of the entire menu or dedicated `@name` semantics. Computer Use cannot automate the ChatGPT desktop app itself. Genuine generated-memory filenames remain unobserved. Issue #20 stays open; no fabricated memory files are used as evidence.

## Test data cleanup

Two synthetic Bots (`OpenTeleport Probe 20261104`, `OpenTeleport Verify 20261104`) and the three Cedar facts were created. After explicit approval, the main Bot confirmed deleting the three shared facts, and both test Bots were deleted and no longer appeared in the list. The first test Bot could not delete the shared facts because it had not created them; the main Bot that created them performed the cleanup. The original ZIP and sanitized report are retained. No other Bot was exported and no user configuration was edited.
