# 119 — Why did Chief send the same reply twice?

Work date(s): 2026-10-23. Written/revised: 2026-10-23.
Status: tested, in review. Text that a model writes beside tool calls is no longer sent as a progress message when a `finish_turn` reply in the same step already contains it. Not released.

## User-visible problem and preceding iteration

On 23 October the owner asked Chief to add a dinner to the calendar, then forwarded the invitation message a fraction of a second later. Chief asked one clarifying question, about the time and place, but Telegram showed it twice, 0.6 seconds apart.

The foreground loop in `src/custom-agent.ts` sends any text a model writes beside tool calls as a progress message, before it runs the calls. This is how a model narrates work such as "I'm checking the saved roles" while a lookup runs. `finish_turn`'s required `reply` is then delivered as the answer. Earlier models that used `finish_turn` left the text field empty. Opus 5.5 ([journal 100](100-opus-main-model-and-caching.md)) sometimes writes the reply in both places.

## Evidence

- **Measured, private records, 23 October (read-only).**
  - The two owner messages arrived 0.25 s apart. They were handled by one run: the second was folded into it as a steering input before the model call. So the duplicate is not two turns answering the same request.
  - That run made one model call (Opus 5.5) and one tool call, `finish_turn` with reason `awaiting_user`.
  - `telegram.delivered` recorded a `progress` delivery of 199 characters, followed 0.6 s later by an `answer` delivery of 199 characters, in the same thread.
- **Measured, frequency.** Over the 14 days to 23 October there were 44 answer deliveries and 14 progress deliveries. Only this run had a progress delivery with the same character count as its answer. The defect is rare so far, but it can recur on any turn where the model repeats its reply in the text field.
- **Code-confirmed.** When `finish_turn` is accepted its `reply` is delivered (`src/answer.ts` requires it). Only text that the reply already contains, ignoring whitespace, is withheld, so text that differs from the reply still reaches the owner.

## Diagnosis and alternatives

When the only tool call is `finish_turn`, the text beside it is a draft or copy of the answer. It is not progress on work.

Alternatives considered:

- **Compare the text with the reply and skip only exact or near duplicates.** This keeps a short preamble such as "Sure" but adds fuzzy matching for little gain.
- **Merge the text into the reply.** This risks doubling the reply when they are the same.
- **Tell the model not to repeat itself.** This depends on the model, and the host can enforce the rule cheaply.

First version (reviewed at `4b23f9f`): skip progress when every call in a step is `finish_turn`. Review found it missed a step with a working call plus `finish_turn` repeating the text, and that it dropped text differing from the reply (for example a reply that only says "see my question above").

Chosen: skip progress only when a `finish_turn` reply in the same step contains the text, comparing with whitespace collapsed. Narration and any text the reply does not contain are still sent.

## Implementation and review

- `src/custom-agent.ts`: `repeatsFinishReply` checks whether a `finish_turn` reply in the step contains the text, and progress is skipped only then.
- `tests/steering-loop.test.ts`, four new tests:
  - text beside a lone `finish_turn` repeating its reply produces no progress, and the reply is delivered once;
  - the same text beside a working call and `finish_turn` produces no progress;
  - text beside a working call is still sent as progress;
  - text that differs from a lone `finish_turn` reply is still sent.
- With the guard removed, the two duplicate tests fail (checked by hand).
- Design note: [Telegram views](../telegram-views.md).

Independent review of `4b23f9f` (23 October, Opus 5.5): approve with nits. Findings: the mixed-step duplicate and the dropped differing text, both fixed as above; whitespace-only replies pass the schema (not changed here); and owner input arriving just after `finish_turn` is dispatched discards that answer without marking it undelivered (pre-existing, now a follow-up). The final guard was checked by the coordinator, not re-reviewed.

## Verification and outcome

- **Tested.**
  - steering-loop: 17/17.
  - custom-runtime: 29/29.
  - effort: 11/11.
  - steering-telegram: 13/13.
  - context-continuity: 33/33.
  - `tsc --noEmit` passes.
- **Not released.**
- **Pending live check.** After release, the weekly review should find no progress delivery with the same size as its run's answer.

## Follow-up and next iteration

- Text that only partly overlaps the reply (for example a reworded version) is still sent, so a near-duplicate can still appear twice.
- Owner input that arrives after `finish_turn` is dispatched drops that answer without marking it undelivered in the model's context (pre-existing; `src/custom-agent.ts`, the steer check before `finish`).
- `finish_turn` accepts a whitespace-only reply.
