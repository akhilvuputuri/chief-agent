# 86 — Learning the bulletin from what the owner saves to Reader

Work date(s): 2026-10-15. Written/revised: 2026-10-15.
Status: in review (round 2). Chief and Reader changes are implemented and tested locally; neither is merged or deployed. Live owner acceptance is pending.

## User-visible problem and preceding iteration

The daily bulletin ([journal 42](42-news-bulletin.md)) offered up to eight items with 👍/👎 buttons. Votes adjusted per-site and per-topic weights. On 15 October the owner asked for a different loop. The bulletin should suggest, and the owner chooses to save a suggestion to Reader, the offline reading app. The owner also saves articles to Reader from Safari. Those saves together are a better sample of what they want to read, and the bulletin should learn from it. The owner asked for five suggestions per edition. They asked to start with the simplest matching method and to keep the option of researching or building a stronger recommender later.

## Evidence

- **Reported (owner, 15 October):** desired behaviour above. They chose metadata-only library access for Chief (title, link, site, save time), the simplest matching method first, and to drop existing votes.
- **Code inspection:** Reader deliberately allowed agent connections only to save and to check their own submissions; there was no way for Chief to see Safari saves. Chief's Reader saves already go through a durable, idempotent MCP journal ([journal 67](67-mcp-connectors.md), [journal 69](69-link-resolution.md)).
- **Tested (mocked, local):** see Verification. No production data was inspected.

## Diagnosis and alternatives

- **Where learning reads from.** Two options: mirror Reader's library into a Chief table, or read Reader at build time. Reading live needs no migration and follows deletions in Reader. A mirror would add an operator rollout and a second copy that drifts. Live read was chosen; the cost is that learning pauses when Reader is unreachable (recorded in the trace).
- **Save state.** The item id is used as the MCP idempotency key, so the existing `mcp_operations` row is the save state. A `saved_at` column would duplicate it and require a migration.
- **Matching (phase 1).** Approaches considered, in increasing cost:
  1. Word overlap: TF-IDF cosine against saved titles, plus per-site affinity. Chosen. Free and inspectable; misses synonyms.
  2. Embeddings: semantic similarity; adds a provider call and cost per edition.
  3. Learned ranker over suggested-versus-saved items, with the above as features.
  4. A model rerank or a reserved exploration slot to avoid narrowing.
     Nearest-neighbour similarity (mean of the top three) was chosen over a single centroid, so separate interests are not averaged into one.
- **Permission boundary in Reader.** A new per-connection opt-in (`connection_grants.interests`, toggled only by the app session) gates a metadata-only listing. OAuth scopes are unchanged; the app toggle is the authorization. Revoking a connection deletes its grant.

## Implementation and review

Chief (branch `feat/news-reader-saves`):

- `src/news-interests.ts`: the profile (`interestProfile`, `affinity`, `describeProfile`).
- `src/news.ts`: Save keyboard and flow, ranking with the profile, Reader read alongside feed gathering, a cap of 5, status changes. Votes removed.
- `src/telegram.ts`: the `nw:sv:` handler answers at once, then edits the keyboard. Old `nw:up|dn` buttons get a retirement notice.
- `src/mcp.ts`, `config/mcp.json`: a `list_saved_articles` read grant with a strict `reader_saved` decoder. Discovery lists a granted-but-absent tool as `unavailable` instead of failing the connection.
- [Runbook](../news-bulletin.md).

Reader (`offline-reader`, branch `feat/reader-interests`): the `connection_grants` table (additive, via the existing idempotent schema), the `list_saved_articles` MCP tool and `GET /v1/interests/saved` (keyset-paged with exact microsecond cursors; articles only, briefs excluded), `PATCH /v1/connections/:id`, and a Settings toggle.

**Independent review round 1 (Opus 5.5, on `dcd05dc`): REQUEST CHANGES.** The reviewer ran its own regressions against the real `McpTools` with a mocked transport. Findings:

- **(P2, reproduced)** A Save that stays pending blocks all of Chief's writes, and the owner got misleading text. Triggers: a Reader 429, or a Reader business error such as a full library, which arrives as a text-only error. Other Save buttons then replied with internal text, and the agent's other writes were refused. Now every pending outcome says what settles it and that other saves and changes wait. A save refused because of another pending write names the bulletin item holding it up. The MCP pending-write rule itself is unchanged.
- **(P2, measured)** Similarity was not the documented cosine. Words the owner never saved were dropped before normalizing, so one shared word in a 14-word headline scored 0.363 against 0.416 for an identical title, and the excerpt's half weight cancelled out. Unseen words now count at the highest IDF; a regression requires an exact match to score more than 2.5× a one-word overlap.
- **(P3)** Further fixes:
  - Accents were turned into word breaks ("Zürich" → "rich"). Marks are now removed.
  - `news_status` advised turning on sharing when connectors were off or Reader lacked the tool. Learning now needs configured MCP, and each failure category has its own note.
  - One oversized title failed the whole page, and a later failed page discarded earlier ones. Records are now cut or skipped, and pages that arrived are kept.
  - Reddit self-posts could not be saved. The discussion is now saved under the same key, which is safe because link resolution refuses before anything is recorded.
  - A press held a grammY runner slot for up to about 90 seconds. The save now finishes outside the handler.
  - Clearer text for an item tried under a previous Reader credential.
- **Not changed:** the model could reuse a news item id as its own `requestKey` (the reviewer judged it unlikely). `news_status` performs live Reader reads (within Reader's rate limit).

**Devin Review (automated, on `dcd05dc`):**

- **(Red)** Adding the grant and a new description to the `reader` connection changed its definition, which is hashed into every operation's binding. Any Reader save still pending at deploy time could then never be replayed, and it would block other writes. The listing now lives on a separate `reader-library` connection, and a test pins the `reader` definition to its released form.
- A saved story reached through a Reddit link was suggested again. Headlines matching a saved title (Jaccard ≥ 0.6) are now excluded.
- Same root cause as the `news_status` P3 above.

Found while fixing: words shorter than three letters were dropped, so "AI" never matched. Two-letter words are kept, except a list of common ones. Reader's review added a `prepared` flag; unprepared saves (title is only a host name) contribute their link and site but no words.

## Verification and outcome

- Chief, local mocked tests: 32 news tests (including save-driven ranking, exclusion of saved links through `www.` and tracking parameters, Reader refused or disconnected, idempotent keyed saves and their outcomes, the five-item cap including legacy rows) and 21 MCP tests (strict decoding, unavailable grant, shipped registry). Full local suite on `da5eabf`: 920/920 application tests, 50 script tests, 105 Pi runtime tests and Prettier pass. The coding benchmark's two `chief-protocol` fixtures fail identically on unmodified `origin/main` (a local environment issue; `evals/` is unchanged here), and `check:coding` could not run locally because `ruff` is not installed. Hosted CI is the authority for both.
- Reader: 26 backend tests, including the opt-in gate, self-grant refusal, paging, brief exclusion and revocation. The iOS simulator build succeeded.
- Not measured: whether word overlap picks better articles than votes did. No live data yet.

## Follow-up and next iteration

- Owner acceptance: turn on sharing for Chief's connection in Reader, receive an edition, save one, and confirm ✓ and the article in Reader.
- Phase 2: evaluate replacement scorers offline on the logged suggested and saved set before shipping one.
- Possible: the agent offering `unfollowedSites` to follow; an exploration slot.
