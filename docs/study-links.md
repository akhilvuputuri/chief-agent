# Study links and proactive link classification

A shared link is classified before it is stored. Study material goes to the owner's own study
collection in Postgres; Reader is for offline reading only. The classification is Jev's
judgment on the page's own content and the owner's words — never a keyword rule — and Chief
asks only when it is genuinely unsure.

## The save flow

1. `link_save` takes the URL and, when the owner said something with it, `ownerMessage`.
   Two values are computed once in [src/link-classifier.ts](../src/link-classifier.ts):
   - `linkUrl()` is the one link URL: the public HTTPS address as the owner shared or as the
     page redirected, with only tracking parameters and the fragment removed (`www` and the
     path stay as served, because that is what gets fetched and sent). It is the fetch
     target, the Reader `save_link` payload and the stored `url`.
   - `dedupeKey()` (`canonicalUrl()` in [src/news-feed.ts](../src/news-feed.ts)) is the
     duplicate key: no `www`, no trailing slash, sorted parameters. It is stored as
     `canonical_url` and never sent anywhere.
     One value per purpose means a tracking-parameter variant of the same link can never reach
     a request key created for a different payload, and `checkReplay()` in
     [src/mcp.ts](../src/mcp.ts) cannot be tripped by Chief's own inconsistency.
2. The page is read through the existing public fetcher (`PublicFeedFetcher`), and the title,
   site and description come from the page's own markup. The excerpt is the page's description
   followed by its own visible post text (paragraphs, list items, headings, quotes; script and
   style content is skipped), so a thread or tutorial with thin meta tags still reaches the
   classifier as text. A PDF or other binary body is treated as unreadable rather than parsed as
   markup, and a blocked page leaves the title unknown; nothing is invented.
3. `JevLinks.judge()` ([src/jev.ts](../src/jev.ts)) asks Jev three `choice` questions in one
   request on `config/link-classifier.json`: the route (study, reader, both, unsure), which of
   the owner's learning interests the page covers, and what kind of page it is. The model id
   is read from `config/tool-picker.json` — the one place the repo pins Jev — so a snapshot
   change lands once. Chief's main model is untouched.
4. Host safety only ([src/study-links.ts](../src/study-links.ts) and
   `judgeLink()`): the answer must validate; a Jev timeout, transport failure or unparseable
   reply becomes `unsure`; a probability below `apply.minConfidence` becomes `unsure`; study
   material without a readable page title becomes `unsure` (there is nothing honest to call
   it). **No failure path falls back to Reader.**
5. Confident study material is inserted into `study_resources`; confident offline reading is
   saved to Reader; `both` does both. The reply names the destination in one line so the
   owner can correct it. `unsure` creates a `link_decisions` row and sends three Telegram
   buttons: `Study list`, `Reader`, `Both`.

Explicit cues always win because they travel in the same request and the rubric says so:
"for AI learning"/"to study" is study, "for offline reading"/"read later" is Reader. There is
no keyword switch in code.

## Storage

Both tables are owner-scoped and live in `db/036_study_links.sql`.

`study_resources` is the collection: `url` (the one link URL sent to Reader), `canonical_url`
(the dedupe key), `title`, `source`, `topic`, `tags`, `notes`, `status`
(`to_study`, `in_progress`, `done`), `added_at`, `classification_route`,
`classification_reason`, `classification_confidence`, `classification_model` and
`reader_saved`. A unique index on `(user_id, canonical_url)` is the duplicate detector: a
repeat returns the existing entry instead of inserting, so a tracking-parameter variant of the
same link cannot become a second entry. It is a Postgres collection, not a canvas snapshot.

`link_decisions` is the durable resume record for a save that needed a choice or failed
part-way: the shared and normalised URL, the classification, the owner's choice, `study_state`
and `study_id`, `reader_state`, `reader_request_key`, `reader_attempts`, the message and thread
the buttons were sent to, a claim lease and the last error. It is never deleted on a tap.

## Reader keys and rejections

- One key per attempt, from `randomUUID()`. Nothing is derived from owner and URL.
- A key is reused only for a genuine retry of the identical request: the row is the same, the
  payload is the same link URL, and the attempt under that key has no stored outcome yet. A
  repeat with the same key and payload replays the stored receipt in `src/mcp.ts`, so it
  cannot create a second save. Nothing is derived from owner and URL.
- After a stored rejection (state `rejected` in `mcp_operations`, or on the decision row) the
  next attempt gets a new key, so one refusal cannot block every later attempt. An unconfirmed
  attempt (timeout, transport failure, `uncertain`) keeps its key, because that is the retry
  request.
- The key reaches the decision row before Reader is contacted (`persist` in `readerSave()`),
  so a crash mid-call leaves a resumable key rather than a duplicate save. The row's
  attempt counter only moves when the key changes.
- If a Reader save for the same link is already in flight under a different key, the reply
  says so, names that request key, and starts no second save. The lookup compares the URL
  Chief sent (`source_payload`), because Reader resolution may have rewritten the dispatched
  `payload.url` to the publisher's address.
- A save that was never sent is its own outcome (`blocked`), not an uncertain one: when another
  Reader save is still unconfirmed, `src/mcp.ts` refuses the write before anything leaves Chief.
  The reply says that plainly ("so this one wasn't sent") and never claims Reader may already
  have it. The decision row keeps `reader_state='none'`, so a later tap tries again.
- When the in-flight save is the identical request (the same link URL, nothing written on this
  decision yet), the tap adopts its key and settles that request instead of being blocked by
  it forever. The key is only adopted for an exact payload, because `mcp.ts` refuses a key
  bound to a different payload. The owner is told that an earlier Reader save for the link
  was already in progress and that this settled that same request, whether the request was
  reached from a tap or from a repeat `link_save` (requirement 8). That note travels on the
  outcome itself, so an accepted, pending or refused result all name it.

## The tap handler

`lnk:<study|reader|both>:<decision-uuid>` in [src/telegram.ts](../src/telegram.ts) answers the
callback first, then works outside the handler so a slow Reader save does not hold an update
slot. The decision row is the state:

- `confirmed` → the owner is told what the record actually holds and nothing is written. A tap
  for the destination that was not saved says so plainly instead of claiming it, so a settled
  card can never report a Reader save that never happened. When the card is settled to the
  study list and the owner taps Both, the advice is "say 'add it to Reader too'" rather than
  "move it to Reader", because a move takes the entry off the study list and would lose the
  half the owner asked to keep.
- An expired card (`expires_at`, two days) writes nothing **only while nothing was written and
  nothing is in flight** (`study_state='none'` and no unconfirmed Reader attempt). An expired
  card that already holds a study entry, or a Reader save that may still land, is resumed and
  reported from its record: calling that "nothing was written" would be false, and clearing its
  buttons would strand the write it holds. A card that holds only a refused Reader attempt
  wrote nothing, so it expires like an untouched one. The study collection is checked too, not
  only the row, so an entry inserted by an earlier tap whose card update failed still counts as
  a write.
- A conditional `UPDATE … RETURNING` claims the row for two minutes; no row means another tap
  is in flight. The lease expires, so a failed tap cannot permanently disable the buttons.
- Only the unfinished step runs. The study insert records `study_state='done'` and `study_id`;
  its title and topic come from the page, because a card made while the page could not be read
  carries none: the page is read again when the tap writes the entry, a topic Jev names is
  stored, and a page that is still unreadable leaves the link as the title rather than an
  invented name. The Reader step records the request key on the row before the call and then
  the outcome (`accepted`, `rejected` or `uncertain`), so a re-tap resumes that exact request.
- A tap on a different button before anything is written replaces the choice. After a
  completed write - or an unconfirmed Reader attempt, which may still land - it means the
  owner wants both, so the remaining half is finished rather than ignored. Tapping Reader,
  then Study list, therefore writes the study entry and resumes that same Reader request under
  its existing key instead of settling the card and later calling the Reader copy absent. A
  settled card never says "isn't in Reader" while the Reader side is still unconfirmed.
- All requested steps done → `confirmed` and one line naming the destination.
- A failure after a partial write names exactly what may be saved ("Saved to your study list;
  Reader refused that link… tap again and I'll retry only the part that failed") and never says
  nothing was written. Each write is reported the moment it returns, before the card that records
  it is updated, so a card update that fails after an INSERT or an accepted Reader save is
  reported as "the entry is saved, but its card couldn't be updated" - never as an unwritten
  entry. The row stays resumable and a re-tap repeats only the recording step.
- An unconfirmed Reader result is reported as uncertain and may already exist in Reader
  ("the result is uncertain: Reader may already have it. Tap again and I'll settle that same
  request"), including when the study entry was the part that failed. A save that was never
  sent is reported as exactly that instead.
- Only a failure with zero writes says nothing was written, and that a re-tap retries.
- A tap that does not finish keeps its three buttons, and a failed message edit changes no
  state: the row is keyed by the decision UUID, so the same callback still resolves and resumes.

## Tools

| Tool           | What it does                                                                                |
| -------------- | ------------------------------------------------------------------------------------------- |
| `link_save`    | Classify a shared link and save it, or ask with three taps.                                 |
| `study_list`   | List and filter by topic, tag or status; phone-friendly `text` plus entries with exact ids. |
| `study_update` | Change status, notes or tags on one exact id.                                               |
| `study_remove` | Remove one entry from the study list.                                                       |
| `link_move`    | Study → Reader (saves, then removes the entry once Reader accepted) or Reader → study.      |

They belong to the `links` tool domain, are cued by saving or study-list language (including a
bare "save this <url>"), and are offered only when migrations up to 036 are installed, so
nothing fails while an operator rollout is pending.

Malformed input is a validation refusal, not a failure: a `http://`, private-host or oversized
link raises `ToolValidationError` (`VALIDATION_FAILED`) and says nothing was written. A plain
error there would be recorded as an uncertain write and block every later write.

## Pending MCP writes and uncertain-write settlement

- A pending MCP operation still blocks ordinary writes, but not `link_save`, `study_update`,
  `study_remove` or `link_move`: those write only the owner's own collection, and the Reader
  half reports a save already in flight (naming its request key) instead of starting a second
  one. Without that exception the requirement-8 notice could never reach the owner from a chat
  turn, because the host gate refused the call first.
- An interrupted study or link write is settled by `settleUncertainStudyWrites()` once the run
  has stopped and the call is older than two minutes. Each of these tools leaves a trace keyed
  by the link or the entry id (a `study_resources` row, a `link_decisions` row, the
  `mcp_operations` row, a row updated after the call started, or - for a removal - the row's
  absence, since the tool refuses an unknown id). A trace settles the call as done, no trace
  settles it as failed, and unreadable arguments or an invalid link are left for an operator.
  Nothing is replayed, and Reader's own operation keeps its state. A page that redirected to
  another address has no stored final URL to compare, because the public fetcher follows the
  redirect without recording it, so a study, decision or Reader record for that owner created
  after the call started settles it as done. Settling such a call as failed would claim
  nothing was written when something may have been.

Reader → study keeps Reader's copy: `config/mcp.json` grants no Reader removal tool, so the
reply says plainly that Reader still has its own copy and how to remove it there. Adding a
removal grant would be a separate reviewed host-configuration change. The moved entry takes
its title from the page and its topic from Jev's read of that page (`topicOf()`), the same way
a classified save does; an unreadable page leaves the link as the title and no topic. Its
recorded confidence is 1 because the owner chose the route, and `classification_model` names
the model that named the topic.

## Presentation

`study_list` writes for a phone screen: a heading with the counts, then one bullet per entry
with the link itself (tappable on the phone), its site, topic, status and tags. A broad topic
query - "AI", "my AI study list", "learning", a question phrased around it - resolves to every
one of the owner's learning interests, because the stored topics are the area labels and
"agent platforms" and "developer tools" contain no "AI" to match; any other query matches a
topic label partially, with `%` and `_` escaped. The result carries the topics actually
in use (`topics`) to correct a filter. Exact ids travel in the returned entries for later
changes rather than in the text. A canvas or Mini App view is a nice-to-have and is not built.

## Limitations

- The route is model judgment, so its quality is Jev's quality. When a page blocks fetching,
  the classifier sees only the site, and a study route then becomes a question.
- A page that renders only in JavaScript (an X thread served as a shell, for example) gives the
  classifier whatever its markup and meta tags carry - often the title, site and a short
  description, not the whole thread. The route then leans on the owner's words and interests,
  and a genuinely thin page becomes the tap question rather than a guess. Reading such pages
  through the public browser would be a separate change.
- The page is fetched at the link URL as shared. A host that only serves one variant (with or
  without `www`) can therefore fail that fetch; the link then becomes a question rather than
  an entry with a guessed title.
- Reader has no removal grant, so "move" only removes the study entry.
- `link_save` and `link_move` always send Reader the article form of a link; they cannot ask for
  a Reddit discussion target. When the owner explicitly wants the discussion preserved, that is
  the existing `mcp_write` `readerTarget` path, not this tool.
- The three choice buttons go through the same topic delivery as every other host card, so
  they land in Main when threaded mode is on, and the thread they really reached is stored on
  the decision row. A tap replies where the buttons are. A wrong tap is recoverable with
  `link_move`.
- Live Telegram keyboard behaviour is exercised through tests and the existing callback
  conventions, not by a production tap.

## Rollout

`db/036_study_links.sql` is additive: two empty tables and indexes. Deployment therefore needs
the reviewed operator procedure (`scripts/deploy-study-links.py`, modelled on the mail-vector
rollout) rather than an automatic release, and the previous image ignores the new tables.
