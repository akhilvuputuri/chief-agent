# 102 — How does Chief keep phone replies short and free of internal IDs, whichever model runs?

Work date(s): 2026-10-20. Written/revised: 2026-10-20.
Status: in review. The reply instructions are sharper, and a host filter removes Chief's internal names and shortens long IDs in model-written answers and progress. Not yet measured in production.

## User-visible problem and preceding iteration

After the switch to Gemini 4 Argon on 14 October, replies became long and leaked internal details: tool names, record fields, revision numbers and hashes. The instructions already forbade exposing internal IDs and tool names, but the model did not follow them reliably. The owner switched the main model to Opus 5.5 ([journal 100](100-opus-main-model-and-caching.md)) and asked that reply quality not depend on the model.

## Evidence

- **Measured** (private conversation review, 5–17 October 2026; 43 replies):

  | Model          | Replies | Median length  | Long replies | Replies leaking internal identifiers |
  | -------------- | ------- | -------------- | ------------ | ------------------------------------ |
  | GPT-6.1 Sol    | 33      | 283 characters | 3            | 0                                    |
  | Gemini 4 Argon | 10      | 844 characters | 6            | 7                                    |

  Leaked examples were Chief's coding operation names, merge-workflow and head-commit field names, revision numbers and review hashes.

- **Hypothesis:** coding dominated the Argon period, so topic and model are confounded.
- **Also observed:** two replies over 2,000 characters, one repeating a sensitive booking identifier, and three that took up a one-off term of endearment.

## Diagnosis and alternatives

An instruction alone depends on how well a model follows it. A host-side filter on model-written text holds for every model. It must not damage real content, so it only changes Chief's own names and long identifiers.

Alternatives considered:

- **Stripping every snake_case word** would corrupt code discussions, for example a variable the owner asked about.
- **Deleting IDs outright** would leave broken sentences, and some IDs must be typed back, as in `/continue <id>`.
- **A model-switch reply-style eval** is still useful as a release gate. It needs paid calls, so it is deferred.

## Implementation and review

- `src/context.ts`: the reply instructions now say:
  - lead with the answer in the first sentence, and use one to three short sentences for simple requests;
  - describe actions in plain words, never by tool or field names, revision numbers, hashes, SHAs or full IDs, unless the owner asks to debug;
  - do not repeat sensitive identifiers;
  - do not take up a one-off nickname.
- `src/owner-text.ts` `tidyOwnerText`:
  - Chief's operation names (from the action schema) and a fixed list of internal fields become plain words. This applies in prose, or when they form a whole inline-code span.
  - Full UUIDs in prose shrink to their first 8 characters, and 40–64-character hex strings with a letter to 7.
  - Fenced and inline code, links, URLs, bare domains with a path, file paths, dotted or call-like names, decimal numbers, and an ID right after a slash command are delivered exactly.
  - The instructions tell the model to put exact values the owner asks for in inline code.
- Where it applies:
  - `src/telegram-views.ts` applies it to answer and progress replies, section titles and bodies, number labels and values, and source labels. Schedule deliveries, notices and direct Bot API senders are not filtered;
  - `src/telegram.ts` applies it to voice replies.
- Tests: `tests/owner-text.test.ts` and a delivery test in `tests/telegram-views.test.ts`.

Independent review (Opus 5.5, commit `08ea023`) requested changes. Three medium issues were confirmed:

- An internal name inside a longer inline-code span lost one backtick, so Telegram showed a stray backtick.
- IDs in inline-code or bracketed slash commands were shortened. `/continue` needs the full ID.
- Exact values the owner asked for were shortened with no way to avoid it. So were code identifiers and file paths in coding discussions.

The docs also overclaimed what was untouched. The rework keeps all inline code verbatim unless the whole span is an internal name. It also leaves paths, call-like names, decimal numbers, parenthesised links and bare domains alone, filters the remaining envelope labels, and corrects the docs. Generic field names such as `run_id` and `pr_url` are no longer rewritten.

## Verification and outcome

Tested locally. Pending:

- review, CI and the release;
- a post-release read of reply lengths and leaks over a week of owner turns on Opus 5.5.

That read will separate the two effects. The pre-filter text is in history, so it shows the instruction's effect. The delivered text, also recorded as `telegram.delivered.characters`, shows the filter's effect. Opus may leak less than Argon to begin with, so the "any model" claim stays untested until a different model runs.

Expected: fewer leaks. That is a hypothesis; the filter's effect is directly testable, while length still depends on the model.

## Follow-up and next iteration

- A reply-style eval, run before any future model switch.
- Long artefacts such as analyses or draft issues could go to a canvas with a short reply.
