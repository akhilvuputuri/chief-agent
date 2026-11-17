# GitHub issues filed by Chief, after owner approval

Status (17 November 2026): built, not yet rolled out. Needs the operator steps [below](#operator-rollout), including the owner creating a GitHub token.

## What it does

The owner can say "file this as a GitHub issue" or "log this bug on GitHub", mainly for bugs and feature requests about Chief itself (the `chief-agent` repo). Chief then:

1. Optionally searches the open issues of the repo for a duplicate (`github_issue_search`, read-only) and says so if one already covers it.
2. Writes the title and markdown body itself and calls `github_issue_draft`. That saves a draft in Postgres. Nothing is sent to GitHub.
3. Telegram shows a card with the repo, title, labels and a body preview (the whole body; bodies are limited to 3,000 characters so it always fits), with **Approve issue** and **Discard**. Only the button can approve. Text assent such as "yes, go ahead" and `/approve UUID` cannot.
4. On **Approve issue** the gateway creates the issue and the card reply gives the real URL and number. Chief says an issue was filed only when its runtime context (`githubIssueApprovals`) shows the approval as `created`.

It follows the Calendar draft pattern ([calendar approval](calendar-approval.md)): the same `approvals` table, the same claim-before-work Telegram callback, the same uncertain-write handling.

## Scope and limits

- **Allowlist.** `GITHUB_ISSUE_REPOS` in `config/runtime.json`: comma-separated `owner/name`, default `akhilvuputuri/chief-agent`. A draft or search for any other repo is refused before anything is saved or sent, and the allowlist is checked again when the Approve button is tapped. Change it with a reviewed PR; no operator step is needed for the list, but the token must also cover any repo added.
- **Only these GitHub calls exist** (`src/github-issues.ts`): create an issue (`POST /repos/{repo}/issues`), list a repo's issues to find one that may have been created (`GET /repos/{repo}/issues`), and search open issues (`GET /search/issues`, results filtered to the allowlisted repo). There is no comment, edit, close, label-management, assignee, pull request, push or merge call. A test asserts that no other endpoint is used.
- **One owner.** The tool works only for the first Telegram user in `TELEGRAM_ALLOWED_USER_IDS`.
- **Labels.** Labels the model chooses are sent as given. GitHub may create a missing label if the token can, or drop it; not verified against real GitHub.
- **Drafts.** A draft expires after one hour. At most five unexpired drafts wait at once. An identical draft saved twice is one card. Changing a draft means a new draft.
- **Not a new capability for the coding jobs.** Coding jobs keep their own GitHub App; this token is separate and cannot push or open PRs.

## Credential

`GITHUB_ISSUES_TOKEN`, passed to the gateway by `compose.yaml` from the host `.env`. Create it as a **fine-grained personal access token** (or a GitHub App installation token) with:

- repository access: **only** the allowlisted repositories (`akhilvuputuri/chief-agent`);
- permissions: **Issues: Read and write**. Metadata read is added automatically. Nothing else.
- an expiry you can track. When it expires GitHub answers 401, the card says the token was rejected and nothing is created.

The token is read only inside the HTTP request header. It is not in tool results, Telegram text, events, receipts or logs, and the model never sees it. Without it the tools answer `not_configured` and save nothing; a tap on an older card then fails with "token no longer configured" and sends nothing.

## Idempotency and uncertain results

GitHub's issue API has no request key, so the host does the work:

- The Approve tap claims the approval row with a conditional `UPDATE … WHERE status='pending' AND expires_at>now() RETURNING`. A second or simultaneous tap loses the claim and gets the recorded outcome. Only the claimant posts, once.
- The posted body ends with a hidden marker `<!-- chief-request:<approval id> -->` that identifies the attempt.
- GitHub **refuses** (401, 403, 404, 410, 422, 429): a definite non-creation, recorded as `failed` with a reason. Repeat taps return that outcome and never retry. The owner asks for a new draft.
- A **timeout, network error, 5xx or unreadable reply** might have created the issue: recorded as `uncertain`, never retried. The card offers **Check status**, which only reads: it lists the repo's recent issues and looks for the marker. If found, the approval is recorded as `created` with its URL. If absent, it stays uncertain until five minutes after the attempt began (no request can still be in flight), then settles as `failed` (`not_found`). If GitHub cannot be read, it stays uncertain.
- The URL reported is built from the repo and the issue number, not taken from the response.
- If the check itself fails, or recording the result fails after the attempt, the owner still gets the uncertain wording and the Check status button, never advice to draft again. Only a card that is expired, discarded or unknown says it is unavailable.

## Privacy

The issue may be public. Before drafting, Chief is told (tool description and the `github` domain guidance in `src/tool-domains.ts`) to write the body in its own words and leave out private data: meeting links, email addresses, phone numbers, booking, account, order or tracking numbers, tokens, keys, passwords, addresses and other people's details, using placeholders such as `<email>`. This is judgment guidance, not a filter: there is no deterministic redaction. The card shows a body preview and the owner is the last check: **read it before tapping Approve**. Bodies are limited to 3,000 characters so the card shows all of it; if a body ever exceeds what the card can hold, the card says how many characters are not shown.

## Where it lives

- `src/github-issue-schema.ts`: tool schemas (`github_issue_draft`, `github_issue_search`).
- `src/github-issues.ts`: draft, search, decide and settlement.
- `src/telegram.ts`: the card (`sendGithubApprovals`, delivered from the interactive turn and the background delivery path) and the `gh:yes|no:<uuid>` callback.
- `src/tool-domains.ts`: the `github` tool domain, its cue words and guidance. `config/tool-picker.json` has the matching picker group.
- `db/037_github_issues.sql`: widens the `approvals.operation` list with `github_issue_create`.
- `tests/github-issues.test.ts`: draft → approve → create, discard, missing token, allowlist, duplicate and simultaneous taps, refusals, timeouts, settlement. The GitHub API is mocked.

## Picker evals

`config/tool-picker.json` gained a `github` domain and `evals/picker/scenarios.json` seven scenarios. The owner needs to run `kite run eval:picker` (about $0.04) and compare it with the last run before merging. It was not run by the coding job.

## Operator rollout

The release guard refuses any `db/` or `compose.yaml` change an operator rollout has not installed, so this feature needs the reviewed procedure. The PR carries `db/037_github_issues.sql`, its Compose line after `036_study_resources.sql`, the `GITHUB_ISSUES_TOKEN` Compose line, and [`scripts/deploy-github-issues.py`](../scripts/deploy-github-issues.py) with its test.

**Owner, before the rollout:**

1. Create the fine-grained token described [above](#credential) at GitHub → Settings → Developer settings → Fine-grained tokens, with only the allowlisted repo and Issues read/write.
2. Add `GITHUB_ISSUES_TOKEN=<token>` to the host `.env` on the server (mode 0600). Never paste it in chat, a PR or a log. The rollout can run without it; filing then answers "not configured" until it is set and the gateway container is recreated (`docker compose up -d --no-deps gateway`; a plain restart does not re-read the environment).
3. Run `kite run eval:picker` and check the result.

**Operator, in order:**

1. Check the live `RELEASE` equals the script's `BASE` (`3e1e3144ecb93ae3b4a0e60484d01d6543e4129f`). If main has moved, update `BASE` in a follow-up commit and have it reviewed first; never edit `RELEASE`.
2. Merge the PR manually after independent approval and green CI. Note that the automatic release is refused for the `db/` and `compose.yaml` change, which is expected.
3. Archive the merge commit: `git archive --format=tar --prefix= -o github-issues.tar <merge SHA>` (with the commit recorded in the archive comment, as for the earlier rollouts).
4. Upload the archive and `scripts/deploy-github-issues.py` to the server, and diff the uploaded script against the merged file. They must be identical.
5. With the gateway idle, run `sudo python3 deploy-github-issues.py <archive.tar> <merge SHA>`. It, under the release lock:
   - checks only migration 037, its Compose line and the `GITHUB_ISSUES_TOKEN` line changed, and `Dockerfile.postgres` did not;
   - builds the candidate image;
   - refuses active runs or queued input (retry when idle; never cancel work);
   - stops the gateway and applies the migration, then checks the version 37 marker;
   - installs the Compose file, starts the candidate and checks health.
6. The next automatic release then starts the CI-built image.
7. First live use: ask Chief to file a harmless test issue, read the card, tap Approve and check the URL it reports. Close the test issue by hand on GitHub; Chief cannot.

**On failure:** any error before the migration leaves the live app untouched. A failed migration is one transaction and rolls back. If the candidate fails health, the script restores the previous image, the old Compose file and `RELEASE`, and exits with "Candidate failed; previous application healthy". The committed migration is kept: it only widens a constraint, and the previous image ignores the new operation. If even the rollback is not healthy, it exits "Rollback needs operator inspection" and changes nothing further: inspect the gateway logs, do not replay.

**Rollback later:** application-only to the previous image. Keep the widened constraint. Do not re-run migrations 003–036 against a database that holds a `github_issue_create` row: 003, 009 and 016 put back a narrower operation list, and adding a constraint checks existing rows, so a plain `docker compose up` that re-runs the migrate service fails once such a row exists (the same limitation as `responsibility_confirm`, see [IBKR](ibkr-portfolio.md)). Production avoids this by starting the gateway with `--no-deps`, as the rollout script does; keep doing so. Setting `GITHUB_ISSUES_TOKEN` empty turns filing off without a release.

If migration 037 is missing, the feature fails only when a draft is saved (the insert is refused); other turns are unaffected.
