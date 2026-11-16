# 202 — Why did an answered coding job stop instead of continuing?

Work date: 2026-11-16 (UTC). Written: 2026-11-16.
Status: tested locally; not released. Host only: nothing in the worker image changes, so no new image pin is needed. Branch `coding/auto-move-retired-image`.

## User-visible problem and preceding iteration

A coding job keeps the worker image it was started with. When a new worker image is pinned and the old one is removed from the coding profile (`image` and `previousImages` in `config/boxes.json`), no coding box can run the old one any more. [Journal 200](200-wait-for-the-kill.md) changed the text such a job is paused with: its image has been retired, its saved work is kept, and it can be moved with `coding_job_update` (`upgradeWorker`) and then resumed.

On 16 November the owner answered a job's question. The job was queued again, its next attempt was paused before any box started with that text, and the owner started a whole new job instead of moving the old one. The manual step was the cause of the friction: a retired image can never run the job, so the only way forward is always the same move.

## Evidence

- **Reported (owner, 16 November):** an answered job paused with the retired-image text, and a new job was started instead of moving it.
- **Read in the code (`src/coding/controller.ts` at `64c918f`):** the launch path claims a queued job (state `provisioning`, a new attempt id, `cleanup='pending'`, a lease) and asks the sandbox whether it runs the job's image. When it does not, the job was paused with one of two texts; the "move it" text was used only when the job and host are both Pi, the host has an image, it differs from the job's, and the sandbox runs it.
- **Read in the code:** `updateJob` (`coding_job_update`) changes a job only while `RESTARTABLE` holds: stopped, `NOT publication_started`, no pending cleanup, no live lease. For `upgradeWorker` it replaces the image with the host's, drops `limits` and `leaderModel` (that worker refuses them, journal 193), drops `contextWindows` (journal 190) and checks the models with `assertDirectPiModels`. It records a `settings:<key>` event with kind `settings_change` and a summary, delivered to the owner as a Telegram notice. The revision moves only for a job still waiting for Start (to replace its Start card).
- **Read in the code (`src/coding/requirements.ts`):** the owner's Start covers the request (objective, context, plan field), not who carries it out, so a new image does not touch it.

## Diagnosis and alternatives

- **Why `updateJob` needs a stopped job.** No box may be running with the settings being replaced, no other pass may hold the job, the previous attempt's box must be cleaned up, and no PR publication may be in flight. At the launch point each of these holds for the claimed job: this pass holds the lease it claimed it with, no box exists for the new attempt (`sandbox_id` is null; `cleanup='pending'` was set by the claim for this attempt only, and `stopped(…, false)` resets it), and every path that queues a job clears `publication_started` (coding_resume, coding_reply, the inbox reply, the automatic retry, the box continuation, the rebase and the PR-feedback requeue), except the owner's Start, which moves a job from waiting-for-Start, where it is false from creation or from the reply that returned it there. The move's update checks all of these again in its `WHERE`.
- **Jobs with a PR.** A job requeued for a rebase or PR feedback has a PR but no publication in progress. The owner could already move it with `upgradeWorker` once it paused, so moving it at launch reaches the same state.
- **Jobs that still pause.**
  - Not movable (not a Pi job, a non-Pi host, no host image, or the sandbox does not run the host's image either): the earlier "start a new coding job" text, unchanged.
  - Movable, but the moved settings fail the check `updateJob` applies (`assertDirectPiModels`, for example a model Chief no longer calls directly): paused with the retired-image text, the reason, and the advice to change its models and move it. `upgradeWorker` would refuse the same job.
- **Alternatives rejected.** Keeping the pause and improving the advice again: the step stays manual and its answer is always the same. Moving jobs when an image is retired (at release): needs a sweep over every open job and races the owner's own updates; moving at launch touches only the job that is about to run.

## Implementation and review

- **Shared change.** `onCurrentWorker(settings, image)` in `src/coding/controller.ts` replaces the image and drops `limits`, `leaderModel` and `contextWindows`. `updateJob`'s `upgradeWorker` now uses it, so the two paths cannot drift.
- **Move at launch.** `moveRetiredWorker` runs `assertDirectPiModels` on the moved settings, then one statement updates the settings (guarded by id, attempt, lease, `provisioning`, no box, no publication, unchanged settings) and inserts the owner's notice keyed `worker-moved:<attempt>` with `ON CONFLICT DO NOTHING`. Either both happen or neither. Only when the update succeeded does the box launch, with the new image.
- **Notice.** Kind `settings_change`, marked `by: "host"` and `reason: "worker_image_retired"`, with the same `changes` shape as `updateJob` and one plain line: the image was retired, Chief moved the job to the current one and is starting it, and its saved work, models and Start stay as they were. It goes through the same pending-delivery path as an owner's settings change. The key is not `settings:…`, so the automatic retry and the box continuation do not read it as "the owner changed this job while it was stopped".
- **Revision unchanged**, as in `updateJob` for a job past Start: the job is in implement mode and has no Start card to replace. The attempt token does not depend on the revision or the image.
- **Crash and repeat.** If the host stops before the move, the attempt is found without a box on the next pass and paused ("never started"); the move happens on the next attempt. If it stops after the move and before the box launch, the job already has the new image and the notice exists once. A second pass cannot move it again: the lease and the unchanged-settings guard fail, and the notice key is per attempt.
- **Unchanged.** The `upgradeWorker` tool and its description in `src/runtime.ts`, the Start gate and the machine-time check before launch, and nothing under `coding_runtime_pi/`.
- **Review.** Independent review of the exact head is pending.

## Verification and outcome

- **Tested (`tests/coding-on-boxes.test.ts`):** a Pi job on a retired image is moved and its box starts with the current image; its settings equal exactly what `upgradeWorker` produces (image replaced; `leaderModel` and `contextWindows` removed); revision and checkpoint unchanged; one pending notice with the expected change; two more passes write no second notice. A retired job whose model fails the direct check stays paused with the reason and no box. A non-Pi job keeps the "start a new coding job" text. A job whose host image is not run either keeps that text and frees the queue.
- **Tested (`tests/coding-job-update.test.ts`):** the existing `coding_job_update` cases pass with the shared helper.
- **Not tested:** a real retired-image job on production; the Telegram rendering of the notice on a phone; a host crash between the move and the box launch (reasoned above, not exercised).
- **Pre-existing, not changed:** startup refuses to run while a `provisioning` attempt with no box has an image no box runs (`codingSandbox`). A host that stops after claiming a retired-image job and before moving it would meet that check, as it would before this change.

## Follow-up and next iteration

Record the release, and the first real job moved this way, in a dated note.
