// The permission rules of an agent (`policy` in `jetpack.json`): how they are written as text
// for an app that does not enforce them, and how a move fits them to the target. The design is
// docs/superpowers/specs/2026-11-03-permission-rules-design.md.

import type { AdapterCapabilities } from "../adapters/types.js";
import type { Item } from "./report.js";
import type { Bundle, Policy, PolicyRule, PolicyScope } from "./schema.js";

/** The heading of the section a text target gets; the whole section is replaced on a later move. */
export const PERMISSIONS_HEADING = "## Permissions";

const INTRO =
  "These rules came with the agent. The app you are running in does not enforce them; follow\nthem yourself.";

/** What the engine puts before an adapter's reason for a rule it wrote as text. */
export const AS_TEXT = "written as text in AGENTS.md; ";

const MODE_LINES = {
  ask: "Mode: ask before any action that changes files or runs commands.",
  auto: "Mode: act without asking for confirmation.",
  readOnly: "Mode: read only; do not change files or run commands.",
} as const;

type Wording = { noun: string; bare: string; gerund: string; plural: boolean };

const WORDING: Record<Exclude<PolicyScope, "tool">, Wording> = {
  shell: { noun: "shell commands", bare: "run shell commands", gerund: "running shell commands", plural: true },
  "files.read": { noun: "reading files", bare: "read files", gerund: "reading files", plural: false },
  "files.write": { noun: "writing files", bare: "write files", gerund: "writing files", plural: false },
  network: { noun: "network access", bare: "use the network", gerund: "using the network", plural: false },
  browser: { noun: "browser use", bare: "use the browser", gerund: "using the browser", plural: false },
  computerUse: { noun: "computer control", bare: "control the computer", gerund: "controlling the computer", plural: false },
  scheduler: { noun: "scheduling routines", bare: "schedule routines", gerund: "scheduling routines", plural: false },
};

const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

function wordingOf(rule: PolicyRule): Wording {
  if (rule.on !== "tool") return WORDING[rule.on];
  const tool = `the tool ${code(rule.tool ?? "")}`;
  return { noun: tool, bare: `use ${tool}`, gerund: `using ${tool}`, plural: false };
}

/** The one line of the text section that states `rule`. */
export function describeRule(rule: PolicyRule): string {
  const { noun, bare, gerund, plural } = wordingOf(rule);
  const matching = rule.pattern === undefined ? "" : ` matching ${code(rule.pattern)}`;
  switch (rule.effect) {
    case "deny":
      return `Never ${bare}${matching}.`;
    case "ask":
      return `Ask before ${gerund}${matching}.`;
    case "allow": {
      const subject = noun[0].toUpperCase() + noun.slice(1);
      return `${subject}${matching} ${plural ? "are" : "is"} allowed without asking.`;
    }
  }
}

/** A short line for a report or `inspect`: `mode ask, 3 rules`. */
export function summarizePolicy(policy: Policy, rules = policy.rules.length): string {
  const parts = [
    ...(policy.mode === undefined ? [] : [`mode ${policy.mode}`]),
    ...(rules === 0 ? [] : [`${rules} rule${rules === 1 ? "" : "s"}`]),
  ];
  return parts.join(", ");
}

/**
 * The `## Permissions` section for the mode (when `mode` is true) and the rules at the given
 * places (from 1, in `policy.rules` order), or `undefined` when there is nothing to say.
 */
export function renderPolicySection(
  policy: Policy,
  which: { mode: boolean; rules: readonly number[] },
): string | undefined {
  const lines = [
    ...(which.mode && policy.mode !== undefined ? [MODE_LINES[policy.mode]] : []),
    ...[...new Set(which.rules)]
      .sort((a, b) => a - b)
      .flatMap((n) => {
        const rule = policy.rules[n - 1];
        return rule === undefined ? [] : [describeRule(rule)];
      }),
  ];
  if (lines.length === 0) return undefined;
  return `${PERMISSIONS_HEADING}\n\n${INTRO}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
}

const HEADING_LINE = /^## Permissions[ \t]*\r?$/m;

/**
 * `instructions` with the `## Permissions` section replaced by `section`, or removed when
 * `section` is undefined. The section runs from its heading to the next `## ` heading or the
 * end, so a chain of moves never stacks copies. A new section goes at the end.
 */
export function withPolicySection(instructions: string, section: string | undefined): string {
  let text = instructions;
  const start = HEADING_LINE.exec(text);
  if (start !== null) {
    const after = text.slice(start.index + start[0].length);
    const next = /^## /m.exec(after);
    const end = next === null ? text.length : start.index + start[0].length + next.index;
    text = `${text.slice(0, start.index).replace(/\s+$/, "")}${end === text.length ? "" : `\n\n${text.slice(end)}`}`;
  }
  if (section === undefined) return text === "" ? text : `${text.replace(/\s+$/, "")}\n`;
  const body = text.replace(/\s+$/, "");
  return body === "" ? section : `${body}\n\n${section}`;
}

const RULE_FIELD = /^rule:([1-9]\d*)$/;

/** The places (from 1) of the `rule:<n>` items in `items`, in range for `policy`. */
export function ruleIndexes(policy: Policy, items: readonly Item[]): number[] {
  const places = new Set<number>();
  for (const { field } of items) {
    const n = Number(RULE_FIELD.exec(field)?.[1]);
    if (Number.isInteger(n) && n <= policy.rules.length) places.add(n);
  }
  return [...places].sort((a, b) => a - b);
}

const everyRule = (policy: Policy): number[] => policy.rules.map((_rule, i) => i + 1);

/**
 * Fits the policy of `bundle` to a target before `write`. A target whose `policy` capability is
 * `"text"` gets the whole policy as a `## Permissions` section of the instructions and one
 * `approximated` item per rule (and one for the mode); `false` drops it with one `skipped` item;
 * `"native"` leaves the bundle to the adapter. The manifest keeps `policy` in every case but
 * `false`, so a folder target carries it on. Returns a new Bundle; `bundle` is left as it was.
 */
export function fitPolicy(
  bundle: Bundle,
  capability: AdapterCapabilities["policy"],
  targetName: string,
): { bundle: Bundle; approximated: Item[]; skipped: Item[] } {
  const { policy } = bundle.manifest;
  if (policy === undefined || capability === "native") {
    return { bundle, approximated: [], skipped: [] };
  }
  if (capability === false) {
    const { policy: _policy, ...manifest } = bundle.manifest;
    return {
      bundle: { ...bundle, manifest },
      approximated: [],
      skipped: [{ field: "policy", detail: `${targetName} does not support policy` }],
    };
  }
  const reason = `${targetName} has no per-agent permission rules`;
  const section = renderPolicySection(policy, { mode: true, rules: everyRule(policy) });
  return {
    bundle: { ...bundle, instructions: withPolicySection(bundle.instructions, section) },
    approximated: textOnlyItems(policy, { mode: true, rules: everyRule(policy) }, reason),
    skipped: [],
  };
}

/**
 * The report items for what went to text: `policy` for the mode (when `mode` and the policy has
 * one) and `rule:<n>` per place, each detail `written as text in AGENTS.md; <reason>`.
 */
export function textOnlyItems(
  policy: Policy,
  which: { mode: boolean; rules: readonly number[] },
  reason: string,
): Item[] {
  const detail = `${AS_TEXT}${reason}`;
  return [
    ...(which.mode && policy.mode !== undefined
      ? [{ field: "policy", detail: `mode ${policy.mode} ${detail}` }]
      : []),
    ...which.rules.map((n) => ({ field: `rule:${n}`, detail })),
  ];
}

/**
 * After a native target's `write`: the `moved` item for the policy, counting the rules the
 * adapter did not hand back as `rule:<n>` in `approximated`, and the mode unless the adapter
 * handed back `policy` itself. `undefined` when nothing was enforced.
 */
export function policyMovedItem(
  policy: Policy | undefined,
  approximated: readonly Item[],
  targetName: string,
): Item | undefined {
  if (policy === undefined) return undefined;
  const asText = new Set(ruleIndexes(policy, approximated));
  const modeAsText = approximated.some(({ field }) => field === "policy");
  const enforced = policy.rules.length - asText.size;
  const mode = modeAsText ? undefined : policy.mode;
  if (enforced === 0 && mode === undefined) return undefined;
  const parts = [
    ...(mode === undefined ? [] : [`mode ${mode}`]),
    ...(enforced === 0 ? [] : [`${enforced} rule${enforced === 1 ? "" : "s"}`]),
  ];
  return { field: "policy", detail: `${parts.join(", ")} enforced by ${targetName}` };
}
