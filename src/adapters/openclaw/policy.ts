// The manifest's `policy` as OpenClaw holds it: per agent, `tools.allow` / `tools.deny` (tool
// names, `group:<name>` and `*` wildcards; deny wins) and `sandbox.workspaceAccess: "ro"`. Ask
// rules and exec approvals are global in OpenClaw, so they go to the `## Permissions` section of
// AGENTS.md instead. See docs/superpowers/specs/2026-11-03-permission-rules-design.md.
import { renderPolicySection, withPolicySection } from "../../core/policy.js";
import type { Item } from "../../core/report.js";
import type { Manifest, Policy, PolicyRule } from "../../core/schema.js";
import { isRecord, nonBlank } from "../../core/values.js";
import type { OpenClawAgentEntry } from "./paths.js";

/** Why a rule OpenClaw cannot hold per agent went to text. */
export const TEXT_REASON = "OpenClaw sets ask and exec approvals globally, not per agent";
/** A tool name with a matcher in it (`Bash(git push *)`) is another app's rule, not an OpenClaw tool. */
export const SPECIFIER_REASON =
  "OpenClaw tool lists take tool names, not matchers; a rule with one is from another app";

/** `agents.entries.<id>.tools`, the parts the adapter carries. */
export type OpenClawTools = { allow?: string[]; deny?: string[]; profile?: string };

const READ_ONLY = "ro";

/** The tools OpenClaw denies for a scope denied without a pattern; the rest go to text. */
const SCOPE_DENIES: Readonly<Record<string, readonly string[]>> = {
  shell: ["exec"],
  "files.write": ["write", "edit", "apply_patch"],
  network: ["group:web"],
  browser: ["browser"],
};

const stringsOf = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.flatMap((item) => nonBlank(item) ?? []) : undefined;

/** The `tools` of an entry (or a vendor block) with only the parts the adapter carries. */
export function toolsOf(value: unknown): OpenClawTools | undefined {
  if (!isRecord(value)) return undefined;
  const tools: OpenClawTools = {};
  const allow = stringsOf(value.allow);
  const deny = stringsOf(value.deny);
  const profile = nonBlank(value.profile);
  if (allow !== undefined) tools.allow = allow;
  if (deny !== undefined) tools.deny = deny;
  if (profile !== undefined) tools.profile = profile;
  return Object.keys(tools).length === 0 ? undefined : tools;
}

/** `sandbox.workspaceAccess` of an entry, when it is set. */
export function workspaceAccessOf(entry: OpenClawAgentEntry): string | undefined {
  return isRecord(entry.sandbox) ? nonBlank(entry.sandbox.workspaceAccess) : undefined;
}

/**
 * The policy that `tools` and `workspaceAccess` state: the denies, then the allows, each as a
 * rule on the tool as named (groups and `*` included), and `readOnly` for `"ro"`. `undefined`
 * when they state nothing.
 */
export function policyOf(
  tools: OpenClawTools | undefined,
  workspaceAccess: string | undefined,
): Policy | undefined {
  const rules: PolicyRule[] = [
    ...(tools?.deny ?? []).map((tool): PolicyRule => ({ effect: "deny", on: "tool", tool })),
    ...(tools?.allow ?? []).map((tool): PolicyRule => ({ effect: "allow", on: "tool", tool })),
  ];
  const mode = workspaceAccess === READ_ONLY ? ("readOnly" as const) : undefined;
  if (rules.length === 0 && mode === undefined) return undefined;
  return { ...(mode === undefined ? {} : { mode }), rules };
}

/** What `read` puts in `x-openclaw` for the policy, raw, so that a move back keeps it. */
export function policyVendorOf(
  entry: OpenClawAgentEntry,
): { tools?: OpenClawTools; workspaceAccess?: string } {
  const tools = toolsOf(entry.tools);
  const workspaceAccess = workspaceAccessOf(entry);
  return {
    ...(tools === undefined ? {} : { tools }),
    ...(workspaceAccess === undefined ? {} : { workspaceAccess }),
  };
}

const sameRule = (a: PolicyRule, b: PolicyRule): boolean =>
  a.effect === b.effect && a.on === b.on && a.tool === b.tool && a.pattern === b.pattern;

const samePolicy = (a: Policy, b: Policy): boolean =>
  a.mode === b.mode && a.rules.length === b.rules.length && a.rules.every((r, i) => sameRule(r, b.rules[i]));

/** `names` with every repeat (case-insensitively, as OpenClaw matches) after the first left out. */
function dedupe(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type PolicyPlan = {
  /** `tools` and `sandbox` for the agent entry, in that order, when something is to be set. */
  values: [key: string, value: unknown][];
  /** The instructions with the `## Permissions` section for what went to text, or without one. */
  instructions: string;
  approximated: Item[];
};

/**
 * How the manifest's `policy` lands in OpenClaw. A `tool` rule without a pattern goes to the
 * agent's `tools.allow` / `tools.deny` as named; `deny` on shell, files.write, network or
 * browser without a pattern becomes the denies of the tools behind the scope; `mode: readOnly`
 * becomes `sandbox.workspaceAccess: "ro"` plus the files.write denies. When `x-openclaw.tools`
 * is there and `policy` is what `read` makes of it, the raw lists go back as they were, so a
 * `profile` and the order survive. What the agent already has (`existing`, on an update) is
 * kept and merged, names deduplicated. Everything else is written as text and handed back as
 * `rule:<n>` items, and a mode that is not per agent as a `policy` item. Without a policy the
 * instructions are left as they are.
 */
export function planPolicy(
  manifest: Manifest,
  instructions: string,
  existing: OpenClawAgentEntry | undefined,
): PolicyPlan {
  const { policy } = manifest;
  if (policy === undefined) return { values: [], instructions, approximated: [] };

  const vendor = manifest["x-openclaw"];
  const rawTools = isRecord(vendor) ? toolsOf(vendor.tools) : undefined;
  const rawAccess = isRecord(vendor) ? nonBlank(vendor.workspaceAccess) : undefined;
  const fromRaw = policyOf(rawTools, rawAccess);
  const lossless = rawTools !== undefined && fromRaw !== undefined && samePolicy(policy, fromRaw);

  const allow: string[] = [];
  const deny: string[] = [];
  const textRules: { n: number; reason: string }[] = [];
  let modeToText = false;
  let readOnly = false;

  if (lossless) {
    allow.push(...(rawTools.allow ?? []));
    deny.push(...(rawTools.deny ?? []));
    readOnly = rawAccess === READ_ONLY;
  } else {
    policy.rules.forEach((rule, i) => {
      const n = i + 1;
      if (rule.effect === "ask" || rule.pattern !== undefined) {
        textRules.push({ n, reason: TEXT_REASON });
      } else if (rule.on === "tool" && (rule.tool ?? "").includes("(")) {
        textRules.push({ n, reason: SPECIFIER_REASON });
      } else if (rule.on === "tool") {
        (rule.effect === "allow" ? allow : deny).push(rule.tool ?? "");
      } else if (rule.effect === "deny" && SCOPE_DENIES[rule.on] !== undefined) {
        deny.push(...SCOPE_DENIES[rule.on]);
      } else {
        textRules.push({ n, reason: TEXT_REASON });
      }
    });
    if (policy.mode === "readOnly") {
      readOnly = true;
      deny.push(...SCOPE_DENIES["files.write"]);
    } else if (policy.mode !== undefined) {
      modeToText = true;
    }
  }

  const values: [string, unknown][] = [];
  const existingTools = toolsOf(existing?.tools);
  if (lossless) {
    values.push(["tools", { ...existingTools, ...rawTools }]);
  } else if (allow.length > 0 || deny.length > 0) {
    const merged: OpenClawTools = { ...existingTools };
    const allAllow = dedupe([...(existingTools?.allow ?? []), ...allow]);
    const allDeny = dedupe([...(existingTools?.deny ?? []), ...deny]);
    if (allAllow.length > 0) merged.allow = allAllow;
    if (allDeny.length > 0) merged.deny = allDeny;
    values.push(["tools", merged]);
  }
  if (readOnly) {
    const sandbox = isRecord(existing?.sandbox) ? existing.sandbox : {};
    values.push(["sandbox", { ...sandbox, workspaceAccess: READ_ONLY }]);
  }

  const section = renderPolicySection(policy, {
    mode: modeToText,
    rules: textRules.map(({ n }) => n),
  });
  const approximated: Item[] = [
    ...(modeToText
      ? [{ field: "policy", detail: `mode ${policy.mode} is not a per-agent setting in OpenClaw` }]
      : []),
    ...textRules.map(({ n, reason }) => ({ field: `rule:${n}`, detail: reason })),
  ];
  return { values, instructions: withPolicySection(instructions, section), approximated };
}
