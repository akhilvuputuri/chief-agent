# 151 — Where should a shared link go?

Work date: 2026-11-02. Written: 2026-11-02.
Status: implemented and tested with mocked integrations. Not released: migration 036 is a database change, so production needs the reviewed operator procedure in docs/cloud-development.md. `kite run eval:picker` could not run in this sandbox: it exits with "OPENROUTER_API_KEY is not set in the environment or .env". The host must run it before merge because `config/tool-picker.json` changed.

## User-visible problem and preceding iteration

"Save this" for a link meant Reader. That is right for offline reading and wrong for anything the
owner wants to study: an X thread on agent architectures, a tutorial, a course, a paper or a
repository landed in the offline reading list, where they are not trackable and carry no status,
notes or topic. Reader is also the only destination, so an unreadable or refused link had nowhere
to go. The earlier MCP and link-resolution work ([67](67-mcp-connectors.md),
[69](69-link-resolution.md)) established the save path and the verified publisher URL; this entry
changes which destination a save goes to and stores study material as its own collection.

## Evidence

- **Code:** every save path ended in Reader — `mcpReaderLink` in `src/main.ts`, the delivered-save
  path in `src/news.ts`, and `saveToReader` in the Telegram news buttons. No collection existed
  for study material, and the `mcp` picker entry described "saving an article" as that domain.
- **Code:** the tool picker, effort picker and shadow decisions already call TypeSafe's Jev
  `/alpha/decisions` with the model id in `config/tool-picker.json`; `src/tool-picker.ts` is the
  only client that owns it. `src/effort.ts` proves a `type: "choice"` question with probabilities
  works on that endpoint.
- **Deferred:** no production traffic was measured; the classification's calibration is untested
  against real owner saves.

## Diagnosis and alternatives

The destination is a judgment, not a keyword. A rule list would call a "news" article about agent
architectures reading and a newspaper tutorial study, which is wrong in both directions. The
chosen mechanism is a Jev `choice` question (`study` / `reader`) over the page's own metadata, the
owner's words and the saved learning interests, plus a `noul` cue question so an explicit "for AI
learning" or "for offline reading" always wins. Thresholds live in `config/link-routing.json`;
anything below them, or any failure, asks the owner. Reader is never a fallback.

Alternatives rejected: a fixed keyword list (not model judgment, and the owner asked for
judgment); a new provider or model id (the repository already runs Jev, and a second id would
diverge); delegating to a plugin agent (heavier: content pins, hashes and allowlists for six small
tools); storing study material as a canvas (a snapshot, not a queryable collection).

## Implementation and review

- `config/link-routing.json`: question, cue, thresholds, interests, TTL. No model id by design.
- `src/link-router.ts`: config schema (strict, so a `model` key is rejected), `jevModel()` from
  `readPickerConfig()`, `linkKey()`, page metadata extraction and `readLinkPage()` through the
  existing SSRF-guarded fetcher, `linkDecision()` (pure, config-driven), `linkReason()` and the
  `LinkClassifier` client. Every failure resolves to `unsure`.
- `db/036_study_resources.sql`: `study_resources` (owner-scoped, unique `user_id`+`url_key`,
  classification record) and `study_link_prompts` (durable ask with TTL and announced/resolved
  timestamps).
- `src/study.ts`, `src/study-schema.ts`: the `study` domain — `link_save`, `study_save`,
  `study_list`, `study_update`, `study_remove`, `study_move` — plus `resolvePrompt()` for taps and
  `pending()` for the ask cards. Reader saves use a request key derived from the owner and the
  link, so a retry replays instead of duplicating.
- `src/protocol.ts`, `src/tools.ts`, `src/runtime.ts`, `src/main.ts`: registration, dispatch,
  availability and wiring. A missing Jev key or an unreadable config leaves the classifier off and
  every link save asks.
- `src/telegram.ts`: `ls:st` / `ls:rd` / `ls:bo` callbacks and the three-button card, sent after
  the reply and announced once.
- `src/context.ts`, `src/tool-domains.ts`, `config/tool-picker.json`, `evals/picker/picker.py`,
  `skills/link-saving/SKILL.md`, `src/baseline-skills.ts`, `Dockerfile`: prompt, domain guidance
  and cue, the `study` picker entry (with `mcp` narrowed to offline reading), the Python mirror,
  the skill, and the image's config copy.
- [Design note](../link-study-routing.md).

## Verification and outcome

- **Tested:** `tests/link-routing.test.ts` (12), `tests/study-resources.test.ts` (17) and
  `tests/study-telegram.test.ts` (3) pass locally with mocked integrations; the existing
  tool-domain, tool-picker and Dockerfile-config tests and the Python picker tests pass with the
  new domain. `tsc --noEmit` is clean apart from the pre-existing `@chief-agent/pi-runtime` build
  errors, which `kite run build:pi` resolves.
- **Not run here:** `kite run eval:picker` (paid) exits with "OPENROUTER_API_KEY is not set in
  the environment or .env"; the runtime smoke was not run either. The picker eval must run
  before merge because `config/tool-picker.json` changed.
- **Not measured:** classification accuracy on real shared links, and whether the Jev snapshot
  answers arbitrary `choice` keys (`study` / `reader`) rather than only `low`/`medium`/`high`. If
  it does not, the answer is malformed and the owner is asked — safe, but the buttons would carry
  the flow until the config is recalibrated.

## Follow-up and next iteration

- Run the picker eval and record the result here.
- Release through the operator procedure for database changes; migration 036 is additive.
- Watch the share of saves that end in the ask card. A high share means the thresholds or the
  question wording need calibration, not more keywords.
- Deferred: a canvas or Mini App study-list view; classification from a browser-rendered page for
  sites that refuse a plain fetch (X in particular).
