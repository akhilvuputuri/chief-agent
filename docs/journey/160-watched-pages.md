# 160 — Can a parcel watch read the carrier's page without a model driving it?

Work date(s): 2026-11-11. Written/revised: 2026-11-11.
Status: tested. The page check is implemented with mocked sources. No real carrier page has been read by it: both carriers' sites were unreachable from the cloud session, so whether SingPost shows a result at a direct address is still unknown.

## User-visible problem and preceding iteration

The owner asked Chief to keep watching two parcels. Chief reported on the Japan Post one and not on the SingPost one, until the owner told it to use the browser in the foreground, which worked.

This builds on [responsibilities](54-responsibilities.md), whose scheduled research runs one fixed web search per occurrence, and on the [public browser agent](148-public-browser-agent.md), which only the browser agent's own run may use.

## Evidence

Measured from sanitized production logs with `kite run logs:cloudwatch`, 10 November 14:15 to 11 November 14:15 SGT:

- One responsibility was created on 10 November at 17:24 SGT. Nine background passes followed, two hours apart, the last at 09:24 SGT on 11 November. No pass ran at 11:24 or 13:24; five releases went out between 10:20 and 11:31, and the logs do not say whether the watch ended, was cancelled or stalled.
- Each pass made one successful `web_search` (9–23 s). `web_read` was refused 7 times with `VALIDATION_FAILED`, and `web_search` twice. No page read succeeded in any pass.
- `responsibility_report` was refused 7 times with `INVALID_INPUT` and accepted 7 times. The logs carry no field name, so the refused field is unknown.
- In the foreground on 11 November, five browser agent runs took 40–145 s each, with 11–15 `public_browser` calls per run; 8 of those calls failed.

Hypothesis, not tested: the Japan Post result is plain HTML that the search provider could fetch, and SingPost's needs a real browser. The logs hold no page content.

## Diagnosis and alternatives

A scheduled pass may read only the addresses its own search returned ([responsibilities](../responsibilities.md#source-adapters)). A carrier's result page is not a search result, so the pass could never open it. The rule exists to stop source text widening a search, and it was working as designed.

Two ways to reach the page were considered:

- **Give the scheduled pass the browser.** It needs 11–15 model steps per reading against a limit of 10 model calls per investigation, spends them every two hours whether or not anything changed, and puts page-controlled text in front of an unattended model that holds a browser. It also breaks the rule that only the browser agent holds `public_browser`.
- **Let the host read one confirmed address.** Chosen. The host opens the address, takes the text, and compares it with the last reading. The model runs only on a change and holds only the report tool. This matches the Gmail and parcel checks, which are also deterministic.

The second fails for a page that needs a form, a click or a CAPTCHA to show its result. For such a site the first remains the fallback, and would need its own review.

## Implementation and review

- `src/responsibility-schema.ts`: a responsibility may name `page: { url, minutes }`, a public HTTPS address re-read every 30–720 minutes (default 120).
- `src/public-browser/client.ts`: `PublicBrowser.snapshot` opens one address, reads its text until two readings match (at most four, 2.5 s apart) and always closes. It never clicks, fills or runs a caller's script, and stores nothing. It is a host path with no model, so it does not pass the browser agent check.
- `src/responsibility-worker.ts`: the check normalizes whitespace, keeps the first 8,000 characters and hashes them. A hash that differs from the last reading admits one candidate holding that text; an unchanged one admits nothing. A busy browser retries in two minutes without a failure. An empty page, or one that lands on another host, degrades the watch through the existing path. A reading no investigation has taken is replaced by the next.
- `src/responsibilities.ts`: the confirmation card shows the address and interval. A page cannot share a responsibility with a schedule or parcel IDs.
- No migration. The check is stored under the existing `schedule` trigger kind, because the triggers table's check constraint allows only four kinds and a database change cannot go out through the ordinary release.
- The investigation writes no parcel record. `parcel_updates.source_kind` allows only `email` and `user`, and unattended parcel writes stay email-only.
- `src/execution.ts`, `src/ops-log.ts`: a refused `responsibility_report` logs `errorField`, the first refused argument path. It is limited to that tool because its schema has only host-named keys and array indexes.

Independent review (Claude Opus 5.5) requested changes on `5ab0e3e`:

- **Blocking:** candidates were keyed by the text's hash, so a page that returned to an earlier, already investigated text admitted nothing while the check was recorded as a success. Confirmed by the reviewer's own test. Candidates are now keyed by reading.
- The confirmation card said the model runs "only when its text changes", though the first reading always runs one, and it did not mention text that differs on every reading. Both are now on the card.
- Findings for a page were deduplicated by outcome and the model's fact key, so a second real change within 24 hours could be dropped. A page now uses the default, per-candidate key.
- A slow page could outlast the two-minute lease. The reading is now cut off at 90 seconds.
- Smaller: the superseding delete was not guarded by the lease and active status; a `www.` redirect degraded the watch; the investigation prompt forbade "carrier verification" while asking for a carrier page to be reported; a reading carried no untrusted marker; the log test used a hand-written message, not a real schema refusal. All corrected.

The reviewer found no boundary break in the host browser path or in `errorField`.

A second independent review (Claude Opus 5.5) approved `7950e31` with no blocking finding, after re-testing each correction, and asked for three more changes before release:

- The delete of a superseded reading and the statement admitting the new one were separate, so a pause between them could lose both. Confirmed by the reviewer's own test. They are now one statement.
- The 90-second cut-off and the pause-during-check guard had no test in the repository. Both now have one.
- Three places still said the model runs "only when its text changes". Corrected.

It also noted that a "busy" reply after a successful open degraded the watch instead of retrying (now treated as busy), and that a rollback to an older image degrades each page watch once (now in the responsibilities doc). Review of the head with these changes: pending.

## Verification and outcome

Tested with PGlite and mocked sources: `tests/responsibilities.test.ts` (baseline, unchanged text, busy browser, change, first-match closure, superseded readings, empty and redirected pages, refused combinations and addresses, the investigation's tool scope), `tests/public-browser.test.ts` (command sequence, busy, failure) and `tests/ops-log.test.ts` (`errorField`).

Not tested: any real carrier page; whether the text of a real tracking page is stable between readings; a provider accepting the changed `responsibility_create` schema.

## Follow-up and next iteration

- Read `errorField` after the first refused report in production and fix the report schema or its guidance.
- Watch one real SingPost parcel. A page whose text changes on every reading (a clock or a rotating banner) would wake the model on each check, up to the existing six investigations a day, and delay a real change until the next day.
- Find out why no pass ran after 09:24 SGT on 11 November.
