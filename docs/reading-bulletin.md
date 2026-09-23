# Daily reading bulletin (issue #50)

Up to five readings a day from feeds the owner approved, delivered in Telegram with per-item Like / Dislike buttons. Explicit feedback shifts later rankings through an inspectable, bounded weight table. Candidate gathering, ranking and delivery are deterministic: **no model call builds or sends an edition**, so a selection can be replayed and explained from its saved trace. The conversational agent only configures the bulletin.

Code: `src/reading.ts` (ranking, learning, editions, scheduler, outbox, buttons, tools), `src/reading-feed.ts` (RSS/Atom parsing, URL canonicalization, guarded fetcher), `db/019_reading.sql`, `tests/reading.test.ts`.

## Setup and conversational control

Nothing is scheduled until the owner supplies preferences. The agent must not assume jobs, AI or any other subject.

1. `reading_source_add(url,name?,topics?)` adds a public HTTPS RSS/Atom feed the owner chose. It is fetched and parsed immediately; an unreadable feed is not saved. `topics` label every item from that feed and count as an interest match when they name an interest. Up to 30 feeds.
2. `reading_settings(...)` sets `interests` (`[{topic, keywords?}]`, matched as whole phrases in headline, excerpt, feed categories and feed topics), optional `languages` (ISO 639 codes checked against the feed's declared language; undeclared languages pass), `preferredDomains`, `excludedDomains`, `mutedTopics`, `deliveryTime` (HH:MM), `timezone` (IANA), `itemsPerEdition` (1–5, default 5), `discoverySlots` (0–2, default 1), `enabled` and `paused`. Lists replace the stored value. Enabling, and any later change while enabled, is refused until interests, time, timezone and at least one active feed exist.
3. `reading_edition_now()` builds and delivers an on-demand edition (at most three per local day). It works before the scheduled bulletin is enabled, which lets the owner preview.
4. `reading_status()` shows settings, feed health, learned weights, recent editions and metrics; it and `reading_explain` are classified as read operations. `reading_explain(itemId)` answers “why did I receive this?”. `reading_preferences(action,key?,weight?)` sets or clears an owner override for `topic:NAME` or `source:DOMAIN` (−3…3), or resets learning.
5. `reading_source_remove(id)` removes a feed and its undelivered candidates. Removing the last active feed switches the daily bulletin off and mutes any pending scheduled edition, so it never sends empty editions.

Mutations are foreground-only, like the watchlist and routines: a background routine can read status but cannot change settings, feeds or preferences or request an edition.

## Candidates and provenance

Each build refreshes due feeds (at most every 30 minutes per feed, four at a time, 15-second and 1.5 MB limits, three redirects). Each feed contributes up to 50 entries with a title and an http(s) link. `reading_candidates` records the canonical URL (scheme, `www.`, fragment, trailing slash and tracking parameters removed), original URL, article domain, title, feed excerpt, feed categories and declared language, **publication time from the feed only** (NULL when missing, unparseable, more than a day in the future or before 1995) and **first/last discovery time** separately. Candidates unseen for 45 days are pruned; delivered items are copied into `reading_items`, so pruning never changes history.

Failures back off per feed (30 minutes doubling to 12 hours) and are listed in the edition trace and `reading_status`.

Feed text is untrusted. Markup, scripts, control and bidirectional-override characters are removed; only fixed named and numeric entities are expanded, so DTD entity payloads remain inert text; `javascript:`/`data:`/credentialed links are dropped. Messages are sent as plain text with link previews disabled. Tools that return article text mark it `untrusted`.

### Network boundary

Other page retrieval in this project happens at hosted providers. Feed polling is the exception: the gateway fetches feeds directly because RSS/Atom must be read as XML and repeatedly, without a paid extraction API. `PublicFeedFetcher` accepts only public HTTPS hostnames without ports or credentials (`publicHttps`), and resolves DNS inside the connection's `lookup` hook: if **any** resolved address is loopback, private, link-local (including the cloud metadata address), CGNAT, documentation, multicast, reserved, IPv4-mapped/-compatible IPv6, NAT64, 6to4 or site-local, the connection is refused. The socket uses the validated answer, so a rebinding response between check and connect cannot reach an internal host. Redirect targets go through the same checks, and every failure — including a refused redirect target — rejects the fetch rather than throwing inside a socket callback. No cookies or credentials are sent.

## Ranking (inspectable)

Hard exclusions come first and are counted per reason in the edition trace: excluded/muted source domain (including subdomains), muted topic (any item label, or the phrase in the headline or excerpt), declared-language mismatch, URL already delivered in the last 14 days, and a near-identical story already delivered (title-token Jaccard ≥ 0.6). An owner's mute always wins over learned preference.

Each remaining candidate gets:

| Component  | Value                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `interest` | 2 when an interest phrase is in the headline; 1.2 when only in excerpt/categories/feed topics; 0 otherwise                       |
| `source`   | 0.5 for a preferred domain                                                                                                       |
| `feedback` | `0.5 × mean(topic weights) + 0.4 × source weight`, clamped to ±1.5                                                               |
| `recency`  | `exp(−age/48h)`; 0.3 when the feed gives no date. Items older than three days are labelled **Older piece**; the window is 7 days |

Selection collapses near-duplicate stories (keeps the best-scoring member), then fills `itemsPerEdition − discoverySlots` slots from interest matches with at most two per domain and per primary topic, relaxing the topic cap and then the domain cap only if slots remain. Discovery slots take the freshest items that match no interest and are not clearly rejected (feedback above −1, which needs reasoned votes or many recent dislikes), under the same two-per-domain cap unless no alternative exists, labelled **Discovery pick**; an unused discovery slot returns to interests. Items outside interests never pad beyond that allowance: when candidates run short the edition has fewer items and says why (failed feeds or too few matches). An empty edition sends only that explanation.

The same candidate snapshot is also ranked with the feedback component removed; the baseline selection is stored in `trace.baseline` and each delivered item records `inBaseline`, so feedback-aware and fixed rankings are compared on identical inputs at build time.

## What “learn” means

Votes live in `reading_votes`, separate from general personal memory: one current row per delivered item, plus an append-only `reading_feedback_events` audit. Weights are recomputed from **current** votes each time, so re-pressing a button, changing a vote or undoing it cannot count twice.

| Vote / reason       | Topic key(s) | Source key |
| ------------------- | ------------ | ---------- |
| Like                | +1           | +0.5       |
| More like this      | +2           | +1         |
| Dislike (no reason) | −0.3         | −0.15      |
| Off-topic           | −1           | 0          |
| Too shallow         | 0            | −0.75      |
| Already knew it     | −0.2         | 0          |
| Poor source         | 0            | −1         |
| Too repetitive      | −0.5         | 0          |

Signals decay with a 30-day half-life; each key is capped at ±3 and the combined feedback component at ±1.5, so a disliked topic ranks lower but is never removed from interest slots by votes alone; a couple of plain dislikes do not remove a non-interest topic from discovery either. Topic keys are the matched interests (or feed topic/category when none match); source keys are article domains. Unrated items contribute nothing — silence is unknown, not dislike. No sensitive traits are inferred.

Every edition references a `reading_preference_versions` row holding the weights and the contributing vote IDs and timestamps; a new row is written only when the weights change (or on override/reset). Reset stops earlier votes from influencing ranking without deleting them; overrides replace a learned key until cleared.

## Buttons

Each item message offers 👍 Like, 👎 Dislike, More like this, Why this?, Mute source and Mute “topic”. After Dislike, optional reasons appear (off-topic, too shallow, knew it, poor source, repetitive) plus Undo. The header offers Pause daily readings. Callback data is `rd:<action>:<uuid>` (≤ 64 bytes). Handlers check the Telegram allowlist and the item's owner, set state instead of toggling, and never queue behind the model. Why this? answers from saved components.

## Scheduling and delivery

`ReadingScheduler` runs on the gateway's existing 15-second timer, like the stock watchlist, rather than as an agent routine: a routine would call the model every day and its prose output cannot carry per-item feedback buttons or a replayable ranking. The slot is `deliveryTime` in the owner's IANA timezone; the edition date is the owner-local date. On DST change days a repeated time uses its earlier occurrence and a skipped time moves forward by the gap (02:30 → 03:30). Scheduled editions are unique per owner and local date at the database level, so a retried tick cannot produce a second, different edition. Builds for one owner (scheduled and on-demand) are serialized in the gateway process, so two concurrent builds cannot select the same readings; the on-demand quota is checked inside that serialization. This relies on the single-gateway deployment. Catch-up is latest-only: after downtime only the current local day is built. Enabling, resuming or changing the time/timezone restarts the schedule clock, so enabling after today's slot starts tomorrow. If every feed fails, the scheduler retries every 15 minutes for up to three hours (in memory; a restart resets the count) and then builds from already-stored candidates, reporting the failure. Owners removed from the Telegram allowlist are skipped.

`reading_editions` doubles as the outbox, following the routine/stock contract: `pending → sending → sent`; an exception or restart during sending becomes `uncertain` and is **never resent automatically** (Telegram may have shown some messages). `reading_items.sent_at` shows how far delivery got, and `reading_status` lists `items` and `sent` per edition so a partial delivery is visible; nothing is resent. Pausing or disabling mutes a pending scheduled edition.

## Observability and metrics

`reading_editions.trace` stores per-feed status/latency/errors, request count, `modelCalls: 0`, pool size, exclusion counts, preference version, the baseline selection, and a snapshot of the top 60 candidates by score plus the top 20 discovery candidates (title, domain, topics, date, labels and all components). Greedy selection only reaches a prefix of each ordering, so the snapshot is enough to replay both the feedback-aware and baseline selections and to explain any delivered item; candidates below it are counted but not stored. `reading_status().metrics` (30 days) reports delivered, rated, like rate (likes ÷ rated), rating coverage (rated ÷ delivered), repeated-story rate, average distinct domains per edition, feed failures, headline-only items, and rated/liked counts for feedback-only picks. Model cost per edition is zero; network cost is the feed requests counted in the trace. Unsupported-summary errors cannot be measured automatically: excerpts are the feed's own text, so they should be reported by the owner.

## Limitations

- Excerpts are the feed's description, not a model summary or full-text reading. Headline-only entries say so. Paywalls are not bypassed; the bulletin links out.
- Only owner-approved RSS/Atom feeds; public search tools are not used for candidates in v1.
- Topic assignment is phrase matching, not semantic classification; synonyms must be added as keywords.
- The parser is a bounded regex reader for common RSS 2.0/RDF/Atom shapes, not a full XML parser.
- Packaging as a portable plugin is deferred: plugins describe read-only model agents, and this deterministic feature has no model instructions to package.

## Deployment (operator-reviewed migration 019)

1. Independently review the exact PR head; run `npm run check`, changed-file formatting and `python3 scripts/test-deploy-reading.py`. Review `scripts/deploy-reading.py`.
2. Merge only after approval and CI. The ordinary release refuses the DB/Compose change.
3. Verify live `RELEASE` is one of the script's reviewed baselines (`BASES`): v0.3.22 `c936d7d630831f6f0c4b27dd62c5a06141a50201` or the app-only releases `2f57b242254124b5d92242220b61eb6ad8715e2a` (PR #80) `7648fca5cb7f2cd0590a7db5e496f3c4a6f97b33` (PR #81) and v0.3.23 `7b1cff9506ebb31159825ff166823b7377e21efa` (PRs #82–#86). If newer, reconcile and re-review the script; do not bypass the guard.
4. Transfer a Git archive of the exact reviewed main SHA and the reviewed script using the existing local operations connection. Run `python3 deploy-reading.py ARCHIVE SHA` on the host. It validates historical migrations and Compose (only the 019 entry may be added), locks releases, builds before stopping, refuses active work/input, applies only 019 and checks health. No secrets or environment variables are needed.
5. Verify release SHA, health, migration marker `19` and preservation of existing records. The rollout configures no feeds and schedules nothing.

Without migration 019 the application keeps the bulletin off: no tools offered, no scheduler or outbox work. Rollback restores the previous application/Compose/source and retains the additive tables; never delete reading history or resend uncertain editions during recovery.
