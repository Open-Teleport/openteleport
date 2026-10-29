import type { Adapter } from "../types.js";
import {
  detectOpenBot,
  listOpenBotAgents,
  openBotCacheIdentity,
  readOpenBotAgent,
} from "./read.js";
import { writeOpenBotAgent } from "./write.js";

/**
 * OpenBot (nightly-labs), through the files it keeps and the archives it makes. Agents are read
 * from a copy of its database (`openbot.db`, with `node:sqlite`, loaded only when needed), or
 * from an export archive that `--source-dir` names: an agent import, which the Grok Bot export
 * skill makes too, or an instance transfer. Writing never reaches the app: it makes an
 * `openbot-agent-import` archive for the user to import (Server settings, Import), so the
 * app need not be installed on the target side (`createsOnWrite`) and the move ends in a
 * handoff. The format has no field for a model or for notes.
 */
export const openbotAdapter: Adapter = {
  name: "openbot",
  displayName: "OpenBot",
  capabilities: {
    // Joined with the instructions in the description of the agent.
    persona: true,
    instructions: true,
    skills: true,
    routines: true,
    facts: true,
    notes: false,
    files: true,
    avatar: true,
    models: false,
    schedules: ["cron", "every"],
  },
  createsOnWrite: true,
  handoff: true,
  detect: detectOpenBot,
  list: listOpenBotAgents,
  read: readOpenBotAgent,
  cacheIdentity: openBotCacheIdentity,
  write: writeOpenBotAgent,
};

export default openbotAdapter;
