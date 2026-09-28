# Context recall eval

This eval measures whether Chief's context pipeline gives the model what it needs in one long rolling chat, especially after topic switches. It is a manual eval and is not a CI gate.

## How it works

`replay.ts` loads each synthetic conversation in `fixtures/` into an in-memory PGlite database. It stores each turn the way a completed run would: journaled tool calls, projected tool results with observation IDs, and conversation history rows. Each probe is then sent as the next owner message through the real `Assistant` pipeline, which covers history loading, the excerpt archive, context selection and tool-domain selection.

`run.py` runs the replay and scores each probe. Results go to `eval-results/context-<mode>-<time>/`, which is ignored by git.

## Modes

- `npm run eval:context` is **context mode** and costs nothing. It captures the first model call's input and checks whether every evidence string is visible in it.
- `npm run eval:context -- --mode answer` is **answer mode** and is paid. The configured model (default `openai/gpt-6-sol`) answers with the real runtime, including `conversation_search`, `conversation_read` and `observation_read`. A reply is correct when it matches an `accept` pattern and no `reject` pattern. A `reject` pattern encodes a known confusion, such as the other wedding's time. Expect roughly $0.02–0.05 per probe.
- `--probe <id>` runs a single probe. `--fixtures <dir>` uses other fixtures. Answer mode reads `OPENROUTER_API_KEY` from the environment or from `--env-file`.

## Slices

| Slice         | Where the answer is                                                                |
| ------------- | ---------------------------------------------------------------------------------- |
| `previous`    | In the immediately previous exchange. The probe is an elliptical follow-up.        |
| `gap`         | 2–6 turns back.                                                                    |
| `distant`     | 12 or more turns back.                                                             |
| `tool-detail` | Only inside an earlier tool result.                                                |
| `switch`      | The probe starts a new topic. The previous exchange holds a tempting wrong answer. |
| `same-word`   | An ambiguous term is shared by two topics.                                         |

## Limits

- **Synthetic fixtures.** The conversations were written for this eval, not taken from real traffic. Two of them are rewritten, fictional versions of the 11 and 13 September incidents. `{"$fill": n}` expands to neutral filler, so results reach realistic sizes.
- **Smaller fixed prompt than production.** The eval has no skill catalogue, alignment scopes, approvals or production memories, and it uses a fixed set of synthetic memories. Compare arms against each other, not against production numbers.
- **No Jev picker.** Tool domains come from the deterministic cues.
- **Integrations are off.** Gmail, calendar, parcels, library and stocks are unavailable, so the model must recall from the conversation (history, `conversation_search`, `observation_read`) and cannot re-fetch. Job and list tools read an empty database. In production, re-running a live tool is another way to recover a detail.
- **One run is a smoke baseline.** Repeat answer-mode runs before comparing context strategies.
