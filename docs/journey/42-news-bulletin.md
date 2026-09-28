# 42 — A lean daily news bulletin from followed sites

Work date(s): 2026-09-27 to 2026-09-28. Written/revised: 2026-09-28.
Status: tested; in review. Needs migration 021 through the reviewed operator procedure; migration 020 ([39](39-watch-monitoring-window.md)) is already live. Not deployed; nothing configured.

## User-visible problem and preceding iteration

On 27 September the owner asked in Telegram whether their news bulletin had been set up, believing it had been merged. The assistant correctly answered that no bulletin existed. [Issue #50](https://github.com/akhilvuputuri/chief-agent/issues/50) had a full implementation in [PR #83](https://github.com/akhilvuputuri/chief-agent/pull/83), but it was parked on 26 September behind issue #77 and never merged. [PR #58](https://github.com/akhilvuputuri/chief-agent/pull/58) (merged 20 September) shipped the general routine engine ([24](24-scheduled-routines.md)), not a news feature.

## Evidence

- **Production inspection (observed, read-only, 27 September ~21:18 SGT):** `agent_routines`, `routine_occurrences` and `daily_schedules` were all empty. CloudWatch `schedules` over the previous 24 hours returned 0 rows. The tool journal shows `routine_list` and `schedule_list` returning `[]` before the assistant's reply. No news routine had ever been created, so nothing could have run.
- **Owner decisions (27 September):** close PR #83 because about 5,000 added lines was too large to review, and restart smaller. Sources are sites the owner follows, named by address (not raw RSS links), with feeds found automatically. The owner chose this over having Chief browse sites with a model each day. Time, topics and sites are configured through Chief, not preset by the developer.

## Diagnosis and alternatives

- **Agent routine vs deterministic bulletin.** A routine could run today with no code, but it calls the model every day, its prose cannot carry per-item 👍/👎 buttons, and it can misdate or invent items. The owner chose feeds.
- **Kept from PR #83:** the feed boundary (bounded RSS/Atom parser, entity-safe text cleaning, canonical URLs, near-duplicate tokens, and the connection-time DNS guard against private addresses), because it had already been examined for SSRF and injection.
- **Dropped from PR #83 to stay small:** the candidate cache, dislike reasons, per-item mute buttons, preference overrides and versions, discovery slots, language filters, baseline-comparison traces and "why this?". Votes live on the delivered item and weights are recomputed from them, which keeps learning inspectable and replayable without extra tables.
- **Added:** site-to-feed discovery (the address itself, then an advertised `<link rel=alternate>`, then conventional paths).

## Implementation and review

See [the bulletin runbook](../news-bulletin.md). `db/021_news.sql` adds four tables: settings, sources, editions (the outbox) and items (which hold votes). `src/news.ts` is about 700 lines and `src/news-feed.ts` about 550 (mostly from PR #83). A new picker domain `news` with cues, a picker description and seven synthetic eval scenarios (four tuning, three held-out). Telegram `nw:` callbacks. The gateway refuses to start without migration 21.

**Independent review round 1 (Opus 5.5, on `2f428fa`): REQUEST CHANGES.**

- **(P1, measured by the reviewer)** The regex-based feed parser slowed quadratically on unclosed tags: 49.8 s for a 1.45 MB body of unclosed `<item>`, which is under the fetch cap. Parsing is synchronous, so one hostile or broken feed could stall the whole gateway. It was replaced by a linear element scanner: closing-tag and `>` searches only move forward and are reused, open tags are capped at 4 KB, and text-cleaning input is bounded. Re-measured on the author's Mac with the same shapes at 1.2–1.56 MB, the worst case (unclosed categories) was 179 ms, and a regression test enforces a 1.5 s limit.
- **(P3)** Also fixed:
  - the 200-character callback limit (answers are truncated);
  - overall deadlines of 45 s for discovery and 90 s for gathering, with the docs corrected;
  - separate scheduling and delivery lanes, with per-owner error isolation;
  - fitting whole items instead of cutting text mid-item;
  - undated items are never re-sent;
  - `nextEdition` after today's edition is built;
  - wording when every site fails;
  - untrusted markers in `news_status`;
  - journal renumbering.

**Independent review round 2 (Opus 5.5, on `1e8e079`): REQUEST CHANGES.** The earlier findings were confirmed fixed.

- **(P2, measured by the reviewer)** `cleanText`'s `<[^>]*>` was still quadratic within its 4 KB bound. Across many fields, a 1.42 MB feed took 7.2 s. It now uses `<[^<>]*>` plus forward-only CDATA and script/style stripping. The same shapes (`<`, CDATA, `<script`, `<style`, `</item`) at 1.45 MB now take at most 41 ms on the author's Mac, and are added to the timing test.
- **(P3)** A closing tag with a longer name (`</linkedin>`) no longer closes `<link>`; HTML `<link>` discovery scans opening tags only.
- **(P3)** The callback answer is now cut on code points.

**Independent review round 3 (Opus 5.5, on `c9d6f7c`): APPROVE, with one P3.** The reviewer measured 13 further hostile shapes; all took at most 39 ms at 1.45 MB. The P3: escaped `<script>`/`<style>` in headlines (common in web-development news) made the forward-only stripper drop the rest of the title. It now requires a name boundary and removes only complete elements. A kind with no closing tag is left to the generic tag stripper, so words survive: "How <script type=module> loads" becomes "How loads", the same as the original regex.

**Devin Review (automated, on `1e8e079`), fixed in `c00bfdc`:**

- A build that finished after the owner switched the bulletin off left a dormant pending edition, which re-enabling would have sent days later. Now a build mutes its own edition if the bulletin is off, and scheduled editions are sent only on their own day (older ones are muted).
- Removing a site withdraws a queued edition that carries its items.
- An aggregator feed linking to many publishers counts as one site for the per-site cap and for votes. The followed site's domain is used, not the article's.
- Status reports a pending same-day retry ("today, retrying at 08:15 SGT") instead of tomorrow.

Each has a regression test (23 news tests). The branch was then rebased onto `7e8dfd3` (#110 and #111). Those PRs took journal numbers 40 and 41, so this entry is 42.

**Independent review round 4 (Opus 5.5, on `b962916`): APPROVE, with three P3s.** Devin Review on the same head found three more issues. All of these were addressed except the last:

- A saved feed that starts serving an HTML page with HTTP 200 (an expired feed or a bot block) was read as an empty feed. That used up the day's edition on "Nothing new". Such a body is now a fetch failure, so the site is reported and the retry path applies.
- When two feeds carried one link, whichever copy arrived first was kept. Now every copy is scored first, and the best one is kept.
- Site removal and settings changes now go through the owner's build queue, which closes the reviewer's two build-interleaving races.
- **Known limit, not changed:** when the 45 s or 90 s deadline fires, it stops waiting, but the underlying request keeps running until its own timeout (15 s per request, up to three redirects). Up to four fetches are in flight at a time, so this stays bounded.

**Devin Review (automated, on `d2d5bf1`), fixed:**

- A scheduled build that crossed midnight was muted, because expiry was by date. Pending editions now expire by age: 6 hours for scheduled, 1 hour for on-demand, with `created_at` taken from the gateway clock. This also withdraws an on-demand edition that is still pending after a restart.
- Removing a site muted the day's edition but left its slot taken, so no bulletin came that day. Moving the delivery time left the old edition queued. The per-day unique index now excludes muted editions: a withdrawn edition frees the day, and the next due tick rebuilds it from current sites and settings. A time change mutes the pending edition.
- Votes on items from undelivered editions are ignored.

There are 3 new regression tests (28 news tests in total). Migration 021 is not deployed yet, so its index predicate could change without a second migration.

## Verification and outcome

- **Synthetic (PGlite, mocked fetcher):** 14 tests at first review; 28 after the review rounds below. They cover address normalization and refusal of private hosts, the three discovery paths plus the no-feed case and the request cap, untrusted feed text, the DNS guard, foreground-only and owner-scoped mutations, enable prerequisites, a single edition at the SGT slot with duplicate-story collapse and no repeated links the next day, enabling after the slot starting tomorrow, ranking and the per-site cap, set-state votes shifting the next edition, the on-demand limit and the "nothing new" message, all-sources-failed retries then an explanation, muting on disable, uncertain delivery across restart, and turning off when the last site is removed. `npm run check` passed 461 application and 21 script tests.
- **Measured, picker eval (28 September, developer Mac, `typesafe/jev-1.13-20260917`, 3 runs, 543 calls):** pooled recall 97.8% (tuning 98.0%, held-out 97.5%), against 97.9% for the 27 September baseline on 522 calls. No news scenario was missed. Extra groups per call were 0.34 (baseline 0.29), schemas were 18.0% of all tools, and there were no errors. Cost $0.044, p50 374 ms. Persistent misses were the four known ones from [37](37-jev-tool-picker.md). `news-6` ("has my news been set up?") was among 12 scenarios whose picked set varied between runs. The scenarios are synthetic; this does not measure production traffic.
- **Not verified:** real sites' feeds, Telegram rendering and buttons, and owner acceptance.

## Follow-up and next iteration

`scripts/deploy-news.py` is the migration-020 script with only its constants changed. Its baseline is the live release, which was `069c8d5` when first written then `7e8dfd3` after #110 and #111, `b01c4e8` after #112, and `54fc145` after #113 (all app-only), and 14 offline tests pass. Its test allows only the `ON DELETE SET NULL` foreign-key clause among destructive keywords. The package version is bumped to 0.3.28, which will label #107, #108 and #109 once this is verified live.

Pending: re-review of the fixes, merge, operator rollout, then the owner configuring sites, time and topics in Telegram and receiving a first edition.
