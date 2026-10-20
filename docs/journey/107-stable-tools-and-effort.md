# 107 — Can a fixed tool list and a steadier effort keep Opus's cache warm?

Work date(s): 2026-10-20. Written/revised: 2026-10-20.
Status: in review. The coordinator is offered every available tool domain on every call (`TOOL_PICKER=all`), and the reasoning effort is raised mid-turn only after a failed step or an owner follow-up. Not yet measured in production.

## User-visible problem and preceding iteration

[Journal 104](104-opus-cache-misses-in-production.md) found that only 5 of 16 production Opus calls read the cache on 20 October. A miss costs about $0.13–0.23 against $0.05–0.09 for a hit. Its fix (PR 289) gave each turn stable cache entries. The owner then asked whether Jev's picking was also causing misses, and approved fixing it.

## Evidence

- **Measured, production, 20 October 2026.** The private events table was read read-only, covering 20 Opus calls in 6 turns.
  - **Tool list.** Jev re-picked tools for an owner follow-up absorbed mid-turn and added the jobs domain (27 → 35 tools). That call read nothing from the cache.
  - **Effort.** The applied effort changed mid-turn once, from low to medium. That call read nothing, although the tools and history were unchanged. Anthropic documents that a thinking-setting change invalidates cached messages.
  - **Across turns.** Jev picked different domain sets from turn to turn (work; work and jobs; mcp), so each turn started with a different tool list.
- **Measured, local, 20 October 2026.** Coordinator tool definitions with every capability on:
  - core only: 15 tools, 7.0k characters;
  - typical picks: 27–35 tools, 14.6–19.2k characters;
  - every domain: 54 tools, 40.4k characters (about 11k tokens).

## Diagnosis and alternatives

- **Tool list.** Anthropic caches tool definitions first, so any change to them, even an appended tool, invalidates the whole cached prompt. Turning the picker `off` would not fix this, because the fallback word cues also vary per message.
- **Size versus misses.** With Opus pricing, reading 11k cached tokens costs about $0.004 per call. One miss costs $0.13 or more. A larger fixed list should therefore be cheaper than a smaller changing one; that is a hypothesis until measured.
- **Effort.** Jev's pick at the start of a message keeps its value for simple messages. The periodic mid-turn raise is what changes the thinking setting inside a turn.
- **Alternatives:**
  - A sticky tool set, where a domain stays loaded for a day. This keeps the prompt smaller, but each new domain still costs a miss.
  - Pinning effort for the whole turn. This loses the raise after a failure, which helps recovery.

## Implementation and review

- **`TOOL_PICKER: "all"`.** This is the new default in `src/config.ts` and the value in `config/runtime.json`. Production Compose does not pass the name, so the file is authoritative.
  - `src/agent.ts` (`stableTools`) loads every available domain in canonical order.
  - Jev is not asked about tools, for the first message or for follow-ups, which also saves about 0.5 s per message.
  - Domain guidance for every loaded domain is always in the runtime context.
- **`escalation.periodic: false`** in `config/reasoning-effort.json`. `src/effort.ts` asks again only after a new failed tool call or an absorbed owner follow-up.
- **Tests:**
  - `tests/tool-domains.test.ts` checks the identical tool list on every call and turn, with no pick or load events;
  - `tests/effort.test.ts` checks the committed policy, and tests the periodic schedule with it switched on.

Independent review: pending.

## Verification and outcome

Pending:

- review, CI and the release;
- the weekly review's comparison of cached tokens and cost per call and per turn against 20 October.

**Expected, a hypothesis:** later calls read nearly the whole prompt, and back-to-back messages within 5 minutes reuse the tools and system prompt.

**Risks:**

- The fixed envelope grows by about 20–25k characters, to about 75–85k, so older history leaves sooner on long turns.
- 54 tools instead of about 30 may affect tool choice, though no change is measured yet.

## Follow-up and next iteration

- Trim the runtime state using `runtimeParts`, which should offset the larger tool list.
- Keep in-turn reasoning for Anthropic models (step 3 of the caching plan).
