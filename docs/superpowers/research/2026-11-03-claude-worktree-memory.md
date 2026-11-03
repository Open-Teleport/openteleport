# Claude Code repository memory verification

The folder path was the wrong memory key for Claude Code worktrees and repository subfolders. Native Claude Code 2.1.273 on Windows shares the primary repository checkout's auto memory across those locations. OpenTeleport now resolves that root before reading or writing memory, keeping each checkout's agent identity sidecar separate.

## Evidence

The [official memory documentation](https://code.claude.com/docs/en/memory#storage-location) describes shared memory across worktrees and subdirectories and the paired `CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_PROJECT_DIR_NAME` override. The installed 2.1.273 binary validates the override as a 1–64 character ASCII letter/digit/underscore/hyphen component and rejects Windows device names. The adapter follows that validation; invalid or unpaired values fall back to the normal root.

Two native probes used temporary Git repositories, a linked worktree, subfolders and a plain folder. Each had an isolated home/config directory, with auto memory explicitly enabled in the probe settings (`autoMemoryEnabled: true`). Distinct synthetic memory markers were seeded under the main and alternative project keys. Claude ran with a dummy API key and an HTTP endpoint bound to loopback. The endpoint captured the outgoing prompt and returned a deliberate 400 response: no model was called and no tools were executed by a model. Exit code 1 is the expected transport stop, not a failed memory assertion.

The baseline probe showed that the four Git locations loaded only the main-repository marker; the plain folder loaded its own. The second probe first imported a synthetic bundle using the corrected OpenTeleport build, then repeated the native capture. The imported fact appeared in all five prompts. Raw prompts, headers, paths and application state are not included here; all temporary state was removed.

| Launch location | Native memory key | Imported fact loaded |
| --- | --- | --- |
| Main checkout | Main checkout | yes |
| Repository subfolder | Main checkout | yes |
| Linked worktree | Main checkout | yes |
| Worktree subfolder | Main checkout | yes |
| Outside Git | Plain folder | yes |

[Sanitized machine-readable evidence](2026-11-03-claude-worktree-memory-evidence.json).

## Regression coverage and limits

Six new regression cases failed before the fix: reads and writes from subfolders, worktrees and worktree subfolders. Seventeen new tests now cover those paths, checkout-specific identities, Git failure before writes, inherited Git routing variables, nested repositories, directory aliases, plain folders and valid/invalid project-key overrides. The final local suite passed 2772 tests (12 skipped); type check, build and fresh installed-package verification passed. Final CI passed on Linux, macOS and Windows.

This verifies prompt loading, not a live model's response or recall quality. The imported build was 0.4.4 plus the pending memory fix, subsequently published as 0.4.5. A separate fresh-cache check of the public 0.4.5 package verified shared-worktree memory import and re-export; see the [release evidence](2026-11-03-release-0.4.5-evidence.json). Custom `autoMemoryDirectory` settings and remote-memory overrides are not resolved. Old misplaced memory folders are not deleted or migrated automatically. Git lookup failures stop an import before any agent, skill or memory write; plain folders do not require Git. IDs remain keyed to the selected checkout so different agents with the same slug in two worktrees do not overwrite each other's identity records.

CI exposed test fixtures keyed by temporary-path aliases on macOS (`/var`) and Windows (8.3 names), while Git correctly returned canonical paths. Fixture roots now use `realpath`, and a separate alias regression checks that repository memory is still loaded through a directory alias.
