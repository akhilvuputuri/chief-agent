# 155 — Classifying a shared link before saving it

Work date(s): 5 November 2026. Written/revised: 5 November 2026.
Status: tested locally; release pending. Migration 036 needs the reviewed operator rollout.

## User-visible problem and preceding iteration

A link the owner shared to save went to Reader by default, so study material (tutorials, papers,
repositories, technical threads) mixed with offline reading, and there was no durable study
collection. [69 — Shared link resolution](69-link-resolution.md) and
[67 — Remote MCP connectors](67-mcp-connectors.md) established link resolution and the Reader
save; this entry adds the missing decision and its own store.

## Evidence

- Tested: `tests/link-router.test.ts` covers a confident study save, a confident Reader save,
  explicit owner cues in both directions, two separate unsure cases (Jev says unsure; the route
  is below the confidence floor), malformed/timeout/429/5xx answers, host-filled titles, and
  duplicate URLs across tracking parameters, http and x/twitter hosts. It also covers a repeat
  Reader save (reported, not written twice), two concurrent saves sharing one Reader request
  key, an explicit cue that still wins when the link is already on the study list, an unsure
  answer for an already-saved link (reported, not asked), and an X post's own text reaching Jev.
- Tested: `tests/study-resources.test.ts` covers add/list/filter/update/remove, owner scoping,
  both move directions, removal leaving Reader untouched, Reader pending/refused/timeout paths,
  the tap claim (double press, foreign user, wrong message), a failed Reader tap that keeps its
  buttons and replays the same key, the list's total and "and N more", and a pre-dispatch
  Reader refusal worded as a refusal rather than an uncertain write.
- Tested: `tests/telegram-link-choices.test.ts` covers the three-button card, one write per tap,
  that a view callback cannot write, a failed tap keeping its buttons, and two delivery paths
  sending one card.
- Reported: Jev's production grading quality on the owner's learning areas is unmeasured.

## Diagnosis and alternatives

The route is a judgement about content and intent, so a keyword classifier would be wrong on
exactly the interesting cases (a technical news story, an essay about agents). The chosen
mechanism is Jev, the decision model the picker and effort picker already use, with the question
and thresholds in `config/decisions.json`; the host validates the answer and treats every failure
as unsure. Alternatives rejected: a deterministic rule set (owner decision A forbids it), a new
provider or model id (owner decision B), and storing study material as a canvas snapshot (not a
durable collection).

## Implementation and review

- `src/link-router.ts` (Jev client), `src/link-page.ts` (bounded page metadata and canonical
  links), `src/study.ts` (store, save flow, corrections, tap claim), `src/study-schema.ts`
  (tools; no title or confidence argument), `db/036_study_resources.sql`, the `study` tool
  domain, the `links` agent and `link-saving` skill, and the host-owned tap card in
  `src/telegram.ts`.
- `src/decision-config.ts` now owns the shared decisions schema so the link router does not
  import the plugin registry through the shadow recorder (a circular module graph).
- The coordinator's fixed prompt grew by about 400 characters, so the 54k context fixture in
  `tests/context-continuity.test.ts` moved to 54,600. The plugin catalogue cap moved from
  12,000 to 16,000 characters to fit the new agent (current catalogue 12,783).
- Review repairs: duplicate detection now covers Reader-routed links and runs after
  classification, so an explicit cue still wins; Reader request keys are derived from the owner
  and URL, so a repeat or a concurrent save replays instead of writing twice; the background
  work delivery path sends the unsure card too; a Reader tap that does not complete keeps its
  buttons and releases its claim; `study_list` counts every match and says "and N more"; X
  status links read the post's own text from public oEmbed metadata; a pre-dispatch Reader
  refusal is worded as a refusal; the owner-message lookup includes the neighbouring messages
  of the same turn; and the picker's `mcp` examples no longer teach a shared link as a Reader
  save, so the eval scenario, picker config and domain test agree.
- Design and rollout: [study resources](../study-resources.md).

## Verification and outcome

Run locally on this checkout: `tsc --noEmit`, `prettier --check .`, the affected TypeScript
suites (`link-router`, `study-resources`, `telegram-link-choices`, `tool-domains`,
`tool-picker`, `plugins`, `migration-rollout`, `context-continuity`, `context-budget`, `agents`,
`telegram`, `telegram-views`, `telegram-topics`, `steering-telegram`, `custom-runtime`,
`runtime-config`, `work`, `work-selection`), `scripts/*.test.mjs`, the picker Python tests and
`scripts/test-deploy-study-resources.py`. The full `kite ci` is left to the host. Not yet
verified: a live Jev classification, a live Reader save, the X oEmbed read against the real
endpoint (hypothesis: it returns the post text; the code falls back silently if it does not),
and the migration rollout on the host. The route journal (`link_saves`) is the audit trail for
the first two.

## Follow-up and next iteration

`kite run eval:picker` is deferred: the `config/tool-picker.json` change needs it by hand, but
this sandbox has no `OPENROUTER_API_KEY`, so no result is claimed. Run it before release. After
release, audit a few real saves in `link_saves` and tune `links.apply` in config if the unsure
rate is too high or too low. A generic `mcp_write` to Reader still bypasses the route journal;
the picker examples, the coordinator prompt and the `mcp` domain guidance steer a shared link
through `link_save`, and a later iteration could refuse a Reader save for a link the owner
shared in the same turn.
