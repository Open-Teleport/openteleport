# Agent transfer pilot

Use this pilot to check whether a transferred agent retains useful instructions, skills and context,
and whether OpenTeleport saves effort compared with configuring the destination manually.
The reviewer in `examples/pilot-reviewer/` uses fictional Project Cedar data. Keep evaluation prompts
and scoring notes outside that folder so they do not become part of the transferred agent.

## Include all three audiences

The first public release serves technical users, people moving a personal assistant, and teams
sharing agent configurations. Use the same fictional reviewer and task rubric for comparable results,
but record each audience separately. A participant can belong to more than one group; record the
scenario being tested for each attempt.

| Audience | Scenario | Additional evidence |
| --- | --- | --- |
| Technical users | Move a reviewer between two applications they use. | Setup and repair effort compared with manual configuration; repeated use across apps. |
| Personal assistant users | Move the fictional assistant through the guided conversation. | Whether the participant understands the preview, chooses the destination and finishes any handoff without operator help. |
| Teams | Give a colleague a reusable configuration using fictional team context. | Whether the recipient can inspect, install and use it; whether both people understand which memory and shared locations are included. |

Record every intervention by the test operator, including terminal commands and explanations. An
assisted completion does not count as an unassisted completion. Installation prerequisites and missing
interfaces are findings, even when the underlying transfer works.

Use synthetic data for the team scenario. MCP includes structured memory by default; includeMemory=false
excludes structured facts and notes, with omissions shown in the preview and report. Credential scanning
is not anonymization: instructions, skills, memory and other fields may contain personal information.
Evaluate whether participants understand the selection and its limits, including that an update may
remove previously imported destination memory. Use copy for the pilot. The CLI exposes the same selection with --no-memory. Check the native plugin setup for its support.

Recruit across all three audiences and include at least two participants per audience when expanding
to ten participants. Report completion, assistance, repair time and repeat use separately for each
audience; the small groups provide qualitative evidence, not representative adoption estimates.

## Prepare the portable reviewer

From this checkout, with Node >=24 and dependencies installed:

```sh
npm run build
node dist/cli.js validate examples/pilot-reviewer
node dist/cli.js export --from folder --agent . --source-dir examples/pilot-reviewer --out /absolute/new/pilot-reviewer.jetpack
```

Use a new output directory: the ordinary CLI export can overwrite its archive and neighbouring
`move-report.md`. The MCP and native plugin export flows refuse existing archives.
Inspect the archive with `node dist/cli.js inspect /absolute/new/pilot-reviewer.jetpack`.
Expected contents: instructions, persona, one skill, two memory facts, no routines and no attachments. Memory facts are reserialized; Windows CRLF line endings can become LF without changing the facts.
The source folder has no fixed identity; export assigns and retains one through the normal identity cache.

Import into a disposable, explicitly selected application profile using MCP preview/apply or the
documented native plugin. Use copy mode. Review shared write locations before applying: setting a
target directory alone does not isolate shared skills or user memory. For filesystem-only checks,
import into a fresh folder instead of an application. See [MCP setup](mcp.md) and
[native plugin setup](native-plugins.md) for the supported entry points.

Run the agent in its source application before moving it to a second application. Record which agent
was selected and how you selected it. Copy the same prompts below into fresh sessions in both apps;
do not paste this scoring guide or the expected answers into either session. Save the two outputs locally.
The task material is synthetic; application model calls may still incur the account's normal charges.

## Task one

```text
Review this function for an input that can make it fail. Also state the export format supported by
Project Cedar from your available context. Do not run the code.

def mean(values):
    return sum(values) / len(values)
```

Award one point for each item:

- Identifies division by zero for an empty input.
- Grounds the finding in `len(values)` or the division expression, without claiming a test was run.
- Suggests one concrete check or handling of empty input.
- Uses the requested four labelled bullets and reports CSV from the transferred project context.

## Task two

```text
Review this release note: "All ten unit tests passed, so deployment and rollback are verified."
The note provides no other evidence. What can we conclude, and what should we check next?
Also state Project Cedar's supported export format from your available context.
```

Award one point for each item:

- Distinguishes passed unit tests from proof of deployment and rollback.
- Grounds that distinction in the supplied claim and the absence of deployment evidence.
- Suggests one concrete deployment or rollback check without claiming it already happened.
- Uses four labelled bullets, stays under 160 words and correctly reports CSV.

Eight points is a rubric for these two tasks, not a general intelligence or migration benchmark.
A failure to use a skill is not proven merely by wording: record whether the host exposes skill-use
evidence. If it does not, mark skill invocation unknown. Preserved files and useful output are separate
observations. Different models, prompts injected by the host and permission settings can change output.

## Record one transfer

Copy this form into a private note. Do not commit account names, personal paths, prompts from real work
or private model outputs to this public repository.

| Field | Result |
| --- | --- |
| Participant alias and date | |
| Audience and scenario tested | |
| Operator interventions and assisted / unassisted completion | |
| OpenTeleport commit or package version | |
| Source app, version, model and selected agent | |
| Target app, version, model and selected agent | |
| Interface used and conflict mode | |
| Setup minutes / transfer minutes / repair minutes | |
| Report outcome and any remaining manual step | |
| Unexpected missing or changed fields | |
| Source score / target score out of 8 | |
| Observed skill invocation, or unknown | |
| Exact task requiring repair and what fixed it | |
| Manual setup comparison, measured or estimated | |
| Would you repeat the transfer for real work? Why? | |
| Voluntary second use within seven days | |

If comparing manual setup, time it separately on a clean destination with the same intended content;
do not count an estimate as a measurement. Avoid prompting participants to say the product saved time.

## Decide what to improve

Start with 5 completed transfers spanning at least 3 application pairs, then expand to 10 participants.
These are pilot targets, not completed results. Preserve failed and abandoned attempts in the denominator.
Stop the affected path immediately for source damage, unreported loss, unexpected writes or credential
exposure; reproduce it with synthetic data before another participant tries it.

Prioritize the repeated repair with the greatest user cost. A successful first transfer with no voluntary
repeat use points to a weaker recurring need; investigate that before expanding the adapter list.
Three voluntary second uses within seven days is an initial signal worth investigating, not proof of
product-market fit. Publish only aggregated, consented findings, with setup effort and failed attempts.
