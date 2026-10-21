# 113 — Can a larger context and cached fixed state stop Opus turns losing history and cache?

Work date(s): 2026-10-21. Written/revised: 2026-10-21.
Status: in review. The compaction threshold rises from 120k to about 1.08M characters (about 300k tokens), and the hard ceiling from 400k to 1.3M. The parts of the runtime state that never change move from the per-call state message into the cached opening system message. Not yet measured in production.

## User-visible problem and preceding iteration

[Journal 107](107-stable-tools-and-effort.md) gave Opus a fixed list of 54 tools, and its review warned that the larger fixed envelope would hit the 120k compaction threshold sooner. The owner's first conversations afterwards showed that happening, and the owner chose a much larger threshold. The owner also asked to cache the unchanging runtime state.

## Evidence

- **Measured, production, 21 October 2026, 02:35–04:18 UTC.** The private events table was read with read-only queries. The run covered 11 Opus calls in 5 turns on a release containing journals 104–108.

  | Measure                      | 20 October (16 calls) | 21 October (11 calls) |
  | ---------------------------- | --------------------- | --------------------- |
  | Calls that read the cache    | 5                     | 9                     |
  | Mean cost per call           | $0.135                | $0.100                |
  | Mid-turn tool picks or loads | 2                     | 0                     |

  Workloads differ, so this comparison is indicative only.
  - Fixed envelope: 79–81k characters, of which 42k was tools, 14–17k runtime state and 8k summary.
  - In 2 turns, older history was dropped mid-turn by the journal 104 latch because the 120k headroom ran out. Those calls read only the tools-and-system entry (22.5k tokens) and wrote about 20k, costing $0.11.
  - In 1 turn, the request crossed 120k. Kept reasoning was dropped and results were cut to excerpts, a loss of fidelity.

- **Measured, production, same calls.** `runtimeParts` averages per call:

  | Key                                                                     | Characters | Changes between calls?              |
  | ----------------------------------------------------------------------- | ---------- | ----------------------------------- |
  | `agentCatalogue`                                                        | 4,206      | no                                  |
  | `skillCatalogue`                                                        | 3,203      | no                                  |
  | `domainGuidance`                                                        | 2,671      | no, with every domain always loaded |
  | `gatheringWorkflow`, `availability`                                     | 827        | no                                  |
  | `conversation`, `openLoops`, `library`, `topic`, `costUsage` and others | about 4.5k | yes                                 |

  The state message comes after every cache marker, so all of it was billed at the full input price on every call.

## Diagnosis and alternatives

- **The threshold.** At 120k characters (about 33k tokens), a fixed envelope of 80k left about 27k for the previous exchange, this turn's results and older history. Ordinary turns ran out of room, so history was dropped and results were excerpted.
  - The new 1.08M-character threshold is about 300k tokens, the owner's choice. That is well within Opus's 1M window.
  - **Cost trade-off (estimated):** a turn can now grow much larger before compaction. A 400k-character call costs about $0.05 when cached, but about $0.55 to write fresh.
  - The soft 48k budget and the 6k older-history floor are unchanged, so older history does not grow, but it is no longer dropped mid-turn at these sizes.
- **Fixed state.** About 11k characters of the state never change between calls. They now sit in the opening system message, after instructions and memories. That message carries a cache marker, so they are read at about 0.1× instead of billed in full every call. The estimated saving is about $0.01 per call.
  - Changing keys stay in the state message at the end.
  - The skill catalogue changes only when a skill is activated, which costs one cache rewrite.
  - Under `TOOL_PICKER=jev`, a mid-turn load would now change the opening message and cost a full miss. `all` is the production setting.

## Implementation and review

- `src/context.ts`:
  - `contextCompactionThreshold` is 1,080,000 and `contextHardLimit` is 1,300,000. Both can be overridden per request (`contextLimits`), for tests that exercise compaction at small sizes.
  - `splitRuntimeContext` moves `STABLE_RUNTIME_KEYS` (`availability`, `toolDomains`, `domainGuidance`, `gatheringWorkflow`, `agentCatalogue`, `skillCatalogue`, `note`), in a fixed order, into the opening system message as "Configuration". A state that is not a JSON object stays whole.
  - The instructions now refer to `domainGuidance` in the configuration.
- `src/history.ts` uses the hard limit when deciding to shorten stored results, so it now shortens them only above 1.3M.
- Tests:
  - the continuity tests keep their calibrated 120k/400k scenarios through an explicit legacy-limits wrapper;
  - new tests pin the production defaults (a 200k-character turn is not compacted) and the stable/current split, including a byte-identical opening message when only the changing state differs;
  - the history and tool-domains tests are updated for the new limit and the guidance's new place.

Independent review: pending.

## Verification and outcome

Pending:

- review, CI and the release;
- in production:
  - no `context.over_budget`-driven history drop mid-turn at about 80k fixed;
  - `wireCompacted` false on ordinary turns;
  - later calls reading at least through the owner's message;
  - the state message shrinking to about 4.5k;
  - cost per call against 21 October.

## Follow-up and next iteration

- Reuse across messages (step 4 of the caching plan) after a week of data.
- Watch for unusually large turns now that compaction starts much later.
