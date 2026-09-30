# 47 — Stopping one long task from growing without bound

Work date(s): 2026-09-30. Written/revised: 2026-09-30.
Status: in review. Tested on synthetic tasks; the production effect is not measured.

## User-visible problem and preceding iteration

Issue #77 opened after a mailbox lookup failed on 22 September after 21 tool calls in one message. Most of the 127,058-character request was work done earlier in that same message (43,291 characters), not older chat history. PR #79 raised the hard limit to 400,000 characters as a stopgap. [Journal 41](41-exchange-index.md) bounded the previous exchange and older history, but not the current turn.

Past 120,000 characters each earlier call of the current turn became an excerpt, yet every call was kept. Each call still added about 2,600 characters, so a long enough task only reached the failure later.

## Evidence

Tested on synthetic mailbox tasks: a fixed part of 67,736 characters as in the incident, and each call returning a projected result of about 12,000 characters with an observation ID. These are offline character counts from `context()`, not provider runs.

| Calls | Before: serialized characters | After: serialized characters | Calls kept |
| ----: | ----------------------------: | ---------------------------: | ---------: |
|    21 |                       124,445 |                      114,019 |         13 |
|    40 |                       173,294 |                      103,089 |          8 |
|    80 |                       276,134 |                      106,290 |          8 |
|   160 |           failed (hard limit) |                      107,508 |          8 |

## Diagnosis and alternatives

- **Chosen:** keep the newest complete call groups that fit under the 120,000 threshold, and list older ones in a code-built digest with their read IDs. Groups leave in blocks of 8 so the kept prompt stays the same across several calls, which keeps the provider cache matching it. This matches what the compaction research found in the other runtimes: clear old tool output first, and keep pointers back to the originals.
- **Rejected for now:** a model-written summary of the dropped calls. It costs a model call, can invent facts, and the digest plus `observation_read` already restores exact detail.
- **Rejected for now:** counting limits in tokens. Provider capacity is far above the character threshold, so a token estimate would not change any decision today. `model.completed` records actual prompt tokens if that changes.

## Implementation and review

- `src/context.ts`: after excerpting, if the request still reaches 120,000 characters, the oldest groups of the current turn are dropped in blocks of 8, keeping 6,000 characters for the digest. The latest group, the owner's message and the previous exchange are never removed. `trimmed` is returned and traced.
- `src/context-continuity.ts`: `turnDigest` writes one line per dropped call with the step, tool name, the start of its arguments, any read IDs and a failure mark, keeping the newest lines within its cap.
- `src/custom-agent.ts` and `src/ops-log.ts`: `context.selected` carries `trimmed`, logged as `trimmedGroups`.
- Tests in `tests/context-continuity.test.ts`:
  - 21, 40, 80 and 160 calls stay under 135,000 characters, and the 160-call size stays within 15,000 of the 21-call size;
  - every call in the prompt keeps exactly its result, and the newest call is unchanged;
  - the digest names the last dropped read ID, and the question and previous exchange stay;
  - trimming moves in steps of 8;
  - a short task is unchanged;
  - the digest's cap and failure marks work.
- An earlier test expected an oversized earlier call in the current turn to fail the request. It now expects that call to leave through the digest, since the original is in the journal.

## Verification and outcome

Tested only. No provider run or production trace yet. After release, check `trimmedGroups` and `serializedChars` in the operational log on a real long task. Also check whether the model reads dropped results with `observation_read` rather than repeating calls.

## Follow-up and next iteration

Per-layer budgets and a background summary (stages 1 and 4 in [context management](../context-management.md)) remain optional and unrequested.
