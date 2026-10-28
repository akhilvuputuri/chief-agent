# 130 — Can Chief learn from finished work without being asked?

Work date(s): 2026-10-28. Written/revised: 2026-10-28.
Status: proposed (phase 2 of issue #326, branch `feat/learner`, stacked on PR #338); not merged or deployed. It ships after phase 1's operator rollout.

## User-visible problem and preceding iteration

Chief remembers only what the owner agrees to save. Issue #326 asks it to learn from completed work with no approvals. [Journal 129](129-revisioned-memory.md) built the safety net first: revisions with provenance, trust tags, flags and bulk rollback. This phase adds the learner that writes into it.

## Evidence

- Reported (issue #326, from Hermes Agent's source): Hermes triggers on activity counts, not outcomes, and its docs warn that in one continuous Telegram chat its learning "almost never" fires. Chief's conversation is one rolling chat, so this learner triggers on finished work tasks instead.
- Reported ("Demystifying Agent Skills", arXiv 2608.14036, abstract): outcome labels matter (74.6% with success/failure labels against 40.0% without).
- Tested (code reading): a task becomes `done` only when every step has proof, so `done` is a stronger signal than a non-empty reply. Nothing reads Telegram reactions, so no reaction signal exists yet.

## Diagnosis and alternatives

- **Trigger on finished tasks, nightly, rather than after each turn.** Owner volume is low, a nightly batch changes the cached prefix at most once a day, and the 24-hour quiet window needs time to pass anyway. The alternative, a fork after every reply like Hermes, would mostly see unfinished work.
- **A small dedicated loop, not the coordinator runtime.** The learner needs four tools and no domain access. Running it through the coordinator would mean scoping out about 54 tools and their context; a separate loop cannot call them at all. It reuses the model adapter, `Spending` and the run ledger, so its cost is still recorded per run.
- **Facts need the owner's own words, and the words must state the fact.** The host checks the quote against the owner's text in the cited task, with attachment content cut off, and requires every content word and number of the value to appear in it, so a fact cannot be lifted from an email, web page or attached document even if the model is misled. Lessons are not quote-checked; they carry the tasks' untrusted tags instead, and are rolled back by source if needed.
- **Apply after the run, all or nothing on pre-emption.** A run the owner interrupts applies nothing and labels nothing, so it starts over cleanly instead of leaving half a batch.

## Implementation and review

- [`src/learning.ts`](../../src/learning.ts): `labelTask`, `untrustedSources`, `Learner` (schedule window, deferral, evidence, model loop, host checks, batch apply, recovery).
- Gateway wiring in `src/main.ts`: a 10-minute tick per allowed owner on the `standard` tier, stopped at shutdown; `LEARNING` in `config/runtime.json` (`on`; `off` stops it).
- Telemetry: `learner.finished` with counts; `learner.failed`, `learner.item_refused` and `learner.tick_failed` with error classes only.
- Design: [learning from completed work](../learning.md#phase-2-the-nightly-learner).

Independent review of `c77d295` (Claude Opus 5.5): REQUEST CHANGES, with three blocking findings, each reproduced by the reviewer:

- **The quote did not have to support the fact.** Any eight characters of the owner's text passed, so a misled model could store "Pays invoices to account 999-000" quoting "Book my flight". Fixed: every content word and number of the value must appear in the quote.
- **Attached PDF text counted as the owner's words, and as owner-trusted.** Telegram intake stores the caption plus the extracted text as the owner's message and as the task request, with no receipt for the inline excerpt. Fixed: owner text is cut at the host's attachment note and the task is tagged `document`.
- **The untrusted-source map missed operations that return external content** (MCP, links, feeds, files, parcels, invoices, gathering, saved roles). Fixed by failing closed: anything not owner-internal is `external`.

Non-blocking findings fixed in the same revision: paused tasks waiting on the owner could fill the 20-task limit and starve finished work (now excluded in the query); the per-task size cap was not enforced beyond steps (now enforced in order); an owner turn during the last call still let the batch apply (now rechecked before applying); learned facts could replace an owner's fact with the same key (now refused until phase 3); `learn_finish` without a summary was refused (now optional); one owner's failure skipped the others in a tick (now caught per owner). Documented rather than changed: items are written one at a time, so a crash can leave part of a batch; the learner's running row makes idle-waiting guards wait for it; any failed receipt makes a task a pitfall.

## Verification and outcome

Tested locally on Node 22.23.4 with PGlite, `tests/learning.test.ts` (14 tests): labelling rules; untrusted kinds; the 03:30 window, one run a night, and a missed night skipped; a run that accepts a quoted fact (tagged untrusted from the task's email and web reads, with message IDs) and a correctly labelled lesson, refuses an unquoted fact, a mislabelled lesson, invalid arguments and an unknown tool, labels each task once and leaves a too-recent task for the next night; no model call without evidence; deferral while the owner is active, capped at three; pre-emption mid-run applying nothing, then a clean retry; retirement limited to learned items; restart recovery and the off switch; and, after review, owner words cut at attachments, quote-to-value binding (an unrelated quote, a changed number), the owner's keys left alone, fail-closed untrusted tags, no starvation by paused tasks, and deferral when the owner arrives during the last call.

Not done: no production run, no measurement of what it learns, cost per run or effect on later turns. A fake model drives the tests, so the quality of real proposals is untested.

## Follow-up and next iteration

After the phase 1 rollout and this release: check the first night's `learner.finished` counts and charges, and read what it wrote (`memory_revisions` with `origin='learned'`). Phase 3 adds the weekly digest with undo, reaction intake (a 👎 veto) and skills drafted from two independent successes.
