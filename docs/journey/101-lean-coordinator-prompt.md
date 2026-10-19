# 101 — Why did Chief never see older conversation, and how small can its fixed prompt be?

Work date(s): 2026-10-20. Written/revised: 2026-10-20.
Status: released (v0.3.90, `11c3bad`, first deployed in `7e648f9` on 19 October 2026). The fixed coordinator prompt is smaller, older history keeps a capped 6,000-character floor, and the over-budget event is reported once per turn. Production sizes are not yet re-measured.

## User-visible problem and preceding iteration

Chief sometimes lost track of what the owner said a few messages earlier. [Context management](../context-management.md) bounds older history to a 48,000-character soft allowance that is left after the fixed envelope. Instructions, memories, summary, runtime state and tool schemas make up that envelope, and since early October it had grown past the allowance on its own.

## Evidence

- **Measured, production, 5–17 October 2026** (private telemetry review; sizes only):
  - 142 of 151 foreground calls were over budget. In 103 of them the fixed envelope alone was at least 48k; the other 39 crossed because of the protected exchange or working set.
  - The allowance for older history was therefore 0 in those calls. In the 9 calls under budget, older verbatim history was only about 2.5–8.7k characters.
  - Tool schemas were the largest part (median 17.7k). Most of the growth came from coding tools added to the `work` domain. `work` was offered in 36 of 45 turns and used in 16.
  - 73% of warn-level log lines were `context.over_budget`, one per model call.
- **Measured, local, 20 October 2026.** `runtimeContext` with every capability on, as the coordinator, on main before this change and on this branch:

  | Part                                           | Before      | After  |
  | ---------------------------------------------- | ----------- | ------ |
  | Instructions                                   | 11,079      | 8,438  |
  | Core tools (15)                                | 7,010       | 7,019  |
  | Core plus `work` tools                         | 14,567      | 10,329 |
  | Core plus `work` and `coding` tools            | 14,567      | 14,575 |
  | Runtime context, `work` loaded (adds guidance) | about 5,950 | 6,930  |

  These are character counts of the assembled parts, not production measurements.

## Diagnosis and alternatives

Most of the fixed envelope was not needed on most turns.

- **Coding schemas.** About 4.2k of coding schemas travelled with every `work` turn.
- **Instruction paragraphs** for three domains (canvas, job alignment, research batching in durable work) were sent on every call, about 2.6k.
- **No floor.** Over budget, older history got no allowance at all.

Alternatives considered:

- Raising the soft budget hides the growth and spends more tokens on every call.
- Removing the domain paragraphs outright would lose guidance the model needs when those tools are offered.
- Putting the guidance into tool descriptions would make the descriptions longer, and those descriptions sit at the start of the prompt. Runtime context sits at the end, where a mid-turn `tools_load` does not disturb the cached prefix.

## Implementation and review

- `src/tool-domains.ts`:
  - New `coding` domain for `coding_*` (with a message cue). `coding_status` stays in the core, so status answers need no load.
  - `DOMAIN_GUIDANCE` holds the canvas, jobs and work paragraphs moved out of `instructions`.
- `config/tool-picker.json`: a `coding` question for the Jev picker.
- `src/runtime.ts`: the runtime context carries `domainGuidance` for the domains whose tools are offered.
- `src/context.ts`:
  - `historyFloor` keeps at least 6,000 characters of older history.
  - The per-turn conversation summary moves from the opening system message into its own system message, so instructions and memories form a stable prefix across turns.
- `src/custom-agent.ts` and `src/ops-log.ts`: `context.over_budget` fires once per turn at info level, with the reason (`fixed` or `protected`), `fixedChars` and `protectedHistoryChars`.
- Tests:
  - `tests/tool-domains.test.ts` covers the split and the guidance.
  - The context tests cover the floor, the summary position and the once-per-turn event.

- `src/agent.ts`: a mid-turn load also carries the loaded domains' guidance. A `pendingCoding` signal (a coding job waiting on the owner) keeps coding tools offered.

Independent review (Opus 5.5, commit `ed74f5c`) requested changes:

- **Medium, confirmed.** A mid-turn `tools_load`, or a call that auto-loaded its domain, never brought that domain's guidance. Fixed in `loadTools`, with a test.
- **Medium, confirmed.** The floor was added after the compaction accounting. Its extra 6k could push a request past the 120k threshold and shrink the tool result the turn had just read. This was reproduced with a fixed envelope of about 94k and a 20k result. The floor is now capped by the compaction headroom, with a calibrated test.
- **Low–medium.** The floor exposed a reply without its question when the question did not fit. History now starts at a user message.
- **Low.** The coding cue matched "continue" and "resume", so every background pass still loaded coding, and so did CV messages. Those words and other false cues ("code", "PR", "merge") are removed, and the waiting-job signal covers short replies.
- **Low–medium.**
  - The scope-history caution and a note that `domainGuidance` is host guidance are now fixed instructions.
  - A continuity assertion that passed trivially was hardened.
  - Two docs were stale: operational logs and cost controls.

Delta review (`94733b2`) found one new medium bug. The `pendingCoding` query treated every `pr_ready` or paused job as waiting, including merged and deployed ones. That would have loaded coding tools on nearly every turn. It now shares the open-loops definition (`CODING_WAITS_ON_OWNER`), with a database test. "Open a PR" also counts as a coding cue again.

Devin Review on `94733b2` raised two more findings:

- **Non-contiguous history.** `boundHistory` could keep a short reply further back while dropping its long question. It now stops at the first owner message that does not fit. An oversized reply or tool group is still skipped, so its compact saved-answer reference, which is a later group, keeps the details retrievable. A first version that stopped at any group failed CI on `543952f`, because it lost that reference (`tests/custom-runtime.test.ts`).
- **Missing picker eval.** The `eval:picker` run that AGENTS.md requires after a picker-config change had not been recorded. The eval's own domain list also needed `coding`. Without it, the offline picker test failed in CI on `6b191be`.

**Picker eval** (`npm run eval:picker`, Jev 1.13, 20 October 2026). Six synthetic coding scenarios were added: three tuning, three held out. Over 190 scenarios × 3 runs (570 calls):

- recall of needed domains was 98.3% (98.1% tuning, 98.6% held-out), with 98.4% of calls fully covered;
- there were 0.43 extra domains per call, and the average offered schema was 20.0% of the full list;
- no coding scenario was missed, but "merge that PR now" was unstable across runs;
- the 3 misses were in calendar, library and gmail scenarios;
- cost was $0.061. The result is a pass against the 97% floor.

The baseline in [journal 37](37-jev-tool-picker.md) was 97.9% on the earlier question set; the scenario sets differ, so this is not a like-for-like comparison.

The shadow continuity eval was not re-run; the floor now admits older exchanges that the earlier assertions kept out.

## Verification and outcome

Tested locally. Pending:

- review, CI and the release;
- a post-release read of `context.selected` and `context.over_budget`. Expected: fewer turns over budget and older history admitted. That expectation is a hypothesis until measured.

Not measured: whether answers improve. Recall-tool calls (`conversation_read`, `conversation_search`) per turn are the next comparison.

### Release closure — 20 October 2026

[PR 274](https://github.com/akhilvuputuri/chief-agent/pull/274) merged as `11c3bad` (package 0.3.90). Exact-head independent review approved `06daef4` in round 6, and hosted CI and Devin passed there.

`11c3bad`'s own release attempt ([run 39303583311](https://github.com/akhilvuputuri/chief-agent/actions/runs/39303583311)) failed the current-main guard, because PR 276 had merged as `7e648f9`. The change first deployed in `7e648f9`, whose [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39305976845) recorded an exact-commit `success` receipt at 18:55:35Z. It is also in `becf234`.

These receipts show deployment and startup health only. Still pending:

- the share of foreground calls over budget;
- the median `fixedChars`;
- whether older history is admitted;
- recall calls per turn.

## Follow-up and next iteration

- Canvas create/update descriptions are 3.7k each; compress them when canvas turns are measured.
- Reply style rules that hold for any model ([journal 100](100-opus-main-model-and-caching.md) covers the model switch).
