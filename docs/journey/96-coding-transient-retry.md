# 96 — Can the host retry a coding job once after a transient fault?

Work date(s): 2026-10-19. Written/revised: 2026-10-19.
Status: released (`496fd50`, first deployed in `c1d556b`). The host re-queues a paused coding job once after a classified transient fault, with an owner notice. No live job has exercised it yet.

## User-visible problem and preceding iteration

In the two-week review of coding work (3–17 October 2026), paused jobs waited a long time for the owner. When the cause was a stopped sandbox, a lost heartbeat or a provider outage, the same approved scope usually needed only another attempt. The product constraint in AGENTS.md forbade automatic resumption of paused tasks, so every such pause waited for a manual resume. On 17 October 2026 the owner approved one exception: retry once after a classified transient fault.

This builds on [journal 74](74-coding-provider-recovery.md) (provider recovery inside an attempt) and [journal 92](92-uncertain-coding-write-lock.md) (uncertain coding writes). Those recover within an attempt or settle a write. Neither starts a new attempt.

## Evidence

- **Measured** (private export, 15 coding jobs, 3–17 October 2026): the owner saw 9 pause notices. The median time from a pause to the owner re-engaging was 7.0 hours (range 2.1–25.9 hours), and one pause was never revisited. Model or provider faults paused 5 owner jobs.
- **Measured:** status and nudge messages made up 37% of the owner's coding messages in the same window.
- **Not measured:** how many of the 9 pauses this classifier would have retried. The earlier pauses did not record a cause, and timeouts, 409 rejections and allocation exhaustion are deliberately excluded. Coverage is therefore a hypothesis until post-release pauses are counted by cause.

Only aggregates are recorded here. The export stays in the private operator workspace.

## Diagnosis and alternatives

A pause has two kinds of cause. Some come from the environment: a sandbox that stopped without a result, a lost worker heartbeat, or a provider 429 or 5xx. Others come from the work itself: an exhausted allocation, a validation failure or a model that never reports. Another attempt helps with the first kind and only wastes allocation on the second.

Alternatives considered:

- **Retry inside the worker.** The worker already retries one terminal HTTP error. It cannot recover from a sandbox or heartbeat loss, because the worker itself is gone.
- **Retry repeatedly with backoff.** A fault that repeats is no longer transient for this job. One retry bounds cost and keeps the owner in control.
- **Remind the owner instead.** This still leaves a manual step for a pause that needs no decision. Clearer pause notices remain separate P1 work.

## Implementation and review

- `src/coding/controller.ts`:
  - `stopped()` now records a `cause` (`sandbox_stopped` or `heartbeat_lost`) in the private `<attempt>:paused` event.
  - `autoRetryOnce()` runs on each tick. One guarded statement:
    - re-queues the oldest eligible job as a new revision keyed `auto-retry:<attempt>`;
    - inserts a pending notice, delivered to the Coding topic, saying the job is retrying once and will wait for the owner if it pauses again.

  A job is eligible when it paused 2 minutes to 1 day ago and its pause is classified as transient. Worker pauses count only if the worker itself paused, its last rejected request was a 429 or 500/502/503/504 with no timeout, finish-reason or provider-failure classification, and no model call completed after that rejection. The job is skipped in any of these cases:
  - publication started, or the job has a PR;
  - cleanup is pending;
  - a lease is held;
  - the owner was revoked;
  - its current revision came from an earlier auto-retry.

- `src/coding/schema.ts`: `autoRetryTransientOnce` (default on) is the host-only off switch.
- `src/runtime.ts`: the `coding_resume` description tells the model that only the host retries.
- AGENTS.md and [coding](../coding.md#transient-auto-retry) record the owner-approved exception.
- `tests/coding-auto-retry.test.ts` covers:
  - one keyed retry with its notice, which is idempotent;
  - the transient classification (heartbeat, 503 and 429 retried; 400 and unclassified not);
  - no second retry;
  - the excluded states and the off switch;
  - a recovered fault before a work-caused pause, a publication-mismatch pause and jobs with a PR;
  - a revoked owner's older job not blocking another job;
  - an unreadable stop reason not being classified as transient;
  - the real tick path that records the cause.

Independent review (Opus 5.5, commit `9435234`) requested changes:

- **F1, high.** An old 429 or 5xx that generation recovery had overcome made any later pause look transient, including failed checks or a missing report. Fixed: no model call may complete after the rejection.
- **F2, high.** A host pause for an agent PR that did not match the reviewed artifact resets `publication_started` and leaves a `:finished` event, so it could be retried without the owner inspecting the PR. Fixed: the worker branch requires the worker's own result to be `paused`, and jobs with a PR are excluded.
- **F3, low.** The oldest candidate belonging to a revoked owner blocked every other retry for a day. Fixed: the first allowed candidate of up to 20 is chosen.
- **F4, low.** The docs named the General topic; coding notices go to the Coding topic. Corrected.
- **S1.** A retried PR-feedback or rebase round would reset its ledger. This is avoided by excluding jobs with a PR.
- **S2.** "Never a second time" overstated the guard: an owner resume creates a new revision that can be retried once. The wording is now exact.
- **S3.** A failed stop-reason lookup was treated as no stated reason. It is now not classified as transient.

While adding these tests, the off-switch test was found to mutate the fixture's shared settings, which silently disabled retries in later tests. It now restores them. The delta re-review approved `b01d226`; the remaining nit was a wording fix in this entry.

Devin Review on `282d907` found three more:

- **High, confirmed.** The host stored `autoRetryTransientOnce` in each job's pinned settings and sent it to workers, whose strict Python settings reject unknown fields. Once the switch was configured, every new Python job would have failed before starting. Fixed: the switch is stripped from the assignment, like `prWorkflow`, with a test.
- **Medium.** Revoked owners' pauses could fill the 20-candidate limit and hide an allowed job. Fixed: the candidate list for the last day is unbounded, with a test using 22 revoked pauses.
- **High, as reported.** A recovered later rejection could let an older one count. The `NOT EXISTS` filter ran before the latest rejection was chosen. Any model call completing after the newer rejection also completes after the older one, so the reported case does not occur through time ordering. The query now judges only the latest rejection, which makes the guarantee explicit.

Both new tests fail on the previous controller.

## Verification and outcome

Tested: 10 focused tests on PGlite, the local application suite (1,010 TypeScript and 51 JavaScript script tests) and hosted CI on the merged head. The local Python coding benchmark test fails on the `chief-protocol-*` fixtures on this Mac, and fails the same way on unchanged main; hosted CI passed. Pending: a live transient pause that is retried once and either completes or waits for the owner.

### Release closure — 19 October 2026

[PR 257](https://github.com/akhilvuputuri/chief-agent/pull/257) merged as `496fd50`. Exact-head independent review approved `44cfeef` in round 6, and hosted CI and Devin passed there. `496fd50` had no release run of its own: releases after `860c45e` failed until [PR 262](https://github.com/akhilvuputuri/chief-agent/pull/262) moved the box migration out of `db/`. The change first deployed in `c1d556b` (package 0.3.84), whose [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39161166544) receipt is `success` at 20:02:44Z on 18 October. It is also in `af33a68` (package 0.3.85, [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39164490351) `success` at 20:45:56Z). Neither is tagged.

This verifies deployment and startup health only. No `coding.auto_retry` event has been observed yet.

## Coding-harness learning record

- **What remained ineffective:** pause recovery depended entirely on the owner noticing, so transient faults cost hours of wall time and no compute.
- **Mechanism changed:** the host classifies pauses at the point it observes them and acts at most once per revision that the owner or automation created.
- **What is unmeasured:** the share of real pauses that are transient, and whether retried attempts complete. The next small test is counting post-release `coding.auto_retry` events against paused jobs by cause over two weeks. If most retries pause again, narrow the classifier or remove it.

## Follow-up and next iteration

- Pause notices that name the cause, with Resume, Fresh and Cancel buttons (review finding F4).
- Count transient pauses by cause after release.
