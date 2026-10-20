# 107 — Can a fixed tool list and a steadier effort keep Opus's cache warm?

Work date(s): 2026-10-20. Written/revised: 2026-10-20.
Status: in review. The coordinator is offered every available tool domain on every call (`TOOL_PICKER=all`), and the reasoning effort is raised mid-turn only after a failed step or an owner follow-up. Not yet measured in production.

## User-visible problem and preceding iteration

[Journal 104](104-opus-cache-misses-in-production.md) found that only 5 of 16 production Opus calls read the cache on 20 October. A miss costs about $0.13–0.23 against $0.05–0.09 for a hit. Its fix (PR 289) gave each turn stable cache entries. The owner then asked whether Jev's picking was also causing misses, and approved fixing it.

## Evidence

- **Measured, production, 20 October 2026.** The private events table was read read-only, covering 20 Opus calls in 6 turns. They ran on releases `7f83158` and `8a7d720`, before PR 289's system and owner markers were deployed (`38d12f7`, 11:43 UTC).
  - **Tool list.** Jev re-picked tools for an owner follow-up absorbed mid-turn and added the jobs domain (27 → 35 tools). That call read nothing from the cache.
  - **Effort.** The applied effort changed mid-turn once, from low to medium. That call read nothing, although the tools and history were unchanged. Anthropic documents that a thinking-setting change invalidates cached messages but keeps tools and system. Without PR 289's system marker there was no tools-and-system entry to fall back on, which fits a full miss.
  - **Across turns.** Jev picked different domain sets from turn to turn (work; work and jobs; mcp), so each turn started with a different tool list.
- **Measured, local, 20 October 2026.** Coordinator tool definitions with every capability on:
  - core only: 15 tools, 7.0k characters;
  - typical picks: 27–35 tools, 14.6–19.2k characters;
  - every domain: 54 tools, 40.4k characters (estimated at about 11k tokens from characters).

## Diagnosis and alternatives

- **Tool list.** Anthropic caches tool definitions first, so any change to them, even an appended tool, invalidates the whole cached prompt. Turning the picker `off` would not fix this, because the fallback word cues also vary per message.
- **Size versus misses.** With Opus pricing, estimated:
  - reading the about 11k cached tool tokens costs about $0.004 per call;
  - writing about 6k more of them on a cold first call (more than 5 minutes after the last) costs about $0.03–0.04;
  - one miss in production cost $0.13 or more.

  A larger fixed list should therefore be cheaper than a smaller changing one. That is a hypothesis until measured.

- **Effort.** Jev's pick at the start of a message keeps its value for simple messages. The periodic mid-turn raise is what changes the thinking setting inside a turn.
- **Alternatives:**
  - A sticky tool set, where a domain stays loaded for a day. This keeps the prompt smaller, but each new domain still costs a miss.
  - Pinning effort for the whole turn. This loses the raise after a failure, which helps recovery.

## Implementation and review

- **`TOOL_PICKER: "all"`.** This is the new default in `src/config.ts` and the value in `config/runtime.json`. Production Compose does not pass the name, so the file is authoritative.
  - `src/agent.ts` (`stableTools`) loads every available domain in canonical order.
  - Jev is not asked about tools, for the first message or for follow-ups. Picker latency was p50 0.5–0.7 s in the two-week review.
  - Background job steps get the same list.
  - With no pick to check, shadow picker checks and the hold and waiting-job queries are skipped; the recent-use and pending-approval reads still run but are unused.
  - The `toolDomains` note now says every domain is loaded.
  - Domain guidance for every loaded domain is always in the runtime context.
- **`escalation.periodic: false`** in `config/reasoning-effort.json`. `src/effort.ts` asks again only after a new failed tool call or an absorbed owner follow-up.
- **Tests:**
  - `tests/tool-domains.test.ts` checks the identical tool list on every call and turn, with no pick or load events;
  - `tests/effort.test.ts` checks the committed policy, and tests the periodic schedule with it switched on.

Independent review (Opus 5.5, commit `ceee859`) confirmed the tool bytes are identical on every call and turn, and the effort wiring is correct. It requested changes:

- **Medium.**
  - Shadow picker checks would record every turn as a "cues" pick with nearly every domain unused.
  - It was unclear which release served the measured calls.
- **Low.**
  - Dead queries ran under `all`.
  - The `toolDomains` note invited a needless `tools_load`.
  - Comments cited the wrong journal number.
  - Docs and `.env.example` were stale.
  - Estimates were stated as measured.
  - One effort test passed vacuously.
  - No test covered the coordinator or an absorbed follow-up.

All are fixed. The new follow-up test fails with stable tools off.

## Verification and outcome

Pending:

- review, CI and the release;
- the weekly review's comparison of cached tokens and cost per call and per turn against 20 October.

**Expected, a hypothesis:** later calls read nearly the whole prompt. Back-to-back messages within 5 minutes reuse the tools and system prompt, provided the effort and memories are the same.

**Risks** (estimated from local sizes):

- The fixed envelope grows by about 21–25k characters, from 50–60k to about 72–82k.
- Headroom before the 120k wire-compaction threshold therefore falls from about 47–57k to about 25–35k. That headroom has to hold the previous exchange, this turn's results and older history. As a result:
  - trimming and wire compaction start about 22k characters earlier in a turn, and each one rewrites earlier in-turn results, so later calls read only up to the owner's entry;
  - with a large previous exchange (20–25k), older history can fall below the 6k floor, or to 0, from the first call. That partly brings back the problem from [journal 101](101-lean-coordinator-prompt.md);
  - the journal 104 latch still drops older history at most once per turn, but it fires sooner.
- Offering 54 tools instead of about 30 may affect tool choice; no change has been measured yet.
- An effort difference between back-to-back messages still invalidates cached messages. Only tools and system can carry over, and only with the same memories.

## Follow-up and next iteration

- Trim the runtime state using `runtimeParts`, which should offset the larger tool list.
- If older history drops too often, consider raising the 120k wire-compaction threshold, which is low for a 1M-token model, or adding a breakpoint after the tools.
- Keep in-turn reasoning for Anthropic models (step 3 of the caching plan).
