# Letta Code fixture

A `~/.letta` layout rebuilt from documentation and source code, not from an installation:
nothing here was produced by a real Letta Code. Source numbers refer to
`docs/superpowers/research/2026-10-28-v0.2-adapters-research.md`, section 4.7.

`home/.letta/` holds:

- `lc-local-backend/agents/agent-local-1111.json`: the local backend's agent record, with the
  fields `id`, `name`, `description`, `system`, `tags`, `model`, `model_settings`, `hidden` and
  `compaction_settings` [L16]. The backend directory is the default one [L15].
- `lc-local-backend/memfs/agent-local-1111/memory/`: that agent's MemFS (version 2: a root
  `MEMORY.md` index, core memory files in the root, `reference/` with an index of its own,
  `skills/<name>/SKILL.md`) [L10][L13][L18]. `persona.md` starts with a UTF-8 byte order mark
  and has `name` and `description` frontmatter; `human.md` holds two bullets and a paragraph of
  prose; `notes.md` is a loose file in the root.
- `agents/agent-cloud-2222/memory/`: the MemFS of a Letta Cloud agent, kept under
  `~/.letta/agents/<agentId>/memory/` [L18]. Cloud has no local record, so there is no name or
  system prompt here; `persona.md` has no frontmatter and `human.md` is empty.
- `crons.json`: `{ version: 1, tasks[] }` with the task fields `id`, `agent_id`,
  `conversation_id`, `name`, `description`, `cron`, `timezone`, `recurring`, `prompt`, `status`,
  `created_at`, `last_fired_at`, `fire_count` and `scheduled_for` [L17]. Three tasks belong to
  `agent-local-1111` (active cron, paused cron, a fired one-off) and one to another agent.

Other sources: the install and the two backends [L5], the CLI reference for `cron add`,
`agents create` and `memory restore` [L9][L19][L20], and scheduling [L12].
