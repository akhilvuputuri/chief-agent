# 136 — What must an owner's approval be tied to?

Work date: 2026-10-31. Written: 2026-10-31.
Status: tested on synthetic jobs in CI; deployment recorded in [releases](../releases.md). No live use of `coding_job_update` yet.

## User-visible problem and preceding iteration

Job `a30098ba` finished implementation and passed its checks, then Gemini failed the same review step three times ([lessons](coding-agent-lessons.md)). The owner asked to use Opus 5.5 as reviewer on that job. I changed the job's settings with a guarded production update and told the owner it could resume. It could not: the next resume stopped with "Requirements must be confirmed before implementation".

## Evidence

- **Measured:** the resume on 31 October created revision 4 and paused at provisioning with that message. The settings carried the new reviewer.
- **Code:** `requirementScope` hashed the job, objective, context, base commit, whole settings block and plan, and an approval is valid only for a matching hash. So the edit made the approval unmatchable.
- **Not checked before the edit:** what depended on the settings. I had only read how the reviewer model was used.

## Diagnosis and alternatives

The binding is right, and its scope was too wide. The approval exists because Chief is a model and could change the requirements after the owner approves; without a binding, the approval would cover text the owner never saw. That reasoning applies only to what the owner read.

The owner's argument settled the rest: a plan is a spec, so any agent can implement it. Models, limits and the worker image say how the job runs. CI and review check the result. A stale base commit is caught by rebase, CI and review. Merge rules matter, but the merge gate and the Merge card enforce them separately.

Alternatives rejected:

- Rewriting the stored approval to match the edited settings. That would fake the owner's sign-off.
- Removing only the models from the hash. It keeps the rest of the rigidity with no reason behind it.
- Excluding the reviewer but keeping a model-specific approval step. The owner rejected that: at most, ask once.

## Implementation and review

- `src/coding/requirements.ts`: the scope is the job, objective, context and plan. `requirementScopes` also accepts the earlier format, so delivered cards and recorded approvals keep working.
- `src/coding/controller.ts`: `coding_job_update` changes models and limits on a stopped job. It writes the change, a carried approval and an owner notice in one statement, guarded by revision, settings and checkpoint.
- A model change for the current step gives that step a new session scope, so the worker starts fresh on the same files. A review gets a new round, because the host refuses a review session that does not match its candidate and round. Independent review caught this: the first version invented a scope, and every later checkpoint would have been refused. This is host-side, so the worker image is unchanged.
- The Merge card now names the coder as well as the reviewer.

Limitations:

- An owner card delivered under the earlier scope stops matching if that job's settings then change. It fails closed, and the owner asks for a fresh brief.
- `a30098ba` cannot recover through this: its approval no longer matches anything, and restoring it would need another manual edit. A new job replaces it.
- A coder repairing review findings keeps its session across a coder change, which is untested.

## Verification and outcome

- **Tested:** `tests/coding-job-update.test.ts` covers the narrowed scope, the earlier format, carrying, retries, key conflicts and refusals, and runs a real worker through a reviewer switch, in CI. `tsc` passes locally. Local test runs stalled while macOS `syspolicyd` was pegged, so the tests' first complete run is CI's.
- **Not measured:** a live job update, and an Opus 5.5 review on a Pi job.
