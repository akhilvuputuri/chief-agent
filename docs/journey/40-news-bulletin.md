# 40 — A lean daily news bulletin from followed sites

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

## Verification and outcome

- **Synthetic (PGlite, mocked fetcher):** 14 tests. They cover address normalization and refusal of private hosts, the three discovery paths plus the no-feed case and the request cap, untrusted feed text, the DNS guard, foreground-only and owner-scoped mutations, enable prerequisites, a single edition at the SGT slot with duplicate-story collapse and no repeated links the next day, enabling after the slot starting tomorrow, ranking and the per-site cap, set-state votes shifting the next edition, the on-demand limit and the "nothing new" message, all-sources-failed retries then an explanation, muting on disable, uncertain delivery across restart, and turning off when the last site is removed. `npm run check` passed 461 application and 21 script tests.
- **Measured, picker eval (28 September, developer Mac, `typesafe/jev-1.13-20260917`, 3 runs, 543 calls):** pooled recall 97.8% (tuning 98.0%, held-out 97.5%), against 97.9% for the 27 September baseline on 522 calls. No news scenario was missed. Extra groups per call were 0.34 (baseline 0.29), schemas were 18.0% of all tools, and there were no errors. Cost $0.044, p50 374 ms. Persistent misses were the four known ones from [37](37-jev-tool-picker.md). `news-6` ("has my news been set up?") was among 12 scenarios whose picked set varied between runs. The scenarios are synthetic; this does not measure production traffic.
- **Not verified:** real sites' feeds, Telegram rendering and buttons, and owner acceptance.

## Follow-up and next iteration

`scripts/deploy-news.py` is the migration-020 script with only its constants changed. Its baseline is the live `069c8d5`, and 14 offline tests pass. Its test allows only the `ON DELETE SET NULL` foreign-key clause among destructive keywords. The package version is bumped to 0.3.28, which will label #107, #108 and #109 once this is verified live.

Pending: re-review of the fixes, merge, operator rollout, then the owner configuring sites, time and topics in Telegram and receiving a first edition.
