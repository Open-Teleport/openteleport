# Codex runtime verification — 2026-11-03

OpenTeleport 0.4.3 (built from main after PR #37) was checked against installed `codex-cli 0.166.0-alpha.5.1` on Windows. All agent content was synthetic. This is a partial runtime check, not a claim that every Codex import path or UI invocation works.

## Results

| Check | Observed result | Scope |
| --- | --- | --- |
| Import into an isolated Codex home | `done`; wrote `agents/teleport-reviewer.toml`, associated skill metadata and the skill under the isolated user home | Actual OpenTeleport CLI, not a hand-written replacement agent |
| Runtime role identity | `debug prompt-input` exposed `Teleport Reviewer`, the TOML `name`, rather than its filename stem | Installed Codex, no model request |
| `agents.enabled` | With `true`, the custom role was exposed; with `false`, it was absent | Installed Codex prompt/tool configuration |
| Copy identity | Original and copy had distinct names, `Teleport Reviewer` and `Teleport Reviewer-2`; Codex exposed both | Rechecks the previously fixed collision on this installed version |
| Re-exported skill | Export of the imported custom agent produced a bundle containing one skill | OpenTeleport archive inspection; not proof that Codex executes the skill |
| Instructions and imported fact at runtime | A spawned custom role returned `ROLE_LOADED_CEDAR` and the synthetic fact `indigo` from its imported instructions | Live request, with the imported TOML registered through process-only `agents.<name>.config_file`; `fork_turns="none"` |
| Skill discovery | A copy of the imported skill under the temporary project's `.agents/skills/` appeared in the skill catalog | Project skill discovery, not the real shared user directory |
| Skill execution | The child attempted to read the named project skill, but its shell read was blocked by execution policy; it did not return the proof phrase | Still unverified; do not count discovery as execution |
| Model selection | The imported TOML contained `gpt-6.1-sol` and the generated role description exposed it as fixed | Actual child-model metadata was not available; inference-time model selection remains unverified |
| `@<name>` | Not established as a dedicated role-invocation syntax | Do not recommend it as a verified command; request the role explicitly by its `name` |
| Generated memories | The existing `memories/` directory contained no Markdown files | No personal memory contents were read; generated-memory filenames remain unverified |

Facts are folded into Codex's `developer_instructions` on import. The re-exported bundle therefore reports zero standalone facts; the runtime fact check above tests the instruction text, not a native Codex memory database.

## Test setup and limitations

The source folder contained a manifest, instructions, one fact and a skill. The instruction told the role to begin with `ROLE_LOADED_CEDAR`; the fact set a synthetic project color to `indigo`. The skill body contained a separate proof phrase that was not supplied in the live user prompt.

Initial discovery used temporary `CODEX_HOME`, `HOME`, `USERPROFILE` and `OPENTELEPORT_HOME`. On this Windows build, Codex still resolved its shared user skills through the actual Windows profile, so the skill in the isolated user home did not appear. The follow-up used only a project-local copy of that skill. Nothing was installed into the real shared skills directory.

The live CLI used its existing authentication normally, `--ignore-user-config`, `--ignore-rules`, `--no-daemon`, `--ephemeral`, read-only permissions and approval policy `never`. No credential file was copied. No existing user agent or configuration was edited.

Project-only agent discovery did not expose the role in these probes, even after initializing the temporary Git repository and supplying a process-only trust setting. To test the imported instruction file without writing to the real Codex home, the live request registered the exact TOML with process-only `agents."Teleport Reviewer".config_file` and `description` overrides. This is not proof of default personal-role discovery in a signed-in session; that remains a follow-up.

A first ephemeral spawn with inherited history failed with `no rollout found`. A fresh child using `fork_turns="none"` ran the imported instructions and returned the fact. The subsequent skill read was blocked by the child's execution policy. Neither restriction was bypassed.

Temporary test files were removed after recording these results. Raw prompts, session logs, personal paths and authentication material are not committed.

## Reproduction outline

1. Build OpenTeleport 0.4.3 and create a new temporary source folder and user home. Use only synthetic instructions, facts and skills.
2. Set `OPENTELEPORT_HOME` and `CODEX_HOME` for the OpenTeleport child process; run `import --to codex <source> --target-dir <temporary-codex-home> --json`.
3. Run installed Codex `debug prompt-input` from the temporary workspace with `agents.enabled=true` and then `false`. Compare the available role definitions.
4. Repeat import with `--copy`; inspect both TOML names, repeat discovery, and export the original role back to a `.jetpack`. Check its skill count.
5. For a live check without writing to the real Codex home, register the generated TOML using process-only `agents.<name>.config_file` and `description`. Use normal Codex authentication, an ephemeral read-only session, and no inherited user config. Place the synthetic skill in the temporary project. Explicitly request exactly one child of that role with `fork_turns="none"`; do not supply its proof prefix or fact in the prompt.
6. Record discovery, instruction execution, skill execution and actual model selection separately. A successful parent exit code alone does not prove a successful child task.

## Sources and follow-up

- [Official custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents): role `name`, standalone TOML files and `agents.enabled`. Retrieved 2026-11-03; documentation is not a substitute for the installed behavior above.
- [Earlier discovery check](2026-10-29-real-install-check.md).
- [Issue #20](https://github.com/Open-Teleport/openteleport/issues/20) stays open for signed-in default-role discovery, supported UI invocation, actual child-model selection, shared-user-skill execution and generated memory filenames.
