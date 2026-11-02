# Link saves: classification, the study list and Reader

A link the owner shares to keep is classified before it is saved. Study material goes to the
owner's study list, a durable Postgres collection; long-form reading goes to Reader for offline
reading. Reader is never the default, and a failed classification asks the owner instead of
choosing.

## Why model judgment

The destination is a judgment about what a page is and what the owner would do with it, which a
keyword list gets wrong: a "news" article about agent architectures is study material, a
tutorial from a newspaper is not. TypeSafe's Jev decision model answers two questions with the
page's own metadata, the owner's words and the owner's saved learning interests as state:

- `destination` (`type: "choice"`, `study` or `reader`) with the criteria in
  `config/link-routing.json`.
- `cue` (`type: "noul"`): whether the owner's message itself names a destination.

`src/link-router.ts` sends one request to `https://openrouter.ai/api/alpha/decisions`, the same
contract the tool picker, effort picker and shadow decisions already use. The model id is not in
`config/link-routing.json`: `jevModel()` reads `config/tool-picker.json` through
`readPickerConfig()`, so one config owns the snapshot (`typesafe/jev-1.13-20260917` today) and
this path cannot drift onto another model. Chief's main model is unchanged.

The route is applied as follows, and nothing else decides:

1. An explicit cue at or above `apply.cue` wins and takes Jev's choice at face value.
2. Otherwise Jev's own choice applies when its probability reaches `apply.study` or
   `apply.reader`.
3. Anything else — a low score, an unusable answer, a timeout, a non-2xx response, a missing
   classifier — is `unsure`, which asks the owner. `src/link-router.ts` never returns `reader` on
   failure.

Thresholds and the interest list are config, so calibration is reviewable without code changes.
The stored `reason` is host-composed from the evidence and the score (Jev answers with a choice
and probabilities, not prose); it never asserts a rationale the model did not give.

## Page facts

`readLinkPage()` fetches through the same SSRF-guarded fetcher the feed reader uses, keeps the
verified destination as the canonical URL, and reads what the page publishes: `og:`/`twitter:`
title, site name, `article:section` as topic, `keywords` as tags, description and lead
paragraphs as the text Jev sees. A page that cannot be read (many sites, including X, refuse a
plain HTTPS fetch) is stored as unreadable: classification then uses the URL and the owner's
words, and its confidence reflects that. Nothing is invented — a page without a title is stored
under its URL, not under a guessed name.

## Storage

Migration `db/036_study_resources.sql`.

`study_resources` is owner-scoped and Postgres-backed, not a canvas snapshot: `url` (verified
canonical URL), `url_key` (duplicate key), `title`, `source`, `topic`, `tags`, `notes`, `status`
(`to_study` / `in_progress` / `done`), `added_at`, `updated_at` and a `classification` record
(destination, reason, confidence, probabilities, choice, cue, via, model, classifiedAt, error).
`UNIQUE(user_id, url_key)` detects duplicates, where `url_key` lowercases the host, drops `www`,
the fragment, tracking parameters and a trailing slash. Every statement filters on `user_id`.

`study_link_prompts` is the durable ask used only when the classification is unsure: the page
facts, the classification, a TTL (`cardTtlMinutes`, 4 hours), `notified_at` so a card is shown
once, and `resolved_at`/`resolution` for the owner's answer. It expires on its own, so a stale
keyboard never blocks a later save.

## Tools

Domain `study` (`link_save`, `study_save`, `study_list`, `study_update`, `study_remove`,
`study_move`). It is offered to Chief, not delegated to a plugin agent, and is unavailable when
link resolution or the Jev key is missing.

- `link_save` — the single entry point for a shared link: resolve, classify, then save to the
  study list, save to Reader, or ask. Chief passes the owner's own words as `ownerMessage`.
  A duplicate URL returns the existing item instead of a second row.
- `study_save` — an explicit "put this on my study list"; the owner decided, so Jev is not
  asked, and the record says so.
- `study_list` — newest first, filter by topic (case-insensitive), tag or status, ten items at a
  time with `more` and per-status counts, each with a one-line summary for a phone reply.
- `study_update` — status, notes (an empty string clears), tags or topic on an exact id.
- `study_remove` — delete one item.
- `study_move` — corrections: `to: "reader"` saves the link to Reader and removes the study row;
  `to: "study"` adds a study row and leaves any Reader copy, because Chief has no Reader delete
  grant.

A refused or failed Reader save asks the owner rather than silently saving elsewhere, and an
unavailable Reader connection fails loudly instead of losing the item.

## Telegram

`link_save`'s `needsChoice` result is reported as a question, never as a save. After the reply,
the host shows one card per unanswered prompt — "Where should "…" go?" with **Study list**,
**Reader** and **Both** — built from `study_link_prompts` and marked announced once sent. Taps
`ls:st:` / `ls:rd:` / `ls:bo:` answer the callback, clear the keyboard, and finish off the
handler because a Reader save can take a minute. A resolved, expired or foreign prompt answers
without changing anything. When the classification is confident, Chief says in one line where
the link went and why, so "no, move it to Reader" is a `study_move`.

A canvas or Mini App view is a deliberate nice-to-have and is not built here.

## Prompt, guidance and skill

`src/context.ts` states that a shared link is classified, not defaulted, and that Reader is only
for offline reading. `src/tool-domains.ts` carries the study domain summary and guidance (the
only place that guidance costs context, because it travels with the offered domain), and the
`mcp` cue no longer reads "save this link" as Reader. The `link-saving` baseline skill
(`skills/link-saving/SKILL.md`) holds the same contract for the model. `config/tool-picker.json`
gained the `study` domain with link-saving examples, which makes `kite run eval:picker` a
required check for that file; `evals/picker/picker.py` mirrors the domain list.

## Tests

- `tests/link-routing.test.ts` — confident study, confident reading, explicit cue overrides in
  both directions, low confidence and malformed answers asked, transport failures asked, the
  request uses the picker's Jev snapshot, page metadata read from the page, duplicate keys.
- `tests/study-resources.test.ts` — the store and tools: study/reader/unsure routing, no reader
  call on a study save, duplicates, owner isolation, list filters and bounds, updates, removal,
  both correction directions, prompt resolution once, a failed Reader save, domain wiring.
- `tests/study-telegram.test.ts` — the three-button card, one card per ask, the tap that stores
  the answer, a repeated tap, and an ignored foreign chat.

All mocked; no credentials.
