# v0.3 session integration

Based on the owner's Claude Code/MCP draft and the subsequent preview-before-write discussion.

Deliver one openteleport mcp stdio subcommand in the existing package and a Claude Code plugin in
plugins/claude-code, with a root marketplace manifest. Preserve existing explicit CLI defaults. The interactive wizard refuses existing export archives and saves unique reports; explicit export offers the same policy through --no-overwrite. Exclusive creation protects existing entries, but an interrupted write can leave a partial new archive. Do not change
adapter implementations in this PR; Codex round-trip corrections are reviewed independently in PR #4.

Expose discovery, metadata inspection and validation, then export/import/move preview tools and an apply
tool. Keep replace unavailable. The session stores bounded, expiring source snapshots and consumes each
plan once before writing. Use the existing engine for every transfer, preserve all report fields and
handoff status, and keep diagnostics off stdout. Explicit host approval of apply remains the trust boundary.

The preview is a content/capability summary, not an exact destination diff. It does not promise atomic
writes, rollback, application-level behavioral equivalence, or anonymization of personal memory.

Test through the official SDK client over stdio in disposable homes with a restricted PATH. Also test plan
expiry/replay, rejected replace/unknown arguments, snapshots, secrets, partial failure, handoff, exclusive
archive output, and plugin packaging/version consistency. Run the existing test suite and strict typecheck.

v0.4 follows as a separate commit/PR: native OpenClaw and Hermes root teleport commands calling the
existing OpenTeleport implementation. SSH, signatures, and cloud API adapters are outside these two releases.
