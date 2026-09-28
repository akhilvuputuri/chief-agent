# Daily news bulletin (issue #50)

A once-a-day Telegram message with up to eight items from news sites and blogs the owner follows, ranked by the owner's topics, recency and explicit 👍/👎 votes. Building and sending an edition makes **no model call**; the conversational agent only configures it. This is a lean restart of the closed [PR #83](https://github.com/akhilvuputuri/chief-agent/pull/83); see [journal 39](journey/39-news-bulletin.md).

Code: `src/news.ts` (tools, ranking, learning, scheduler, outbox, votes), `src/news-feed.ts` (feed discovery, RSS/Atom parsing, URL canonicalization, guarded fetcher, adapted from PR #83), `db/021_news.sql`, `tests/news.test.ts`.

## Configuring it through Chief

Nothing is scheduled until the owner asks. The agent must ask for the time, sites and topics instead of choosing them.

- `news_source_add(site, name?)`: the owner names a site (`theverge.com`, a blog link or a feed link). Chief finds its feed: the address itself if it is a feed, else a feed the page advertises (`<link rel="alternate" type="application/rss+xml|atom+xml">`), else `/feed`, `/rss`, `/feed.xml`, `/rss.xml`, `/atom.xml` or `/index.xml`. It makes at most nine requests. The confirmation lists the latest three titles. A site with no discoverable feed is refused with an explanation. Up to 30 sites.
- `news_settings(deliveryTime?, topics?, itemsPerEdition?, enabled?)`: `deliveryTime` is `HH:MM` **Singapore time**. `topics` are phrases that rank matching items higher; the list is replaced, and `null` clears it. `itemsPerEdition` is 1–8 (default 5). Turning the bulletin on requires a time and at least one site. Enabling it, or moving the time, restarts the schedule, so a slot that has already passed today is not caught up. The result gives `nextEdition`.
- `news_status()` (read): settings, sites with last fetch and error, the five latest editions with 👍/👎 counts, and learned weights.
- `news_edition_now()`: an extra or preview edition, even while the bulletin is off, at most three per day.
- `news_source_remove(id)`: removing the last site turns the bulletin off.

Mutations are foreground-only, like the watchlist and routines. A background job, or feed text, cannot change settings. The picker domain is `news` (`src/tool-domains.ts`, `config/tool-picker.json`).

## Selection

At the slot, every site's feed is fetched, four at a time, taking up to 50 entries each. Items are dropped when their link was delivered in the last 30 days (canonical URL, tracking parameters removed) or when they are more than seven days old. Undated items are kept, with a low recency score. Each remaining item scores:

| Component  | Value                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| `interest` | 2 if a topic phrase is in the title, 1 if in the excerpt or categories, else 0 |
| `recency`  | `1.5 × exp(−age/36h)`; 0.3 when undated                                        |
| `feedback` | `0.4 × site weight + 0.4 × mean(topic weights of matched topics)`              |

Near-identical stories (title-token Jaccard ≥ 0.6) keep only the best-scoring one. At most two items come from one site unless no other site can fill the edition. If nothing new remains, the edition says so rather than padding. Unreachable sites are named at the end.

## What 👍/👎 learn

Each item carries two buttons (`nw:up|dn:<item id>`). A press sets that item's vote; it does not toggle, so a replayed press changes nothing. Changing the vote replaces it. The keyboard marks the current choice. Handlers check the Telegram allowlist and the item's owner, and are never queued behind the model.

Weights are recomputed from **current** votes each time: +1 per 👍 and −1 per 👎, applied to the item's site and to each matched topic, halving every 30 days and capped at ±3 per key. Unrated items count for nothing. `news_status` shows the learned weights. There is no hidden model state and no inference about the owner beyond site and topic.

## Delivery and recovery

`NewsBulletin.tick` runs on the gateway's 15-second timer. A scheduled edition is unique per owner and Singapore date (partial unique index), and builds for one owner are serialized. An edition and its items are stored in one statement. If every site fails, the scheduled build retries every 15 minutes, four attempts in total, then sends an explanation. The attempt count is kept in memory, so a restart resets it.

`news_editions` is the outbox: `pending → sending → sent`. A failure or restart while sending becomes `uncertain` and is never resent automatically. Turning the bulletin off mutes a pending scheduled edition. The edition `trace` records per-site fetch results, pool size, exclusions, the weights used and `modelCalls: 0`.

## Network boundary

Other page retrieval in this project goes through hosted providers. Feeds are the exception: the gateway fetches them directly, because RSS/Atom has to be read as XML, repeatedly, without a paid extraction API. `PublicFeedFetcher` accepts only public HTTPS hostnames without ports or credentials, and resolves DNS inside the connection's `lookup` hook. If any resolved address is non-public (loopback, private, link-local including cloud metadata, CGNAT, documentation, multicast, reserved or embedded-IPv4 IPv6 forms), the connection is refused, and the socket uses the address that was checked. Redirects (at most three) go through the same checks. Responses are limited to 1.5 MB and 15 seconds, and no cookies or credentials are sent. Feed text is untrusted: markup, scripts, control and bidi characters are removed, only fixed entities are decoded, and `javascript:`, `data:` and credentialed links are dropped. Editions are sent as plain text with link previews disabled.

## Limitations

- Only sites that publish a feed can be followed. Paywalled items link out; nothing is bypassed.
- Excerpts are the feed's own text, not model summaries.
- Topic matching is phrase matching, not semantic classification.
- Fixed Singapore time zone; one edition per day.

## Deployment (operator-reviewed migration 021)

The same shape as migration 020: independent review of the exact head, `npm run check` and `python3 scripts/test-deploy-news.py`, then merge (the ordinary release refuses the DB/Compose change). Check that the live `RELEASE` is in `BASES` of `scripts/deploy-news.py`, then run `python3 deploy-news.py ARCHIVE SHA` on the host with the exact main archive. It applies only 021 with the gateway stopped and checks health. The gateway refuses to start without migration 21. The rollout configures nothing; the owner sets up sites and time in Telegram.
