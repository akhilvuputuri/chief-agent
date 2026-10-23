# Coordinator and agents

Chief is a coordinator. It keeps the conversation, memory, recall, work tracking, canvases and the job-alignment workflow. Memories are explicit: when the owner states a durable preference or fact, Chief offers to remember it in one short line and calls `memory_set` only after the owner agrees ([journal 117](journey/117-open-loops-and-memory-offers.md)). Domain work runs in agents: each is a separate run with its own context, its own tools and, by default, a cheaper model. Chief starts one with a single generic tool and relays what it reports.

Heavy work that needs its own compute is planned as [boxed sub-agents](boxes.md); the light agents described here are unchanged.

This page is the design record for that split: why it exists, how an agent is defined and run, what it may do, and how to add one. The change history is in [journal 49](journey/49-coordinator-agents.md).

## Why

In the six days of production logs before this change, Chief made about 190 tool calls itself and delegated 2 (both to the media reader). Email reads, parcel hunts and calendar lookups all ran on the main model inside Chief's own context. That had three costs:

- **Context.** A `gmail_thread` result is up to 16,000 characters, and a parcel hunt is 10 to 25 calls. Long email tasks were what pushed a turn over its limit in [issue #77](https://github.com/akhilvuputuri/chief-agent/issues/77).
- **Fixed prompt.** Every call carried domain tool schemas. With every domain connected, Chief was offered 76 tools, about 43,000 characters of schema.
- **Model cost.** Every step of every domain task ran on the main model.

With agents, Chief is offered 34 tools (about 22,000 characters) before domain selection, and the domain agents run on Gemini 3.8 Flash by default. These are offline counts from `runtimeContext`; production numbers belong in the journal once measured.

## The tool

```text
agent_run(type, objective, context?, model?, effort?)
```

- `type` is an entry from `agentCatalogue` in Chief's runtime state: a short alias such as `email`, or a full `plugin/agent` ID.
- `objective` and `context` are the brief. The agent cannot see the conversation, so the brief carries everything it needs, including any IDs or links as ordinary text. There are no per-agent fields.
- `model` is a tier (`fast`, `standard` or `strong`), never a model ID. `effort` is the reasoning effort (`low`, `medium` or `high`). Both default to the agent definition's choice.

The result is the agent's report plus `type`, `agentId`, the resolved `model` (tier and ID), `effort`, `childRunId`, and any `approvals` the agent created.

### References in the brief

The host scans the brief for URLs and UUIDs (`resolveReferences` in `src/agents.ts`) and keeps only those the owner owns or that belong to this turn:

| Kind               | Resolved from                                                       |
| ------------------ | ------------------------------------------------------------------- |
| attachment         | this turn's image attachments                                       |
| stored source      | `research_sources` owned by the owner                               |
| saved role         | `jobs` owned by the owner                                           |
| stored tool result | successful `runtime_calls` of the owner's runs                      |
| URL                | any `http(s)` link (public-URL checks still apply where it is read) |

An ID the owner does not own stays plain text: it never becomes a target. The research and media contracts turn references into their targets; a findings agent receives them as a list and reads them with its own tools.

## Agent definitions

Every agent is a plugin agent, including the built-in ones. The built-ins live in the `core` plugin (`plugins/core/`), in the same format as any other package:

| Type            | Does                                                                                                                                     | Tools                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `email`         | search and read Gmail, read-only                                                                                                         | `gmail_*`, `observation_read`                                    |
| `parcels`       | the delivery tracker, from email or owner updates                                                                                        | `gmail_*`, `parcel_*`                                            |
| `calendar`      | calendar reads and event drafts                                                                                                          | `calendar_list`, `calendar_draft`                                |
| `daily`         | items, reminders, briefings, daily Sheet, routines                                                                                       | `item_*`, `schedule_*`, `daily_sync`, `routine_*`                |
| `jobs`          | saved roles                                                                                                                              | `job_save/list/update/analyze/delete`, `web_read`, `source_read` |
| `stocks`        | the watchlist                                                                                                                            | `watchlist_*`                                                    |
| `news`          | the daily bulletin                                                                                                                       | `news_*`                                                         |
| `library`       | NLB availability and the linked shelf                                                                                                    | `library_*`                                                      |
| `web`           | quick public-web lookups                                                                                                                 | `web_search`, `web_read`, `source_read`                          |
| `media`         | attached images and stored documents                                                                                                     | `source_read`                                                    |
| `subscriptions` | the subscription tracker from owner statements and already-matched invoices                                                              | `subscription_*`                                                 |
| `gathering`     | invoice PDFs for an exact collection, files only                                                                                         | `gather_*` (not start/revise)                                    |
| `bills`         | invoice collection plus owner-requested tracker updates from it                                                                          | `gather_*` (not start/revise), `subscription_*`                  |
| `research`      | evidence-backed research (alias of `public-research/researcher`)                                                                         | `web_search`, `web_read`, `source_read`                          |
| `merlion`       | Singapore weather, air, alerts, carparks, cameras, holidays, hawker closures, bus arrivals, MRT status and traffic (`singapore/merlion`) | `sg_*`, `lta_*`                                                  |

A definition in `plugin.json` declares:

- `description`: what the coordinator reads when choosing;
- `instructions`: `agents/<id>.md`, the agent's system prompt;
- `contract`: the report shape the host validates (below);
- `tools`: operations it needs, which the registry must grant;
- `skills`, `limits` (time, model calls, tool calls);
- `model` (default tier) and `effort` (default effort);
- `invocable`: false keeps an agent for host workflows only.

Agents in one package can share skills: each lists the package skill IDs it uses, and every listed skill appears in that agent's pinned catalogue for `skill_read`. The `core` package holds `invoice-gathering`, `subscription-ledger` and `invoice-ledger`; `gathering`, `subscriptions` and `bills` each name the ones their work needs, so the procedure lives in one place. A skill is guidance only; the definition's `tools` and the registry grant decide what an agent can do.

The host registry (`plugins/registry.json`) pins each package's content hash and grants its tools. It also holds:

- `aliases`: short types such as `email` → `core/email`;
- `delegated`: operations Chief is not offered because an agent does that work. An operation is withheld only while an agent that uses it is in the catalogue, so a disconnected integration never strands its tools.

## Contracts

A package chooses one of the host's contracts. It cannot add its own validation code.

- **`findings/v1`** (general). The agent finishes with `agent_report`: status (complete, partial, blocked), summary, up to 12 findings, refs and optional `needsOwner`. The host checks that:
  - a quote comes with a `sourceId` the agent read, and is that source's own words (see [report checks](#report-checks));
  - an `observationId` is one of the agent's own calls;
  - every ref appears in the agent's tool results or its brief.
- **`public-research/v1`**. One result per target with source-quoted evidence ([research specialist](research-specialist.md)).
- **`media/v1`**. Facts per image or document with page or region references; image extractions are stored and reused ([media specialist](media-specialist.md)). Media agents may only read stored sources.

## Report checks

The checks exist so that a report cannot cite an invented ID, source or quote. Since [journal 116](journey/116-tolerant-agent-reports.md) they tolerate what models routinely change when copying, and no more (`src/quote-match.ts`, `checkReport` in `src/agents.ts`):

- **Quotes** (`findings/v1` and `public-research/v1`). What the host guarantees: every character of the returned quote comes from that one source, in order. The quote does not start or end partway through a word or number of the source, in scripts written with spaces.
  - Ignored: whitespace runs, curly versus straight quote marks, dash variants and zero-width characters. Case and characters otherwise count.
  - A quote, and each piece of an elided one, must start and end on a word boundary of the source, so "profitable" never matches inside "unprofitable".
  - Some punctuation does not end a word: an apostrophe or hyphen between letters ("can't", "non-toxic"), and a "." or "," between digits ("1.5", "1,234"). A leading `-` or `−` before a digit, after a non-word character, belongs to its number ("-5%"). So "they can" is refused out of "they can't", "5 million" out of "1.5 million", and "5% today" out of "fell -5% today". A dash after a word is a range, so "5pm" can be quoted out of "9am-5pm".
  - The accepted cost: "The firm" cannot be quoted out of "The firm's"; quote "The firm's" instead.
  - An en or em dash between words separates them ("Friday" can be quoted out of "Monday–Friday"). The source's own character decides this, although every dash matches "-" in a quote.
  - Scripts written without spaces (Chinese, Japanese, Thai and similar) have no boundary to check, so there a piece can still start mid-word.
  - `...`, `…` or `[...]` marks omitted words. Each piece must occur in that one source, in order, with at least 8 characters per piece and at most 4 pieces. A leading or trailing ellipsis just marks an excerpt.
  - Among the possible matches, the host takes the shortest acceptable source span from the first piece to the last: a shorter span that would be refused for a hidden qualifier does not stop a longer, clean one elsewhere in the source. If that span is at most 300 characters (the quote limit), the coordinator receives the whole span, omitted words included: "The drug is ... effective" comes back as "The drug is not effective". A span of 301–600 characters comes back elided, as the source's pieces joined with `…`, unless the omitted text contains a negating or limiting word (not, no, never, cannot, `n't`, none, nothing, nobody, neither, nor, nowhere, only, except, excluding, unless, without). In that case the quote is refused, and the message tells the child to quote the passage without "..." or to shorten it. A span over 600 characters is refused.
  - The coordinator always receives the source's own words, with whitespace collapsed, never the model's copy. What is left out of a 301–600 character span is not shown. The qualifier list covers the common reversing and narrowing words, not every qualification (for example "rarely" or "in some cases").
  - Each cited source is read and normalised once per report check. The shortest-span search keeps one forward-moving cursor per piece, so it is a single pass over the source with no cap on occurrences.
  - Other quote checks are unchanged. `work_evidence` (`src/work.ts`) still requires a contiguous quote (whitespace-normalised only), so an elided quote returned for a long span cannot be reused as work evidence.
- **Refs.** A ref of 8 or more characters must appear anywhere in the agent's tool results or brief, as before. A shorter ref, such as a 6- or 7-digit record number or a ticker, must appear as a whole token inside a string or number value of a tool result, or in the brief. It must not sit inside a longer number or word (`1234567` does not match `91234567` or `1234567.5`), and a JSON key does not count. Refs under 3 characters are refused. Short refs without a digit, such as tickers, are allowed.
- **Rejections.** One rejection names every failing item (`finding 2: the quote "…" is not in source <id>`, `refs … not found: "7654321"`) and how to fix it, so one corrected report can pass. It is returned as `VALIDATION_FAILED` with `retryable: true`.
- **Job alignment and media** keep exact quote matching. Job-alignment quotes flow into the preparation chain and the preparation Sheet, which re-check them exactly; media quotes are stored and reused.

### Running low and partial results

A child's last model calls are reserved for reporting (`budgetNotice` in `src/custom-agent.ts`). This applies to every child with a report tool: findings agents, public research, and the media and job-alignment specialists, whose quote checks are unchanged:

- when one model call will remain after the current one, the host adds a notice telling it to report now, so a rejected report can still be fixed;
- on the last model call, or when its tool allocation or time (under 20 seconds, or a quarter of its allocation if that is less) could not cover another round, the call offers only the report tool, with a notice. A call to any other tool from that step, including `finish_turn`, is refused without dispatch ("Not dispatched: …"). The refusal costs no tool unit, so it cannot take the unit the report needs.

Each notice records `agent.budget_notice` (`final` true or false) in the child run.

A findings agent's result then follows these rules:

| Situation                                            | `status`               | Content                                                                                                                                                    |
| ---------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report accepted, child finished                      | the report's           | the report                                                                                                                                                 |
| Report accepted, allocation ran out in the same step | `partial` (or blocked) | the report, with `partialReason`                                                                                                                           |
| Last report rejected, child then answered or ran out | `partial` (or blocked) | the rejected report with every failing quote, `sourceId`, `observationId` and ref removed, each affected finding marked `unsupported`, and `partialReason` |
| No report, allocation ran out                        | `incomplete`           | `observations`: the child's latest 12 successful calls, in call order (`observationId`, `operation`) for `observation_read`                                |
| Interrupted, failed, or reported then failed         | `incomplete`           | as before; the report is not relied on                                                                                                                     |

Nothing unchecked is passed on as a quote, link or ref. A salvaged finding keeps its text even when its support failed. Such a finding is marked, for example `unsupported: ["quote"]` or `["observationId"]`, and its text is the agent's unsupported claim. `partialReason` lists every failing item compactly, for example `finding 2 quote; refs "9999999"`. The coordinator instructions say `partial`, `blocked` and `incomplete` are not complete. Public research follows the same salvage rules per target ([research specialist](research-specialist.md#partial-results)); job alignment and media keep their all-or-nothing contracts.

## Models and effort

`config/model-policy.json` maps tiers to model IDs. It is reviewed and released like the main model:

```json
"agents": {
  "default": "fast",
  "tiers": { "fast": "google/gemini-3.8-flash", "standard": "anthropic/claude-opus-5.5" }
}
```

- A call's tier, else the definition's tier, else the policy default, picks the model. An unconfigured tier is refused with the tiers that exist.
- A host `model` pinned on a registry entry wins over any tier.
- Without an `agents` section every tier uses the main model.
- A runtime built without a model factory (tests) runs every agent on its one model.
- Agent runs that do not come from `agent_run` (job-alignment workers) use the default tier.
- `effort` is sent as the provider's reasoning effort; it was fixed at medium before.
- `agent_run` offers only the tiers the policy maps.

## What an agent may do

- **Tools.** Only the definition's tools, intersected with what the registry grants and what is connected. Some operations can never be granted (`NEVER_GRANTED` in `src/plugins.ts`): `agent_run`, report operations, `finish_turn`, `tools_load`, job alignment, work-task control, `memory_set` and skill drafting or activation.
- **Authorization.** Each child call goes through `executeAgent` in `src/agent.ts`. The host checks the call against the tool list it recorded in the child's `agent.child_started` event, not against anything the child sends. Then it runs through the same dispatcher, uncertain-write guard and journal as Chief's own calls.
- **Writes and approvals.** Domain agents can write where their domain allows it. Approval rules do not change: a Calendar draft still needs the owner's Telegram button, and a role deletion still needs `/approve`. Approvals carry the child's run ID. `runFamily` in `src/run-family.ts` makes the coordinator's approval checks, pending-reply state and record context include its children. So Chief's turn ends `awaiting_approval` and the notice is delivered.
- **No recursion.** An agent cannot start another agent.
- **Lane.** A child inherits its parent's foreground or background lane, so a background job's agent cannot make foreground-only writes such as changing routines, the watchlist or news settings.
- **Budget.** A child's limits are its definition's, bounded by what the parent has left, and its usage is charged to the parent once.
- **Context.** Empty history and memories, the brief, resolved references, Singapore time, pinned skills, and domain state the host supplies (`agentState`: pending Calendar approvals for `calendar`, pending library requests for `library`).

## Direct mode

`availability.delegation: false` gives Chief every enabled tool, as before this change. Tests that exercise one domain tool through Chief use it. Production uses coordinator mode.

## Adding an agent

1. Write a package: `plugin.json` with an agent using `findings/v1` (or another contract), and `agents/<id>.md`.
2. `npm run plugins -- validate <dir>` prints the content hash.
3. Add the package to `plugins/registry.json` with its hash, agent IDs and tool grants, and optionally an alias.
4. Open a PR for review. No change to the conversation loop is needed; `tests/agents.test.ts` has an example that enables a new agent from registry configuration alone.

## Observability

- **Traces.** Chief's run records `agent.completed` or `agent.failed` for every `agent_run`, whatever the contract. It also records `agent.started` (findings agents) or `research.started` (research and media) with the child run ID; `runFamily` uses those to find a turn's children. A findings child's run records `agent.child_started`, which holds its type, definition hash, tools, model choice, limits and references; research and media children record `research.child_started`. Child model calls are ordinary `model.started` and `model.completed` events under the child run.
- **Operational log.** `agent.child_started` logs `agentType`, `model`, `tier` and `effort` for findings agents. `agent.completed` logs `agentType`, `state`, `stopReason` and `approvalCount` for every agent run; `state` is `partial` for a salvaged report. `agent.budget_notice` logs `state` `warning` or `final` for a child running low. Briefs and reports are never logged.
- **Queries.** Use `npm run logs:cloudwatch -- event --event agent.completed` for outcomes, and `run --run <id>` for a whole delegation.
