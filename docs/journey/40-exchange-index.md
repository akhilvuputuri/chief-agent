# 40 — Pointing the model at what it cannot see

Work date(s): 2026-09-28. Written/revised: 2026-09-28.
Status: in review. The change is on a review branch; the production effect is not measured.

## User-visible problem and preceding iteration

[Journal 39](39-context-recall-eval.md) measured the current context pipeline on synthetic multi-topic chats:

- 83% of probes were answered correctly;
- only 44% of the probes whose answer sat inside an earlier tool result;
- the evidence was in the prompt for 67% of probes.

Nothing in the prompt said which stored result held a detail. Conversation search rarely surfaced facts inside tool results, and the previous exchange's raw tool output was always sent whole. In production, a 36,700-character parcel result once rode into an unrelated stock question.

## Evidence

Measured on 28 September with the same 36 probes, integrations off, `openai/gpt-6-sol`, one answer run per arm:

|                            | Baseline (journal 39) | This change   |
| -------------------------- | --------------------- | ------------- |
| Correct                    | 83% (30/36)           | 97% (35/36)   |
| Tool-detail correct        | 44% (4/9)             | 89% (8/9)     |
| Distant correct            | 86% (6/7)             | 100% (7/7)    |
| Evidence in prompt         | 67%                   | 67%           |
| In prompt or one read away | 67%                   | 97%           |
| Median fixed characters    | 29,997                | 30,472        |
| Eval cost / median latency | $1.09 / 6.1 s         | $1.18 / 6.6 s |

- **How the model now answers.** In the new arm, correct tool-detail answers followed a `conversation_search` or index line, then `observation_read` on the listed ID.
- **The remaining miss** is an eval artefact: the model kept calling `job_list`, which reads the eval's empty jobs table.
- **Caveats.** These are single runs on developer-written synthetic fixtures, so they measure direction rather than a success rate.

## Diagnosis and alternatives

The research on Codex, Claude Code, Cursor and Hermes found that recall after compaction depends on pointers back to stored originals more than on summaries. Hermes measured 43% for a summary alone against 79% with one search.

Chief already stores every message and tool result by ID. It lacked a contiguous map of recent exchanges that carries those IDs.

- **Chosen, stage 2:** the previous exchange keeps its text, and its large tool results become excerpts with read references. This happens only when a new message arrives, which is cache-friendly.
- **Chosen, stage 3:** a code-built exchange index (lines capped at 8,000 characters, plus a header of about 470) replaces the extractive archive of messages about 13–40 back, which left a gap 2–6 turns back.
- **Deferred:**
  - per-layer budgets (stage 1);
  - a background summary (stage 4);
  - token-aware admission within a turn (stage 5).

## Implementation and review

- **`src/context.ts`.** The previous exchange is always projected through `compactToolGroup`. The now-redundant recompaction branches were removed.
- **`src/context-continuity.ts`.** `exchangeIndex` replaces `extractiveConversationSummary`. It reads tool names from assistant calls and observation IDs from tool results, and skips the saved-answer-details pointer. It also:
  - gives a background delivery from another run its own line;
  - lists at most 8 tools per line, excluding `finish_turn`;
  - JSON-quotes message heads.
- **`src/conversation-state.ts`.** Selects bounded heads of the last 400 rows (user, assistant and tool) and builds the index.
- **Tests.** The archive test is replaced by index tests covering:
  - ordering, exclusion of the previous exchange, observation IDs (including after a receipt ID), the allowance and prompt placement;
  - background deliveries, the tool cap and quoting;
  - excerpting of the previous exchange;
  - a PGlite test of the real `conversationState` query.
- **Review.** An independent Opus 5.5 review of `908fe04` approved with low findings, and all were addressed:
  - background deliveries overwrote an earlier reply;
  - tool lists were unbounded;
  - the risky paths had no tests;
  - some docs were stale;
  - message heads were quoted raw.

## Verification and outcome

- `npm test` passes, and the eval results above are measured.
- Still to measure in production after release:
  - fixed size, which should change little (index lines at most 8,000 characters plus a header, against about 10,200 for the archive);
  - how often `observation_read` and `conversation_read` are called;
  - replies on topic switches, which need owner acceptance.
