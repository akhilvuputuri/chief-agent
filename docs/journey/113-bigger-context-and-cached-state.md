# 113 — Can a larger context and cached fixed state stop Opus turns losing history and cache?

Work date(s): 2026-10-21. Written/revised: 2026-10-21.
Status: released in `9fc5ecc` (PR 309, version 0.3.96) on 21 October 2026; live acceptance pending. The compaction threshold rises from 120k to about 1.08M characters (about 300k tokens), and the hard ceiling from 400k to 1.3M. The parts of the runtime state that never change move from the per-call state message into the cached opening system message. Not yet measured in production.

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

  | Key                                                                     | Characters | Changes between calls? (from the code, not measured) |
  | ----------------------------------------------------------------------- | ---------- | ---------------------------------------------------- |
  | `agentCatalogue`                                                        | 4,206      | no                                                   |
  | `skillCatalogue`                                                        | 3,203      | no                                                   |
  | `domainGuidance`                                                        | 2,671      | no, with every domain always loaded                  |
  | `gatheringWorkflow`, `availability`                                     | 827        | no                                                   |
  | `conversation`, `openLoops`, `library`, `topic`, `costUsage` and others | about 4.5k | yes                                                  |

  The state message comes after every cache marker, so all of it was billed at the full input price on every call.

## Diagnosis and alternatives

- **The threshold.** At 120k characters (about 33k tokens), a fixed envelope of 80k left about 27k for the previous exchange, this turn's results and older history. Ordinary turns ran out of room, so history was dropped and results were excerpted.
  - The new 1.08M-character threshold is about 300k tokens, the owner's choice. That is well within Opus's 1M window (OpenRouter catalogue `context_length` 1,000,000 for `anthropic/claude-opus-5.5`).
  - **Cost trade-off (estimated):** a turn can now grow much larger before compaction. A 400k-character call costs about $0.02–0.03 when cached (cache read is $0.20/M, 0.05× the $4/M input price), but about $0.55 to write fresh.
  - The soft 48k budget and the 6k older-history floor are unchanged, so older history does not grow, but it is no longer dropped mid-turn at these sizes.
- **Fixed state.** About 11k characters of the state never change between calls. They now sit in the opening system message, after instructions and memories. That message carries a cache marker, so they are read at about 0.05× instead of billed in full every call. The estimated saving is about $0.01 per call.
  - Changing keys stay in the state message at the end.
  - The skill catalogue changes only when a skill is activated, which costs one cache rewrite.
  - `toolDomains` and the fixed `note` move too, along with child agents' `skillCatalogue` and role `note`.
- Under `TOOL_PICKER=jev`, a mid-turn load already changed the tool list, which precedes the system message in the cached prefix. So moving these keys adds no new miss there. `all` is the production setting.

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

Independent review (Opus 5.5, `a3e1d49`): APPROVE, with no blocking findings. It confirmed:

- every stable key is constant per deployment and owner, and `refreshContext` and `loadTools` never rewrite one;
- no consumer reads the moved keys from the state message;
- the limits are coherent with `history.ts`, and trimming still behaves;
- the cache markers are unchanged.

Its low findings:

- specialist traces can grow about 9× per row;
- there is no per-turn cost ceiling;
- text in scripts near one character per token (for example Chinese) could exceed the token window before the character limits act;
- the cache property lacked an integration test, which has since been added;
- doc corrections, since applied.

## Verification and outcome

Pending:

- review, CI and the release;
- in production:
  - no `context.over_budget`-driven history drop mid-turn at about 80k fixed;
  - `wireCompacted` false on ordinary turns;
  - later calls reading at least through the owner's message;
  - the state message shrinking to about 4.5k (derived: `runtimeParts` measures the whole state before the split, so subtract the stable keys);
  - cost per call against 21 October.

### Release closure — 2026-10-21

- **Merged.** [PR 309](https://github.com/akhilvuputuri/chief-agent/pull/309) as `9fc5ecceb519684254a4ede3385787529cccda35`, version 0.3.96.
- **Heads.** Independent review (Claude Opus 5.5) approved `a3e1d49` and then `a67cf17`. The merged head `a527976` adds only journal cost corrections and a reading-path link, checked by the coordinator; hosted CI and Devin passed on it.
- **Review.** Exact-head independent review (Claude Opus 5.5) approved, after a test that the opening message stays byte-identical and corrections to journal costs.
- **Release.** The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/39584597049) succeeded and `release:status` recorded the exact commit deployed with startup health passing at 10:31 UTC on 21 October. No migration.
- **Not yet observed.** No mid-turn history drop or wire compaction on ordinary Opus turns, and later calls reading the cached prefix, on a week of conversations.

## Follow-up and next iteration

- Reuse across messages (step 4 of the caching plan) after a week of data.
- Watch for unusually large turns now that compaction starts much later. Estimated: an extreme turn costs about $1–3, and a fresh 300k-token write about $1.50.
- Watch `research.model_input` trace storage, since specialist rows can grow about 9×.
- Text near one character per token, for example Chinese, could exceed the 1M-token window before 1.3M characters. This is a known limit.
