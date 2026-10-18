# 96 — Can the host retry a coding job once after a transient fault?

Work date(s): 2026-10-19. Written/revised: 2026-10-19.
Status: in review. The host re-queues a paused coding job once after a classified transient fault, with an owner notice. No live job has exercised it yet.

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
    - inserts a pending General notice saying the job is retrying once and will wait for the owner if it pauses again.

  A job is eligible when it paused 2 minutes to 1 day ago and its pause is classified as transient. Worker pauses count only if the last rejected request was a 429 or 500/502/503/504 with no timeout, finish-reason or provider-failure classification. The job is skipped in any of these cases:
  - publication started;
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
  - the real tick path that records the cause.

Independent review: pending.

## Verification and outcome

Tested only: the focused tests pass on PGlite. Pending:

- the full suite, CI and exact-head review;
- the release;
- a live transient pause that is retried once and either completes or waits for the owner.

## Coding-harness learning record

- **What remained ineffective:** pause recovery depended entirely on the owner noticing, so transient faults cost hours of wall time and no compute.
- **Mechanism changed:** the host classifies pauses at the point it observes them and acts at most once per approved scope.
- **What is unmeasured:** the share of real pauses that are transient, and whether retried attempts complete. The next small test is counting post-release `coding.auto_retry` events against paused jobs by cause over two weeks. If most retries pause again, narrow the classifier or remove it.

## Follow-up and next iteration

- Pause notices that name the cause, with Resume, Fresh and Cancel buttons (review finding F4).
- Count transient pauses by cause after release.
