# 120 — Does a meaning index find emails that Gmail search misses?

Work date(s): 2026-10-25. Written/revised: 2026-10-25.
Status: in progress. Implemented and tested on `feature/mail-recall`; not released and not yet measured on the owner's mailbox.

## User-visible problem and preceding iteration

Chief finds email through the email agent, which uses Gmail's own search: keyword and operator queries, at most three per brief ([email agent](../../plugins/core/agents/email.md)). That works when the owner remembers a sender, a subject or an exact phrase. It does not work when the owner remembers only what an email was about ("the email where they apologised for the late delivery"). [Journal 23](23-gmail-search.md) fixed the tool contract and deferred a local index or embeddings until the contract was right.

This entry tests the first owned retrieval (RAG) capability in Chief: a meaning index over recent mail, offered to the email agent as `gmail_recall`. The design is in [mail recall](../mail-recall.md).

## Evidence

- **Measured, 25 October 2026, read-only production queries:** Chief's own stored conversation (218 owner messages and about 134,000 characters of replies over seven weeks) fits in the cached prompt, so retrieval over it was not chosen as the first test. A mailbox does not fit: even one month of mail is external to Chief and far larger than what an agent can read per brief.
- **Hypothesis:** with `gmail_recall`, the email agent finds more half-remembered emails than with Gmail search alone, at a cost of cents.
- **Deferred:** no production measurement yet. The eval and the result go below.

## Diagnosis and alternatives

- **Long context:** not possible. A month of mail does not fit in a Flash agent's brief, and putting it into the coordinator's prompt would add it to every call.
- **More Gmail searches:** finding more needs the right words, and the questions this tests are the ones without them.
- **Own embedding model:** keeps mail on the host. The host had about 1 GB of memory free with swap in use, so a resident model risks the gateway; the owner chose the API.
- **Persistence in Postgres:** needs an additive migration and the reviewed operator rollout. An in-memory index answers the question first. It costs a rebuild after each restart: one month of Primary mail, a few cents of embeddings (estimate).

## Implementation and review

- `src/mail-recall.ts`: `OpenRouterEmbedder` and `MailIndex` (backfill, top-up on use, 30-day pruning, cosine search).
- `src/gmail.ts`: `indexPage`, `indexMessage` and `indexBody` (HTML-only mail as display text).
- `gmail_recall` in `src/protocol.ts`, `src/tools.ts` and `src/runtime.ts`. It is offered only with `MAIL_INDEX=on`.
- `OPTIONAL_OPERATIONS` in `src/plugins.ts`, so the email agent stays in the agent catalogue without the index.
- Email agent manifest, instructions and registry pin.
- `src/mail-recall-eval.ts`: the operator-run retrieval eval.
- Tests: `tests/mail-recall.test.ts` (chunking and quotes, HTML text, owner scoping, ranking, top-up and pruning, failed-build retry, embedder parsing, availability and catalogue).
- **Independent review, Opus 5.5, `44c411d`: REQUEST CHANGES.**
  - **Blocker:** with the index unavailable, the email agent stayed listed but every run for it failed, because `runFindingsAgent` required every listed tool. The coordinator also kept delegating Gmail to it.
  - **Should-fix:**
    - the top-up watermark skipped mail after more than 50 new messages;
    - a failed build re-read the whole window on every call, with no pause;
    - the backfill held every body in memory before embedding;
    - the privacy note left out that tool results are stored like other Gmail results;
    - a rebuild a turn started was charged to that turn.
  - **Nits:** quoted HTML history; escape-heavy results past the projection limit; messages skipped silently; the failure log did not name the dependency.
  - **Fixes:**
    - optional tools are left out of the child's toolset and grant instead of being required;
    - listed mail is queued oldest first and never dropped;
    - fetching and embedding run in groups of ten that keep their progress;
    - a failed build resumes after five minutes, outside the turn's ledger;
    - unreadable messages are retried once, then counted;
    - results are trimmed below the limit;
    - the docs are corrected.
  - Each finding has a regression test in `tests/mail-recall.test.ts`.

## Verification and outcome

Mocked tests pass. The retrieval eval on the owner's mailbox and an end-to-end Telegram check have not run.

### Release closure — pending

Pending: independent review, merge, release and the operator-run eval.

## Follow-up and next iteration

- Run `mail-recall-eval.js` with 30 generated questions and add about 10 owner-written ones. Record keyword and recall rates here as aggregates only.
- Check a few real half-remembered requests in Telegram.
- If recall clearly helps, persist the index (additive migration), sync in the background, and consider the second account and attachments.
- Deleted or moved mail stays in the index until it is 30 days old (Devin Review on #320). The agent's `gmail_thread` check keeps it out of answers, but it can take a result slot. Reconcile indexed IDs against Gmail if the eval or live use shows it matters.
- If it does not help, turn `MAIL_INDEX` off and record why.
