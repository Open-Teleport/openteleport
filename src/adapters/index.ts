import { claudeCodeAdapter } from "./claude-code/index.js";
import { folderAdapter } from "./folder/index.js";
import { openclawAdapter } from "./openclaw/index.js";
import { registerAdapter } from "./registry.js";

/**
 * Registers the adapters that ship with OpenTeleport: `folder`, `openclaw` and `claude-code`, in
 * that order. Calling it again is harmless: an adapter registered under a taken name replaces
 * the earlier one in its place.
 */
export function registerBuiltinAdapters(): void {
  registerAdapter(folderAdapter);
  registerAdapter(openclawAdapter);
  registerAdapter(claudeCodeAdapter);
}
