# Real-install checks: Codex and Hermes

Date: 2026-10-29 (Europe/Warsaw).

This documentation-only report is based on `main` (`f1ad906e6001157497a46c907a59bc999011e65d`). Adapter assumptions were compared with committed v0.2 snapshot `66dd9bfb13aab0f3a31661ace8769e2e8c23cfc7`; consolidation continued independently during this investigation.

## Scope and evidence

- **Observed:** existence, types, counts and selected configuration key names from the existing installations. Credentials, personal instructions, project paths, skill contents and personal memory are excluded.
- **Runtime:** installed programs or their actual Python modules run against synthetic data in isolated temporary homes.
- **Source:** code shipped with the installed Hermes checkout.
- **Docs:** current official documentation, used as corroboration rather than as proof of installed behavior.

| Application | Installed version / provenance | Coverage |
| --- | --- | --- |
| Codex | `codex-cli 0.165.0-alpha.1.2`, binary on PATH | Existing layout; isolated `debug prompt-input` probes for agent and skill discovery |
| Hermes Agent | `0.13.0`; installed checkout `942adf617910f50a39f41bd200d8083bf4cb2bed`, clean tracked working tree | Existing layout; actual memory and cron storage APIs in an isolated home |
| Letta Code | No `letta` command on PATH or default `~/.letta` directory | Not verified; a custom installation elsewhere is not ruled out |

The synthetic homes contained no copied authentication. Child processes received required OS environment variables and isolated home paths. Hermes imports used `-B` / `PYTHONDONTWRITEBYTECODE=1`. Codex warned that temporary homes cannot receive PATH helper aliases, but discovery probes exited successfully. No LLM was called, no custom subagent was spawned, no gateway/scheduler was started, and no import targeted the user's real application directories.

## Initial assumption versus observation

| Assumption | What is actually present / what happened | Adapter and consequence |
| --- | --- | --- |
| Codex uses `~/.codex/config.toml`. | **Observed:** present, parseable TOML; no `CODEX_HOME` override. Selected keys: `model`, `model_reasoning_effort`, `features`, `mcp_servers`, `projects`, `plugins`. No `agents` table or `skills.config` array. Values and dynamic table names are omitted. | Codex: default location and scalar model-setting shape confirmed. Missing optional settings remain valid. |
| Personal custom agents live in `~/.codex/agents/*.toml`. | **Observed:** the real `agents/` directory is absent. **Runtime:** creating it in an isolated home made a synthetic TOML agent appear in the available-role list. | Codex: discovery location confirmed by runtime; an absent directory is a normal existing-install state. |
| An imported agent can be addressed by its filename stem. | **Runtime:** `agents/probe-file.toml` with `name = "probe_field"` exposed `probe_field` in the available-role list; `probe-file` was absent. **Docs:** `name` is the identity. | Codex: the writer preserves `manifest.name` but prints `@<slug>`. The hint is inconsistent when the original name differs from the slug. This verifies role identity, not the UI's `@` syntax. |
| Both user and legacy skill roots need reading. | **Observed:** `~/.agents/skills` and `~/.codex/skills` exist, with 2 and 19 immediate directories respectively; the latter includes `.system`. **Runtime:** skills from both roots appeared in the generated prompt. | Codex: reading both roots is supported by this installed version. Directory counts are not counts of validated/active skills. |
| A same-named skill in `~/.agents/skills` replaces the legacy-root copy. | **Runtime:** two `collision-probe/SKILL.md` files with the same declared name, one in each root, both appeared with distinct synthetic descriptions. **Docs:** same-named skills can both appear. | Codex: `readAllSkills` drops the legacy same-folder-name copy and warns. This is OpenTeleport's lossy conflict policy, not observed Codex precedence. |
| Codex memory is in `memories/MEMORY.md`. | **Observed:** `memories/` exists but is empty. | Codex: generated memory filenames remain **unverified**; an empty directory cannot validate the fixture's filename. |
| Hermes uses `HERMES_HOME`, with a Windows fallback at `%LOCALAPPDATA%/hermes`. | **Observed:** the override is set and the installation uses that Windows location. **Runtime/source:** with the override removed in an isolated child, `get_hermes_home()` returns `Path.home() / ".hermes"`, including on Windows. | Hermes: explicit override works. The adapter's Windows fallback differs from this version's own fallback when the override is absent. Check launcher/profile behavior before choosing a compatibility fix. |
| Hermes config carries model, timezone and memory settings. | **Observed:** `config.yaml` exists; `model` is a mapping with `default`, `provider`, `base_url`; `memory` has `memory_enabled`, `memory_char_limit`, `user_char_limit`. `SOUL.md` exists; `profile.yaml` and `profiles/` do not. | Hermes: key shapes confirmed. Real named profiles were not exercised. |
| Memory uses `memories/MEMORY.md`, `memories/USER.md` and a newline–section-sign–newline separator. | **Observed:** neither file exists in the live home. **Runtime:** `MemoryStore.add` created both in the isolated home; reloading recovered two memory entries and one user entry. Separator was exactly `\n§\n`, without a trailing newline. | Hermes: filenames and serialization confirmed using files produced by the installed implementation. |
| `skills/.bundled_manifest` contains `name:hash` lines. | **Observed:** 87 non-empty lines, all with a 32-character hexadecimal hash, no BOM. **Source:** the installed parser also accepts legacy plain-name lines. | Hermes: current hash-bearing format confirmed; legacy format is source evidence only. No actual skill names are published. |
| `cron/jobs.json` wraps jobs in an object. | **Observed:** absent in the live home. **Runtime:** `create_job` generated `jobs` and `updated_at`, with cron, interval and once schedules; `save_jobs`/`load_jobs` preserved paused records. | Hermes: storage confirmed with the real producer/consumer code. Scheduler execution was not tested. |
| Offset-free one-off times use the configured Hermes timezone. | **Runtime:** with `HERMES_TIMEZONE=UTC`, the Hermes clock used UTC, but `parse_schedule("2099-01-01T12:00:00")` produced `2099-01-01T12:00:00+01:00`, using the machine's local zone at that date. `_ensure_aware` likewise interpreted an offset-free stored timestamp as `11:00Z`. | Hermes: adapter `instantOf` instead uses the configured profile zone, yielding `12:00Z` here. Applies to legacy/hand-written timestamps without offsets; offset-bearing timestamps are not implicated. |

## Findings for the post-review wave

1. **Codex identity:** make the hint refer to the actual `name` field, and separately verify the supported invocation syntax before retaining `@...`. Test a name that slugifies differently. The follow-up below confirms that copies with the same name collide at runtime; a distinct filename is insufficient.
2. **Hermes offset-free one-off time:** align `instantOf` with system-local interpretation, or refuse/report ambiguous inputs. Add a case where the machine and configured zones differ. This is a demonstrated semantic difference, not a failure of the basic cron layout.
3. **Codex duplicate skills:** decide whether to preserve both copies under distinct export names or retain an explicitly lossy policy. Do not describe the existing policy as Codex's own precedence.
4. **Hermes default home:** distinguish the installer's selected directory from the runtime's fallback with no override. An existing Windows directory alone does not prove a newly launched Hermes process will use it.

## Reproduction

### Codex discovery

Use a new temporary directory and isolated `CODEX_HOME`, `HOME` and `USERPROFILE` **in the child process environment only**. Run outside the real project. Copy no auth or config files. Create `<CODEX_HOME>/agents/probe-file.toml`:

```toml
name = "probe_field"
description = "Synthetic research probe"
developer_instructions = "Describe synthetic input only."
```

Run `codex debug prompt-input "Synthetic verification only"`. The generated tool description exposes the role `probe_field`, not `probe-file`.

For skills, create both `<CODEX_HOME>/skills/collision-probe/SKILL.md` and `<isolated-user-home>/.agents/skills/collision-probe/SKILL.md`, with `name: collision-probe`, descriptions `LEGACY_SAME_FOLDER` and `USER_SAME_FOLDER`, and harmless instructions. The same command includes both descriptions. This is model-visible discovery, without a model request or UI interaction.

### Hermes serialization

Use the installed virtual environment's Python with `-B`, its checkout on `PYTHONPATH`, an empty temporary `HERMES_HOME`, and `HERMES_TIMEZONE=UTC`:

```python
from tools.memory_tool import MemoryStore
from cron.jobs import create_job, load_jobs, save_jobs

store = MemoryStore()
store.load_from_disk()
assert store.add("memory", "Synthetic fact one")["success"]
assert store.add("memory", "Synthetic fact two")["success"]
assert store.add("user", "Synthetic user fact")["success"]

for schedule in ["0 9 * * *", "every 2h", "2099-01-01T12:00:00"]:
    create_job("Synthetic probe only", schedule, name="Synthetic check")

jobs = load_jobs()
for job in jobs:
    job.update(enabled=False, state="paused", next_run_at=None)
save_jobs(jobs)
```

No scheduler was running against this temporary home. A new `MemoryStore` recovered the three synthetic entries. Generated schedule records were:

```json
{"kind":"cron","expr":"0 9 * * *","display":"0 9 * * *"}
{"kind":"interval","minutes":120,"display":"every 120m"}
{"kind":"once","run_at":"2099-01-01T12:00:00+01:00","display":"once at 2099-01-01 12:00"}
```

The one-off repeat object was `{"times":1,"completed":0}`; recurring jobs used `{"times":null,"completed":0}`. `origin` was null; `deliver` was local. The sample offset reflects this machine, not a universal Hermes offset.

With the same environment, compare `hermes_time.now()`, `cron.jobs.parse_schedule(...)` and `cron.jobs._ensure_aware(datetime.fromisoformat(...))`: the clock is UTC, while the offset-free scheduled instant is interpreted in system-local time.

## Follow-up: importing through OpenTeleport itself

Date: 2026-10-29. These additional checks use committed snapshot `4a433e7bda8dc5c6170b2f460d01a31d6377ba59`, exported into temporary directories. No code from the concurrently edited working tree was executed. Temporary builds used esbuild with the already installed dependencies; this was not a published npm-package test.

### Codex: archive to application to archive

The actual CLI was built from that snapshot and run with isolated `CODEX_HOME`, `OPENTELEPORT_HOME`, `HOME` and `USERPROFILE`. A synthetic `.jetpack` held an agent named `Probe Agent`, one skill, persona, instructions, one fact, a note, a file and one routine. Every CLI invocation below exited with code 0.

| Step | Result |
| --- | --- |
| First import with `--include-files` | Wrote `agents/probe-agent.toml`. Installed Codex exposed role `Probe Agent` and the imported skill. Persona and fact text were present in `developer_instructions`. The report explicitly skipped routines, notes and files. |
| Re-import with the same ID and changed instructions | Updated the same TOML file; there was still only one custom-agent file. |
| Import with `--copy` and a different synthetic description | Wrote `probe-agent-2.toml`, but both files had `name = "Probe Agent"`. OpenTeleport listed two agent files; installed Codex exposed one role with the copied description. The original description disappeared from the generated role list although its file remained. |
| Export custom agent `probe-agent` back to `.jetpack` | Preserved ID, name, persona and updated instruction text. The fact survived as a `# Facts` section of instructions, rather than in structured `facts`. **The skill was absent, with no warning or skipped item.** |
| Control: export `--agent default` from the same home | Included the one skill. It was still on disk; the custom-agent export omitted it. |
| Global-file sentinels | Synthetic global `config.toml` and `AGENTS.md` stayed byte-for-byte unchanged. |

**Confirmed finding: copy identity collision.** The earlier suspicion is now reproduced through a real OpenTeleport import and installed Codex discovery. File-level conflict handling is insufficient: two different files retain the same runtime identity. In this run the copy occupied the role and the original was no longer separately selectable in the generated role list. Do not rely on which file wins. Assign a distinct supported runtime name for copies/name conflicts, and ensure the result/hint refers to that identity.

**Confirmed finding: skill omitted on custom-agent re-export.** The import reports one moved skill and Codex discovers it, but exporting that custom agent produces `skills: []` with empty warnings and skipped arrays. `readCustom` initializes an empty skill list while only `readGlobal` calls `readAllSkills`. This is a reproducible loss of skill portability on the second transfer, not deletion from the installed application. Resolve the policy explicitly: preserve the associated/inherited skills or clearly report their omission. Avoid silently exporting every unrelated user skill without deciding the intended ownership model.

Minimal sequence, after preparing the isolated environment and synthetic archive:

```text
node <temporary-build>/cli.js import --to codex input.jetpack --include-files --json
codex debug prompt-input "Synthetic validation only"

# Change instructions while retaining manifest.id:
node <temporary-build>/cli.js import --to codex input.jetpack --json

# Change title/description while retaining name and id:
node <temporary-build>/cli.js import --to codex input.jetpack --copy --json
codex debug prompt-input "Synthetic validation only"
node <temporary-build>/cli.js list --from codex --json

node <temporary-build>/cli.js export --from codex --agent probe-agent --out exported.jetpack --json
node <temporary-build>/cli.js export --from codex --agent default --out global-export.jetpack --json
```

Read the two archives using `readBundle`; the custom-agent archive has zero skills, the global archive has one. Distinct synthetic descriptions let the role-list comparison distinguish the original from the copy without invoking either agent.

### Hermes: engine import and native read-back

These checks used the actual `importBundle` / `exportBundle` engine APIs with `hermesAdapter`, not the CLI. All context paths and child-process homes pointed to temporary directories. `ctx.exec` deliberately threw if called. Installed Hermes independently read the adapter-generated files with `MemoryStore.load_from_disk`, `tools.skills_tool._find_all_skills`, `cron.jobs.load_jobs` and `hermes_cli.profiles.list_profiles`.

| Step | Result |
| --- | --- |
| First import | Profile `hermes-probe`; native readers recovered two facts, one skill and three routines (cron, interval, once). |
| Routine state | All three had `enabled: false`, `state: "paused"`, `next_run_at: null`. No job was executed. |
| Same-ID update | Reused the profile, replaced its imported facts and removed a withdrawn routine; remaining items were not duplicated. |
| Copy | Created `hermes-probe-2`; native profile discovery saw both profiles, each with the skill, and no running gateway. |
| Export and `.jetpack` read-back | Preserved ID, name, persona, instructions, both current facts, the skill and both remaining routines. Exported routines remained disabled. |
| Unsupported note | Explicitly reported as `memory.notes` skipped on import. |
| Independent native entries | A further update retained a fact and paused job created by Hermes's own API, plus a separate synthetic skill. Only the previous import's owned entries were replaced. |

The tested Hermes import/update/copy/export and native-read scenarios passed. This confirms recognition of named profiles and basic portability for the supported fields. It does not test provider connectivity, agent execution, gateway operation, or scheduled execution.

### Priorities from the follow-up

Before treating Codex round-trip portability as verified, address the **runtime-name collision on copies** and **unreported skill omission on custom-agent exports**, then repeat the exact scenarios above on the fixed snapshot. Keep the previously identified timezone and default-home differences scoped to their demonstrated cases. Hermes's successful native read-back does not invalidate those separate edge-case findings.


## Sources and remaining limits

- Installed Codex: version/help output and isolated `debug prompt-input` probes.
- Installed Hermes: `hermes_constants.py:get_hermes_home`; `tools/memory_tool.py:MemoryStore`; `tools/skills_sync.py:_read_manifest`; `cron/jobs.py:parse_schedule`, `_ensure_aware`, `create_job`, `load_jobs`, `save_jobs`; `hermes_time.py`. Runtime probes used that installation's virtual environment.
- [Official custom-agent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents): standalone TOML files and name identity, retrieved 2026-10-29.
- [Official skill discovery documentation](https://learn.chatgpt.com/docs/build-skills): user/repository roots and same-name discovery, retrieved 2026-10-29.
- Adapter comparison at the snapshot above: `src/adapters/codex/read.ts:readAllSkills`, `src/adapters/codex/write.ts`, `src/adapters/hermes/paths.ts:hermesHome`, `src/adapters/hermes/cron.ts:instantOf`.

These native Windows checks apply to the installed versions. The follow-up exercises Codex CLI archive/import/export and Hermes engine import/export with native read-back. Codex generated memory filenames, actual agent invocation, provider connectivity, scheduler execution, and Letta MemFS/crons remain unverified. No source, tests, README, CHANGELOG or pre-existing branch contents were edited; only this report changes.

## Release-review follow-up: current v0.2 snapshot

Repeated the isolated Codex CLI import/update/copy/export and installed Codex discovery probe against commit `65acd19fee6b7b5b6282e772163000eaf9af476d` on 2026-10-29. Source was extracted with `git archive` into a temporary directory; the working v0.2 checkout was not changed. This is a targeted runtime recheck, not a rerun of the full unit suite.

Both Codex findings remain reproducible on this newer snapshot:

| Priority | Observed result | Acceptance condition for a fix |
| --- | --- | --- |
| High | Copy creates two TOML files with the same runtime name; installed Codex exposes only the copied description. | Original and copy have distinct runtime identities and are independently discoverable. Reported invocation hints identify those actual roles. Re-import of the same bundle without copy still updates the intended agent. |
| High | Custom-agent export contains zero skills and no warning or skipped item, after import reported moving one skill. | Define skill ownership/inheritance policy. Preserve intended skills on re-export, or explicitly report their omission; do not silently include unrelated user skills. Repeat import/export/archive read-back. |

Same-ID update still used one file before the copy. The imported skill remained visible to Codex. Global config and instructions sentinels remained byte-for-byte unchanged. The probe did not invoke a model or run scheduled work.

Recommended release review: resolve these two cases before describing Codex round-trip portability as verified. Recheck the separately documented Hermes default-home and timezone edge cases after their fixes; this follow-up did not repeat Hermes execution. The plugin research is preparatory work for v0.4 and does not resolve these v0.2 adapter findings.
