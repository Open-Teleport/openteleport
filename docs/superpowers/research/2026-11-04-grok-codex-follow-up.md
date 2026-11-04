# Grok Bot and Codex follow-up — 2026-11-04

Later result: the desktop restart restored UI access. [The live Grok test](2026-11-04-grok-live-check.md) passed paste, fresh-Bot shared-memory recall and a genuine export/folder round trip. The blocked attempt below is historical; Codex #20 remains unresolved.

## Grok Bot #17 — earlier blocked attempt

The installed Grok Bot process was running. The supported computer-use runtime failed before accessing a window with `failed to write kernel assets` / Windows error 3. Reset/retry and the alternate entry point produced the same initialization failure. No message was sent to a Bot and no app state was changed.

Public npm 0.4.7 generated [a synthetic paste pack](fixtures/grok-probe-2026-11-04/README.md). It contains two fictional Cedar project facts and an instruction marker, no skills or routines. Do not count generating the pack as an import test.

Pending procedure: create the named test Bot; paste the generated first message; check the marker and both facts. Separately exercise Add to Memory with the synthetic memory text and verify saved recall from a fresh conversation that was not given the values. Record that memory is shared across Bots. Request a genuine OpenBot-format export of only the synthetic Bot, check it with OpenTeleport list/export, and record retained/lost fields. Cleanup must affect only the synthetic Bot and test facts. Issue #17 stays open until these observations exist.

## Codex #20

The top level of `~/.codex/memories/` remains empty; `memories_v2/` is absent. No personal memory content was read and no setting was changed. Existing native role/instruction/fact/skill/model evidence from 2026-11-03 remains valid for its recorded version.

The [official subagent guide](https://learn.chatgpt.com/docs/agent-configuration/subagents) documents named roles and explicit requests to spawn them; it does not establish dedicated `@name` selection. The [official memory guide](https://learn.chatgpt.com/docs/customization/memories?surface=app) describes background generation and both memory stores. Neither an empty store nor the lack of documented mention syntax proves the feature unsupported. UI invocation and generated filenames remain unverified; #20 stays open.
