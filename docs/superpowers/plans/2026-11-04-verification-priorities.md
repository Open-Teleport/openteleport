# Verification priorities after 0.4.7

Updated 2026-11-04. Continue in separate `codex/` branches; check open PRs before starting a file area Claude may be editing. Each runtime check uses synthetic data and records application/package versions and limitations.

| Priority | Work | Done when | Current status |
| --- | --- | --- | --- |
| 1 | Public release consistency | npm latest/provenance/gitHead, fresh install, production version and release notes agree; STATUS reflects 0.4.7 | Public package and production verified; documentation in this change |
| 2 | Real SSH | Published CLI transfers both directions through an actual server, including cold npx and quoted path | Passed on Windows OpenSSH to Linux, folder adapter; see research report |
| 3 | Grok Bot #17 | Synthetic paste import persists, fresh-chat recall succeeds, genuine export ZIP is read, demo table records actual behavior | Passed on Grok Bot 0.78.1: paste, fresh-Bot memory recall, genuine ZIP and folder round trip; scoped evidence recorded |
| 4 | Codex #20 | UI invocation is observed or explicitly established unsupported, generated memory filenames are observed, report/demo updated | Core runtime passed earlier; UI unverified and memory store empty |
| 5 | Enforced permission rules | Claude Code denies a harmless prohibited tool action, OpenClaw loads per-agent deny/allow, Codex role lacks the denied shell tool; allowed controls still work | Unit/fixture coverage only; real application tests pending |
| 6 | Pilot | One technical user, one personal-assistant scenario and one team scenario record transfer time, losses and actual reuse | Use docs/integrations/pilot.md |

For permission checks, distinguish parsing a setting from enforcing it. Text fallback must be reported as advisory; a policy carried into AGENTS.md is not a security boundary. Use a synthetic source and reversible denied actions, verify preserved restrictions on update/copy, then decide whether any adapter mapping needs a patch.

Grok UI recovered after restart and step 3 passed with scoped live evidence. Do not generalize the minimal instruction/fact check to untested export fields. Codex memory filenames must come from genuine generated state; do not fabricate files and call that runtime evidence. These blockers do not prevent permission tests or the pilot.

After each successful change: update README/demo/STATUS as applicable, record sanitized evidence, run relevant checks and PR CI, merge, and prepare an English X draft with artwork. Publish a new npm patch only for runtime/package changes. Close issues only when their acceptance evidence exists. No automated X posting is authorized.
