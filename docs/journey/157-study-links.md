# 157 — Study material or offline reading?

Work date: 2026-11-10. Written: 2026-11-10. Revised: 2026-11-10.
Status: implemented on a branch with the focused checks below; independent review, merge and
deployment are separate steps and nothing here claims them. Migration 036 is a database change,
so delivery needs the reviewed operator procedure rather than an automatic release.

## User-visible problem and preceding iteration

The owner shares links constantly. Some are study material — an X thread on agent
architectures, a tutorial, a course, a paper, a repository about applied AI engineering, agent
platforms, developer tools or voice/conversational AI. Others are offline reading: a news
story, an essay or a long-form general-interest article. Chief had one destination, Reader, so
every save became offline reading whether or not it was something to work through. The owner
asked for Chief to classify a shared link itself, keep study material in its own durable
collection, and ask with quick taps only when it is genuinely unsure. An earlier attempt
(PR 428) was rejected on four Reader-idempotency and partial-write issues; those are
requirements here from the start, and so are the review findings on PR 433 listed under
"Review repairs".

## Evidence

- **Tested:** `tests/study-links.test.ts` (55 tests), `tests/study-links-telegram.test.ts` (8),
  `tests/study-settlement.test.ts` (9) and `tests/jev-links.test.ts` (4) pass locally. They cover
  the Jev request shape and its typed failures, the store (owner scoping, canonical duplicate
  detection, filters, update, remove), confident study and confident reading, an explicit cue in
  both directions reaching the classifier, four unsure paths (unsure route, low confidence, Jev
  timeout, Jev failure) each producing the three tap buttons and writing nothing, an unreadable
  page never becoming a study entry with an invented title, the Both route succeeding and
  half-failing, a stored Reader rejection followed by a new key, an in-flight key reused for the
  identical request, a tracking-parameter variant matching the pending lookup, partial-write
  wording in both orderings, a re-tap resuming only the unfinished step, a held claim expiring,
  a changed tap before and after a partial write, a Reader timeout settled from chat, and both
  directions of a correction.
- **Tested:** the Reader mock is the real `McpTools` over a fake server, so it replays a stored
  key and refuses a different payload under the same key exactly as `src/mcp.ts` does.
- **Tested:** `tsc --noEmit` is clean; `tests/tool-domains.test.ts`, the picker unit tests (8)
  and `python3 scripts/test-deploy-study-links.py` (17) pass; Prettier is clean on the changed
  files.
- **Blocked (named):** `kite run eval:picker` stops immediately with
  "OPENROUTER_API_KEY is not set in the environment or .env". No picker measurement exists, so
  the `links` routing of `mcp-reader-save` ("Save this article to Reader for offline reading")
  and the added link scenarios are unmeasured until a credentialed run.
- **Hypothesis:** Jev's route quality on real pages, and how the picker routes the new domain,
  are unverified until that paid run happens.

## Diagnosis and alternatives

- **Classification is model judgment** (owner decision A). One Jev request asks four `choice`
  questions in the same call — route, learning-interest topic, page kind, and whether the
  owner's own words named the destination — with the page's title, site and visible post text,
  the owner's message and their saved learning interests. The model id comes from
  `config/tool-picker.json`, the one place the repo pins Jev, through the request pattern in
  `src/tool-picker.ts` (owner decision B); nothing new is pinned and Chief's main model is
  untouched. A keyword classifier was rejected: the owner's examples turn on meaning ("an X
  thread on agent architectures"), not on tokens.
- **Host safety is thin on purpose:** schema validation, a non-empty reason, the configured
  confidence floor, and a title that must come from the page. Every failure — timeout,
  transport, unparseable answer, low confidence, missing title without an explicit cue —
  becomes `unsure` and sends the taps. Nothing falls back to Reader.
- **Two tables, not a canvas snapshot:** `study_resources` is the collection with a unique
  `(user_id, canonical_url)` index as the duplicate detector; `link_decisions` is the durable
  resume record so a tap is never one-shot.
- **One URL per link** (requirement 8): the normalised URL is computed once and is the pending
  lookup, the `save_link` payload, the entry's link and the source of the duplicate key. A key
  is reused only while that identical request is still in flight; a stored rejection forces a
  new key (requirement 9).
- **Partial writes report what happened** (requirement 10): each step is reported the moment it
  returns, and a failure after a write names what may be saved and offers a re-tap that resumes
  only the rest. The row keeps its state and the claim lease expires, so a failed tap cannot
  disable the buttons.
- **Reader → study keeps Reader's copy.** `config/mcp.json` grants no Reader removal tool, so
  the reply says so plainly; adding a grant is a separate reviewed host change.

## Implementation and review

- `db/036_study_links.sql` with its Compose line, `scripts/deploy-study-links.py` and its test.
  The rollout is additive, so a rollback keeps the empty tables and the previous image ignores
  them; it refuses an unreviewed baseline, active work, pending input and unexpected migration
  or Compose changes.
- `src/jev.ts`, `config/link-classifier.json` (copied into the image), `src/link-classifier.ts`
  and `src/study-links.ts` (store, decision record, save, tap, corrections) with
  `src/study-links-schema.ts`, and the wiring in `src/protocol.ts`, `src/tool-domains.ts`,
  `src/runtime.ts`, `src/tools.ts`, `src/execution.ts`, `src/agent.ts`, `src/main.ts` and
  `src/telegram.ts`.
- Prompt and domain guidance: the `links` domain with the owner's own examples, a narrowed `mcp`
  description (Reader is offline reading), guidance that travels with the domain, and a new
  section in `skills/personal-assistance/SKILL.md` (skill version 5 → 6).
- Picker data: `mcp-reader-save` now belongs to `links`, `links-study-save`, `links-save-url`,
  `links-job-posting` and `links-study-list` were added, `mcp-reader-brief` and
  `mcp-reader-status` stay `mcp`, and the Python contract's domain list follows.
- Design notes: [study links](../study-links.md). `docs/current-work.md` and
  `docs/releases.md` were deliberately not edited (owner decision C).
- Review: the review of `08996b4f` returned REQUEST CHANGES. Its blocking finding is fixed by
  `McpTools.persistedWrite()` plus the `src/tools.ts` guard described below, with tests. The
  important finding (requirement 11 unmeasured) stays a named blocker, not a pass. The nits are
  fixed: the settler's docstring now matches its behaviour (a pending Reader row counts as
  written), its redirect fallback is bounded to the call's own window instead of every later
  write, a failed `markReaderSaved` after both writes no longer turns the pair into a failure,
  and a Reader failure before `mcp_operations` holds the request is reported as a definite
  non-send instead of as uncertain. This journal entry was cut from 420 lines to this one.

### Review repairs carried in this change

Each line names the finding and what now prevents it; the tests are in the files above.

- **PR 433, requirement 6 lived only in the prompt.** A turn could save a shared link to Reader
  without classification. `src/tools.ts` now refuses a new Reader `save_link` from a turn and
  points at `link_save`; the classification path and the news feed call `McpTools` directly and
  are unaffected.
- **PR 433, an explicit cue did not win on an unreadable page.** The fourth `cue` question tells
  the host whether the owner's words named the destination; with a cue, an unreadable page is
  saved under its site name and the receipt says the title could not be read. An absent answer
  counts as no cue, so a thin page asks.
- **PR 433, "what's on my AI study list" hid entries.** A broad learning-interest query covers
  every configured area and entries with no topic ("Other"), because "agent platforms" contains
  no "AI"; other queries match a label partially with `%`/`_` escaped.
- **PR 433, a Both card with a refused Reader half could never settle.** It now settles once the
  study half is written and Reader definitely did not take the link, and says how to retry only
  the Reader copy.
- **PR 433, duplicate detection missed X share variants.** `canonicalUrl()` drops the `s`/`t`
  share codes and folds `twitter.com` into `x.com` for status links only; other sites keep them.
- **PR 433, the owner's message came from the model.** `src/tools.ts` reads `work_turns.request`
  for the run and passes that to `link_save`; the model's field is only a fallback when the host
  has no record, so a cue cannot be paraphrased away.
- **Earlier revisions** (kept as evidence, not re-litigated here): an inserted study entry is
  reported as saved when the card update fails; an accepted Reader save is never reported as
  nothing; a settled card answers only from its record; an input error is a validation refusal,
  not an uncertain write that blocks later writes; an unconfirmed Reader attempt keeps its
  request open when the owner then taps the other destination.

### Blocking finding on `08996b4f` and its fix

The guard that sends a Reader link save back to `link_save` refused **every** Reader
`save_link` from a turn, including an exact replay of an operation Chief itself had persisted.
Only a re-dispatch of the same request key through `McpTools.call` moves a pending
`mcp_operations` row to complete or rejected, and the agent's pending-write gate refuses every
other write meanwhile — so one Reader timeout would refuse every ordinary write indefinitely,
and the documented recovery ("ask me to check that save, then retry") could not succeed.

Now `McpTools.persistedWrite(user, input)` reports whether `mcp_operations` already holds that
owner's row for the same connection, tool, request key and payload (arguments omitted, or equal
to the persisted ones). The guard lets exactly that case through; a key bound to another
payload, an ungranted tool or an unknown connection is still refused. The `mcp_write` runtime
description names the replay, so the model knows the recovery path. Tests: "a Reader save that
timed out is settled from chat, and later writes are not blocked" (uncertain save → gate refuses
an ordinary write → replay completes the row → the write is allowed) and "a replay bound to
another payload is still refused, so the guard is not a back door".

## Deferred

- A canvas or Mini App study view (a nice-to-have in the request).
- A Reader removal grant, if the Reader server actually exposes one.
- The by-hand `kite run eval:picker` measurement, blocked on OpenRouter credentials.
- Reading JavaScript-only pages (an X thread served as a shell) through the public browser, so
  the classifier sees the whole thread; documented as a limitation of this change.
