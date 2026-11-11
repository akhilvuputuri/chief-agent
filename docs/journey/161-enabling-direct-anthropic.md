# 161 — What does it take to switch Chief to the direct Anthropic route?

Work date: 11 November 2026. Written: 11 November 2026.
Status: enabling change prepared on branch `claude/gifted-mccarthy-gond93` and tested offline; awaiting independent review. Not merged, not rolled out. It changes `compose.yaml`, so it ships only through the reviewed operator rollout in [model providers](../model-providers.md#key-rollout-procedure), and only while the host's `RELEASE` is `a7c199386c75ff8ac084d7a0e9462ca4fe810917`.

## User-visible problem and preceding iteration

[Journal 160](160-direct-anthropic-provider.md) added a direct Anthropic pathway beside OpenRouter, merged as `a7c1993` (PR #441) and released on 11 November ([release run 43004943097](https://github.com/akhilvuputuri/chief-agent/actions/runs/43004943097), exact commit deployed and startup health passed). It is inert in production: Compose does not pass `ANTHROPIC_API_KEY` to the gateway. That entry left three owner decisions open: whether to enable it, Chief's 8,000-token output allowance, and the coding allowances.

Owner decisions, 11 November 2026:

- Switch from OpenRouter to the direct Anthropic route for the models mapped in `config/model-policy.json` (today Opus 5.5).
- Raise output allowances: Chief 32,000 tokens, coding reviewer 64,000.
- Use Opus 5.5 for the coding planner and coder as well as the reviewer.
- Cost is acceptable for this, including tens of dollars for a single coding change; coding runs are infrequent.
- Later the same day: raise the nightly learner's and the judge's allowances to 32,000 as well, matching Chief's.

These are owner-requested changes to model and output allocations, which AGENTS.md otherwise keeps fixed. The price ceilings ($4/$20) and the time, model-call and tool allocations are unchanged.

## Evidence

- **Measured (journal 160, 11 November 2026, temporary key, local runs, not production):** Chief's 8,000-token allowance, which includes thinking, failed 3 of 6 deliberately hard prompts at medium and high effort as an empty response (every token spent thinking). The coder's 128,000-token allowance let one trivial call spend 91k output tokens ($1.82). Pi plan, code and review jobs with every role on Opus 5.5 direct reached `pr_ready` with an APPROVE at about $0.25 each. Chief's real loop read 76% of prompt tokens from cache across 68 calls; the `tools` scenario cost $0.38–0.56 for 21–22 direct calls. The account's rate-limit headers showed 4,000 requests, 2M input tokens and 400k output tokens per minute.
- **Computed, not measured:** at Opus 5.5's $20 per million output tokens, one call that uses its whole allowance costs at most $0.64 for Chief (32,000), $1.28 for the reviewer (64,000) and $2.56 for the coder or planner (128,000, unchanged). Input is extra: $4 per million uncached, $0.20 cached, $5 for cache writes.
- **Not measured:** a Python squad job with Opus as leader and coder (only its message shape was tested with Opus direct); a long, real coding job with Opus as coder; Chief's hard prompts at 32,000.

## Diagnosis and alternatives

- **One enabling PR.** The two Compose lines, `BASE` in the rollout script, the allowances and the coding models ship together, so the single operator rollout that brings the key also brings the settings the owner chose for it. `scripts/deploy-anthropic-key.py` checks only `db/` (unchanged), `scripts/cloud-release.py` (unchanged) and `compose.yaml` (the live file plus exactly the two lines). Changes under `config/` and `src/` are published like an ordinary release; a new offline test case shows this.
- **Where Chief's 32,000 applies.** Every model call in Chief's agent loop (`src/custom-agent.ts`) now sends `maxOutputTokens: CHIEF_MAX_OUTPUT_TOKENS` (32,000, `src/model.ts`). That one call site serves the main model, `agent_run` agents on both tiers, research specialists and media reading. The adapters' default for callers that send nothing stays 8,000, rather than changing silently for every caller.
- **The learner and the judge (owner decision, later on 11 November).** The first version of this change left them alone: the review pass and the judge sent no allowance (8,000) and the procedure pass kept 16,000. The owner then asked for 32,000 on all three. Each now sends an explicit `maxOutputTokens`: `LEARNING_LIMITS.reviewOutputTokens` (32,000, new) on the review pass, `LEARNING_LIMITS.procedureOutputTokens` (16,000 → 32,000) on the procedure pass, and `JUDGE_LIMITS.outputTokens` (32,000, new, in `src/memory-judge.ts`) on the judge. Coupled to it:
  - _The per-call time limit is unchanged and is now the binding limit._ All three use `LEARNING_LIMITS.callMs` (5 minutes, 300 s, `AbortSignal.timeout`). The coding host plans for at least 100 tokens a second ([journal 156](156-room-for-the-whole-plan.md)); at that rate 32,000 tokens take 320 s, beyond 300 s, and 16,000 took 160 s. A call slower than about 107 tokens a second therefore cannot use its whole allowance: it is aborted at 300 s and everything it generated is lost. Neither Opus 5.5's nor GPT-6.1 Sol's output rate on these calls has been measured, so whether 32,000 is reachable in time is not known. The raise helps only a call that needs more than its old allowance and finishes within 300 s. As the owner directed, the time limit is not changed here.
  - _Transport._ The judge (`openai/gpt-6.1-sol`) is always a non-streamed OpenRouter request, and so is the learner whenever it is not served directly (before the key, after switching back, or on a fallback). Its response headers arrive only when the generation is done, so Node's 300 s header wait and the 300 s call limit coincide: the generation must finish within 300 s either way. A fallback after a failed direct attempt shares the same 300 s signal, so it gets only what is left. Once the key is live the learner (the `standard` tier, Opus 5.5) streams on the direct route, where only the call limit applies.
  - _What a lost call costs._ A timed-out or failed review call fails its batch, which waits for the next night; a failed procedure window stops that night's procedure run; a failed judge call fails the judge run, keeping earlier batches. Nothing is applied from the failed call. The provider may still bill tokens generated before the abort (hypothesis), and the retry the next night bills again. The learner makes no immediate retry.
  - _`requireComplete`._ Unchanged: the procedure pass sets it (a cut-off reply fails rather than passing for a window with nothing to save); the review pass and the judge do not. With `requireComplete` the stream's wire bound grows with the allowance (32 MiB at 32,000), which matters only on a streamed route.
  - _Spending estimate._ Each call's pre-call estimate counts the whole allowance at the adapter's output price: $20 a million (the OpenRouter ceiling, or Opus 5.5's list price on the direct route). A review or judge call's estimate rises by $0.48 and a procedure call's by $0.32. The judge is billed at GPT-6.1 Sol's $10, so its whole allowance costs at most $0.32 (computed). Worst case a night, every call using all 32,000 tokens: 70 review calls ($44.80), 20 procedure calls ($12.80) and 14 judge calls ($4.48), plus input; computed, far above what has been seen (the last measured review run took 39 s for 40 items), and the 300 s limit makes it unreachable at 100 tokens a second. Estimates are accounting hints, never caps.
  - _Provider output limit._ OpenRouter requests send `require_parameters: true` and `max_tokens: 32000`. If no GPT-6.1 Sol provider accepts an output of 32,000 tokens, OpenRouter could refuse the request (HTTP 404 "no eligible provider", or an error), and every judge run would fail. Not checked: there is no live access from this change, and the repository records no output limit for that model. The first judge run after release shows it (`learner.finished` for the judge pass, `model.failed` with its HTTP status). Opus 5.5 allows 128,000, so the learner is not affected.
  - _Tests._ `tests/learning.test.ts` asserts the review pass asks for 32,000 without `requireComplete` and the procedure pass for 32,000 with it; `tests/memory-judge.test.ts` asserts each judge call asks for 32,000.

  Coding allowances come from the coding profile and were never the adapter default.

- **What the allowance is coupled to:**
  - _Time._ A call in Chief's loop is bounded by the run's remaining time (900 s for an owner turn; 60–180 s for most agents in `plugins/core/plugin.json`), not by its allowance. A larger allowance does not lengthen a run; an agent with 90 s simply cannot produce 32,000 tokens.
  - _HTTP timeouts._ The direct adapter always streams (the SDK's 10-minute timeout covers only the wait for response headers, and the API sends pings while thinking), so a long generation is not cut off. Chief's ordinary OpenRouter calls are not streamed: a plain `fetch` whose response headers arrive only when the generation is done. Node's fetch gives up after 300 s without headers ([journal 156](156-room-for-the-whole-plan.md)), and the loop retries such a failure once. At 8,000 tokens that limit was out of reach; at 32,000 a slow generation on OpenRouter (a fallback, or after switching back) could reach it. Hypothesis, not observed; watch for `model.failed` with a fetch error after about 300 s.
  - _Spending estimate._ The pre-call estimate counts the whole allowance, so a Chief call's estimate rises by $0.48 at Opus prices. It is an accounting hint, never a cap ([cost controls](../cost-controls.md)).
  - _Context._ Chief's context limits are in characters and reserve no room for output; 32,000 tokens fits Opus 5.5's window beside the 1.3M-character hard limit.
  - _Other models._ The fast tier (`google/gemini-3.8-flash`) and any media model also receive 32,000. If a provider's output limit were lower, OpenRouter could refuse the request. Not checked live; the first fast-tier agent call after the rollout shows it.
- **Coding (Pi, the default backend).** `config/coding-pi.json` sets `model` and `leaderModel` to `anthropic/claude-opus-5.5` and adds `reviewerMaxOutputTokens: 64000`. The schema allows up to 128,000 for Pi profiles, and the pinned worker image (`sha256:e67dc9ea…`, built from `fa058f9`) validates its settings with a schema that already has the field. The host's per-call limit becomes 640 s for the reviewer (was 300 s at 16,000) and stays 1,280 s for the coder; the worker waits a minute longer. The job allocation (150 minutes, 1,500 model calls, 4,000 tool calls) is unchanged. Opus passes the coding price filter ($4/$20 against the same ceilings), and Pi's context window comes from the OpenRouter catalogue snapshot, as it already does for the Opus reviewer.
- **Stored owner preferences can shadow the file.** `coding_model_set` appends a per-role choice (`events` rows of type `coding.models`), and `coding_start` takes, per role, the latest stored choice over the file. A role the owner ever set explicitly stays on that model after this release. `coding_models` shows the effective result; if a role does not show Opus 5.5 after the rollout, the owner sets it with `coding_model_set`. The output allowances have no per-owner override. Jobs snapshot their settings at creation, so existing jobs keep their models and allowances.
- **The Python squad profile (`config/coding.json`) is unchanged.** `config/coding-backend.json` selects Pi for new jobs, so the squad profile serves only jobs already created on it, which keep their snapshot anyway. The squad merges automatically (`autoMerge: true`), and its protocol with Opus as leader and coder was only message-shape tested, never a full job. Switching it would change nothing today and would be unverified if the backend were switched back.
- **Rejected: raising the adapters' default to 32,000.** It would hide each caller's allowance from its readers, and would change every other caller that sends none. The learner and the judge send theirs explicitly instead.

## Implementation and review

- `compose.yaml`: `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` and `ANTHROPIC_WORKSPACE_ID: ${ANTHROPIC_WORKSPACE_ID:-}` directly after the gateway's `OPENROUTER_API_KEY` line. Empty defaults keep every call on OpenRouter until the key is in the server `.env`.
- `scripts/deploy-anthropic-key.py`: `BASE = 'a7c199386c75ff8ac084d7a0e9462ca4fe810917'`, the merge commit of PR #441. If any other release lands first, `BASE` must change to that live SHA through review. `scripts/test-deploy-anthropic-key.py` gains a case showing that `config/` and `src/` changes in the same commit are published.
- `src/model.ts`: `CHIEF_MAX_OUTPUT_TOKENS = 32000`; `src/custom-agent.ts` sends it on every call. `tests/custom-runtime.test.ts` asserts each loop call asks for it.
- `config/coding-pi.json`: Opus 5.5 planner and coder, `reviewerMaxOutputTokens: 64000`. `tests/coding-output-allowance.test.ts` asserts the shipped reviewer allowance and its 640-second call limit.
- `src/learning.ts`: `LEARNING_LIMITS.reviewOutputTokens: 32000` sent by the review pass, `procedureOutputTokens` 16,000 → 32,000; `src/memory-judge.ts`: `JUDGE_LIMITS.outputTokens: 32000` sent by every judge call. `callMs` is unchanged at 5 minutes.
- Docs: [model providers](../model-providers.md), [cost controls](../cost-controls.md), [learning](../learning.md), [coding](../coding.md), [configuration](../configuration.md), [model response recovery](../model-response-recovery.md), [reasoning effort](../reasoning-effort.md), [coding-agent lessons](coding-agent-lessons.md).

Independent review: pending.

## Verification and outcome

Tested offline on 11 November 2026: `kite run typecheck`; the custom runtime, context, model policy, router, cache-hint, Anthropic, OpenRouter stream, runtime config, Dockerfile, migration rollout, agents, media, research, effort and learning tests; every `tests/coding*.test.ts`; `node --test scripts/*.test.mjs`; every `scripts/test-*.py`. After the learner and judge allowances were added (same day): `kite run typecheck`, and `tests/learning.test.ts`, `tests/memory-judge.test.ts` and `tests/custom-runtime.test.ts`. No live call was made and no key was used.

### Rollout

The exact commands are in [model providers](../model-providers.md#key-rollout-procedure). In order:

1. Before merging: confirm the host's `RELEASE` is `a7c199386c75ff8ac084d7a0e9462ca4fe810917` and the release was healthy. Once this PR is merged, no other release can land until the rollout has run.
2. Merge. Its automatic release refuses the Compose change; that is expected.
3. Add a long-lived Console key (and, for an unscoped key, the workspace ID) to the server `.env`. The temporary keys from the 11 November tests are not for production and should be revoked in the Console.
4. Archive the exact merge commit, transfer it with the reviewed script, and run the script. Verify `RELEASE`, health and that the key reached the gateway.
5. Dispatch the normal release for the same commit as a no-op, to confirm later releases accept the installed Compose file.

### After enabling

The [first live run checklist](../model-providers.md#first-live-run) applies, plus:

- `model.routes` shows `anthropicKey: true` and `mainRoute`/`standardRoute: anthropic-direct`.
- A hard owner turn at high effort completes without an empty-response failure; its usage shows output tokens above 8,000 where it needed them.
- A fast-tier agent call completes on OpenRouter with the 32,000 allowance.
- `coding_models` shows `anthropic/claude-opus-5.5` for planner, coder and reviewer; any role that does not is reset with `coding_model_set`.
- One Pi coding job plans, codes and reviews with all roles direct; record its cost from its `model_usage` events.
- Watch for `rate_limit` fallbacks during coding jobs, which now send every role to the same account.
- The first nightly learner and judge runs complete: no `model.failed` near 300 s, and the judge's OpenRouter request is not refused for `max_tokens` 32,000.

The independent reviewer's non-blocking observations, to watch on the first live runs:

- On OpenRouter (the `fast` tier, and any fallback), a larger `max_tokens` may enlarge the reasoning budget OpenRouter derives from the effort level, so agents with short time budgets may run slower or end `budget_exhausted`. Watch `fast`-tier agent latency against the days before.
- A non-streamed OpenRouter call can reach Node's 300 s header wait at the larger allowance; the loop retries it once, and the provider may bill both attempts.
- One 32,000-token call can take much of a 900 s owner turn.
- Opus is slower per token than the previous coder (DeepSeek V4.1 Flash), while the coding job's time limit (150 minutes) is unchanged.

### Release closure

Pending: independent review, merge, operator rollout and the checks above.

## Coding-harness learning record

Updated in [coding-agent lessons](coding-agent-lessons.md). Every Pi role moves to Opus 5.5, served directly once the key is live, and the reviewer may write up to 64,000 tokens with a 640-second call limit. Pi drops the direct route's thinking entries between tool turns, so the coder loses thinking continuity across its own tool calls on the direct route (it keeps OpenRouter's reasoning entries). What would show a benefit: fewer requested changes and paused jobs per job than the DeepSeek coder's, at a recorded cost per job. Not yet measured beyond the three small local jobs in journal 160.

## Follow-up and next iteration

- Record the rollout, the first live run and the first real coding job here, with dated evidence.
- Measure the learner's and the judge's output rate and call time at 32,000; if calls reach the 5-minute limit, decide (owner) whether to raise `callMs` or lower the allowance.
- If OpenRouter calls hit Node's 300-second header limit at the larger allowance, stream them or send headers early.
- Deferred from journal 160: the two runtime cache behaviours (a host notice appended as a user message; a child's final call narrowing the tool list).
