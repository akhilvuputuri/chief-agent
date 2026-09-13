# 20 — Revising instructions without granting code execution

Work: 6–7 September 2026. Written: 14 September 2026.
Status: text-skill versioning and subsequent loading fixes released. [Entry 15](15-portable-plugins.md) covers the later portable-package work.

## Problem and design

Reusable instructions needed to improve through use without silently replacing the procedure already approved for ordinary work. Keeping only the newest text would also make a bad revision difficult to inspect or roll back. [Commit `b770cf8`](https://github.com/akhilvuputuri/companion-agent/commit/b770cf8), integrated through [PR #2](https://github.com/akhilvuputuri/companion-agent/pull/2), added immutable text drafts, append-only evaluation reports and a separate active-version pointer in Postgres.

The agent could draft and evaluate a procedure, then request activation. The gateway required an evaluation report and the owner's exact approval command, bound to that revision and its expected predecessor. Rollback selected a retained version through the same approval boundary. Drafts stayed inactive; concurrent changes and expired or reused approvals could not silently move the active pointer. Using the existing database and tool dispatcher kept these procedures separate from application code, shell access and account permissions. The [versioned-skills guide](../versioned-skills.md) owns the current operations and constraints.

## Iteration: a valid identifier is part of the tool contract

The first read operation accepted a skill key plus an optional private-version UUID. Repository defaults also exposed version labels. Those two concepts looked similar to the model: a placeholder or repository version label supplied as `id` could prevent loading an otherwise available default. The historical [handover](../../HANDOVER.md) records that failure; source changes show how the boundary was repaired.

The first fix, [PR #10 / `375262c`](https://github.com/akhilvuputuri/companion-agent/pull/10), preserved UUID, URL, date-time, length and pattern constraints when translating validated tool definitions into model-facing JSON schemas. Previously strings became only `type: string`. Instructions and the read-tool description also clarified that repository version labels were metadata, not private revision IDs. A mocked runtime test verified key-only loading.

The follow-up, [PR #12 / `94ad8cf`](https://github.com/akhilvuputuri/companion-agent/pull/12), removed the ambiguous choice from the operation itself: `skill_read(key)` loads the approved active version or repository default, while `skill_version_read(key,id)` requires an explicit owner-scoped historical UUID. Host validation still rejects invalid arguments, but ordinary loading no longer asks the model to decide whether to invent or omit a version identifier. The general lesson was to simplify the operation after clarifying the schema, rather than relying on more explanatory prompt text alone.

## Verification and outcome

[Release record `96a2790`](https://github.com/akhilvuputuri/companion-agent/commit/96a2790) documents deployment of the original versioning implementation on 6 September, with 36 TypeScript tests, two OAuth tests, four Python bridge tests and local type/build/format checks. Those counts describe that historical release. Tests covered ownership, draft inactivity, evaluation prerequisites, expiry, single use, stale-head rejection, denial and rollback.

The [7 September verification record](../verification.md#companion-agent-fresh-start--7-september-2026) records passing CI for the split read operations and a real Sol request successfully loading the repository research skill through `skill_read(key)`. This establishes that the repaired path worked in that check. It does not measure a general reduction in model errors or certify the quality of every skill.

An agent-authored evaluation report is recorded evidence, not an independently verified semantic test pass. Owner approval controls activation; it does not turn an unsupported report into a correct one. Automatic periodic review, a dedicated frontier review model for private skills and automatic consolidation were not implemented in this milestone. The later [portable-plugin chapter](15-portable-plugins.md) extends capability/version identity and pins definitions to runs; it does not replace the private activation boundary or prove vendor-wide compatibility. This documentation pass ran no new model calls.
