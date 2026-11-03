# Permission rules implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `policy` in `jetpack.json` travels with the agent: enforced natively where the target can, written as a `## Permissions` section of the instructions where it cannot, and reported per rule.

**Architecture:** `src/core/policy.ts` holds the types, the text rendering and the native/text split; the engine applies it after `diffCapabilities`; each adapter declares `policy: "native" | "text"` and the native ones map rules in their read and write.

**Tech Stack:** TypeScript, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-permission-rules-design.md`

## Global Constraints

- `schemaVersion` stays `"0.1"`; `policy` is written only when non-empty.
- No adapter edits a project- or user-wide settings file.
- Report wording: native rules count under `policy` in Moved; each text-only rule is `rule:<n>` in Approximated with detail starting `written as text in AGENTS.md; `.
- Commits as author Story, no attribution trailers.

## Review Focus

- A bundle whose instructions already hold a `## Permissions` section: the section is replaced, not stacked (test in Task 2).
- A rule with `on: "tool"` and no `tool`: schema rejects it (Task 1).
- A pattern that looks like a secret: scanned (Task 1 test asserts `scanSecrets` sees manifest patterns).
- A native adapter that lists `rule:<n>` out of range: engine ignores it with a warning (Task 2).
- Same-app round trip keeps the native form (Tasks 3, 4).

---

### Task 1: Schema and `policy.ts`

**Files:** Modify `src/core/schema.ts`; Create `src/core/policy.ts`; Test `test/core/schema.test.ts`, `test/core/policy.test.ts`; regenerate `schema/jetpack.schema.json` (`npm run build && npm run schema`).

**Produces:** `PolicySchema`, `Policy`, `PolicyRule`, `PolicyMode`, `PolicyScope`; `renderPolicySection(policy, rules: number[] | "all"): string`; `withPolicySection(instructions, section | undefined): string` (replaces an existing `## Permissions` section up to the next `## ` heading or the end); `PERMISSIONS_HEADING = "## Permissions"`.

- [ ] Tests: schema accepts the example from the spec; rejects `on: "tool"` without `tool`, unknown `effect`, empty `rules` with no `mode`; `renderPolicySection` gives the five wordings from spec section 5; `withPolicySection` appends, replaces, and strips when `section` is undefined.
- [ ] Implement; `npm run schema`; commit `feat(core): policy field and text rendering`.

### Task 2: Engine, report, inspect

**Files:** Modify `src/core/engine.ts`, `src/adapters/types.ts` (`policy` in `AdapterCapabilities`), every `src/adapters/*/index.ts` (`policy: "text"` for now), `src/commands/inspect.ts`; Test `test/core/engine.test.ts`, `test/commands/inspect.test.ts`.

**Produces:** `applyPolicy(bundle, capabilities, targetName, approximated: Item[]): { bundle, moved?: Item, approximated: Item[] }` in `policy.ts`, used by `deliver` after `to.write` for the text target case before write and for native leftovers after write (see note).

Note on order: for a `"text"` target the section must be in `instructions` before `write`, so `deliver` renders it before `write` from the full rule list. For a `"native"` target the adapter returns `rule:<n>` items; since the instructions were already written, the native adapter writes the section itself through `withPolicySection` from the rules it could not enforce (helper exported from `policy.ts`), and the engine only rewrites the report detail. Both paths share the rendering.

- [ ] Tests: text target gets the section and `rule:<n>` approximated items with the `<app> has no per-agent permission rules` reason; a target with no policy and an empty bundle policy adds nothing; moved `policy` item reads `mode ask, 2 rules enforced by <app>`; `inspect` prints `policy: mode ask, 4 rules` and `--json` carries it.
- [ ] Implement; commit `feat(engine): carry policy, as text where the target cannot enforce it`.

### Task 3: Claude Code native

**Files:** `src/adapters/claude-code/frontmatter.ts`, `read.ts`, `write.ts`, `index.ts`; tests under `test/adapters/claude-code/`.

- [ ] Frontmatter: parse and write `permissionMode` and `disallowedTools` (list or comma string).
- [ ] Read: `mode` from `permissionMode` per spec table; `disallowedTools` → `deny tool`; project `.claude/settings.json` `permissions.allow|ask|deny` → rules on `tool` with the rule string as `tool` (`Bash(git *)` stays one token), warning "project-wide in Claude Code; exported with the agent".
- [ ] Write: `mode` → `permissionMode`; `deny tool` without `(`→ `disallowedTools`; the rest → section via `withPolicySection` and `rule:<n>` with reason `Claude Code takes pattern rules only in settings files`.
- [ ] Round trip test: read → write → read keeps mode and disallowedTools.

### Task 4: OpenClaw native

**Files:** `src/adapters/openclaw/read.ts`, `write.ts`, `paths.ts`, `index.ts`; tests under `test/adapters/openclaw/`.

- [ ] Read `agents.entries.<id>.tools.allow|deny|profile` and `sandbox.workspaceAccess` per spec.
- [ ] Write with the existing per-agent config path (`setAgentConfig` family) per spec; leftovers to section with reason `OpenClaw sets ask and exec approvals globally`.
- [ ] Round trip test with groups and `*` kept.

### Task 5: Codex, Hermes, Letta partial

- [ ] Codex read: `mode` from global settings with the warning; write `features.shell_tool = false` for `deny shell`; rest text.
- [ ] Hermes read: `approvals.deny`, `command_allowlist`, `approvals.mode` with the global warning; capability `"text"`.
- [ ] Letta: read `requires_approval` where the adapter already reads tools; write `modify_approval` lines into the handoff script; else text.

### Task 6: Docs

- [ ] README (format section: `policy`; adapters table column or note), `docs/design.md` pointer to the spec, `docs/STATUS.md` (what is verified: unit tests and fixtures only, no real app checked for policy yet), CHANGELOG Unreleased (`### Added`, with the 0.4.6-and-older note).
- [ ] `npm run lint && npm run build && npm test`.
