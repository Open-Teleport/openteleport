// How a Claude Code subagent's `permissionMode` and `disallowedTools`, and the project's
// `.claude/settings.json` permissions, map to the manifest's `policy` and back. The table is
// section 4 of docs/superpowers/specs/2026-11-03-permission-rules-design.md.

import type { Policy, PolicyMode, PolicyRule } from "../../core/schema.js";

/** The `permissions` block of `.claude/settings.json`, only the string entries. */
export type SettingsPermissions = { allow?: string[]; ask?: string[]; deny?: string[] };

/** What Claude Code holds natively, as `readAgent` keeps it in `x-claude-code`. */
export type ClaudePolicySource = {
  permissionMode?: string;
  disallowedTools?: string[];
  settingsPermissions?: SettingsPermissions;
};

/** `permissionMode` → `policy.mode`; `undefined` for a value this adapter does not know. */
const MODE_OF: Record<string, PolicyMode> = {
  default: "ask",
  manual: "ask",
  acceptEdits: "ask",
  auto: "auto",
  dontAsk: "auto",
  bypassPermissions: "auto",
  plan: "readOnly",
};

/** `policy.mode` → `permissionMode`, when no raw value can be kept. */
export const PERMISSION_MODE_OF: Record<PolicyMode, string> = {
  ask: "default",
  auto: "auto",
  readOnly: "plan",
};

export const SETTINGS_WARNING =
  "permission rules in .claude/settings.json are project-wide in Claude Code; exported with the agent";

/** The rule `acceptEdits` adds after the mode. */
const ACCEPT_EDITS_RULE: PolicyRule = { effect: "allow", on: "files.write" };

const toolRule = (effect: PolicyRule["effect"], tool: string): PolicyRule => ({
  effect,
  on: "tool",
  tool,
});

/**
 * The `policy` Claude Code's own values stand for, and the warnings reading them earns. The
 * rules come in this order: the one `acceptEdits` implies, then `disallowedTools`, then the
 * settings `deny`, `ask` and `allow` entries. `policy` is `undefined` when there is nothing.
 */
export function policyFromClaude(source: ClaudePolicySource): {
  policy?: Policy;
  warnings: string[];
} {
  const warnings: string[] = [];
  const rules: PolicyRule[] = [];
  let mode: PolicyMode | undefined;
  const { permissionMode, disallowedTools, settingsPermissions } = source;

  if (permissionMode !== undefined) {
    mode = Object.hasOwn(MODE_OF, permissionMode) ? MODE_OF[permissionMode] : undefined;
    if (mode === undefined) {
      warnings.push(`permissionMode '${permissionMode}' is not known; not exported`);
    } else if (permissionMode === "acceptEdits") {
      rules.push({ ...ACCEPT_EDITS_RULE });
    }
  }
  for (const tool of disallowedTools ?? []) rules.push(toolRule("deny", tool));
  if (settingsPermissions !== undefined) {
    const { deny = [], ask = [], allow = [] } = settingsPermissions;
    const fromSettings = [
      ...deny.map((tool) => toolRule("deny", tool)),
      ...ask.map((tool) => toolRule("ask", tool)),
      ...allow.map((tool) => toolRule("allow", tool)),
    ];
    if (fromSettings.length > 0) {
      warnings.push(SETTINGS_WARNING);
      rules.push(...fromSettings);
    }
  }

  if (mode === undefined && rules.length === 0) return { warnings };
  return { policy: { ...(mode === undefined ? {} : { mode }), rules }, warnings };
}

const sameRule = (a: PolicyRule, b: PolicyRule): boolean =>
  a.effect === b.effect && a.on === b.on && a.tool === b.tool && a.pattern === b.pattern;

/** Whether two policies say the same thing: same mode, same rules in the same order. */
export function samePolicy(a: Policy | undefined, b: Policy | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.mode === b.mode &&
    a.rules.length === b.rules.length &&
    a.rules.every((rule, i) => sameRule(rule, b.rules[i] as PolicyRule))
  );
}

/** A `deny` on a plain tool name, which `disallowedTools` can hold as it is. */
export function isDisallowedToolRule(rule: PolicyRule): boolean {
  return (
    rule.effect === "deny" &&
    rule.on === "tool" &&
    rule.pattern === undefined &&
    rule.tool !== undefined &&
    !rule.tool.includes("(")
  );
}

export type ClaudePolicyFit = {
  permissionMode?: string;
  disallowedTools?: string[];
  /** The places (from 1) of the rules Claude Code does not enforce from the agent file. */
  textRules: number[];
};

/**
 * How `policy` goes into the agent file. When `raw` (the agent's `x-claude-code` values) stands
 * for exactly `policy`, the raw values are written back and only the settings rules go to text.
 * Otherwise the mode maps to `permissionMode`, every plain `deny tool` to `disallowedTools`,
 * and the rest to text. Settings rules are never written: a move does not edit settings.json.
 */
export function fitClaudePolicy(policy: Policy, raw: ClaudePolicySource): ClaudePolicyFit {
  const hasRaw = raw.permissionMode !== undefined || raw.disallowedTools !== undefined;
  if (hasRaw && samePolicy(policyFromClaude(raw).policy, policy)) {
    const own =
      (raw.permissionMode === "acceptEdits" ? 1 : 0) + (raw.disallowedTools?.length ?? 0);
    return {
      ...(raw.permissionMode === undefined ? {} : { permissionMode: raw.permissionMode }),
      ...(raw.disallowedTools === undefined || raw.disallowedTools.length === 0
        ? {}
        : { disallowedTools: [...raw.disallowedTools] }),
      textRules: policy.rules.map((_rule, i) => i + 1).filter((n) => n > own),
    };
  }
  const disallowedTools: string[] = [];
  const textRules: number[] = [];
  policy.rules.forEach((rule, i) => {
    if (isDisallowedToolRule(rule)) disallowedTools.push(rule.tool as string);
    else textRules.push(i + 1);
  });
  return {
    ...(policy.mode === undefined ? {} : { permissionMode: PERMISSION_MODE_OF[policy.mode] }),
    ...(disallowedTools.length === 0 ? {} : { disallowedTools }),
    textRules,
  };
}
