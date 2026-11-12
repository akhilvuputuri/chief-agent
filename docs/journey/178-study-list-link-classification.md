# 178 — Shared links: study list or Reader

Work date(s): 2026-11-12. Written/revised: 2026-11-12.
Status: in progress. Implemented and tested offline on a branch from `1c55cf18`; independent review, merge, the migration 036 operator rollout and the hand-run picker eval are pending.

## User-visible problem and preceding iteration

Reported by the owner: when they shared a link and said "save this", Chief saved it to Reader, even for material they wanted to study (an X thread on agent architectures, a tutorial, a repository). Reader is for offline reading; study material had nowhere of its own. Chief should decide where a link belongs, ask only when it is really unsure (with buttons, not an open question), and keep study material in its own durable list.

Builds on [67 — Remote MCP connectors](67-mcp-connectors.md) and [69 — Shared link resolution](69-link-resolution.md) (the Reader `save_link` path) and on the Jev clients from [37 — Jev tool picker](37-jev-tool-picker.md). The owner's review of an earlier attempt (PR #428) added requirements this build had from the start: the Reader request key must match the exact payload sent, a stored rejection must not block later attempts, a tap that fails part-way must say what may have been saved, the picker eval must route "Save this article to Reader for offline reading" through classification, and the Both route needs failure tests with a Reader mock that behaves like `src/mcp.ts`.

## Evidence

- **Verified in source:** Jev is `typesafe/jev-1.13-20260917` in `config/tool-picker.json`, `config/decisions.json` and `config/reasoning-effort.json`; `config/runtime.json` sets `SHADOW_DECISIONS` and `EFFORT_PICKER` to `jev`. The classifier reads the id through `readDecisionConfig()` and adds none (`grep jev-1.13 config` still shows those three files only).
- **Verified in source:** `checkReplay` in `src/mcp.ts` refuses a different payload under a stored key, a `rejected` key returns `rejected` forever, and `pendingAllows` refuses every other write while any operation is pending.
- **Tested:** `tests/links.test.ts` (34 tests, PGlite, mocked Jev transport, the real `McpTools` over a fake Reader server that also remembers keys and refuses another URL under one), plus the domain tests in `tests/tool-domains.test.ts`. Run locally on 12 November 2026; all passed, again after the review fixes below.
- **Not run:** `kite run eval:picker`. Neither this sandbox nor the review-fix sandbox had an `OPENROUTER_API_KEY` (the runner printed "OPENROUTER_API_KEY is not set in the environment or .env." both times). It must be run by hand before merge and its recall and cost recorded here.
- **Deferred:** a measurement of classification quality on real links; a canvas or Mini App view.

## Diagnosis and alternatives

Reader was the only save destination Chief knew, and the `mcp` domain's cue matched "save … link", so a shared link went to `mcp_write save_link` by default.

The owner decided (binding) that the classification is model judgment, set up as a Chief skill and/or a small sub-agent, on Jev, with the lightest host safety that works. Chosen: a host tool (`link_save`) that reads the page and asks Jev two `choice` questions, plus the link-saving skill as `links` domain guidance (mirrored as the `core/link-saving` plugin skill). Not chosen: a separate plugin agent with its own model loop. The Jev decision call is already the "small sub-agent" and is cheaper and faster. Also not chosen: a keyword classifier, which the owner ruled out. The domain `CUES` regex only selects which tools are offered.

Explicit owner cues are applied by Chief (it sets `destination`) and seen by Jev in `owner_message`. A host-side cue parser would be a keyword rule.

## Implementation and review

- `src/link-classifier.ts`, `config/links.json`: Jev client and questions. No model field; the threshold `confident` is 0.75.
- `src/link-url.ts`: the canonical URL, also used by the tool schema to refuse an unusable link before dispatch.
- `src/links.ts`, `src/links-schema.ts`: page facts, `link_save`, `link_move`, `study_list`, `study_update`, `study_remove`, `readerSave` key rules, `applyChoice`, and the link-specific exceptions at the agent write boundary (`retriesPending`, `retriesUncertain`).
- `db/036_study_resources.sql`: `study_resources`, `link_choices` and `link_reader_keys`, with its Compose line, `scripts/deploy-study-list.py` and its test. The gateway offers the tools only once migration 36 is recorded.
- `src/telegram.ts`: the `lk:` tap handler and `sendLinkChoices` (interactive and background delivery). `src/news-feed.ts`: `pageMeta`.
- `src/tool-domains.ts`, `src/runtime.ts`, `src/context.ts`, `config/tool-picker.json`, `evals/picker`: a new `links` domain after `mcp`; the `mcp` description and examples now cover briefs and submission status only. Scenario `mcp-reader-save` became `links-reader-save` (gold `links`), and five `links` scenarios were added. The request goldens did not change, because their domain lists do not include `mcp` or `links`.
- Plugin skill: `core/link-saving` is in the skill catalogue for Chief (`skill_read`), and the same text drives the domain guidance. The core package hash in `plugins/registry.json` was updated.

Design details: [links](../links.md).

Independent review of the first candidate (reported, REQUEST CHANGES). Fixed in this branch:

- **[blocking]** An `http://` or non-public link reached `canonicalUrl` after dispatch and failed as `TOOL_FAILED`, so the call became uncertain and blocked every later write. Now a plain `http` link is upgraded to `https`, and anything else that is not a public hostname is refused by the `link_save`/`link_move` schema as `INVALID_INPUT` before dispatch. Tested through `Assistant` and `CustomAgent`: the bad save fails, and the next write runs.
- **[important]** A redirected link (twitter.com to x.com) with a pending Reader save was refused at the agent boundary on "save it again", because the pending payload had the redirected URL. Every canonical form of the link is now mapped to its key in `link_reader_keys` before the send, and `retriesPending`, `earlierReaderSave` and `settleUncertain` match through it. Tested, including a retry when the page can't be read the second time.
- **[important]** Interests came only from a `learning_interests` memory that nothing creates. The guidance now tells Chief to pass the owner's interests from whichever explicit memory holds them, and when it passes none, the host reads active, owner-trusted fact memories whose key names learning, interests or study. With none, the topic stays null rather than being guessed. Tested.
- **[important]** Tapping Study list after a pending Reader tap hid the pending save. The reply now says what happened to it, an unconfirmed one keeps the card open, and a part-way failure names it. Tested.
- **[nit]** Settling an earlier uncertain save on the `needs_choice` path stays, with a comment: otherwise that save would keep blocking the owner's writes while they decide on the card.

The core package hash in `plugins/registry.json` was updated again for the skill text change. Re-review: pending.

## Verification and outcome

Tested offline. Classification routing (confident study, confident reading, explicit cues both ways, unsure on low confidence, timeout and malformed answer giving three buttons and never Reader), store operations (duplicate detection across tracking parameters, filters, updates, removal, owner isolation, the status check, a null title when the page is unreadable), corrections (study to Reader only after Reader confirms, kept on pending or rejected, Reader to study), items 8 to 10, the Both route (both succeed, Reader rejects, the study insert fails), a concurrent double tap, the Telegram handler keeping its buttons on a result that is not final, card delivery (one send, a refused send retried, an interrupted send kept as uncertain), and the agent write boundary (with a Reader save pending, another write is refused but a later save of the same link runs, reuses the key and settles it).

Not verified: real Jev answers on real links, the picker eval, and the production rollout.

Release note for the operator: this change adds migration 036, so it needs the reviewed operator procedure in [cloud development](../cloud-development.md) with `scripts/deploy-study-list.py`, after confirming its `BASE` against the live release. Never bypass the release guard.

## Follow-up and next iteration

- Run `kite run eval:picker` by hand and record pooled recall and cost here.
- After release: share a few real links (an X thread, a tutorial, a news story, one borderline) and check where they went, the one-line reply, and the buttons.
- A small labelled eval for the link classifier, so the 0.75 bar can be tuned on evidence.
- The owner adds the current-work and release notes after merging.
