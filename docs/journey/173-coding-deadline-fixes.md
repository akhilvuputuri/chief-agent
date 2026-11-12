# 173 — Do a coding job's deadlines follow its own settings?

Work date: 12 November 2026. Written: 12 November 2026.
Status: tested. Host change only; no worker image, migration or Compose change. Not yet released.

## User-visible problem and preceding iteration

[Journal 169](169-three-hour-coding-attempts.md) gave new Pi jobs 180 minutes and pointed at `coding_job_update` for raising a paused job, such as `9600af57`, to the same. An independent review of that change found two places, outside it, where a job's time limit and the limit that actually applies could disagree. Neither has been observed in production; both were found by reading the code.

1. **The first deadline came from the current configuration.** When the controller claims a queued job, it sets the attempt deadline to now plus the configured `limits.ms` plus five minutes, although every job carries its own settings snapshot and `coding_job_update` can change its `limits.ms`. The first heartbeat replaces it with the job's own active time, so the gap lasted only until the worker started. In that window the host's deadline could disagree with the box's own timeout (`timeoutMinutes`) and the window used to find a box (both already from the job): a job allowed 180 minutes, with the configuration at 150, would be timed out at 155 if its worker never reported; one allowed 30 minutes, with the configuration at 15, would be timed out after 20 minutes of a slow box start.
2. **Raising a paused job ignored its worker image's box deadline.** `coding_job_update` accepts up to `PI_ATTEMPT_MS` (3 hours) for any Pi job. A box runs the agent copied from the job's own pinned image (`src/boxes/ec2-provider.ts`), and images built before PR 357 (29 October 2026) kill a task after two hours (`deadlineMs` in `src/boxes/agent.ts`). A job on one of them raised past that would be killed by its box before the host's deadline.

## Evidence

**Tested (repository history, 12 November 2026).** Which accepted images predate PR 357 (`8e53d52`, which changed `deadlineMs` from 2 to 4 hours):

| Digest (prefix) | Built from | Source           | Contains `8e53d52`? | Box task deadline | Accepted now               |
| --------------- | ---------- | ---------------- | ------------------- | ----------------- | -------------------------- |
| `e8f1c2cd…`     | `6ab96c0`  | journal 91       | no                  | 2 hours           | yes, `previousImages`      |
| `2fd65df0…`     | `15e6def`  | journal 126      | no                  | 2 hours           | yes, `previousImages`      |
| `34987193…`     | `0a78485`  | journal 128      | no                  | 2 hours           | yes, `previousImages`      |
| `97cee1ae…`     | `8e53d52`  | releases, PR 358 | yes                 | 4 hours           | yes, and every later image |

"Contains" was checked with `git merge-base --is-ancestor 8e53d52 <commit>`, and the deadline by reading `src/boxes/agent.ts` at each build commit. `src/boxes/agent-main.ts` passes no limits, so the default applies. The seven later images in `config/boxes.json` were built from `304d691`, `fd7b16d`, `f70dade`, `2ce1fd6`, `fa058f9`, `f6df014` and `d2d7d3b` (build records in `docs/releases.md`); each contains `8e53d52` and has the four-hour deadline. Whether any open production job still uses one of the three old images was not checked (no host access in this task); jobs created on them were given 90 minutes by the configuration of the time, below the old 100-minute ceiling, so only a later `coding_job_update` could have raised one past it.

## Diagnosis and alternatives

**Fix 1.** The claim picks the job inside one statement (`FOR UPDATE SKIP LOCKED`), so the host does not know the job's settings until after it is claimed, and the database interface has no transactions. Options:

- **Compute the deadline in the same SQL statement from the row's settings (chosen).** It stays one statement, so it is as race-free as before. The cost is that the active-time ceiling exists twice, in `activeMs` and in SQL; the SQL takes the TypeScript constants as parameters, and the tests compare the two for each kind of job.
- Claim first and correct the deadline in a second statement. Simpler SQL, but a crash between the two leaves the configuration's deadline on the row.
- Select the job, compute in TypeScript, then update conditionally. A different locking pattern from the rest of the controller, for no benefit.

The five-minute startup margin is kept: before the first heartbeat the deadline is the job's own active time (`activeMs`) plus five minutes, matching `timeoutMinutes` (active minutes plus five). After it, unchanged, the heartbeat sets the job's active time from that moment.

**Fix 2.** Three accepted images do predate PR 357, so a documented assertion that every accepted image has the four-hour deadline would be false. Options:

- **Refuse a limit the image's box cannot honour, and cap those images' attempts (chosen).** A fixed list of the three digests, which never grows because every later image has the four-hour deadline. Their ceiling is 100 minutes, the ceiling they ran with before PR 357 (it left 20 minutes for the worker to start inside the two-hour task deadline). `coding_job_update` refuses a larger `limits.ms` with a message naming `upgradeWorker`, and it checks the image the job will run, so an update that also moves the job to the current image may raise it to 3 hours. `activeMs` applies the same ceiling, so a job already raised past it before this change is timed out by the host, with saved work, rather than killed by its box.
- Retire the three images from `previousImages`. That needs evidence that no open job uses them, which this task cannot collect, and `config/boxes.json` is a protected, owner-reviewed path.
- Read the deadline from the image at runtime. A box agent does not report it, and pulling images on the host to inspect them is far more machinery than a fixed list.

## Implementation and review

- `src/coding/controller.ts`: `TWO_HOUR_BOX_IMAGES`, `piAttemptCeiling`; `activeMs` uses it; the provisioning claim computes `attempt_deadline` from the row's `settings` in SQL; `updateJob` refuses a limit above the next image's ceiling.
- Tests: `tests/coding-attempt-deadline.test.ts` (provisioning deadline and box timeout for a Pi job, a Pi job over the ceiling, a Pi job on a two-hour image and a Python job, each differing from the configuration; and a provisioning job not timed out at the configuration's window); `tests/coding-job-update.test.ts` (refused above 100 minutes on a two-hour image, accepted at 100, and accepted at 3 hours together with `upgradeWorker`); `tests/coding-box-config.test.ts` (the image new jobs use is never on the two-hour list).
- Dated note in [coding.md](../coding.md) under size and time limits; entry in [coding-agent lessons](coding-agent-lessons.md).

Independent review: pending.

## Verification and outcome

**Tested, locally, 12 November 2026** (Node 22.23.4, Kite 0.2.0, PGlite): the three affected files pass (24 tests); the full TypeScript suite (`kite run test:ts`) passed 1,680 tests with 1 skipped and none failing; `kite run typecheck` passed; Prettier is clean on the changed files. With the old claim restored, all five new deadline tests fail.

Not yet released. Nothing here was observed in production.

## Follow-up and next iteration

- Once no open job uses the three pre-PR 357 images, they can leave `previousImages` and the list can go.
- `coding_job_update` keeps checking only a limit the call changes, so an inherited limit above the ceiling does not block a model change; `activeMs` bounds such a job at run time.
