# Study resources and link classification

Chief keeps the owner's learning material in its own durable, owner-scoped Postgres collection
(`study_resources`), separate from Reader and from canvases. Reader is only for offline reading.
A link the owner shares to save is classified first, by Jev, and then stored in the right place.

## Classification

`src/link-router.ts` asks TypeSafe's Jev decision model — the same model and client pattern as
the tool picker and effort picker — three questions in one call:

- `route` (choice): `study`, `reader` or `both`;
- `topic` (choice): `applied-ai-engineering`, `agent-platforms`, `developer-tools`,
  `voice-conversational-ai` or `other`;
- `unsure` (probability): whether the link is genuinely hard to place.

The model id, timeout, question text, criteria, thresholds and the owner's learning interests
live in `config/decisions.json` under `links`; `src/decision-config.ts` is the single reader, so
no model id is retyped in code. The thresholds are `apply.confidence` (0.7) and `apply.unsure`
(0.5): a route below the confidence floor, or an unsure probability at or above its floor, is
`unsure`. An explicit owner cue ("for AI learning", "to study", "for offline reading") wins
because Jev is told so and reads the owner's message; there is no keyword or rule classifier in
the code path.

The host, not the model, fills the link, title and site: `src/link-page.ts` reads the public
page once (bounded, SSRF-guarded, `parse5`) for `<title>`, `og:title`, `og:site_name` and a short
description, and falls back to the bare site name. For an X/Twitter status link, where a plain
fetch only gets a script shell, the post's own text comes from X's public oEmbed metadata; a
failure there is silent and the page title and the owner's message remain the evidence. No tool
accepts a title, topic or confidence from the model. A malformed, timed-out, rate-limited or
failed Jev answer is `unsure`, never a Reader default.

## Storage

`db/036_study_resources.sql` adds two tables:

- `study_resources`: `id`, `user_id`, `canonical_url`, `url`, `title`, `site`, `topic`, `tags`,
  `notes`, `status` (`to_study`, `in_progress`, `done`), `reason`, `confidence`, `added_at`,
  `updated_at`, unique `(user_id, canonical_url)` for duplicate detection, and indexes for
  status, topic and tags.
- `link_saves`: every save's route journal — owner, canonical URL, page URL, title, site, topic,
  route (`study`, `reader`, `both`, `unsure`), reason, confidence, study id, Reader request key
  and state, run id, Telegram message id, claim and delivery timestamps. This is what lets a
  confident Reader save be corrected to the study list later.

`canonical_url` is scheme-less, tracking-free and treats `x.com` and `twitter.com` as one link
(`src/link-page.ts`). A duplicate returns the existing entry instead of a second row, for the
study list and for Reader alike: a link already saved to Reader is reported, not saved again.
Classification runs before the duplicate check, so an explicit owner cue still wins when the
link is already on the study list. Reader request keys are derived from the owner and the URL,
so a repeat or a concurrent save replays the same MCP operation instead of writing twice.

## Tools

| Tool           | What it does                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `link_save`    | Classifies and saves a shared link. `study` writes the study list, `reader` saves through the existing Reader MCP connection, `both` does both, `unsure` writes neither and returns three tap options.                                                  |
| `link_move`    | One correction tool: `to=reader` moves a study entry to Reader (the Reader save completes before the study entry is removed), `to=study` adds a Reader save to the study list (Reader keeps its copy), `to=remove` removes it from the study list only. |
| `study_list`   | Owner-scoped list, filtered by topic, tag or status, rendered phone-friendly with ids for later updates.                                                                                                                                                |
| `study_update` | Status, notes, tags or topic on an exact owned id. Only an owner request may change a topic.                                                                                                                                                            |
| `study_remove` | Removes one owned entry; any Reader save is untouched.                                                                                                                                                                                                  |

The `study` tool domain is offered only once migration 036 is installed, so a pending rollout
cannot fail ordinary turns. The bundled `links` agent and `link-saving` skill carry the criteria
and the "Reader is offline reading only" rule; the coordinator's instructions and the `mcp` and
`study` domain guidance say the same.

## Presentation and corrections

A confident save returns a one-line receipt naming where it went, so the owner can reply "no,
move it to Reader". An unsure save writes nothing; the host delivers a separate card with three
buttons ("Study list", "Reader", "Both") bound to the owner and that Telegram message, from the
interactive turn and from the background work delivery path alike. The tap is handled by
`src/telegram.ts` (`lnk:<route>:<id>`), which claims the `link_saves` row with a conditional
update before writing, so a double tap or a foreign user cannot write twice. View state and
model answers never authorize this write. A Reader write that is pending, refused or
unconfirmed leaves the row unclaimed and keeps the buttons, so the owner can tap again; a
finished write clears them. `study_list` counts every matching entry and says "and N more" when
the phone list is cut at its limit.

## Rollout

Migration 036 is additive (two empty tables and indexes) but production releases refuse `db/`
and `compose.yaml` changes, so the merge needs the reviewed operator procedure in
[cloud-development](cloud-development.md): run `scripts/deploy-study-resources.py` on the host
with the exact reviewed SHA, verify both tables and the `runtime_migrations` row 36, confirm
`/healthz`, and keep the previous gateway rollback path (no destructive change, no Postgres
restart). The script's baseline must be reconciled with the live `RELEASE` immediately before
rollout. Manual review is expected for the migration and the deploy script.

## Limits

- Jev's grading quality on the owner's four learning areas is unproven in production; the route
  journal lets the owner audit it, and thresholds live in config so tuning needs no code change.
- Reader has no delete tool, so moving an item to the study list leaves the Reader copy in place;
  the receipt says so.
- The X post-text read depends on X's public oEmbed endpoint; if it is unavailable the
  classification falls back to the page title and the owner's message, and may ask with buttons.
- A canvas or Mini App study view is not included.
