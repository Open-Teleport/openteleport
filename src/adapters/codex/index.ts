import type { Adapter } from "../types.js";
import { codexCacheIdentity, detectCodex, listCodexAgents, readCodexAgent } from "./read.js";
import { writeCodexAgent } from "./write.js";

/**
 * OpenAI Codex (the CLI and the app), through the files it keeps in `CODEX_HOME` and in
 * `~/.agents/skills`; no `codex` command is run. The global setup (`AGENTS.md`, skills and
 * `config.toml`) and every custom agent in `agents/*.toml` can be read. A Bundle is written as a
 * custom agent file, never into the user's `AGENTS.md` or `config.toml`. Codex keeps its
 * scheduled automations in the app and its memory is generated, so neither routines nor notes are
 * supported, and an agent has no avatar or workspace of its own.
 */
export const codexAdapter: Adapter = {
  name: "codex",
  displayName: "Codex",
  capabilities: {
    persona: true,
    instructions: true,
    skills: true,
    routines: false,
    facts: true,
    notes: false,
    files: false,
    avatar: false,
    models: true,
    schedules: [],
  },
  // The agent file goes into Codex's own folder, which has to be there.
  createsOnWrite: false,
  detect: detectCodex,
  list: listCodexAgents,
  read: readCodexAgent,
  cacheIdentity: codexCacheIdentity,
  write: writeCodexAgent,
};

export default codexAdapter;
