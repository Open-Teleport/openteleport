# Permission rules in a `.jetpack`: design

Date: 2026-11-03. Status: approved by the owner ("rób wszystko"); the open question from the
brainstorm (what the report shows for a rule the target cannot enforce) is settled in section 5.

## 1. Intent

An agent is more than its instructions: it is also what it may and may not do. Today a move
carries instructions, persona, skills, memory and routines, and drops the permission posture:
"ask before any shell command", "never touch `.env`", "no network". A user who moved an agent
from Claude Code to OpenClaw asked whether the rules travel too. They do not. This design makes
them travel, and makes the report say exactly where each rule landed.

The principle stays the one in `docs/design.md`: carry what the format can state, write it
natively where the target enforces it, and never pretend. A rule the target cannot enforce is
written where the model will read it, as text, and the report says so per rule.

## 2. Goals, non-goals, anti-goals

Goals

- A `policy` in `jetpack.json`: an overall posture and a list of rules, app-neutral.
- Every adapter reads what its app enforces per agent into `policy`, keeping the native form
  in its `x-<app>` extension for a lossless same-app round trip.
- Every target either enforces a rule natively or writes it into the instructions as text.
- The report lists each rule under `Moved` (enforced natively), `Approximated` (text only) or
  `Skipped` (dropped), never silently.

Non-goals

- Editing a target's project- or user-wide settings (`.claude/settings.json`,
  `~/.codex/config.toml`, `~/.hermes/config.yaml`, `.gemini/settings.json`). A move touches
  the agent, not the machine. What is only global in an app is read with a warning and never
  written.
- Translating pattern syntax between apps (`Bash(git *)` versus `git *` versus
  `run_shell_command(git)`). A pattern is carried as the source wrote it, and a target of
  another app writes it as text.
- OpenClaw exec approvals in its SQLite state. The adapter does not open that database.

Anti-goals

- Widening permissions on a move. A rule that cannot be enforced natively never becomes an
  allow; the fallback is text, and the posture a target cannot set is reported, not dropped.
- A move that changes how other agents in the target behave.

## 3. The format

`jetpack.json` gains one optional field. `schemaVersion` stays `0.1`; the field is written
only when it is non-empty, and OpenTeleport 0.4.6 and older refuse a manifest that has it (they
reject unknown keys), which is documented in the CHANGELOG. Readers of the same or a later
version accept it.

```json
"policy": {
  "mode": "ask",
  "rules": [
    { "effect": "deny",  "on": "files.write", "pattern": "./.env" },
    { "effect": "ask",   "on": "shell",       "pattern": "git push *" },
    { "effect": "allow", "on": "shell",       "pattern": "npm test" },
    { "effect": "deny",  "on": "tool",        "tool": "WebFetch" }
  ]
}
```

- `mode` (optional): `"ask"` (the app confirms risky actions), `"auto"` (no confirmation),
  `"readOnly"` (no writes, no shell). Absent means the app's default.
- `rules`: in order; an empty list is left out together with `mode` when both are absent.
  - `effect`: `"allow"`, `"deny"` or `"ask"`.
  - `on`: `"shell"`, `"files.read"`, `"files.write"`, `"network"`, `"browser"`,
    `"computerUse"`, `"scheduler"` or `"tool"`. The first seven follow `capabilities`;
    `filesystem` is split because every app distinguishes reading from writing.
  - `tool`: required when `on` is `"tool"`, the app's own tool name (`WebFetch`,
    `mcp__github__*`, `exec`, `web_search`). Carried verbatim.
  - `pattern` (optional): the app's own matcher for the rule (a command prefix, a path, a
    domain). Carried verbatim. A rule without a pattern applies to the whole scope.
- Precedence, when a target enforces natively: deny over ask over allow, as Claude Code and
  OpenClaw both do.

Zod: `PolicySchema` in `src/core/schema.ts`, strict objects, `rules` non-empty when `policy`
is present or `mode` set. `schema/jetpack.schema.json` regenerated.

## 4. What each app can hold

`AdapterCapabilities` gains `policy: "native" | "text" | false`.

| App | Reads into `policy` | Writes natively | Else |
| --- | --- | --- | --- |
| Claude Code | subagent `permissionMode` → `mode` (`default`/`manual` → ask, `acceptEdits` → ask plus `allow files.write`, `auto`/`dontAsk`/`bypassPermissions` → auto, `plan` → readOnly); `disallowedTools` → `deny tool:<name>`; `tools` stays in `x-claude-code.tools` and `capabilities` as today. Project `.claude/settings.json` `permissions` is read as rules with the warning "project-wide in Claude Code; exported with the agent". | `mode` → `permissionMode`; `deny tool:<name>` without a pattern → `disallowedTools`. | A rule with a pattern, and allow/ask rules, go to text: Claude Code only takes those in settings files, which a move does not edit. |
| OpenClaw | `agents.entries.<id>.tools.allow`/`deny`/`profile` → `allow`/`deny tool:<name>` and `x-openclaw.tools`; `sandbox.workspaceAccess: "ro"` → `mode: readOnly`. | `tool` rules → `tools.allow`/`tools.deny` on the agent entry (groups and `*` carried as given); `deny shell` → `deny exec`; `deny files.write` → `deny write, edit, apply_patch`; `deny network` → `deny group:web`; `mode: readOnly` → `sandbox.workspaceAccess: "ro"` plus the write denies. | Patterns on shell rules (exec approvals live in SQLite) and `ask` rules go to text; `mode: ask`/`auto` go to text, since OpenClaw's ask is global. |
| Codex | global `approval_policy`/`sandbox_mode` → `mode` (`read-only` → readOnly; `never` → auto; `on-request` → ask) with the warning "global in Codex, not per agent"; stays in `x-codex` as today. | `deny shell` → `features.shell_tool = false` in the agent file. | Everything else to text: an agent file may not set approval or sandbox. |
| Hermes | `approvals.deny` globs → `deny shell <glob>`; `command_allowlist` → `allow shell <text>`; `approvals.mode` → `mode` (`manual` → ask, `off` → auto, `smart` → ask); all with the warning "global in Hermes". | nothing | text |
| Letta | `requires_approval` on the agent's tools → `ask tool:<name>` (local backend only, as the adapter reads today). | `ask tool:<name>` → `modify_approval` lines in the handoff script. | text |
| folder, Gemini CLI, Cline, Codex (rest), OpenBot, Grok Bot | nothing (`folder` keeps `policy` in the manifest as is) | nothing | text |

`folder` as a target writes the manifest with `policy` intact and also the text section, so a
tool that opens the folder sees the rules; as a source it reads `policy` back from the manifest
and, when the text section is the only thing there, leaves `policy` empty (text is not parsed
back into rules; no model, no guessing).

## 5. The text fallback and the report

The engine, not each adapter, writes the fallback. After `diffCapabilities`, for a target whose
`policy` capability is `"text"`, or for the rules a `"native"` adapter hands back as
`approximated` with field `rule:<n>`, the engine appends one section to `instructions`:

```markdown

## Permissions

These rules came with the agent. The app you are running in does not enforce them; follow
them yourself.

- Mode: ask before any action that changes files or runs commands.
- Never write files matching `./.env`.
- Ask before running shell commands matching `git push *`.
- Shell commands matching `npm test` are allowed without asking.
- Never use the tool `WebFetch`.
```

One line per rule, fixed wording per `effect` and `on` (a small table in
`src/core/policy.ts`), the pattern or tool name in backticks, the mode first when set. The
section is appended once; a `## Permissions` heading already in the instructions (a bundle
exported from a text target and moved on) is replaced, so a chain of moves does not stack
copies. A rule is listed in the section exactly when it is not enforced natively, so a native
target with every rule mapped writes no section.

The report answers the brainstorm's question directly:

- `Moved`: `policy`, "mode ask, 3 rules enforced by OpenClaw" (native ones only).
- `Approximated`: one item per rule the target could not enforce, field `rule:<n>`, detail
  "written as text in AGENTS.md; OpenClaw does not enforce ask rules for shell patterns" (the
  adapter supplies the reason; the engine supplies the "written as text" part), and
  `policy`, "mode ask written as text; Codex sets approval globally".
- `Skipped`: only when `policy` is `false` (no adapter is, in this version; the value exists so
  an adapter that writes nowhere a model reads, such as a future one, can say so).
- `inspect` prints the policy (mode and rules) and `validate` validates it.

Counting: a native adapter lists, in `WriteResult.items.approximated`, the rules it did not
enforce as `rule:<n>` (n from 1, in `policy.rules` order) with a reason. The engine then writes
those rules as text and prefixes each detail with "written as text in AGENTS.md; ". A `"text"`
adapter needs no code for this: the engine lists every rule and the mode that way with the
reason "<app> has no per-agent permission rules".

## 6. Round trips

- Same app: the native form in `x-<app>` wins on write when it is present and `policy` is
  unchanged from what the read produced (the adapter compares); an edited `policy` wins over a
  stale `x-<app>`. This keeps OpenClaw groups and profiles, and Claude Code's `tools` list,
  intact.
- Text target then native target: the second read gets `policy` from the manifest (`folder`)
  or nothing (apps that do not keep the manifest), never from the text section.
- Secrets: a pattern is scanned like any other string in the manifest.

## 7. Out of scope, for a later version

- Pattern translation between apps.
- Reading OpenClaw exec approvals from SQLite; Letta tool rules (`InitToolRule` and the
  like are orchestration, not permissions).
- Gemini CLI `.gemini/settings.json` `tools.*` and Cline auto-approve: project- or
  UI-level, not per agent.
- An `openteleport policy` command to edit rules in an archive.

## 8. Left to the builder

- Exact TypeScript types and where `src/core/policy.ts` ends and the adapters begin.
- Test fixtures for each native mapping; the Claude Code frontmatter parser gains
  `permissionMode` and `disallowedTools` (both ignored today).
- The wording table for the text section (section 5 gives the five shapes).
