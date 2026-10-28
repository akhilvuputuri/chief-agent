# 120 — Does a meaning index find emails that Gmail search misses?

Work date(s): 2026-10-25 to 2026-10-27. Written/revised: 2026-10-27.
Status: released with a 12-month window and quota-paced builds. Retrieval eval measured at 30 days and 12 months; owner-written questions and live use pending.

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

### Release closure — 2026-10-25

- **Merged.** [PR 320](https://github.com/akhilvuputuri/chief-agent/pull/320) merged as `d98f91201488956c2af7245007ac5991a3c9fdef` from the approved head `8dbae1c`. Hosted CI and Devin Review passed.
- **Deployed.** Live at 12:56 UTC on 25 October. `release:status` reported success ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/40194920183)), the server `RELEASE` matched and health was ok. No migration.
- **First build, measured** from `mail_index.built`: 119 messages in the 30-day window, 65,925 embedding prompt tokens, 40.5 seconds, none left out, no `mail_index.failed`.
- **Not yet observed.** Owner-written questions and live Telegram use.

## Retrieval eval, 30-day window

Measured on 25 October 2026 with `mail-recall-eval.js` in the production container on release `d98f912`. The private per-question output stays in the operations folder.

- **Setup:**
  - 119 indexed messages.
  - 30 questions written by `google/gemini-3.8-flash` from randomly sampled messages, without the subject's or sender's words.
  - The same model wrote up to three Gmail queries per question.
  - A question counts as found when the target message is in the results.
- **Results:**

| Condition                                                 |   Found | 95% Wilson interval |
| --------------------------------------------------------- | ------: | ------------------- |
| Keyword: up to three Gmail searches (today's email agent) | 17 / 30 | 39–73%              |
| `gmail_recall` top 8 by itself                            | 28 / 30 | 79–98%              |
| Keyword plus `gmail_recall`                               | 29 / 30 | 83–99%              |

- **Paired comparison** (keyword against `gmail_recall` alone): 12 targets were found only by `gmail_recall` and 1 only by keyword. Exact McNemar p ≈ 0.003.
- **Ranks:** when `gmail_recall` found the target it ranked it first 17 times and never below fifth. Eight random messages out of 119 would include the target about 7% of the time.
- **Cost:** about $0.28 in model calls for the run, plus embeddings.
- **Limits:**
  - The questions avoid subject and sender words by design, which models half-remembered requests and disadvantages keyword search.
  - The questions and queries are synthetic.
  - This is a retrieval score, not a check of the agent's answers.
  - 119 messages is a small pool, so the 12-month run is the harder test.

## Window widened to 12 months

At 30 days the whole index is about 66,000 tokens, which fits in one prompt. That window can show whether meaning search beats keyword search, but not that retrieval is needed rather than optional. The follow-up widens it to 12 months, still Primary category and primary account only, with the 3,000-message cap unchanged.

Estimates from the 30-day build, to be checked against the first 12-month `mail_index.built`:

- about 1,400 messages and 0.8M embedding tokens per rebuild, roughly $0.02;
- about 8 minutes to build after each restart, during which `gmail_recall` reports `building`;
- under 20 MB of gateway memory.

### Release closure and first 12-month build — 2026-10-27

- **Merged.** [PR 321](https://github.com/akhilvuputuri/chief-agent/pull/321) merged as `fcdb81ceb908bb370fb15f1709f323489e8c341c` from the approved and tested head `6557562` (a merge of main).
- **Deployed.** Another session merged `c4ba246` right after, and the release deployed that commit, which contains `fcdb81c`, at 15:47 UTC on 27 October ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/40534440754)).
- **First 12-month build, measured** from `mail_index.built`:
  - 1,024 messages indexed;
  - **384 left out**;
  - 842,443 embedding tokens;
  - 506 seconds;
  - the host kept about 1.1 GB of memory available.

### Why 384 messages were left out

- **Measured on 28 October** with read-only probes in the gateway container (error metadata only):
  - 1,408 messages are listed for the window.
  - Re-reading them four at a time failed 1,077 reads, all with HTTP 403.
  - The 403 body names Gmail's quota `totalQueryCostPerMinutePerUser`, limit 6,000 query-cost units a minute per user. A probe of 100 reads succeeded, so this was the quota, not authorization.
- **Mechanism:** the index read four messages at a time. It used up the minute's quota after a few hundred reads, then retried each refused message once and abandoned it.
- **Risk to the email agent:** the same quota serves its own Gmail calls, so a build could also make its searches fail for the rest of that minute after a restart.
- **Fix:** read one message at a time, about two a second. A quota refusal pauses reading for a minute without counting against the message; five consecutive pauses fail the build.
- **Expected after the fix (estimate):** builds take about 12 minutes for 1,408 messages and leave none out for quota reasons. To be checked against the next `mail_index.built`.

### Quota fix release — 2026-10-27

- **Merged.** [PR 336](https://github.com/akhilvuputuri/chief-agent/pull/336) merged as `1ff88d24d3c05333df673bebb15a279f602f7981`. Independent review (Opus 5.5) approved it after one should-fix: a cut-short top-up discarded its reads. Devin's finding (a non-quota 403 also pauses) is accepted and documented.
- **Deployed.** Live at 16:50 UTC on 27 October. Another session's release (`45bd6ed`) restarted the gateway 17 minutes later, before that build finished.
- **Measured on `45bd6ed`,** which contains the fix: `mail_index.built` reported **1,408 messages, 0 left out**, 1,152,424 embedding tokens, 993.6 seconds. Builds are slower than the 12-minute estimate but complete.

## Retrieval eval, 12-month window

**Measured on 27 October 2026 on release `45bd6ed`, against 1,409 indexed messages.**

- **Method:**
  - Same eval as the 30-day run, with two guards added. A malformed model reply now counts as no answer, and a question whose Gmail query plan is malformed or empty is skipped.
  - A first unguarded run crashed at question 19 on a malformed reply.
  - The guarded copy was streamed into the container. The same guards are in `src/mail-recall-eval.ts` from this PR.
  - In the 30-day run a well-formed but invalid or empty plan would have counted as a keyword miss; malformed JSON would have crashed that run, and it completed. Whether that happened can't be checked, so that run's keyword figure may be slightly low.
- **Results:**

| Condition                           | 30 days (119 messages) | 12 months (1,409 messages) | 95% Wilson interval, 12 months |
| ----------------------------------- | ---------------------: | -------------------------: | ------------------------------ |
| Keyword: up to three Gmail searches |                17 / 30 |                    14 / 30 | 30–64%                         |
| `gmail_recall` top 8 by itself      |                28 / 30 |                    16 / 30 | 36–70%                         |
| Keyword plus `gmail_recall`         |                29 / 30 |                    23 / 30 | 59–88%                         |

- **`gmail_recall` alone against keyword:** 9 targets found only by `gmail_recall` and 7 only by keyword; 7 by both and 7 by neither. Exact McNemar p ≈ 0.80, so no difference was detected.
- **Both against keyword alone:** 9 gained and none lost. Exact McNemar p ≈ 0.004.
- **Ranks:** `gmail_recall` ranked its finds 1st 8 times, 2nd and 3rd twice each, 5th twice, and 6th and 8th once each. Eight random messages out of 1,409 would include the target about 0.6% of the time.
- **Cost:** about $0.40 in model calls.
- **Reading:**
  - In the larger pool, meaning search is not better than keyword search on its own, so the 30-day result likely reflected the small pool; the two runs used different questions, so this is an inference.
  - The two methods fail on different emails, and using both is the measured gain.
  - The email agent's instructions and the tool description now say to use both for content questions instead of `gmail_recall` first.
- **Limits:** synthetic, keyword-avoiding questions; 30 per run; a retrieval score, not a check of the agent's answers.

## Follow-up and next iteration

- Add about 10 owner-written questions to the eval.
- Fuse keyword and meaning results inside `gmail_recall` so one call gets both.
- Then try re-ranking the top results and smaller chunks, compared offline in a Python eval over a private export.
- Check a few real half-remembered requests in Telegram.
- If recall clearly helps, persist the index (additive migration), sync in the background, and consider the second account and attachments.
- Deleted or moved mail stays in the index until it is 12 months old (Devin Review on #320). The agent's `gmail_thread` check keeps it out of answers, but it can take a result slot. Reconcile indexed IDs against Gmail if the eval or live use shows it matters.
- If it does not help, turn `MAIL_INDEX` off and record why.
