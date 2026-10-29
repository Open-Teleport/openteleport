# Codex fixture

A Codex home rebuilt from the documentation, not copied from an installation: Codex is not
installed on the machine that wrote this adapter. Every value is invented. Source references
(C1 to C14) point into `docs/superpowers/research/2026-10-28-v0.2-adapters-research.md`, section 2.

`home/` is the user's home directory:

| Path | What it reproduces | Sources |
|---|---|---|
| `.codex/AGENTS.md` | Global instructions, in the `# Persona` / `# Instructions` layout the adapter writes, with CRLF line endings (a Windows checkout). There is no `AGENTS.override.md`: the tests add one. | C2 |
| `.codex/config.toml` | User configuration: `model`, `model_reasoning_effort`, `approval_policy`, a comment and an `[mcp_servers.x]` table the adapter must leave alone. | C3, C4, C5 |
| `.codex/agents/reviewer.toml` | A custom agent (subagent) with `name`, `description`, `developer_instructions`, `model` and `nickname_candidates`. | C7, C11 |
| `.codex/memories/MEMORY.md` | Generated memory; read as one note, never written. | C9, C13 |
| `.codex/skills/old/SKILL.md` | A skill in the deprecated `CODEX_HOME/skills` folder, still read. | C10 |
| `.agents/skills/new/SKILL.md` | A skill in the user skills folder. | C1 |
| `.agents/skills/old/SKILL.md` | The same name as the deprecated skill, with other content: the user folder wins. | C1, C10 |

The layout of the home directory (`CODEX_HOME`, default `~/.codex`) is from C5 and, for Windows,
C12. `openteleport-ids.json` is not here: only the adapter writes it.
