# 151 — Why did a passing review miss five bugs?

Work date: 2026-11-04. Written: 2026-11-04.
Status: tested on synthetic jobs. Not released: the worker part needs a new image, and `planCheck` is switched on with that pin.

## User-visible problem and preceding iteration

The study-links job (PR 416) cost $0.41, passed every check, and its DeepSeek reviewer approved it in one round. An independent Opus review then confirmed five blocking bugs with its own tests: unconfirmed Reader saves reported as saved, a request key that collides on tracking variants, the owner's stated destination ignored, buttons lost on a failed tap, and unclaimed taps running twice. The migration also lacked its rollout. Three of those had already been listed in the job's own request.

## Evidence

- **Code:** the reviewer was told to "judge whether the current candidate implements the plan". REVIEW.md's failure-hunting contract was never given to it, and it had no shell to test anything.
- **Measured:** the job's context mentioned pending saves. The approved plan, 14,748 characters long, did not. The owner approves plans without reading them, by design.
- **Measured:** every Reader mock in PR 416's tests returned success.
- **Configuration:** the coder model also reviewed its own work.

## Diagnosis and alternatives

A requirement can be lost before any code is written: the planner drops it, the owner taps approve, and the coder builds what the plan says. The reviewer then checks the code against the same plan. Nothing in the loop compared the result with the request, and nothing tried to make it fail.

Alternatives:

- **Have the owner read plans.** The owner declined: approving should be one tap.
- **Install a general review skill.** [code-review-skill](https://github.com/awesome-skills/code-review-skill) was assessed. Its general items are useful and are adapted in the checklist with credit. Most of its 600 KB is language guides that do not apply here, and it would not have caught any of these Chief-specific bugs.
- **A different reviewer model.** Done separately: review moved back to Opus (PR 417).

## Implementation and review

- `coding_runtime_pi/src/runtime.ts`: the planner leads with a Requirements section; the coder follows the checklist and tests failure paths.
- `src/coding/pi-worker.ts`: the reviewer contract (requirements from the request, a failure case per change, severity labels, approve only without blocking findings), and the `planCheck` step before the plan is offered. Independent review found that the first version passed the checker's findings to the planner as owner instructions, so a wrong or manipulated finding could add scope that the owner then starts without reading. The findings now arrive only as an untrusted document, and the checker also treats added requirements as gaps. The result (passed, revised, gaps or unavailable) is stored with the plan and shown on the card, with any remaining gaps in the attached plan.
- `coding_runtime_pi/src/tools.ts`, `src/coding/pi-worker.ts`: a candidate reviewer gets a shell in its disposable checkout with its own home, never edit or write tools. The shell is not a filesystem jail: it could reach the coder's checkout next door. So the worker seals what a later round could pick up before the review, and refuses to go on if it changed: the coder's tracked work by content, git's index flags, and every other entry under the attempt's root (git ignore rules and hooks, the coder's package cache, the task store) by identity and change time. Excluded: the reviewer's own checkout, home and task directory, lock files, and git's index file and objects, which change without a reviewer; directory permissions are not sealed. A second review showed that the first seal, which covered only tracked work, git config and hooks, missed a planted ignore rule, a planted package and a planted session. AGENTS.md records the owner's approval of the shell.
- `src/coding/pi-proxy.ts`: the reviewer model may answer in plan mode only with `planCheck`.
- `src/coding/controller.ts`, `src/coding/delivery.ts`: the Start card.
- `docs/coding-checklist.md`: the shared checklist.

Limitations:

- These are instructions to models, so they raise the odds of a good review but do not guarantee one.
- The plan check is a single model call chain. If it cannot finish, the plan is offered with a note.
- A reviewer test runs in a fresh checkout and may need `kite ci` first, which costs time.
- The seal detects changes; it does not prevent them. Running the reviewer as a separate user would.

## Verification and outcome

- **Tested:** the seal stops a reviewer that changes tracked work, plants a hook or a FIFO, adds an ignore rule, plants a cached package or a session, and lets a reviewer that only runs commands through. `tests/coding-plan-check.test.ts` covers a gap sent back and revised, findings kept out of the owner's instructions, gaps that remain, a check that cannot finish, a revision that asks the owner, a clean plan, and the setting off, through a real worker. `tests/coding-review-shell.test.ts` covers a reviewer running commands, and a reviewer that changes the coder's checkout or plants a git hook. `coding_runtime_pi/tests/review-tools.test.ts` covers which intents get a shell.
- **Measured:** run with these instructions on PR 416's candidate, without being told what to look for, Opus marked as blocking four of the five bugs from the earlier independent review, plus the missing rollout and a new blocking bug: every turn fails while the migration is pending. It marked the fifth, lost buttons, as important. It ran through Claude Code's tools rather than the Pi worker.
- **Not yet measured:** whether the new reviewer finds PR 416's five bugs. That is the acceptance test before the next job.
