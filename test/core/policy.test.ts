import { describe, expect, it } from "vitest";
import {
  AS_TEXT,
  describeRule,
  fitPolicy,
  policyMovedItem,
  renderPolicySection,
  ruleIndexes,
  summarizePolicy,
  textOnlyItems,
  withPolicySection,
} from "../../src/core/policy.js";
import type { Bundle, Policy } from "../../src/core/schema.js";

const POLICY: Policy = {
  mode: "ask",
  rules: [
    { effect: "deny", on: "files.write", pattern: "./.env" },
    { effect: "ask", on: "shell", pattern: "git push *" },
    { effect: "allow", on: "shell", pattern: "npm test" },
    { effect: "deny", on: "tool", tool: "WebFetch" },
  ],
};

const SECTION = [
  "## Permissions",
  "",
  "These rules came with the agent. The app you are running in does not enforce them; follow",
  "them yourself.",
  "",
  "- Mode: ask before any action that changes files or runs commands.",
  "- Never write files matching `./.env`.",
  "- Ask before running shell commands matching `git push *`.",
  "- Shell commands matching `npm test` are allowed without asking.",
  "- Never use the tool `WebFetch`.",
  "",
].join("\n");

const bundle = (instructions: string, policy: Policy | null = POLICY): Bundle => ({
  manifest: {
    schemaVersion: "0.1",
    id: "01J9ZT3Z9K8QGQ2M6Q4Y3V6B2T",
    name: "Ada",
    models: [],
    capabilities: [],
    ...(policy === null ? {} : { policy }),
  },
  instructions,
  skills: [],
  routines: [],
  facts: [],
  notes: [],
  files: [],
  unknownPaths: [],
});

describe("describeRule", () => {
  it("states the five shapes of the design", () => {
    expect(POLICY.rules.map(describeRule)).toEqual([
      "Never write files matching `./.env`.",
      "Ask before running shell commands matching `git push *`.",
      "Shell commands matching `npm test` are allowed without asking.",
      "Never use the tool `WebFetch`.",
    ]);
  });

  it("drops the matcher when a rule has no pattern", () => {
    expect(describeRule({ effect: "deny", on: "network" })).toBe("Never use the network.");
    expect(describeRule({ effect: "ask", on: "files.read" })).toBe("Ask before reading files.");
    expect(describeRule({ effect: "allow", on: "browser" })).toBe(
      "Browser use is allowed without asking.",
    );
    expect(describeRule({ effect: "allow", on: "tool", tool: "exec", pattern: "ls *" })).toBe(
      "The tool `exec` matching `ls *` is allowed without asking.",
    );
  });

  it("keeps a backtick in a pattern from closing the code span", () => {
    expect(describeRule({ effect: "deny", on: "shell", pattern: "a`b" })).toBe(
      "Never run shell commands matching `a'b`.",
    );
  });
});

describe("renderPolicySection", () => {
  it("renders the mode and the rules asked for, in order, once each", () => {
    expect(renderPolicySection(POLICY, { mode: true, rules: [4, 2, 2, 1, 3] })).toBe(SECTION);
  });

  it("leaves out the mode and ignores a place out of range", () => {
    expect(renderPolicySection(POLICY, { mode: false, rules: [2, 9] })).toBe(
      `${SECTION.split("\n").slice(0, 5).join("\n")}\n- Ask before running shell commands matching \`git push *\`.\n`,
    );
  });

  it("is undefined when there is nothing to say", () => {
    expect(renderPolicySection(POLICY, { mode: false, rules: [] })).toBeUndefined();
    expect(renderPolicySection({ rules: POLICY.rules }, { mode: true, rules: [] })).toBeUndefined();
  });
});

describe("withPolicySection", () => {
  it("appends the section after the instructions", () => {
    expect(withPolicySection("Be brief.\n", SECTION)).toBe(`Be brief.\n\n${SECTION}`);
    expect(withPolicySection("", SECTION)).toBe(SECTION);
  });

  it("replaces an existing section up to the next heading, so moves do not stack", () => {
    const text = `Be brief.\n\n## Permissions\n\nOld.\n\n- Never use the network.\n\n## Style\n\nShort.\n`;
    expect(withPolicySection(text, SECTION)).toBe(`Be brief.\n\n## Style\n\nShort.\n\n${SECTION}`);
    expect(withPolicySection(withPolicySection(text, SECTION), SECTION)).toBe(
      withPolicySection(text, SECTION),
    );
  });

  it("removes the section when given none", () => {
    expect(withPolicySection(`Be brief.\n\n${SECTION}`, undefined)).toBe("Be brief.\n");
    expect(withPolicySection("Be brief.\n", undefined)).toBe("Be brief.\n");
  });
});

describe("fitPolicy", () => {
  it("writes the whole policy as text for a text target and reports every rule", () => {
    const fitted = fitPolicy(bundle("Be brief.\n"), "text", "Hermes");
    expect(fitted.bundle.instructions).toBe(`Be brief.\n\n${SECTION}`);
    expect(fitted.bundle.manifest.policy).toEqual(POLICY);
    const reason = `${AS_TEXT}Hermes has no per-agent permission rules`;
    expect(fitted.approximated).toEqual([
      { field: "policy", detail: `mode ask ${reason}` },
      { field: "rule:1", detail: reason },
      { field: "rule:2", detail: reason },
      { field: "rule:3", detail: reason },
      { field: "rule:4", detail: reason },
    ]);
    expect(fitted.skipped).toEqual([]);
  });

  it("drops the policy for a target without one", () => {
    const fitted = fitPolicy(bundle("Be brief.\n"), false, "Grok Bot");
    expect(fitted.bundle.manifest.policy).toBeUndefined();
    expect(fitted.bundle.instructions).toBe("Be brief.\n");
    expect(fitted.skipped).toEqual([{ field: "policy", detail: "Grok Bot does not support policy" }]);
  });

  it("leaves a native target and a bundle without a policy alone", () => {
    const native = bundle("Be brief.\n");
    expect(fitPolicy(native, "native", "OpenClaw").bundle).toBe(native);
    const none = bundle("Be brief.\n", null);
    expect(fitPolicy(none, "text", "Hermes")).toEqual({ bundle: none, approximated: [], skipped: [] });
  });
});

describe("the report items", () => {
  it("names the rules a native target handed back and counts the rest as enforced", () => {
    const items = textOnlyItems(POLICY, { mode: false, rules: [2, 3] }, "OpenClaw sets ask globally");
    expect(ruleIndexes(POLICY, [...items, { field: "rule:9", detail: "" }, { field: "skill:x", detail: "" }])).toEqual([2, 3]);
    expect(policyMovedItem(POLICY, items, "OpenClaw")).toEqual({
      field: "policy",
      detail: "mode ask, 2 rules enforced by OpenClaw",
    });
  });

  it("is undefined when nothing was enforced", () => {
    const all = textOnlyItems(POLICY, { mode: true, rules: [1, 2, 3, 4] }, "x");
    expect(policyMovedItem(POLICY, all, "Hermes")).toBeUndefined();
    expect(policyMovedItem(undefined, [], "Hermes")).toBeUndefined();
  });

  it("says 1 rule in the singular and summarizes a policy", () => {
    const items = textOnlyItems(POLICY, { mode: true, rules: [1, 2, 3] }, "x");
    expect(policyMovedItem(POLICY, items, "Codex")?.detail).toBe("1 rule enforced by Codex");
    expect(summarizePolicy(POLICY)).toBe("mode ask, 4 rules");
    expect(summarizePolicy({ rules: [POLICY.rules[0]!] })).toBe("1 rule");
  });
});
