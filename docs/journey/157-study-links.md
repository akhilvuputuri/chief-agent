# 157 — Study material or offline reading?

Work date: 2026-11-10. Written: 2026-11-10.
Status: implemented on a branch with focused checks below; independent review, merge and
deployment are separate steps and nothing here claims them. Migration 036 is a database change,
so delivery needs the reviewed operator procedure rather than an automatic release.

## User-visible problem and preceding iteration

The owner shares links constantly. Some are study material — an X thread on agent
architectures, a tutorial, a course, a paper, a repository about applied AI engineering, agent
platforms, developer tools or voice/conversational AI. Others are offline reading: a news
story, an essay or a long-form general-interest article. Chief had one destination, Reader, so
every save was offline reading whether or not it was something to work through. The owner asked
for Chief to classify a shared link itself, keep study material in its own durable collection,
and ask with quick taps only when it is genuinely unsure. The previous attempt (PR 428) was
rejected on four Reader-idempotency and partial-write issues; those are requirements in this
change from the start.

## Evidence

- **Tested:** `tests/study-links.test.ts` (44 tests at the latest revision, all passing
  locally), `tests/study-links-telegram.test.ts` (8), `tests/study-settlement.test.ts` (8) and
  `tests/jev-links.test.ts` (3) cover the Jev request shape and its typed
  failures as well as the store
  (owner scoping, canonical duplicate detection, filters, update, remove), confident study and
  confident reading, an explicit cue in both directions reaching the classifier, four unsure
  paths (unsure route, low confidence, Jev timeout, Jev failure) each producing the three tap
  buttons and writing nothing, an unreadable page never becoming a study entry with an invented
  title, the Both route succeeding and half-failing, a stored Reader rejection followed by a new
  key, an in-flight key reused for the identical request, a tracking-parameter variant matching
  the pending lookup, partial-write wording in both orderings, a re-tap resuming only the
  unfinished step, a held claim expiring, a changed tap before and after a partial write, and
  both directions of a correction.
- **Tested:** the Reader mock is the real `McpTools` over a fake server, so it replays a stored
  key and refuses a different payload under the same key exactly as `src/mcp.ts` does.
- **Tested:** `tests/tool-domains.test.ts`, `tests/tool-picker.test.ts` and
  `tests/dockerfile-config.test.ts` still pass with the new `links` domain and config file
  (50 tests). `evals/picker` unit tests pass (8).
- **Blocked (named):** `kite run eval:picker` was run by hand and stopped immediately with
  "OPENROUTER_API_KEY is not set in the environment or .env". No picker measurement was
  performed, so the scenario change is unmeasured until a credentialed run.
- **Hypothesis:** Jev's route quality and the picker's routing of the new domain are unverified
  until that paid run happens.

## Diagnosis and alternatives

- **Classification is model judgment** (owner decision A). One Jev request asks three `choice`
  questions with the page data, the owner's message and their saved interests: route, topic and
  page kind. The model id comes from `config/tool-picker.json`, the one place Jev is pinned, so
  nothing new is added and a snapshot change lands once (owner decision B). A keyword classifier
  was rejected: the owner's examples turn on meaning ("an X thread on agent architectures"),
  not on tokens.
- **Host safety is thin on purpose:** schema validation, a non-empty reason, the configured
  confidence floor, and a title that must come from the page. Every failure — timeout,
  transport, unparseable, low confidence, missing title — becomes `unsure` and sends the taps.
  Nothing falls back to Reader.
- **Two tables, not a canvas snapshot:** `study_resources` is the collection with a unique
  `(user_id, canonical_url)` index as the duplicate detector; `link_decisions` is the durable
  resume record so a tap is never one-shot.
- **One URL per link** (requirement 8): the normalised URL is computed once and is the pending
  lookup, the `save_link` payload, the duplicate key and the entry's link. A key is reused only
  while that identical request is still in flight; a stored rejection forces a new key
  (requirement 9).
- **Partial writes report what happened** (requirement 10): each step is reported on its own,
  and a failure after a write names what may be saved and offers a re-tap that resumes only the
  rest. The row keeps its state and the claim lease expires, so a failed tap cannot disable the
  buttons.
- **Reader → study keeps Reader's copy.** `config/mcp.json` grants no Reader removal tool, so
  the reply says so plainly. Adding a removal grant is a separate reviewed host change and was
  not invented here.

## Implementation and review

- `db/036_study_links.sql`, `compose.yaml`, `scripts/deploy-study-links.py` and its test
  (`python3 scripts/test-deploy-study-links.py`: 17 tests passing). The rollout is additive, so
  a rollback keeps the empty tables and the previous image ignores them. It refuses an
  unreviewed baseline, active work, pending conversation input and unexpected migration or
  Compose changes.
- `src/jev.ts`, `config/link-classifier.json` (copied into the image), `src/link-classifier.ts`
  and `src/study-links.ts` (store, decision record, save, tap, corrections) with
  `src/study-links-schema.ts`, `src/protocol.ts`, `src/tool-domains.ts`, `src/runtime.ts`,
  `src/tools.ts`, `src/main.ts` and `src/telegram.ts`.
- Prompt and domain guidance: the `links` domain with the owner's own examples, a narrowed `mcp`
  description (Reader is offline reading), guidance that travels with the domain, and a new
  section in `skills/personal-assistance/SKILL.md`.
- Picker data: `mcp-reader-save` ("Save this article to Reader for offline reading") now belongs
  to `links`, a new `links-study-save` tuning scenario was added, and the Python contract's
  domain list follows the TypeScript one.
- Design notes: [study links](../study-links.md). `docs/current-work.md` and
  `docs/releases.md` were deliberately not edited (owner decision C).
- Review: pending an independent reviewer on the exact head SHA. No approval is claimed here.

## Deferred

- A canvas or Mini App study view (a nice-to-have in the request).
- A Reader removal grant, if the Reader server actually exposes one.
- The by-hand `kite run eval:picker` measurement, blocked on OpenRouter credentials.

## Revision after the independent review of b7b6b6d6

The reviewer returned REQUEST CHANGES on b7b6b6d6 with two blocking findings and five important
ones. This revision fixes them; nothing here claims the review, the mid-CI suite or the paid
eval passed.

- **[blocking] An uncertain Reader result was reported as "Nothing was written".** `confirm()`
  now carries a third list (`mayHave`) beside what was written and what failed. A Reader
  outcome of `pending` — a timeout, a transport failure, `uncertain`, or an earlier attempt
  still in flight — is named as "the result is uncertain: Reader may already have it. Tap again
  and I'll settle that same request", in both orderings (Reader only, and Both with the study
  insert failing). `outcomeText()` can still say "Nothing was written", but only when nothing
  was written _and_ nothing could be in flight. Tests: "an uncertain Reader-only tap never
  claims that nothing was written" and "a Both tap whose study insert failed and whose Reader
  result is uncertain names both".
- **[blocking] The Reader key was not on the decision row before the call.** `readerSave()` takes
  a `persist` callback and calls it with a newly created key before it contacts Reader, so a
  gateway restart mid-call leaves a resumable key. `setReaderAttempt()` only increments
  `reader_attempts` when the key changes, so one attempt is one attempt. The pending-request
  check also moved after the row's own key is considered, so a genuine retry of that exact
  request is no longer refused as "already in progress". Tests: "the Reader key is on the
  decision row before the call, so a crash stays resumable" (the probe asserts the row already
  held the key, then a crash, then a re-tap that reuses it) and the retry assertion in the
  tracking-parameter test.
- **[important] The pending lookup compared the URL Reader was sent.** `pendingReaderSave()` now
  reads `source_payload` and falls back to `payload`, because Reader resolution may rewrite
  `payload.url` to the publisher's address. Test: "an earlier pending Reader save is found
  through the URL Chief sent, not the resolved one". The in-flight reply also names that
  request key, so the model can settle it.
- **[important] Test gaps.** A new `tests/study-links-telegram.test.ts` drives the real `lnk:`
  callback through `bot.handleUpdate`: an uncertain tap that keeps its buttons and later
  settles under the same key, a failed `editMessageReplyMarkup` that still reports the outcome
  and still resumes on a second tap, the handler's own failure wording, a tap from another user
  and a missing study list. The dead `if (decision)` branch is gone and the key-reuse claim is
  now asserted instead of only replayed by hand.
- **[important] The "normalised" URL rewrote the address that was fetched and sent.**
  `normalisedUrl()` became two functions: `linkUrl()` (public HTTPS, tracking parameters and
  fragment removed, `www` and path kept) is the one URL used for the fetch, the pending lookup
  and the `save_link` payload; `dedupeKey()`/`canonicalUrl()` stays the duplicate key in
  `canonical_url`. Tests: "one link URL keeps the owner's host and drops only tracking" and
  "a www variant is the same entry and the stored link stays the one the owner shared".
- **[important] Topic filter and phone text.** The topic filter now matches any word of a stored
  topic ("AI" finds the AI interests), the list returns the topics in use, and each bullet
  carries the link itself so it is tappable.
- **Nits fixed:** a `links` cue exists in `src/tool-domains.ts`; the interest filter matches
  whole words only (no more `email`/`mail`/`detail`); an unconfirmed Reader attempt no longer
  counts as a write, so "Reader, then Study list" is a change of mind; a definite Reader
  rejection is reported as a failure rather than as uncertain.
- **Still blocked (named):** `kite run eval:picker` (run again by hand for this revision) stops
  with "OPENROUTER_API_KEY is not set in the environment or .env". The picker scenario is
  unmeasured until a credentialed run; the owner must run it before merging.

One more fix in the same revision: a tap now adopts the request key of an identical Reader save
that is already in flight (same link URL, nothing written on this decision yet) and settles it,
instead of replying "already in progress" for ever. That was the visible symptom of the
second blocking finding — a pending Reader row the buttons could never settle. The key is
adopted only for an exact payload, because `mcp.ts` refuses a key bound to a different payload.
Test: "a tap adopts the key of an identical Reader save that is already in flight".

## Revision after the independent review of 831a3bf

The reviewer returned REQUEST CHANGES on 831a3bf (base d59cee7) with five blocking findings,
four important ones and nits. This revision repairs them; nothing here claims that review, the
full CI suite or the paid eval passed.

- **[blocking] An inserted study entry was reported as "The study entry wasn't written …
  Nothing was written" when recording it on the card failed.** `confirm()` now reports each write
  the moment it returns: `store.add()` and `setStudy()` no longer share a `try`, and a card
  update that fails after the INSERT is named as "The entry is saved, but its card couldn't be
  updated", with the row left resumable so a re-tap repeats only the recording. Test: "a study
  entry that was inserted is reported as saved when its card update fails".
- **[blocking] An accepted Reader save was reported as "Nothing was written" when the card
  update failed.** The Reader outcome is now claimed (`wrote`/`mayHave`) before
  `setReaderAttempt()` runs, and a card failure is added beside it. Only a Reader step that
  never returned an outcome pushes nothing. Test: "a Reader save that was accepted is never
  reported as nothing when its card update fails".
- **[blocking] A settled card claimed a Reader save that never happened.** A `confirmed` row now
  answers from the record only: `confirmedText()` names the destinations actually stored and
  says plainly when the tapped one is missing ("It isn't in Reader; say 'move it to Reader'").
  The old test that asserted the false claim was replaced by that assertion plus "no Reader
  call" (`tests/study-links.test.ts`, "an unsure link's tap writes only the chosen destination").
- **[blocking] A routine input error became an uncertain write that blocked every later write.**
  `http://`, `localhost` and oversized links now raise `ToolValidationError` through
  `validatedLink()` and
  `validatedKey()` instead of a bare `publicLink()` error, so they map to `VALIDATION_FAILED`
  and say nothing was written. Test: "a non-public or non-https link is refused as input, not
  as an uncertain write".
- **[blocking] "What's on my AI study list" hid most AI entries.** The topic filter resolves a
  broad learning-interest query ("AI", "my AI study list", "learning") to every configured
  interest area, because "agent platforms" and "developer tools" contain no "AI"; other queries
  match a label or tag partially, with `%`, `_` and `\` escaped. `topicFilter()` carries the rule
  and the list heading still names the owner's own query. Test: "'what's on my AI study list'
  finds AI interests whose labels contain no AI".
- **[important] The requirement-8 notice never reached the owner from a chat turn.** The agent's
  pending-MCP gate now exempts the four study writes (`STUDY_WRITE_OPERATIONS`), because they
  are local to the owner's collection and the Reader half reports the in-flight save with its
  request key instead of duplicating it. Test: "a pending Reader save does not block a study
  write, and the tool reports that key" (it asserts the gate would refuse, the exemption, the
  study save succeeding and the `already in progress` notice naming the key). Documented in
  `docs/study-links.md`.
- **[important] No settler for an uncertain study or link write.** `settleUncertainStudyWrites()`
  reconciles `link_save`, `link_move`, `study_update` and `study_remove` from their own traces
  after the run stopped and two minutes passed, settles the runtime call as success or failed
  with a reconciliation note, and is called from the agent's write gate and `/continue`. It
  never replays. Tests: `tests/study-settlement.test.ts` (6 tests), including running runs,
  recent calls, other owners, unreadable arguments, an invalid link and a pending Reader row.
- **[important] Requirement 11 still not measured.** `kite run eval:picker` was run by hand
  again and stops at "OPENROUTER_API_KEY is not set in the environment or .env"; no
  credentialed run exists here. The scenario change is therefore unmeasured: `mcp-reader-save`
  ("Save this article to Reader for offline reading") now labels `links`, and two scenarios were
  added for the core trigger and the list question (`links-save-url` tuning, `links-study-list`
  held-out). The `links` cue in `src/tool-domains.ts` also matches a bare "save this <url>".
  The owner must run the eval before merging.
- **[important] Page reading was too thin for the requirement-1 examples.** The classifier's
  excerpt is now the page description plus the page's own visible post text (paragraphs, list
  items, headings, quotes; script/style skipped), and a PDF or binary body is treated as
  unreadable instead of parsed as markup, so study material becomes a question rather than an
  entry named from garbage. Test: "the page's own post text reaches the classifier when the meta
  tags are thin". A JavaScript-only page still gives less text and is documented as a
  limitation; reading it through the public browser is not part of this change.
- **Nits fixed:** `confirm()` acts on the claimed row, not the one read before the claim; an
  expired choice card (`expires_at`) writes nothing; `setReaderAttempt()` really does count one
  attempt per key (the counter only moves when the key changes); the `link_save` description no
  longer both says "say where it went" and "never claim a save" (the result is the authority);
  `study_list`'s description matches the new broad filter.
- **Test gaps closed:** the Telegram tests now also drive the real `McpTools`-backed Reader mock
  (extracted to `tests/helpers/reader-mock.ts`) for a Both tap that saves both and for one whose
  Reader write is refused, and `tests/study-settlement.test.ts` covers the settler.

## Revision after the independent review of 59071246

The reviewer returned REQUEST CHANGES on 59071246 (base d59cee7) with one blocking finding, four
important ones and four nits. This revision repairs them; nothing here claims that review, the
full CI suite or the paid eval passed.

- **[blocking] An unconfirmed Reader save was dropped and then reported as absent.** Tapping
  Reader (timeout) and then Study list settled the card and later claimed "It isn't in Reader"
  while a pending Reader request could still land. `confirm()` now counts an unconfirmed Reader
  attempt (`pending`/`uncertain`) as progress: the study half is written and the same Reader
  request is resumed under its existing key, and the card is not confirmed until that request
  settles. A `confirmed` row also never says a link is not in Reader while its Reader state is
  unconfirmed. The test that asserted the flagged behaviour now lives in
  tests/study-links.test.ts as "after an uncertain Reader tap, tapping Study list keeps the
  Reader request open": it asserts the Reader step is retried under the same key, the card stays
  open, and no reply says the item is missing from Reader.
- **A definite non-send is not uncertain**: a Reader write refused before it is even sent
  (another Reader save is still pending) is now `blocked`, not `uncertain`. The reply says the
  save was not sent and never that Reader "may have it"; the row's Reader state returns to
  `none` so a later tap retries. Tested in "a Reader save that was never sent is never described
  as one Reader may have".
- **Partial-write wording**: a study entry that was already on the list is no longer reported as
  newly saved when the Both route repeats ("already on your study list and saved to Reader").
  Tested in "a Both save of a link already on the study list does not claim to add it again".
- **Choice card delivery**: the three buttons now go through `topics.deliver(user, {kind:
"general"}, …)` from `studyLinkChoiceAsk()` in `src/telegram.ts` instead of a bare
  `bot.api.sendMessage`, so they land in Main when threaded mode is on. The thread the card
  really reached is stored in `link_decisions.telegram_thread_id` and used for replies when the
  tapped message carries none. Tested in `tests/study-links-telegram.test.ts` ("the choice card
  goes through topic delivery and records the thread it reached").
- **Skill version label**: `repo:personal-assistance` moves from 5 to 6 with the new section in
  `skills/personal-assistance/SKILL.md`, so the catalogue and run provenance cannot show two
  different texts under one version.
- **Settler and redirected pages**: `link_save` stores the URL a redirect ended on, so comparing
  the shared URL marked a write that happened as `failed`. A study, decision or Reader record
  created after the call started now settles it as done (a settled `failed` would claim nothing
  was written when something was). Tests: "a save whose page redirected settles from the write it
  made, not as failed" and the negative case where the only entry predates the call.
- **Nits fixed:** `readerHas()` logs its failure instead of swallowing it; the `links` cue matches
  "save this" and the link across a line break (`[\s\S]{0,120}`); the `link_save` description
  explains `blocked` and `uncertain`.
- **Unchanged by design:** when the page cannot be fetched at all there is no title to record, so
  even an explicit "for study" cue still produces the three taps. That is the approved choice
  (never invent a title), and it is stated in the docs.

Requirement 11 remains a named blocker, not a pass: `kite run eval:picker` was run again by hand
and stopped immediately with "OPENROUTER_API_KEY is not set in the environment or .env". The
picker eval needs the owner's key; nothing is claimed about the classifier or picker accuracy
without it.

**Formatting repair.** The host's `kite run format:check` was the one failing check on this
revision, on the new `links` cue assertions in `tests/tool-domains.test.ts`. Prettier was applied
to that file only; `kite run format:check` is now clean, and `tests/tool-domains.test.ts` (17),
`tests/study-links.test.ts` (39), `tests/study-links-telegram.test.ts`,
`tests/study-settlement.test.ts` (8), `tests/jev-links.test.ts`, `tests/mcp.test.ts` (21),
`tests/news.test.ts` (32), `tests/skills.test.ts` (1), `tests/telegram.test.ts` (8) and
`tests/telegram-topics.test.ts` (25) pass locally after it. `tsc --noEmit` and
`tsc -p tsconfig.evals.json --noEmit` are clean, and the picker and deploy-script unit tests
pass (8 and 17).

## Revision after the independent review of 812b9262

The reviewer returned REQUEST CHANGES on 812b9262 with one blocking finding, one important one
and three nits. This revision repairs them; nothing here claims the re-review, the full CI suite
or the paid eval passed.

- **[blocking] An expired card with a partial write said "nothing was written" and lost its
  buttons.** `confirm()` applied `expires_at` before it looked at what the row held, so a card
  that had inserted a study entry and left a Reader request unconfirmed answered "nothing was
  written" with the tap handler clearing the keyboard. Expiry now applies only while nothing was
  written and nothing is in flight (`study_state='none'` and no unconfirmed Reader attempt); any
  other expired card is resumed, runs only its unfinished step, and is reported from its record.
  Tests: `tests/study-links.test.ts` "an expired card that already holds a write
  resumes instead of claiming nothing" (the reviewer's reproduction, plus the request key being
  reused), "an expired card whose Reader write was refused still retries only that half" (new
  key, requirement 9), and `tests/study-links-telegram.test.ts` "an expired card that holds a
  partial write still settles and never says nothing was written" (buttons still settle it).
- **A settled card's advice no longer loses the other half (nit).** `confirmedText()` used to
  tell the owner to "move it to Reader" when the card was settled to the study list and they
  tapped Both, but `link_move` removes the study entry once Reader accepts, so following the
  advice dropped the half they wanted. The advice for that case is now "say 'add it to Reader
  too'", which is a plain `link_save` and keeps the entry; the skill and the `links` domain
  guidance say the same, and `link_move`'s runtime description names the difference. Test:
  "an unsure link's tap writes only the chosen destination and reports exactly that".
- **A moved or tapped study entry gets a real subject (nit).** Reader → study stored no topic and
  a title-less card stored the URL, so a "moved" entry had no subject at all. `move()` now takes
  the topic from Jev's read of the page (`topicOf()`, the same mapping a classified save uses),
  and `confirm()` re-reads the page when the card lacks a title or topic (`pageDetail()`): the
  page's own title and a topic Jev names are stored, and a page that still cannot be read keeps
  the link as the title with no topic rather than inventing either. Tests: "corrections move an
  item between the study list and Reader" (title, URL and topic of the moved entry), "a study
  tap fills a missing topic from the page, the same way a save does", and "a card whose page
  Chief still cannot read keeps the link as its title, with no topic".
- **A reused in-flight Reader request is named to the owner (nit).** When a repeat save of the
  identical link adopted the pending key, nothing said an earlier save existed (requirement 8
  asks for it). `readerSave()` now carries a `note` on the outcome — "an earlier Reader save for
  this link was still in progress, so this settled that same request instead of starting a
  second" — and it reaches the owner from `link_save`, the tap and `link_move`, on accepted,
  pending and refused outcomes alike. Tests: "a repeat save of the identical link reuses the
  in-flight request and says so" and the note assertion in "a tap adopts the key of an identical
  Reader save that is already in flight".
- **Unchanged by design:** a card that holds only a refused Reader attempt and no study entry
  wrote nothing, so it still expires like an untouched one. A variant URL (different host or
  path) still cannot adopt a key bound to another payload, so it is still reported as
  `blocked` with that request key. A card whose study INSERT succeeded but whose card update
  failed is a write the row does not show; the expiry check therefore reads the study
  collection too, and the existing test for that case now expires the card before its re-tap
  and still gets "Already on your study list".

**Requirement 11 remains a named blocker, not a pass.** `kite run eval:picker` was run by hand
again for this revision and stopped immediately with "OPENROUTER_API_KEY is not set in the
environment or .env". No picker measurement exists here, so the `links` routing of `mcp-reader-save`
("Save this article to Reader for offline reading") is unmeasured until the owner runs it.
