# 119 — Why did Chief send the same reply twice?

Work date(s): 2026-10-23. Written/revised: 2026-10-23.
Status: tested, in review. Text that a model writes beside a lone `finish_turn` call is no longer also sent as a progress message. Not released.

## User-visible problem and preceding iteration

On 23 October the owner asked Chief to add a dinner to the calendar, then forwarded the invitation message a fraction of a second later. Chief asked one clarifying question, about the time and place, but Telegram showed it twice, 0.6 seconds apart.

The foreground loop in `src/custom-agent.ts` sends any text a model writes beside tool calls as a progress message, before it runs the calls. This is how a model narrates work such as "I'm checking the saved roles" while a lookup runs. `finish_turn`'s required `reply` is then delivered as the answer. Earlier models that used `finish_turn` left the text field empty. Opus 5.5 ([journal 100](100-opus-main-model-and-caching.md)) sometimes writes the reply in both places.

## Evidence

- **Measured, private records, 23 October (read-only).**
  - The two owner messages arrived 0.25 s apart. They were handled by one run: the second was folded into it as a steering input before the model call. So the duplicate is not two turns answering the same request.
  - That run made one model call (Opus 5.5) and one tool call, `finish_turn` with reason `awaiting_user`.
  - `telegram.delivered` recorded a `progress` delivery of 199 characters, followed 0.6 s later by an `answer` delivery of 199 characters, in the same thread.
- **Measured, frequency.** Over the 14 days to 23 October there were 44 answer deliveries and 14 progress deliveries. Only this run had a progress delivery with the same character count as its answer. The defect is rare so far, but it can recur on any turn where the model repeats its reply in the text field.
- **Code-confirmed.** `finish_turn`'s `reply` is required and must be non-empty (`src/answer.ts`), so dropping the accompanying text cannot lose a turn's only reply.

## Diagnosis and alternatives

When the only tool call is `finish_turn`, the text beside it is a draft or copy of the answer. It is not progress on work.

Alternatives considered:

- **Compare the text with the reply and skip only exact or near duplicates.** This keeps a short preamble such as "Sure" but adds fuzzy matching for little gain.
- **Merge the text into the reply.** This risks doubling the reply when they are the same.
- **Tell the model not to repeat itself.** This depends on the model, and the host can enforce the rule cheaply.

Chosen: when every call in a step is `finish_turn`, the text is not sent as progress. Steps with working calls behave as before.

## Implementation and review

- `src/custom-agent.ts`: progress is sent only when the step has at least one call other than `finish_turn`.
- `tests/steering-loop.test.ts`, two new tests:
  - text beside a lone `finish_turn` produces no progress, and the reply is delivered once;
  - text beside a working call is still sent as progress.
- With the guard removed, the first test fails (checked by hand).
- Design note: [Telegram views](../telegram-views.md).

Independent review: pending.

## Verification and outcome

- **Tested.**
  - steering-loop: 15/15.
  - custom-runtime: 29/29.
  - effort: 11/11.
  - steering-telegram: 13/13.
  - context-continuity: 33/33.
  - `tsc --noEmit` passes.
- **Not released.**
- **Pending live check.** After release, the weekly review should find no progress delivery with the same size as its run's answer.

## Follow-up and next iteration

A model could still write a different, longer narration beside a lone `finish_turn`, and that narration would now be dropped. If that matters, the next step is to fold distinct text into the reply rather than send it separately.
