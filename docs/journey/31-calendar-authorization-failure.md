# 31 — Why could an approved Calendar event fail as "uncertain"?

Work date(s): 2026-09-23. Written/revised: 2026-09-23.
Status: released 2026-09-23 (deployed `7648fca`, no version tag). The expired Calendar credential itself still needs operator reconnection.

## User-visible problem and preceding iteration

**Reported:** the owner tried to add a Calendar event on 23 September (about 00:59 Singapore time) and it did not get created. [Calendar approval](../calendar-approval.md) makes one creation attempt per Telegram approval, and any failure during that attempt was recorded as an _uncertain_ write. [Journal 26](26-google-authorization-expiry.md) replaced the expired Gmail credential on 21 September after the OAuth project moved out of Testing. Calendar and Sheets use separate refresh tokens, and the runbook left their renewal as a separate check.

## Evidence

- **Measured** (bounded [diagnostics run 35864713296](https://github.com/akhilvuputuri/chief-agent/actions/runs/35864713296), 2026-09-23 13:05 UTC, release `c936d7d`, 24-hour tool window): `calendar_list` failed 3 of 3 times; `calendar_draft` succeeded once; `gmail_search` (2) and `gmail_read` (1) succeeded. The run that saved the draft stopped with `awaiting_approval`.
- **Not observable:** diagnostics include neither approval rows, button taps nor tool error text. Whether the owner pressed Approve, and which message was shown, is not established.
- **Hypothesis:** the Calendar refresh token was issued while the OAuth project was in Testing and has expired (`invalid_grant`). It explains Calendar reads failing while Gmail, renewed two days earlier, succeeded. The error text that would confirm it is not in the diagnostics.

## Diagnosis and alternatives

**Tested from source:** saving a draft makes no Google request, so it succeeded. On approval, `CalendarTools.create` refreshes the token and checks the account before the insert request. A failure there was caught along with network failures and marked `uncertain`. That has two effects:

1. The owner is told the outcome is uncertain and offered **Check status**, which fails the same way and shows a generic "unavailable" message.
2. `calendar_draft` refuses all later drafts while an uncertain write exists. After reconnection, **Check status** finds no event and still reports uncertain, so an operator must clear it.

The token endpoint's `invalid_grant` 400 also reached tools as the generic `Google request failed (400)`. That text did not match the `AUTHORIZATION_REQUIRED` classification, so the model saw only "the tool failed".

Alternatives considered: re-opening the approval as `pending` for a retry. That contradicts the one-attempt-per-approval rule, so it was rejected. Classifying failed insert responses (e.g. 4xx from Google) as definite non-creation was left out: a 409 means the event already exists, so it needs its own reconciliation analysis.

## Implementation and review

- `src/calendar.ts`: `GoogleAuthError` records whether a rejection needs owner reconnection (`authorization`) or a server OAuth settings fix (`configuration`). Tools classify these as `AUTHORIZATION_REQUIRED` and `NOT_CONFIGURED` respectively. Only the token endpoint's `invalid_grant` code (read from a bounded error body) and userinfo 401/403 or a wrong account count as `authorization`. Other token 400/401 codes, such as `invalid_client`, or an unreadable body, count as `configuration`. `list` now reuses the same header and account check. The token helper is shared with the daily Sheet. Failures before the insert request is sent throw `CalendarNotSentError`.
- `src/calendar-actions.ts`: that error sets `execution: "failed"` with `failure.code` `authorization`, `configuration` or `not_sent` (carried on the error, not inferred from message text), and records `calendar.not_sent`. This mirrors the library approvals' failed state. The approval is not reopened, repeated callbacks return the saved failure without contacting Google, and later drafts are allowed. Network and response failures of the insert request itself still become `uncertain`.
- `src/telegram.ts`: the callback says no event was created. For `authorization` it says to reconnect Calendar and draft again; for `configuration` it says the server's Google connection settings must be fixed. A status check that fails with a `GoogleAuthError` says so.
- Regression tests: `tests/calendar-approval.test.ts` covers the token-only request sequence, the tool error classification, the Telegram reply, the stored state, no retry, and that a later draft is allowed.

Independent review, round 1 (2026-09-23): a separate reviewer agent in this session (Claude, harness-selected model; GPT-6 Astra was unavailable) returned **REQUEST CHANGES** on `652a3278`. It found the logic correct, but:

- **F1 (blocking):** no test used the real client to prove that failures after the insert request is sent stay uncertain. Its mutation that wrapped the insert in `CalendarNotSentError` passed every test.
- **F2:** userinfo 401/403 and missing configuration were labelled "could not be reached".
- **F3:** the "expired or revoked" wording overstated the cause for `invalid_client` and wrong-account failures.
- **F4:** the `calendar.not_sent` event was written even when the guarded update matched no row.
- **F5:** the stored draft was revalidated outside the not-sent boundary.

Fixes:

- **F1:** a new test covers an insert network error and an insert 500; it fails under the reviewer's mutation.
- **F2:** userinfo 401/403 and missing configuration are now classified as authorization.
- **F3:** the wording is now a neutral "authorization failed".
- **F4:** the event is written only when the row was updated; otherwise the callback reports uncertain.
- **F5:** the stored draft is now validated only inside `create`.

Devin Review on `652a3278` raised two findings. The first, userinfo 401/403 classified as `not_sent`, was already fixed in `900b83c`. The second was that every token 400/401 was called expired, although `invalid_client` needs a settings fix rather than reconnection. That was addressed by parsing the OAuth `error` code and adding the structured `GoogleAuthError` classification above.

Independent review, round 2: the same reviewer returned **APPROVE** on exact head `60c3bda915257f81c2ffae331c01d1b7871c88f9`. It re-ran `npm run check` (346 application and 10 script tests) and Prettier on a clean `git archive` of that SHA. Mutations caught by tests 5 and 7 included: the insert wrapped as not-sent, every token 400/401 treated as authorization, the userinfo 401/403 mapping removed, and the error kind not propagated.

The reviewer left non-blocking notes, deferred here:

- The F4 row guard, the F5 validation placement and the Telegram `configuration` reply are correct by probe but not pinned by tests.
- A token-endpoint 403 is still classified as `not_sent`.
- The `configuration` reply says "before drafting again" although drafts are not blocked.

It could not verify Google's OAuth error semantics (`invalid_grant`/400, `invalid_client`/401) against the documentation because the session's network proxy blocks the documentation hosts.

## Verification and outcome

**Tested:** `npm run check` (346 application and 10 script tests after the review fixes) and `npm run format:check` passed locally on 2026-09-23. No live Google or Telegram check was run.

Remaining operator steps: reconnect Calendar with `scripts/connect-calendar.mjs` and replace `CALENDAR_REFRESH_TOKEN`, confirm whether the Sheets token also needs renewal, and inspect/clear any existing `uncertain` `calendar_create` approval created by this incident. The deployed code cannot distinguish that older row from a genuinely uncertain write.

## Follow-up and next iteration

Runtime context lists only pending Calendar approvals, so the model does not see a failed or created outcome. Diagnostics also omit approval states and tool error codes, which prevented confirming this incident remotely. Both are candidate follow-ups.

### Release closure — 2026-09-23

- **Merge:** [PR #81](https://github.com/akhilvuputuri/chief-agent/pull/81) was squash-merged as `7648fca5cb7f2cd0590a7db5e496f3c4a6f97b33` from approved head `60c3bda`. The merge sits on top of the watchlist-only #80 (`2f57b24`), which merged while this PR was open.
- **Checks:** [checks run 35867846631](https://github.com/akhilvuputuri/chief-agent/actions/runs/35867846631) passed on the merge commit.
- **Release:** [release run 35868480055](https://github.com/akhilvuputuri/chief-agent/actions/runs/35868480055) re-ran format, check and build, then deployed and reported `{"deployed": "7648fca5cb7f2cd0590a7db5e496f3c4a6f97b33", "healthy": true}`.
- **Scope:** application-only; no migration or Compose change.
- **Version:** no version tag was published, because the package version was not bumped in the PR.

Startup health does not show that Calendar works. Remaining steps:

- Reconnect Calendar and replace `CALENDAR_REFRESH_TOKEN`.
- Check whether the Sheets token also needs renewal.
- Clear any `uncertain` `calendar_create` row left by the original incident.
- Then the owner should confirm, with a real Telegram approval, that an event is created. Until the credential is replaced, an approval should now produce the reconnect message rather than "uncertain".

### Follow-up — 2026-09-24

**Owner report:** a new Calendar request failed and a later request still could not query Calendar. The owner also saw an unrelated old job-task status after following the bot's `/status` hint. The bounded trace of the two latest Calendar runs contained no job-data reply; the screenshot and `/status` source code established that the old task came from the global status command.

**Measured on production before repair:** the older approved Calendar action was still `uncertain`; the server's Calendar refresh request returned Google `invalid_grant`. The subsequent `calendar_list` returned `AUTHORIZATION_REQUIRED`. A new `calendar_draft` hit the stale approval guard before inserting a draft, but the generic error was classified as `TOOL_FAILED` on a write. The runtime therefore marked that tool call uncertain and stopped with a generic operational error. The model also suggested a nonexistent in-app connection screen after the read failure.

**Operator repair:** the owner completed a fresh Google consent. The new credential matched the configured primary account and could read primary-calendar events. A read-only GET for the old approval's deterministic event ID returned 404 roughly a day after the failed attempt. The operator installed only the new Calendar refresh token in the server's owner-only `.env`, restarted the healthy gateway while no run was active, verified a server-side primary-calendar read (HTTP 200), and recorded a guarded `reconciled_absent` resolution plus an audit event for the old approval. No event insert or retry was performed. A successful live creation is still unverified until the owner approves a new Telegram preview.

**Application follow-up:** classify the pre-draft uncertain-approval guard as `ToolValidationError`, so the runtime records a definite failed invocation and lets the model explain that no new draft was saved. The context now says that Calendar authorization requires operator reconnection and forbids an invented settings flow. The OAuth helper reports which nonsecret verification stage failed. A regression test covers the prior approval state, zero new drafts and the `VALIDATION_FAILED` classification. Release evidence follows below.

**Separate status confusion (owner screenshot, 24 September):** after the generic error told the owner to use `/status`, that command listed an older paused research task. Source inspection shows `/status` without an ID lists all unfinished tracked tasks across conversations; the Calendar request did not route into or resume that task. The error hint was wrong because the Calendar turn was untracked. A follow-up change distinguishes untracked failures from task-bound failures and labels the global list explicitly. It does not change task routing or restart old work.

**Review/merge boundary:** [PR #89](https://github.com/akhilvuputuri/chief-agent/pull/89) passed CI (403 application and 10 script tests) and an independent GPT-6 Astra review approved exact head `dec3c8e`. It was squash-merged as `05b68a2` on 24 September Singapore time. The server was still at `7b1cff9` at merge, so the application guidance fix is not yet a verified production behavior; migration 019 in main requires the reviewed operator rollout before this and the status-guidance follow-up can be live.

**Release closure:** [PR #90](https://github.com/akhilvuputuri/chief-agent/pull/90) passed CI (404 application and 10 script tests) and independent GPT-6 Astra review on exact head `814de8d`, then merged as `6927494`. [Main checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/35895599690) passed. An independent reviewer approved the combined `7b1cff9` → `6927494` operator rollout. Its script installed migration 019 and reported the exact commit healthy; separate inspection confirmed `RELEASE`, gateway health, the old approval recorded as `failed/reconciled_absent`, and a post-rollout primary-calendar read (HTTP 200) using the renewed account. [v0.3.24](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.24) tags the deployed commit. The automatic [release job](https://github.com/akhilvuputuri/chief-agent/actions/runs/35896375462) never started because GitHub Actions reported an account payment/spending-limit block; the reviewed operator rollout, not that job, deployed the code. A real Telegram draft plus owner-approved event creation remains unverified.
