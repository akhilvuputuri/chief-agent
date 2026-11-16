# 202 — Why did an answered coding job stop instead of continuing?

Work date: 2026-11-16 (UTC). Written: 2026-11-16.
Status: tested locally; not released. Host only: the worker image's build context includes `src/` (`Dockerfile.coding-pi` copies it and builds all of it), but the worker (`src/coding/pi-worker.ts`) never imports `controller.ts`, directly or through its imports, so a rebuilt image would behave the same and no new image pin is needed. Branch `coding/auto-move-retired-image`.

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
- **Notice.** Kind `settings_change`, marked `by: "host"` and `reason: "worker_image_retired"`, with the same `changes` shape as `updateJob` and one plain line: the image was retired, Chief moved the job to the current one and is starting it, and its saved work, its coder and reviewer models and its Start stay as they were (`leaderModel` is dropped, as `upgradeWorker` drops it). It goes through the same pending-delivery path as an owner's settings change. The key is `worker-moved:<attempt>`, not `settings:…`. The automatic retry and the box continuation skip a job with a `settings:` event newer than its last update; a later pause always updates the job after the move, so even a `settings:` key would not block them, and the name only keeps a host move from reading as an owner's change.
- **Revision unchanged**, as in `updateJob` for a job past Start: the job is in implement mode and has no Start card to replace. The attempt token does not depend on the revision or the image.
- **Crash and repeat.**
  - An error in the move itself pauses the job as an uncertain start; the next pass finds no box and pauses it as "The coding box never started; resume to try again". It needs the owner's resume, and the move happens on that next attempt.
  - If the host process stops after the claim and before the move, the job is left `provisioning` with no box on the retired image, and the next startup is refused by `codingSandbox` until an operator settles that attempt. This was already so before this change (the same window ended in the pause); see the last bullet under Verification.
  - If it stops after the move and before the box launch, the job already has the new image and exactly one notice. The next pass finds no box and pauses it as never started; it also needs a resume.
  - A second pass cannot move it again: the lease and the unchanged-settings guard fail, and the notice key is per attempt.
- **When the move matches no row.** Nothing in the controller changes a `provisioning` job's settings except this move, which needs the lease, and no queued job has `publication_started`. So the row has either left this pass (its lease ran out and another pass took it, or the owner cancelled it) or was changed outside the controller. The pass re-reads the row under the claim's conditions (id, attempt, lease, `provisioning`, no box). If it still holds it, it pauses it with "moving it to the current one did not apply, so no coding box was started … resume it to try again". If not, it leaves the job alone. Both log `coding.worker_move_skipped`.
- **Unchanged.** The `upgradeWorker` tool and its description in `src/runtime.ts`, the Start gate and the machine-time check before launch, and nothing under `coding_runtime_pi/`.
- **Review.** Approved at `307be66` with four notes, fixed in the next commit:
  - a move that matched no row returned silently, so the job was later paused as "never started", the wrong text;
  - the repeat test never went back through the claim, so it passed without the per-attempt key or the settings guard;
  - two journal claims were wrong (see the correction note below);
  - the notice said the models stay as they were, while `leaderModel` is dropped.

## Verification and outcome

- **Tested (`tests/coding-on-boxes.test.ts`):** a Pi job on a retired image is moved and its box starts with the current image; its settings equal exactly what `upgradeWorker` produces (image replaced; `leaderModel` and `contextWindows` removed); revision and checkpoint unchanged; one pending notice with the expected change. Two more passes write no second notice; that part was weak (later passes see the box and never reach the move) and is replaced by the cases below. A retired job whose model fails the direct check stays paused with the reason and no box. A non-Pi job keeps the "start a new coding job" text. A job whose host image is not run either keeps that text and frees the queue.
- **Tested after review (`tests/coding-on-boxes.test.ts`), each checked by breaking what it guards locally (the breaks were not committed):**
  - The job's settings change between the claim and the move: paused with the "did not apply" text, no box, no notice. Fails without the unchanged-settings guard, and fails when the zero-row case returns silently.
  - The lease changes between the claim and the move: the job is left `provisioning` under the other lease, no box, no notice. Fails without the lease guard in the move, and fails when the re-read ignores the lease.
  - The move replayed for the same attempt: no second notice. Fails without `ON CONFLICT DO NOTHING`, and fails with a key that is not per attempt.
  - A job with a PR, queued again as the rebase and PR-feedback requeues leave it: moved and launched. Fails if PR jobs are excluded from the move.
  - A moved job whose box stopped without a reason is still retried once automatically. This case does not fail if the notice key is renamed to `settings:…`, for the reason given under Notice. It guards the retry staying eligible, not the name.
- **Tested (`tests/coding-job-update.test.ts`):** the existing `coding_job_update` cases pass with the shared helper.
- **Not tested:** a real retired-image job on production; the Telegram rendering of the notice on a phone; a host crash between the move and the box launch (reasoned above, not exercised).
- **Pre-existing, not changed:** startup refuses to run while a `provisioning` attempt with no box has an image no box runs (`codingSandbox`). A host that stops after claiming a retired-image job and before moving it would meet that check, as it would before this change. The window is the Start and machine-time checks between the claim and the move.

## Follow-up and next iteration

Record the release, and the first real job moved this way, in a dated note.

> **Correction, 16 November 2026:** two claims in this entry were wrong when first written (`307be66`) and are corrected above.
>
> - The Status line said nothing in the worker image changes. The image's build context does include `src/`. What holds is that the worker never imports `controller.ts`.
> - The Crash bullet said that if the host stops before the move, "the move happens on the next attempt". A job is first paused as never started and needs the owner's resume, and a host restart in that window is refused at startup.
>
> The Notice bullet also said the key name keeps the automatic retry going; the retry's own time check already does that.
