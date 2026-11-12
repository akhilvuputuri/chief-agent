# Saving shared links: study list or Reader

Written 12 November 2026 ([journal 178](journey/178-study-list-link-classification.md)). The code and `config/` are the source of truth; this records the design when it was written.

When the owner shares a link and says "save this", Chief decides where it belongs before saving it. Study material (a tutorial, course, paper, repository, documentation, or a technical thread such as one on agent architectures) goes to the **study list**, an owner-scoped Postgres collection. Offline reading (news, essays, general-interest long reads) goes to **Reader**. Chief never defaults to Reader.

## Flow

1. Chief calls `link_save {url, destination?, sourceId?, title?, interests?, tags?, notes?}`. The `links` domain guidance (the link-saving skill, mirrored as the `core/link-saving` plugin skill) tells it to do this for every shared link it is asked to save, and to set `destination` only on the owner's explicit cue ("to study", "for AI learning", "for offline reading", "both").
2. The host canonicalises the URL (`canonicalUrl` in `src/link-url.ts`: public HTTPS, with a plain `http` link upgraded, lowercase host, no fragment, no `utm_*`/`fbclid`/`gclid`/`mc_*`/`igshid`/`ref_src`, no `s`/`t` on x.com and twitter.com, other parameters sorted, Reddit post pages without a query).
3. It reads page facts through the SSRF-safe `PublicFeedFetcher`: `og:title` or `<title>`, `og:site_name` or the hostname, a description and a paragraph excerpt (`pageMeta` in `src/news-feed.ts`), or from a stored `web_read` source when Chief passes `sourceId`. A missing title stays null and is displayed as the site. Chief may pass `title` only when the owner wrote it.
4. `LinkClassifier` (`src/link-classifier.ts`) asks Jev two `choice` questions: `destination` (`study` or `reader`) and `topic` (one of the owner's learning interests or `other`). Jev sees only the owner's latest message in this turn, the page facts and the interests. The interests come from the tool call (the guidance tells Chief to take them from the owner's explicit memories, whatever key holds them). If Chief passes none, the host reads the owner's active, owner-trusted fact memories: `learning_interests` first, then any whose key names learning, interests or study. Nothing about the owner is stored in config or code. With no interests at all, no topic question is asked and the topic stays null rather than being guessed.
5. Confident (`confidence` = Jev's probability for its choice, at least `confident` in `config/links.json`, 0.75 when written): the host saves straight away and returns a one-line `where`, for example "Saved to your study list (agent platforms). Say "move it to Reader" to change."
6. Unsure (below the bar, or a Jev timeout, HTTP failure or malformed answer): the host stores a `link_choices` row and returns `needs_choice`. After Chief's reply, Telegram gets a card with **Study list / Reader / Both** buttons (`lk:<id>:s|r|b`). Nothing is saved until the owner taps.
7. An explicit owner cue skips the destination question and is stored as `classified_by='owner'` with confidence 1 and reason "You asked for …". Jev still sees the cue in `owner_message`, as a second layer.

This is model judgment, not a keyword rule. The host only bounds what Jev sees, checks the answer's shape and treats a low or missing answer as unsure. The `CUES` regex for the `links` domain only decides which tools are offered to Chief; it never decides where a link goes.

## Jev

The model id is read from `config/decisions.json` through `readDecisionConfig()`, the same source the shadow decisions use. `config/links.json` has no model field. The client follows `ToolPicker`/`ShadowDecisions`: POST to `https://openrouter.ai/api/alpha/decisions`, `AbortSignal.timeout`, ledger key `openrouter-jev`, injectable transport, every failure an "unsure" result. Chief's main model is unchanged.

## Storage (migration 036)

`study_resources`: `id`, `user_id`, `url` (canonical or resolved), `title`, `site`, `topic`, `tags text[]`, `notes`, `status` (`to_study`, `in_progress`, `done`), `added_at`, `updated_at`, `classification_reason`, `classification_confidence` (0 to 1), `classified_by` (`jev` or `owner`), `UNIQUE(user_id,url)`. A save first looks for any of the link's canonical forms (as shared, and after redirects); the unique key settles a race. A duplicate returns the existing entry with `duplicate: true`.

`link_choices`: the pending button card: canonical URL, page facts, classification, the delivery state of the card (`pending`, `sending`, `sent`, `uncertain`), its tap state (`open`, `applying`, `done`) with a claim time, and `study_written`, `reader_key` and `reader_state` recorded before and after each write.

The gateway offers the link tools only when migration 36 is recorded, so the feature is off rather than failing on every turn before the rollout. The rollout is `scripts/deploy-study-list.py`, modelled on the earlier additive migrations.

## Tools

- `link_save`, as above.
- `link_move {id|url, to}`: `to: reader` saves to Reader first and deletes the study row only when Reader confirms (`complete`); a pending, refused or uncertain save keeps it and says so. `to: study` adds the link to the study list; Chief has no Reader delete grant, so it tells the owner to remove the Reader copy themselves.
- `study_list {topic?, tag?, status?, limit?, offset?}`: newest first, with counts by status and a `line` per entry for a phone list. `topic` matches the topic or the title.
- `study_update {id, status?, notes?, tags?, topic?}` and `study_remove {id}`.

The `url` fields are checked in the tool schema (`savableLink`): a link that is not a public hostname (an IP address, a port, a login, a local name, a non-web scheme) is refused as invalid input before dispatch, so it can never become an uncertain write that blocks the owner's later writes.

All are owner-scoped. `study_list` is a read; the rest are writes and go through the normal uncertain-write journal.

## Reader request keys

The Reader save path (`LinkTools.readerSave`) uses one canonical URL for both the lookup of an earlier save and the `save_link` payload, so the persisted payload and the key always match (`checkReplay` in `src/mcp.ts` refuses a different payload under a stored key):

- An earlier **pending** save of that URL: reuse its key and URL. This is the genuine retry of an identical request, and the owner is told ("An earlier Reader save of this link was still pending, so I retried that same request.").
- An earlier **complete** save: nothing is sent; "It was already saved to Reader earlier."
- An earlier **rejected** save, or none: a new random key, so one rejection never blocks later attempts.
- Another link's pending save blocks the write (`pendingAllows`): the owner is told another Reader save is unconfirmed.

Before anything is sent, every canonical form of the link (as shared, after redirects, and the payload URL) is mapped to the key in `link_reader_keys`. A link shared as `twitter.com/…` whose save went out as the redirected `x.com/…` URL is therefore still found from the link as shared, even if the page can't be read the next time, and the retry reuses the same key and the same payload.

The agent boundary (`Assistant.call`) still blocks writes while a Reader save is pending or a write is uncertain, with one narrow exception: a `link_save` or `link_move` of the very link that every pending or uncertain write is about (matched by payload URL or through `link_reader_keys`) may run, because it is that write's idempotent retry. After such a save, an earlier uncertain `link_save`/`link_move` of the same link in a stopped run is settled, unless a Reader save of the link is still pending.

News bulletin Save buttons are unchanged: they remain an explicit Reader action keyed by the item id. Research briefs still go to Reader with `save_document`.

## Telegram tap handler

`lk:<id>:<s|r|b>` checks the allowlist and the owner, answers the callback at once and finishes outside the handler. `applyChoice`:

1. Claims the row with `UPDATE … SET state='applying' WHERE state='open' OR (state='applying' AND claimed_at < now()-2 minutes) RETURNING`, so a double tap runs once.
2. Study write (`INSERT … ON CONFLICT DO NOTHING`), then `study_written=true`.
3. Reader write: the key is recorded with `reader_state='sending'` before the call, and the result after it. A re-tap reuses the recorded key only when nothing is stored under it yet; otherwise the rules above apply.
4. If the owner switches to Study list after a Reader tap, the reply says what happened to that Reader save: in Reader, refused, or still unconfirmed. An unconfirmed one keeps the card open with its buttons, because only its own retry (Reader or Both) settles it, and a part-way failure names it as "may or may not have gone through".
5. A final result marks the card done and edits it without buttons. A result that is not final (pending, blocked, uncertain) reopens the card and keeps the buttons.
6. A failure part-way says "Result uncertain:" and names what was or may have been saved (the study entry, the Reader save); it never says nothing was written. If reopening fails too, the two-minute lease still lets a later tap take the card, and the message says to tap again in two minutes. A failed message edit is ignored and the buttons stay.

Cards are delivered by `sendLinkChoices` from both the interactive reply path and the background work delivery path. A refused send (Telegram 4xx) goes back to pending; any other failure is kept as `uncertain` and never resent.

## Deferred

- A canvas or Mini App view of the study list (nice-to-have). Telegram replies come from `study_list` and the guidance.
- Deleting from Reader: there is no grant, and none was added.
- Measured classification quality on real links: the eval for this classifier does not exist yet; the picker eval covers only domain selection.
