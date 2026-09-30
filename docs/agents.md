# Coordinator and agents

Chief is a coordinator. It keeps the conversation, memory, recall, work tracking, canvases and the job-alignment workflow. Domain work runs in agents: each is a separate run with its own context, its own tools and, by default, a cheaper model. Chief starts one with a single generic tool and relays what it reports.

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

| Type       | Does                                                             | Tools                                                            |
| ---------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| `email`    | search and read Gmail, read-only                                 | `gmail_*`, `observation_read`                                    |
| `parcels`  | the delivery tracker, from email or owner updates                | `gmail_*`, `parcel_*`                                            |
| `calendar` | calendar reads and event drafts                                  | `calendar_list`, `calendar_draft`                                |
| `daily`    | items, reminders, briefings, daily Sheet, routines               | `item_*`, `schedule_*`, `daily_sync`, `routine_*`                |
| `jobs`     | saved roles                                                      | `job_save/list/update/analyze/delete`, `web_read`, `source_read` |
| `stocks`   | the watchlist                                                    | `watchlist_*`                                                    |
| `news`     | the daily bulletin                                               | `news_*`                                                         |
| `library`  | NLB availability and the linked shelf                            | `library_*`                                                      |
| `web`      | quick public-web lookups                                         | `web_search`, `web_read`, `source_read`                          |
| `media`    | attached images and stored documents                             | `source_read`                                                    |
| `research` | evidence-backed research (alias of `public-research/researcher`) | `web_search`, `web_read`, `source_read`                          |

A definition in `plugin.json` declares:

- `description`: what the coordinator reads when choosing;
- `instructions`: `agents/<id>.md`, the agent's system prompt;
- `contract`: the report shape the host validates (below);
- `tools`: operations it needs, which the registry must grant;
- `skills`, `limits` (time, model calls, tool calls);
- `model` (default tier) and `effort` (default effort);
- `invocable`: false keeps an agent for host workflows only.

The host registry (`plugins/registry.json`) pins each package's content hash and grants its tools. It also holds:

- `aliases`: short types such as `email` → `core/email`;
- `delegated`: operations Chief is not offered because an agent does that work. An operation is withheld only while an agent that uses it is in the catalogue, so a disconnected integration never strands its tools.

## Contracts

A package chooses one of the host's contracts. It cannot add its own validation code.

- **`findings/v1`** (general). The agent finishes with `agent_report`: status (complete, partial, blocked), summary, up to 12 findings, refs and optional `needsOwner`. The host checks that:
  - a quote comes with a `sourceId` the agent read, and occurs in that source;
  - an `observationId` is one of the agent's own calls;
  - every ref appears in the agent's tool results or its brief.
- **`public-research/v1`**. One result per target with source-quoted evidence ([research specialist](research-specialist.md)).
- **`media/v1`**. Facts per image or document with page or region references; image extractions are stored and reused ([media specialist](media-specialist.md)). Media agents may only read stored sources.

## Models and effort

`config/model-policy.json` maps tiers to model IDs. It is reviewed and released like the main model:

```json
"agents": {
  "default": "fast",
  "tiers": { "fast": "google/gemini-3.8-flash", "standard": "openai/gpt-6.1-sol" }
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
- **Operational log.** `agent.child_started` logs `agentType`, `model`, `tier` and `effort` for findings agents. `agent.completed` logs `agentType`, `state`, `stopReason` and `approvalCount` for every agent run. Briefs and reports are never logged.
- **Queries.** Use `npm run logs:cloudwatch -- event --event agent.completed` for outcomes, and `run --run <id>` for a whole delegation.
