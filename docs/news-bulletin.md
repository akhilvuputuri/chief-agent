# Daily news bulletin (issue #50)

A once-a-day Telegram message with up to five suggestions from news sites and blogs the owner follows. Each suggestion has a **📥 Save** button that saves it to Reader. Ranking learns from the owner's Reader library: the articles saved from the bulletin and those saved anywhere else, such as Safari's share sheet. Building and sending an edition makes **no model call**; the conversational agent only configures it. This is a lean restart of the closed [PR #83](https://github.com/akhilvuputuri/chief-agent/pull/83); see [journal 42](journey/42-news-bulletin.md). Save-based learning replaced 👍/👎 votes in [journal 86](journey/86-news-reader-saves.md).

Code: `src/news.ts` (tools, ranking, scheduler, outbox, Save flow), `src/news-interests.ts` (interest profile from Reader saves), `src/news-feed.ts` (feed discovery, RSS/Atom parsing, URL canonicalization, guarded fetcher, adapted from PR #83), `db/021_news.sql`, `tests/news.test.ts`.

## Configuring it through Chief

Nothing is scheduled until the owner asks. The agent must ask for the time, sites and topics instead of choosing them.

- `news_source_add(site, name?)`: the owner names a site (`theverge.com`, a blog link or a feed link). Chief finds its feed: the address itself if it is a feed, else a feed the page advertises (`<link rel="alternate" type="application/rss+xml|atom+xml">`), else `/feed`, `/rss`, `/feed.xml`, `/rss.xml`, `/atom.xml` or `/index.xml`. It tries at most nine addresses, each with up to three redirects, within 45 seconds. The confirmation lists the latest three titles. A site with no discoverable feed is refused with an explanation. Up to 30 sites.
- `news_settings(deliveryTime?, topics?, itemsPerEdition?, enabled?)`: `deliveryTime` is `HH:MM` **Singapore time**. `topics` are phrases that rank matching items higher; the list is replaced, and `null` clears it. `itemsPerEdition` is 1–5 (default 5). Rows saved under the earlier 1–8 range are read as at most five. Turning the bulletin on requires a time and at least one site. Enabling it, or moving the time, restarts the schedule, so a slot that has already passed today is not caught up. The result gives `nextEdition`.
- `news_status()` (read): settings, sites with last fetch and error, the five latest editions with how many items were saved, the Reader connection state, and what the saves taught: top sites, frequent title words, and `unfollowedSites` (sites saved from at least about twice recently but not followed, which the agent may offer to follow, never add unasked).
- `news_edition_now()`: an extra or preview edition, even while the bulletin is off, at most three per day.
- `news_source_remove(id)`: removing the last site turns the bulletin off.

Mutations are foreground-only, like the watchlist and routines. A background job, or feed text, cannot change settings. The picker domain is `news` (`src/tool-domains.ts`, `config/tool-picker.json`).

## Selection

At the slot, every site's feed is fetched, four at a time, taking up to 50 entries each. At the same time the owner's Reader library is read (below). Items are dropped when their link was delivered in the last 30 days (canonical URL, tracking parameters removed), when it is already saved in Reader, when they are more than seven days old, or when the link is over 600 characters. Undated items are kept with a low recency score, but are never delivered twice. Each remaining item scores:

| Component  | Value                                                                           |
| ---------- | ------------------------------------------------------------------------------- |
| `interest` | 2 if a topic phrase is in the title, 1 if in the excerpt or categories, else 0  |
| `recency`  | `1.5 × exp(−age/36h)`; 0.3 when undated                                         |
| `site`     | `0.4 ×` decayed saves from the article's site or the followed site, capped at 3 |
| `similar`  | `min(2, 3 × s)`, where `s` is word overlap with recent saves (0–1, below)       |

The stored item `score` keeps `site`, `similar` (the raw `s`) and `like`, the closest saved title, for inspection.

Near-identical stories (title-token Jaccard ≥ 0.6) keep only the best-scoring one. At most two items come from one site unless no other site can fill the edition. If nothing new remains, the edition says so rather than padding. Unreachable sites are named at the end. The message is fitted to one Telegram message by dropping excerpts, then whole trailing items, so every button matches a visible item.

## Save to Reader and what it learns

Each item carries one button (`nw:sv:<item id>`), five to a row. A press is answered at once ("Saving 2 to Reader…") and the button shows `…`. The save then finishes outside the Telegram handler, so a slow save (link resolution plus Reader's import status, up to about a minute) never holds one of the runner's update slots. It goes through Chief's reviewed Reader MCP grant (`save_link`, [MCP connectors](mcp.md)) with the same durable journal, link resolution and status polling as an agent save. **The item id is the idempotency key**, so repeated or concurrent presses, or a press after an uncertain outcome, can never create a second article. The keyboard's ✓ comes from that journal (`mcp_operations`, state `complete`); there is no second copy of save state. Handlers check the Telegram allowlist and the item's owner, accept only items from delivered (`sent` or `uncertain`) editions, and are never queued behind the model. Buttons on bulletins sent before this change answer that votes are retired.

Success is shown only as ✓. Everything else gets a short reply in the same topic:

- an import Reader could not prepare ("it is in Reader's Imports");
- a Reddit post that links no publisher article: link resolution refuses it before anything is recorded, so Chief saves the Reddit discussion under the same key and says so;
- a save that is still **pending** (uncertain, rate-limited, refused credentials, or a Reader business error such as a full library or import queue). Chief's MCP host holds every other write until a pending write is settled, so the reply names what settles it (tap again, make room in Reader, wait, reconnect) and says that other saves and changes wait for it;
- a save refused because another write is pending: the reply names the bulletin item holding it up, or says it is a Reader save made in conversation;
- a missing connection, or an item tried under a previous Reader credential.

**Interest sample.** Every build reads the owner's saved-article metadata from Reader with the read-only `list_saved_articles` grant on its own `reader-library` connection: title, link, site, save time and whether Reader has prepared the article. It never reads article text, briefs or reading progress. It reads up to five pages of 200, newest first, within 30 seconds, alongside feed gathering; pages that arrived before a later page fails or the budget ends are used (`reader.partial`). One malformed or oversized record is cut or skipped (`reader.skipped`), not allowed to discard the page. Reader returns this only after the owner turns on **Share saved-article titles** for Chief's connection in Reader → Settings → Assistant connections. Otherwise, or when Reader is unreachable or connectors are off, the edition is ranked without it. The edition trace and `news_status` record why (`reader.state`, `category`), and status gives a note for each case: sharing not allowed, Reader not yet offering the listing, connection rejected, rate-limited or unreachable.

**Profile (`src/news-interests.ts`).** Rebuilt from Reader's current library for every edition; nothing is learned or stored on Chief's side, so deleting an article in Reader removes its influence.

- Each save weighs `0.5^(age/60 days)`. Saves older than a year shape nothing but are still never re-suggested.
- `site`: summed weights per site domain (without `www.`). An item matches on its own article domain or its followed site's domain, whichever is higher.
- `s`: title words are lowercased, accents removed ("Zürich" → "zurich"), stop words removed (two-letter words such as "AI" are kept, common ones like "of" are not) and plurals lightly folded ("chips" → "chip"). Saved titles are TF-IDF vectors over the saved set. A candidate's vector holds its title words plus half-weighted excerpt words; words the owner has never saved get the highest IDF, so they count in the candidate's length and one shared word in a long headline stays a weak match. `s` is the mean of the three highest `cosine × save weight`. Using the nearest neighbours, not one centroid, means separate interests (bread and compilers) each count instead of blurring together.
- Articles Reader has not prepared (queued, or a failed import) often have only their host name as a title. They mark their link and site but contribute no words.
- A headline that is the same story as a saved title (title-token Jaccard ≥ 0.6, at least three tokens) is skipped too, so a saved article reached through a Reddit post or syndicated copy is not suggested again.
- Scripts written without spaces (Chinese, Japanese) become one token per run, so they match only near-identical titles.

This is phase 1: inspectable word overlap. It misses synonyms and paraphrase. `interestProfile` and `affinity` are the only seam the ranker uses, so a later scorer can replace them. **Learning data:** every suggestion is stored in `news_items` with its score. Joined with Reader's library by canonical link, "suggested and later saved" versus "suggested, not saved" is a labelled set for evaluating a replacement. The old `vote`/`voted_at` columns are retained but no longer read.

## Delivery and recovery

`NewsBulletin.tick` runs on the gateway's 15-second timer. A missed slot is caught up for up to 6 hours (for example after an outage); later than that, the day is skipped. Scheduling and delivery run in separate lanes, so a slow build never delays an on-demand delivery, and one owner's failed build is logged (`news.build_failed`) without stopping others. Fetching all sites for one edition is limited to 90 seconds; sites not reached in time are listed as unreachable. A scheduled edition that has not been muted is unique per owner and Singapore date (partial unique index). A muted edition was never shown, so it frees the day: switching off and on again before the slot, removing a site, or moving the time rebuilds that day's edition from current settings. Builds, site removals and settings changes for one owner are serialized. An edition and its items are stored in one statement. If every site fails, the scheduled build retries every 15 minutes, four attempts in total, then sends an explanation. The attempt count is kept in memory, so a restart resets it.

`news_editions` is the outbox: `pending → sending → sent`. A failure or restart while sending becomes `uncertain` and is never resent automatically. Turning the bulletin off, removing a site that is in a pending edition, or moving the time mutes that pending edition. A pending edition is withdrawn if it has waited more than 6 hours (scheduled; long enough for a build that crosses midnight) or 1 hour (on-demand), for example after a gateway outage. Saves are accepted only on items from delivered (`sent` or `uncertain`) editions. The edition `trace` records per-site fetch results, pool size, exclusions (including already saved), the Reader read result and `modelCalls: 0`.

## Network boundary

Other page retrieval in this project goes through hosted providers. Feeds are the exception: the gateway fetches them directly, because RSS/Atom has to be read as XML, repeatedly, without a paid extraction API. `PublicFeedFetcher` accepts only public HTTPS hostnames without ports or credentials, and resolves DNS inside the connection's `lookup` hook. If any resolved address is non-public (loopback, private, link-local including cloud metadata, CGNAT, documentation, multicast, reserved, embedded-IPv4 IPv6 forms, or any IPv6 outside global unicast `2000::/3`), the connection is refused, and the socket uses the address that was checked. Redirects (at most three) go through the same checks. Responses are limited to 1.5 MB and 15 seconds, and no cookies or credentials are sent. Feed text is untrusted: markup, scripts, control and bidi characters are removed, only fixed entities are decoded, and `javascript:`, `data:` and credentialed links are dropped. Editions are sent as plain text with link previews disabled.

## Limitations

- Only sites that publish a feed can be followed. Paywalled items link out; nothing is bypassed.
- Excerpts are the feed's own text, not model summaries.
- Topic matching is phrase matching, and save similarity is word overlap; neither is semantic classification.
- Learning needs Reader connected (MCP on) and the owner's opt-in in Reader. Without it the bulletin still works, ranked by topics and recency only.
- Fixed Singapore time zone; one edition per day.

## Deployment (operator-reviewed migration 021)

The same shape as migration 020: independent review of the exact head, `npm run check` and `python3 scripts/test-deploy-news.py`, then merge (the ordinary release refuses the DB/Compose change). Check that the live `RELEASE` is in `BASES` of `scripts/deploy-news.py`, then run `python3 deploy-news.py ARCHIVE SHA` on the host with the exact main archive. It applies only 021 with the gateway stopped and checks health. The gateway refuses to start without migration 21. The rollout configures nothing; the owner sets up sites and time in Telegram.

## Save-based learning rollout (no migration)

The change is application-only: save state lives in the existing MCP journal and the 1–5 cap is enforced in code, so the ordinary release applies. The listing is granted on a separate `reader-library` connection (same endpoint and credential reference) so the `reader` save connection's definition, which is part of every pending save's binding, is unchanged. Deploy order does not matter: until Reader offers `list_saved_articles`, discovery lists it as `unavailable`, saves keep working and status says Reader needs its update. Learning starts once Reader has it and the owner turns on sharing for Chief's connection.
