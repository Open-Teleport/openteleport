import { claudeCodeAdapter } from "./claude-code/index.js";
import { codexAdapter } from "./codex/index.js";
import { folderAdapter } from "./folder/index.js";
import { grokBotAdapter } from "./grok-bot/index.js";
import { hermesAdapter } from "./hermes/index.js";
import { lettaAdapter } from "./letta/index.js";
import { openbotAdapter } from "./openbot/index.js";
import { openclawAdapter } from "./openclaw/index.js";
import { registerAdapter } from "./registry.js";

/**
 * Registers the adapters that ship with OpenTeleport: `folder`, `openclaw`, `claude-code`,
 * `codex`, `letta`, `hermes`, `grok-bot` and `openbot`, in that order. Calling it again is
 * harmless: an adapter registered under a taken name replaces the earlier one in its place.
 */
export function registerBuiltinAdapters(): void {
  registerAdapter(folderAdapter);
  registerAdapter(openclawAdapter);
  registerAdapter(claudeCodeAdapter);
  registerAdapter(codexAdapter);
  registerAdapter(lettaAdapter);
  registerAdapter(hermesAdapter);
  registerAdapter(grokBotAdapter);
  registerAdapter(openbotAdapter);
}
