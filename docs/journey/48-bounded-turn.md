# 48 — Stopping one long task from growing without bound

Work date(s): 2026-09-30. Written/revised: 2026-09-30.
Status: released at `1c0e480` on 30 September 2026. Tested on synthetic tasks; the production effect is not measured.

## User-visible problem and preceding iteration

Issue #77 opened after a mailbox lookup failed on 22 September after 21 tool calls in one message. Most of the 127,058-character request was work done earlier in that same message (43,291 characters), not older chat history. PR #79 raised the hard limit to 400,000 characters as a stopgap. [Journal 41](41-exchange-index.md) bounded the previous exchange and older history, but not the current turn.

Past 120,000 characters each earlier call of the current turn became an excerpt, yet every call was kept. Each call still added about 2,600 characters, so a long enough task only reached the failure later.

## Evidence

Tested on synthetic mailbox tasks: a fixed part of 67,736 characters as in the incident, and each call returning a projected result of about 12,000 characters with an observation ID. These are offline character counts from `context()`, not provider runs.

| Calls | Before: serialized characters | After: serialized characters | Calls kept |
| ----: | ----------------------------: | ---------------------------: | ---------: |
|    21 |                       124,445 |                       94,060 |          5 |
|    40 |                       173,294 |                      102,191 |          8 |
|    80 |                       276,134 |                      103,232 |          8 |
|   160 |           failed (hard limit) |                      105,466 |          8 |

## Diagnosis and alternatives

- **Chosen:** keep the newest complete call groups that fit under the 120,000 threshold, and list older ones in a code-built digest with their read IDs. Groups leave in blocks of 8 so the kept prompt stays the same across several calls, which keeps the provider cache matching it. This matches what the compaction research found in the other runtimes: clear old tool output first, and keep pointers back to the originals.
- **Rejected for now:** a model-written summary of the dropped calls. It costs a model call, can invent facts, and the digest plus `observation_read` already restores exact detail.
- **Rejected for now:** counting limits in tokens. Provider capacity is far above the character threshold, so a token estimate would not change any decision today. `model.completed` records actual prompt tokens if that changes.

## Implementation and review

- `src/context.ts`: after excerpting, if the request still reaches 120,000 characters, the oldest call groups of the current turn are dropped in blocks of 8. The allowance keeps 9,000 characters for the digest and 4,000 for escaping. Only call groups leave: the owner's message, owner input sent during the task, text-only replies, the previous exchange and the latest group stay. `trimmed` is returned and traced.
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
- Independent review (Opus 5.5, first revision) requested changes:
  - **Major:** owner input steered into a long task was a one-message group and could be trimmed without appearing in the digest. Fixed: only call groups leave, with a regression test that steers after call 4 of 60.
  - The digest's header was outside its cap, and the fixed-part estimate ignores escaping, so the wire pass could still excerpt the latest group. Fixed with a cap that includes the header, a 4,000-character margin and a `wireCompacted === false` assertion.
  - The header named the wrong argument for `observation_read`, which takes `id`. Fixed; `approvalId` is now listed, and the header says receipt and approval IDs are proofs, not read IDs.
  - Devin, on the approved head `97a2412`: when many calls left, the digest's cap dropped the oldest read IDs, and a failed call kept only the word "failed", not its error. Fixed: the newest 8 calls keep full lines with the error message; older ones keep short lines with their read IDs, and the digest grows to 9,000 characters. A test at the 100-call run budget checks that every call's read ID is still in the prompt.
  - Re-reading many dropped results can push earlier reads out in turn. The header now asks the model to record findings before reading many results again. This is not measured; see follow-up.

## Verification and outcome

Tested only. No provider run or production trace yet. After release, check `trimmedGroups` and `serializedChars` in the operational log on a real long task. Also check whether the model reads dropped results with `observation_read` rather than repeating calls.

### Release closure — 2026-09-30

- **Merged:** [PR #122](https://github.com/akhilvuputuri/chief-agent/pull/122) at head `3fe8f07`, merge commit `1c0e480`.
- **Reviewed:** Opus 5.5 approved the code at `ee24827`. What followed was a docs clarification and a merge of main, which touched only the journal index.
- **CI:** Devin's findings were resolved and main CI passed.
- **Deployed:** the automatic release reported "Exact commit deployed; startup health passed".
- **Scope:** app-only; no migration or Compose change.
- **Issue:** #77 closed with a summary of all its stages.

## Follow-up and next iteration

- **Read churn is not measured.** A task that aggregates many dropped results can read them back, and those reads leave in turn. The only guard is the header's instruction to record findings first. If production shows repeated `observation_read` of the same ID in one run, mark re-read lines in the digest or keep re-read pages longer.
- **No provider run yet.** The before/after numbers are offline character counts.
- Per-layer budgets and a background summary (stages 1 and 4 in [context management](../context-management.md)) remain optional and unrequested.
