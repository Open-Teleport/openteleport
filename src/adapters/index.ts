import { claudeCodeAdapter } from "./claude-code/index.js";
import { codexAdapter } from "./codex/index.js";
import { folderAdapter } from "./folder/index.js";
import { grokBotAdapter } from "./grok-bot/index.js";
import { lettaAdapter } from "./letta/index.js";
import { openclawAdapter } from "./openclaw/index.js";
import { registerAdapter } from "./registry.js";

/**
 * Registers the adapters that ship with OpenTeleport: `folder`, `openclaw`, `claude-code`,
 * `codex`, `letta` and `grok-bot`, in that order. Calling it again is harmless: an adapter
 * registered under a taken name replaces the earlier one in its place.
 */
export function registerBuiltinAdapters(): void {
  registerAdapter(folderAdapter);
  registerAdapter(openclawAdapter);
  registerAdapter(claudeCodeAdapter);
  registerAdapter(codexAdapter);
  registerAdapter(lettaAdapter);
  registerAdapter(grokBotAdapter);
}
