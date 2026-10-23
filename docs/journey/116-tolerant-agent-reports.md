# 116 — Can web and research agents report what they found instead of failing their own report checks?

Work date(s): 2026-10-23. Written/revised: 2026-10-23.
Status: in review. Quote checks for findings agents and public research now tolerate whitespace, quote-mark and dash differences and `...` omissions. Short refs are accepted when they appear as a whole value in a tool result or the brief. A child's last model call offers only its report tool. A rejected or cut-short report returns its checked part as `partial` instead of nothing. Tested with mocked models only. Independent review: pending. Not released and not measured in production.

## User-visible problem and preceding iteration

The coordinator delegates web lookups and public research to child agents ([agents](../agents.md), [research specialist](../research-specialist.md)). Each child must finish with a report whose quotes, observation links and refs the host checks, so that a report cannot cite an invented ID or quote. The checks rejected valid reports, each rejection used one of the child's few model calls (the web agent has 6), and the child often ran out of calls without ever reporting. The coordinator then received `incomplete` with nothing from the work, even when the child had read the right page.

## Evidence

- **Reported, production, private reviews of 5–17 October and 14–21 October 2026.** These are aggregates from the owner's private trace reviews; no trace content is copied here.
  - First review: all 3 web-agent runs ended `budget_exhausted`; 8 report rejections were spread across 7 of 21 child runs.
  - Second review: 5 of 5 web-agent runs ended `budget_exhausted`, with 6 report validation failures. On 21 October there were 4 more failed `agent_report` calls.
  - Which check failed in each case was not broken down in the reviews. The split between quote, ref and observation failures is unknown.
- **Code-confirmed (before this change).**
  - `checkReport` in `src/agents.ts` refused every ref shorter than 8 characters, so real 6- or 7-digit record IDs failed as "not found".
  - `checkResearchQuote` in `src/research.ts` required an exact substring. A quote with straight instead of curly quotes, single instead of repeated or no-break spaces, a hyphen for an en dash, or an ellipsis for omitted words failed.
  - Rejections stopped at the first failing item and returned `retryable: false`, so a child could fix one problem per model call.
  - A child got no warning before its last model call, and nothing it had found survived a missing report.
- **Hypothesis.** These causes explain most of the rejections and budget exhaustion. That is plausible from the code but not established: the reviews did not attribute each failure to a cause.

## Diagnosis and alternatives

The checks protect one guarantee: what reaches the coordinator as a quote or ref was in something the child actually saw. The failures came from checking more than that guarantee needs (exact typography, a blanket length floor) and from losing the work when a check failed.

Chosen mechanism:

1. **Tolerant quote matching** (`src/quote-match.ts`). Normalise whitespace, quote marks, dashes and zero-width characters in both source and quote. Treat `...`, `…` and `[...]` as gaps: each piece must occur in the same source, in order. Pieces need at least 8 characters and there can be at most 4, so a quote cannot be assembled from common fragments. Case and wording still have to match. The host maps the match back to the source and passes on the source's own words, so downstream text is verbatim.
2. **Whole-value refs.** Refs of 8 or more characters keep the old substring check. Shorter refs must appear as a whole value in a tool result or the brief: not inside a longer number or word, and not as part of a decimal or grouped number. Refs under 3 characters are refused. JSON keys are not values, so a ref such as `status` does not pass because a result had that key.
3. **Complete, retryable rejections.** One rejection lists every failing item, says how to fix each, and is `VALIDATION_FAILED` with `retryable: true`.
4. **Reserve the end for reporting** (`budgetNotice` in `src/custom-agent.ts`). One call before the last, the child is told to report now. On the last call, or when tools or time could not cover another round, only the report tool is offered.
5. **Salvage instead of nothing.** A rejected report keeps only what passed (failing quotes, `sourceId`s, `observationId`s and refs removed). If the child then stops by answering or running out, that becomes `status: "partial"` with `partialReason`. A report accepted just before the allocation ran out is also kept as `partial`. With no report at all, the result stays `incomplete` but lists the child's successful calls as `observations`.

Alternatives considered:

- **Raise the web agent's model limit.** This changes a plugin allocation, which AGENTS.md says to keep unless asked. It also would not fix rejections of valid quotes and refs.
- **Drop the ref check for short refs, or case-insensitive or fuzzy quote matching.** Rejected: these weaken the invented-ID and invented-quote guarantee. Edit-distance matching would accept altered numbers ("9am" for "8am").
- **Loosen job alignment and media too.** Not done. Job-alignment quotes flow into the preparation chain and Sheet, which re-check them exactly (`src/preparation-chain.ts`), so a tolerant match there would be refused later. Media quotes are stored and reused. Both keep exact matching and their all-or-nothing results. Media is the most likely place for whitespace differences from PDF extraction; see follow-up.
- **Synthesize a summary from observations when there is no report.** Rejected: the host would be writing claims the agent never made. The coordinator gets pointers instead.

What would change the conclusion: production traces showing rejections dominated by a different cause (for example, unread `sourceId`s or wrong target sets), or children still exhausting their allocation after the last-call restriction.

## Implementation and review

- `src/quote-match.ts`: `normalizeForQuote`, `matchQuote`, `containsToken`.
- `src/research.ts`: `checkResearchQuote` takes `{ tolerant }` and returns the matched `quote`. Its messages say whether the source was not read or the quote was not found. Public-research reports collect every problem and salvage a partial result. Profiles (job alignment, media) are unchanged and exact.
- `src/agents.ts`: `checkReport` returns the checked report and all problems. `runFindingsAgent` adds `partialReason` and `observations` and applies the salvage rules. The findings contract tells children to use `...` for omitted words.
- `src/custom-agent.ts`: `budgetNotice`, and the offered-tool restriction on a child's last call. Dispatch still accepts any enabled tool, so a model that ignores the restriction is not refused.
- `src/tool-errors.ts`: `ReportRejectedError` gives `VALIDATION_FAILED` with `retryable: true`.
- `src/ops-log.ts`: `agent.budget_notice` is projected with `state` set to `warning` or `final`.
- `src/context.ts`: the coordinator is told that `partial`, `blocked` and `incomplete` are not complete, and what `partialReason` means.
- `src/execution.ts`: `limits` is readable, for the time threshold.
- Design docs: [agents: report checks](../agents.md#report-checks) and [research specialist: partial results](../research-specialist.md#partial-results).

Independent review: pending.

## Verification and outcome

**Tested (mocked models, PGlite), 23 October 2026:**

- `tests/quote-match.test.ts`, new:
  - curly and straight quotes, en and em dashes, repeated and no-break spaces, and zero-width characters match, and the source's words are returned;
  - ellipsis pieces match in order, and out-of-order or short-piece collages are refused;
  - fabricated, altered-number and case-changed quotes are refused;
  - whole-value refs: `1234567` is refused inside `91234567`, `12345678` or `1234567.5`;
  - `budgetNotice` thresholds.
- `tests/agents.test.ts`, 3 new tests on the core web agent:
  - a short numeric ref seen in `web_read` is accepted, and one never seen is named and refused. A prefix of a longer number and a 2-character ref are refused. Typographic and elided quotes are accepted and returned verbatim, and a fabricated quote is named. One corrected report then passes.
  - A rejected report followed by running out of calls returns `partial` with the checked finding, without the failed quote, and with only the seen ref. The child gets the warning at call 5, and its call 6 is offered only `agent_report`.
  - A child that never reports returns `incomplete` with its 6 calls in `observations`.
- `tests/research.test.ts`, 1 new test: public research accepts an elided, whitespace-variant quote and returns the source's words. A rejected report followed by running out of calls returns `partial` with the checked evidence. The exact (job alignment and media) mode still refuses the same variant, and a source read in another run does not ground a quote.
- Existing `agents` (9), `research` (6), `alignment` (5), `media` (6), `plugins` (8), `steering-loop` (13) and `ops-log` (16) tests pass unchanged. That includes the alignment assertion that an invented identity quote is refused.
- `npx tsc --noEmit -p .` passes.

**Not measured.** Whether production rejections and `budget_exhausted` endings fall. Whether models follow the last-call restriction. How often salvaged reports reach the owner, and whether they help.

## Follow-up and next iteration

- After release, compare `agent.completed` states (`partial` versus `incomplete`) and `stopReason` for `agentType: web` with the two reviews above. Also count `agent.budget_notice` `final` events and failed `agent_report` calls over a comparable window.
- If rejections remain, break them down by message prefix (`finding N: …is not in source`, `refs … not found`, `is not a source you read`) to find the next cause.
- Media quotes from PDF text may need the same whitespace tolerance. The coordinator would need the stored extraction re-keyed on the verbatim span. Deferred until media rejections are measured.
- Remaining hypothesis: the 8-character piece minimum and the 3-character ref floor are judgement calls, not measured values.
