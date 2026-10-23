# 116 — Can web and research agents report what they found instead of failing their own report checks?

Work date(s): 2026-10-23. Written/revised: 2026-10-23.
Status: released in `a39f8eb` (PR 313, version 0.3.100) on 23 October 2026; live acceptance pending. Changes:

- Quote checks for findings agents and public research tolerate whitespace, quote-mark and dash differences and `...` omissions. Matches are word-bounded. Short elided spans come back whole, and long ones are refused.
- Short refs are accepted when they appear as a whole token inside a value in a tool result, or in the brief.
- A child's last model call offers and dispatches only its report tool.
- A rejected or cut-short report returns its checked part as `partial`, with unsupported items marked, instead of nothing.

Tested with mocked models only. The first independent review (23 October, on `ac4622c`) requested changes, which were fixed in `8865161`. The delta review of `8865161` approved with nits, fixed in `9573b37`. The second delta review approved `9573b37`; its three nits are fixed in the final commit. No further review is pending, apart from the coordinator's check of that commit. Not measured in production.

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

1. **Tolerant quote matching** (`src/quote-match.ts`). Normalise whitespace, quote marks, dashes and zero-width characters in both source and quote. The resulting guarantees:
   - Every returned character comes from the one cited source.
   - A match, or each piece of an elided one, starts and ends on a word boundary in scripts written with spaces. An apostrophe or hyphen between letters, or a "." or "," between digits, does not end a word: "they can" is refused out of "they can't", and "5 million" out of "1.5 million". The cost is that "The firm" cannot be quoted out of "The firm's".
   - `...`, `…` and `[...]` mark gaps. There are at most 4 pieces of at least 8 characters each.
   - The host takes the shortest source span from the first piece to the last. A span of at most 300 characters (the quote limit) is returned whole, so an omitted "not" is visible to the coordinator. Spans of 301–600 characters are returned elided, as the source's pieces joined with `…`. They are refused when the omitted text contains not, no, never, cannot, `n't`, none, nothing, nobody, neither, nor, nowhere, only, except, excluding, unless or without. Spans over 600 characters are refused. Qualifiers outside that list, such as "rarely", can still be omitted in the 301–600 band.
   - Matching is otherwise character-exact, including case.
2. **Whole-token refs.** Refs of 8 or more characters keep the old substring check. Shorter refs must appear as a whole token inside a string or number value of a tool result, or in the brief. They may not sit inside a longer number or word, or form part of a decimal or grouped number. A JSON key is not a value, so a short number that only keys an object does not pass. Refs under 3 characters are refused.
3. **Complete, retryable rejections.** One rejection lists every failing item, says how to fix each, and is `VALIDATION_FAILED` with `retryable: true`.
4. **Reserve the end for reporting** (`budgetNotice` in `src/custom-agent.ts`). This applies to every child with a report tool, including the media and job-alignment specialists, whose quote checks are unchanged. One call before the last, the child is told to report now. On the last call, or when tools or time could not cover another round, only the report tool is offered and dispatched.
5. **Salvage instead of nothing.** From a rejected report the host removes every failing quote, `sourceId`, `observationId` and ref. Each finding's text and the summary are kept, and those are the agent's unverified reading. A finding or research target that lost support is marked, for example `unsupported: ["quote"]` or `["evidence 2"]`. If the child then stops by answering or running out, that becomes `status: "partial"`, with a `partialReason` that lists every failing item. A report accepted just before the allocation ran out is also kept as `partial`. With no report at all, the result stays `incomplete` but lists the child's successful calls as `observations`.

Alternatives considered:

- **Raise the web agent's model limit.** This changes a plugin allocation, which AGENTS.md says to keep unless asked. It also would not fix rejections of valid quotes and refs.
- **Require a digit in short refs that do not come from the brief.** Not done: tickers and codes such as `AAPL` are legitimate short refs, and a word-only ref that appears as a token was still seen by the child.
- **Drop the ref check for short refs, or case-insensitive or fuzzy quote matching.** Rejected: these weaken the invented-ID and invented-quote guarantee. Edit-distance matching would accept altered numbers ("9am" for "8am").
- **Loosen job alignment and media too.** Not done. Job-alignment quotes flow into the preparation chain and Sheet, which re-check them exactly (`src/preparation-chain.ts`), so a tolerant match there would be refused later. Media quotes are stored and reused. Both keep exact matching and their all-or-nothing results. Media is the most likely place for whitespace differences from PDF extraction; see follow-up.
- **Synthesize a summary from observations when there is no report.** Rejected: the host would be writing claims the agent never made. The coordinator gets pointers instead.

What would change the conclusion: production traces showing rejections dominated by a different cause (for example, unread `sourceId`s or wrong target sets), or children still exhausting their allocation after the last-call restriction.

## Implementation and review

- `src/quote-match.ts`: `normalizeForQuote`, `matchQuote`, `containsToken`.
- `src/research.ts`: `checkResearchQuote` takes `{ tolerant }` and returns the matched `quote`. Its messages say whether the source was not read or the quote was not found. Public-research reports collect every problem and salvage a partial result. Profiles (job alignment, media) are unchanged and exact.
- `src/agents.ts`: `checkReport` returns the checked report, all problems and a compact list of failures, and marks unsupported findings. `runFindingsAgent` adds `partialReason` and `observations` and applies the salvage rules. The findings contract tells children to use `...` for omitted words.
- `src/custom-agent.ts`: `budgetNotice`, and the last-call restriction. The call offers only the report tool, and any other tool call from that step is refused without dispatch, before it can use a tool unit.
- `src/tool-errors.ts`: `ReportRejectedError` gives `VALIDATION_FAILED` with `retryable: true`.
- `src/ops-log.ts`: `agent.budget_notice` is projected with `state` set to `warning` or `final`.
- `src/context.ts`: the coordinator is told that `partial`, `blocked` and `incomplete` are not complete, and what `partialReason` means.
- `src/execution.ts`: `limits` is readable, for the time threshold.
- Design docs: [agents: report checks](../agents.md#report-checks) and [research specialist: partial results](../research-specialist.md#partial-results).

Not changed: `work_evidence` (`src/work.ts`) still requires a contiguous, whitespace-normalised quote. An elided quote returned for a 301–600 character span cannot be reused as work evidence; shorter spans come back contiguous.

### Independent review

Independent reviewer, 23 October 2026, reviewing head `ac4622c`. Verdict: **REQUEST CHANGES**. Findings and fixes:

1. **Medium. Ellipsis pieces were not word-bounded.** "The firm said ... profitable this year" matched a source saying "unprofitable"; "alpha be...ta gamma" matched "alpha beta gamma". Fixed: every match and piece is word-bounded, including leading or trailing ellipsis excerpts and contiguous quotes.
2. **Medium. The span was unbounded.** A 4-piece quote matched across about 30k characters, and "The drug is ... effective in adults" passed against "The drug is not effective in adults" with the negation hidden. Fixed: the shortest span is used, a span of up to 300 characters is returned whole, 301–600 is returned elided, and a longer span is refused.
3. **Low-medium. Salvaged items were unmarked, and `partialReason` listed only 3 problems.** Fixed: `unsupported` markers, and every failure is listed.
4. **Low. Short refs were described as a "whole value"** although the check is a whole token inside a value, and no test covered a ref that appears only as a JSON key. Fixed: wording, plus the test. The digit requirement was declined; see alternatives.
5. **Low. The last call still dispatched tools that were not offered.** Fixed: they are refused. The docs now say media and job-alignment children get the notice too.
6. **Nit. `work_evidence` refuses elided quotes.** Documented above.
7. **Nit. Tests that survive mutations.** Tests added; the mutation results are below.
8. **Docs accuracy.** This entry and the design docs were corrected. `1234567.5` was listed as tested but was not; it is now tested.

Second review, the delta review of `8865161`, 23 October 2026. Verdict: **APPROVE WITH NITS**. Findings and fixes:

1. **Punctuation inside words counted as a word boundary.** "they can" matched out of "they can't", and likewise "toxic in rats" out of "non-toxic", "234 units" out of "1,234 units", "5 million" out of "1.5 million" and "99 per month" out of "$12.99". Fixed: one character of look-around on each side. A match may not start or end between digit `.`/`,` digit, or between letter `'` letter, or between letter and hyphen and letter. A hyphen is judged by the source's own character, so en and em dashes still separate words.
2. **The 301–600 band could still hide a negation.** Fixed: the band is refused when the omitted text contains a negating or limiting word. The message tells the child to quote the passage contiguously or shorten it.
3. **A lookup refused on the last call took a tool unit first.** That unit could be the one the report in the same step needed. Fixed: the refusal comes before tool consumption. It is a `ToolValidationError` with the neutral prefix "Not dispatched:".
4. **Performance.**
   - Sources are now read and normalised once per report check.
   - Normalisation builds its text with an array join.
   - `MAX_STARTS` is gone: the shortest-span search keeps one forward-moving cursor per piece, so it is one pass over the source.
5. **Docs.** This entry and the design docs were corrected, and plugins 8/8 was added to the tested list.

Third review, the second delta review of `9573b37`, 23 October 2026. Verdict: **APPROVE**. It raised three nits, all fixed in the final commit:

1. **`cannot` was not caught**, because `\bnot\b` misses it. The qualifier list now also has cannot, none, nothing, nobody, neither, nor, nowhere and excluding.
2. **A leading sign was not part of its number.** A `-` or `−` after a non-word character and before a digit now joins the number, judged by the source's own character. So "5% today" is refused out of "fell -5% today" or "−5%", while "5pm" can still be quoted out of "9am-5pm".
3. **The source cache depended on the call mode.** A call with a cache but without `tolerant` cached an empty normalised text. A cached source is now always prepared.

No further review is pending, apart from the coordinator's check of this final commit.

## Verification and outcome

**Tested (mocked models, PGlite), 23 October 2026:**

- `tests/quote-match.test.ts`, new, 7 tests:
  - curly and straight quotes, en and em dashes, repeated and no-break spaces, and zero-width characters match, and the source's words are returned;
  - a short elided span comes back whole, including an omitted "not";
  - a 301–600 character span comes back elided, a 30k-character collage is refused, and the shortest span is chosen;
  - the reviewer's word-split cases are refused, as are contiguous mid-word quotes, out-of-order pieces, short pieces and a fifth piece; an unspaced (Chinese) excerpt still matches;
  - fabricated, altered-number and case-changed quotes are refused;
  - whole-token refs: `1234567` is refused inside `91234567`, `12345678`, `1234567.5` and `id_1234567`;
  - `budgetNotice` thresholds.
- `tests/agents.test.ts`, 5 new tests on the core web agent:
  - a short numeric ref seen in `web_read` is accepted, and one never seen is named and refused. A prefix of a longer number and a 2-character ref are refused. Typographic and elided quotes are accepted and returned in the source's words, and a fabricated quote is named. One corrected report then passes.
  - A rejected report followed by running out of calls returns `partial`. The checked finding is kept; the failed one loses its quote and is marked `unsupported: ["quote"]`; only the seen ref is kept; and `partialReason` lists `finding 2 quote; refs "9999999"`. The child gets the warning at call 5. Its call 6 is offered only `agent_report`, and its `web_search` there is refused without dispatch.
  - A child that never reports returns `incomplete` with its 5 dispatched calls in `observations`; the sixth, asked for on its last call, was refused.
  - A short ref that appears only as a JSON key in a tool result is refused.
  - A time-based last call, using a faked clock through the agent loop: the final notice is given once across two last calls, a lookup there is refused, and the following report is accepted.
- `tests/research.test.ts`, 1 new test: public research accepts an elided, whitespace-variant quote and returns the whole short span in the source's words. A rejected report followed by running out of calls returns `partial`, with the checked evidence, `unsupported: ["evidence 2"]`, and every failure listed. The exact (job alignment and media) mode still refuses the same variant, and a source read in another run does not ground a quote.
- Delta-review tests:
  - in `tests/quote-match.test.ts`: the five reproduced punctuation cases, plus an elided one, are refused, while whole numbers, possessives with their "'s", and words beside en dashes match; a hidden "not" about 380 characters into a span and a hidden "only" about 350 characters in are refused; the refusal message asks for a contiguous quote; and a source is read once per check;
  - in `tests/agents.test.ts`: on the last call with one tool unit left, `[web_search, agent_report]` refuses the search and accepts the report.
- After the delta fixes: quote-match 10/10, agents 15/15, research 7/7, alignment 5/5, media 6/6, steering-loop 13/13, ops-log 16/16, delegation-accounting 3/3 and plugins 8/8. That includes the alignment assertion that an invented identity quote is refused. `npx tsc --noEmit -p .` and Prettier pass. Before the review, the full tsx suite passed on `c93c2a9`; it was not rerun after the fixes.
- Mutations: each of these was applied alone and failed at least one focused test:
  - removing the `MAX_QUOTE_PIECES` check;
  - removing the word-boundary check;
  - removing the span bound;
  - disabling the whole-span return;
  - removing the notice de-duplication;
  - removing the last-call dispatch refusal;
  - checking short refs against raw JSON instead of values.
- Final nits: `tests/quote-match.test.ts` adds a hidden "cannot" in the 301–600 band (refused), "5% today" out of "-5%" and "−5%" (refused), "5pm daily" out of "9am-5pm" (accepted), and an exact-mode cache entry serving a later tolerant check. Removing each of the three fixes on its own fails a test. After the nits: quote-match 10/10, agents 15/15 and research 7/7; tsc and Prettier pass.
- Delta mutations, each failing at least one focused test:
  - consuming a tool unit before the last-call refusal;
  - removing the punctuation look-around;
  - letting every dash join words;
  - removing the qualifier check.

**Not measured.** Whether production rejections and `budget_exhausted` endings fall. Whether models follow the last-call restriction. How often salvaged reports reach the owner, and whether they help.

### Post-merge findings — 23 October 2026

Released in `a39f8eb` (PR 313). Devin posted two findings on the final head that the merge did not wait for; both were fixed in a follow-up PR:

1. **Repeated occurrences.** Only the shortest span was checked for a hidden qualifier, so a valid, longer, clean occurrence elsewhere in the source was refused. The search now keeps the shortest _acceptable_ span. A new test fails on the released matcher.
2. **Latest observations.** An incomplete child returned its _earliest_ 12 successful calls, hiding its latest work when it made more than 12. It now returns the latest 12 in call order (`latestObservations`). A new test fails with the old ordering.

### Release closure — 2026-10-23

- **Merged.** [PR 313](https://github.com/akhilvuputuri/chief-agent/pull/313) as `a39f8eb684a77192b468b352496c524b5b3d5330`, version 0.3.100.
- **Review.** Independent review (Claude Opus 5.5) requested changes (meaning-inverting quotes reproduced), then approve with nits, then approve (40,000 fuzz cases against a brute-force reference). Devin posted two findings on the final head after its check passed and the merge did not wait; both were fixed in PR 317.
- **Release.** The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/39951629213) succeeded and `release:status` recorded the exact commit deployed with startup health passing at 12:18 UTC on 23 October. No migration. CloudWatch showed no warn or error lines from 08:42 to 15:42 UTC on 23 October.
- **Not yet observed.** Fewer web-agent `budget_exhausted` endings without a report, compared with the two October reviews.

## Follow-up and next iteration

- After release, compare `agent.completed` states (`partial` versus `incomplete`) and `stopReason` for `agentType: web` with the two reviews above. Also count `agent.budget_notice` `final` events and failed `agent_report` calls over a comparable window.
- If rejections remain, break them down by message prefix (`finding N: …is not in source`, `refs … not found`, `is not a source you read`) to find the next cause.
- Media quotes from PDF text may need the same whitespace tolerance. The coordinator would need the stored extraction re-keyed on the verbatim span. Deferred until media rejections are measured.
- Remaining hypothesis: these limits are judgement calls, not measured values: the 8-character piece minimum, the 300 and 600 character span limits, and the 3-character ref floor.
- Known limit: in scripts written without spaces, an elided piece can still start or end mid-word.
