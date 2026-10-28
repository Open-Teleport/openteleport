import type { Adapter, AdapterCapabilities } from "../types.js";
import { detectGrokBot, grokBotCacheIdentity, listGrokBots, readGrokBot } from "./read.js";
import { writeGrokBot } from "./write.js";

const CAPABILITIES: AdapterCapabilities = {
  persona: true,
  instructions: true,
  skills: true,
  routines: true,
  facts: true,
  notes: false,
  files: false,
  avatar: false,
  models: false,
  schedules: ["cron", "every", "at"],
};

/**
 * Grok Bot (xAI). It keeps its Bots on a computer in the cloud and has no export or import of
 * its own, so there is no app to find: Bots are read from the zip that OpenBot's export skill
 * makes (`--source-dir <zip>`), and `write` is a handoff, a folder of text to paste into a new
 * Bot's chat. It makes its target, so Grok Bot need not be installed (`createsOnWrite`).
 */
export const grokBotAdapter: Adapter = {
  name: "grok-bot",
  displayName: "Grok Bot",
  capabilities: CAPABILITIES,
  createsOnWrite: true,
  handoff: true,
  detect: detectGrokBot,
  list: listGrokBots,
  read: readGrokBot,
  cacheIdentity: grokBotCacheIdentity,
  write: writeGrokBot,
};

export default grokBotAdapter;
