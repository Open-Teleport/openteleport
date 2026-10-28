# Hermes Agent fixture

`home/` is a small `HERMES_HOME` rebuilt from the documentation and the source of Hermes Agent
(Nous Research), not copied from an installation. The reference numbers are those of
`docs/superpowers/research/2026-10-28-v0.2-adapters-research.md`.

| Path | What it shows | Source |
|---|---|---|
| `config.yaml` | `model.default`, `model.provider`, `timezone`, `memory.memory_char_limit` | H3, H18 |
| `profile.yaml`, `SOUL.md` | the default profile: a display name, a `SOUL.md` without the persona/instructions layout | H3, H4 |
| `memories/MEMORY.md` | three entries joined by `"\n§\n"`, no trailing line break; the third is 700 characters | H5, H14 |
| `memories/USER.md` | one entry | H5, H14 |
| `cron/jobs.json` | `{ "jobs": [...], "updated_at": ... }` with a `cron`, an `interval` and a `once` job (naive `run_at`); the interval job has `deliver: "telegram"` and a `workdir` | H13 |
| `skills/writing/release-notes/` | a skill in a category, with a `references/` file | H6 |
| `skills/triage/` | a skill that ships with Hermes (listed in `.bundled_manifest`) | H6, H17 |
| `skills/.bundled_manifest` | the manifest of bundled skills, see below | `tools/skills_sync.py` |
| `skills/.hub/state.json` | state of the skills hub, never read | H6, H17 |
| `skills/claude-code-imports/old/` | a skill imported by `hermes import-agent claude-code` | H1, H6 |
| `profiles/reviewer/` | a named profile (`profile.yaml` with a description, `SOUL.md` in the `# Persona` / `# Instructions` layout, no `cron/`) | H4, H18 |

The paths follow H16 (`~/.hermes`, `%LOCALAPPDATA%\hermes`) and H4 (`profiles/<name>/`); a
directory is a profile when it holds one of `config.yaml`, `.env`, `SOUL.md`, `profile.yaml`,
`auth.json`, `state.db`.

## `.bundled_manifest`

The format is not JSON. In `tools/skills_sync.py` (`_read_manifest`, `_write_manifest`) it is one
line per skill shipped with Hermes: `name:hash` (v2, the hash is the MD5 of the skill folder as it
was copied), or just `name` (v1, read as a skill with no hash yet). The name is the `name` of the
skill's frontmatter, else its folder name. The file is read as UTF-8 with a byte order mark
allowed. Source:
https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_sync.py

The fixture holds one v2 line, `triage:<md5>`. A listed skill is left behind when a profile is
read, whether or not the user has changed it since.

## `cron/jobs.json`

The fields are those of `create_job` in H13 as of the `main` branch. Two things differ from the
research and the spec: `origin` is an object (the chat a job was created in) or `null`, not a
string, and `repeat` is `{ "times": <n or null>, "completed": <n> }`, with `times: 1` for a
one-off. `next_run_at` is `null` for a job created paused; Hermes works it out on
`hermes cron resume`.
