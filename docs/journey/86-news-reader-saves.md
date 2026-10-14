# 86 — Learning the bulletin from what the owner saves to Reader

Work date(s): 2026-10-15. Written/revised: 2026-10-15.
Status: in review. Chief and Reader changes are implemented and tested locally; neither is merged or deployed. Live owner acceptance is pending.

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

Independent review: pending.

## Verification and outcome

- Chief, local mocked tests: 32 news tests (including save-driven ranking, exclusion of saved links through `www.` and tracking parameters, Reader refused or disconnected, idempotent keyed saves and their outcomes, the five-item cap including legacy rows) and 21 MCP tests (strict decoding, unavailable grant, shipped registry). Full `npm run check` result: see the PR.
- Reader: 26 backend tests, including the opt-in gate, self-grant refusal, paging, brief exclusion and revocation. The iOS simulator build succeeded.
- Not measured: whether word overlap picks better articles than votes did. No live data yet.

## Follow-up and next iteration

- Owner acceptance: turn on sharing for Chief's connection in Reader, receive an edition, save one, and confirm ✓ and the article in Reader.
- Phase 2: evaluate replacement scorers offline on the logged suggested and saved set before shipping one.
- Possible: the agent offering `unfollowedSites` to follow; an exploration slot.
