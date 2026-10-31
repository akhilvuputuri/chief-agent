# Chief architecture

One Node application owns the Telegram gateway, the coordinator runtime, tools, deterministic monitors and background workers. Postgres owns all durable state. Work that needs isolation runs outside the gateway. Owner-controlled invoice browsing runs in a separate browser container with a public egress proxy. Coding runs in disposable EC2 boxes. Neither receives the gateway's integration credentials.

## Modules

| Module                                                     | Responsibility                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `agent.ts`                                                 | Authenticated owner scope, per-user serialization, history, approvals, task continuation and child-agent execution |
| `custom-agent.ts`                                          | Sequential model → validated tool → observation loop and explicit stop reasons                                     |
| `context.ts` / `history.ts`                                | Core instructions, Singapore time, memories, skill and agent catalogues, bounded history selection                 |
| `model.ts` / `model-policy.ts` / `effort.ts`               | OpenRouter adapter, reviewed model policy and tiers, price ceilings, per-message reasoning effort                  |
| `execution.ts`                                             | Persisted checkpoints, invocation journal, budgets, traces and restart recovery                                    |
| `runtime.ts` / `protocol.ts`                               | Individual tool definitions from Zod; strict operation-specific arguments                                          |
| `tools.ts`                                                 | Owner-scoped dispatcher and action receipts                                                                        |
| `agents.ts` / `plugins.ts` / `plugin-registry.ts`          | `agent_run`, pinned plugin agent definitions, tool grants and report contracts                                     |
| `work.ts` / `work-worker.ts`                               | Task steps, evidence and automatic continuation within the task allocation                                         |
| `schedule.ts` / `daily.ts` / `routines.ts`                 | Reminders, briefings and scheduled agent routines                                                                  |
| `responsibilities.ts`                                      | Owner-confirmed monitoring of named sources                                                                        |
| `news.ts` / `stocks.ts` / `subscription-summary.ts`        | Deterministic bulletins, alerts and summaries that make no model call                                              |
| `subscriptions.ts` / `gathering/` / `parcels.ts`           | Subscription tracker, invoice collections and the delivery tracker                                                 |
| `ibkr/` / `stock-*.ts`                                     | Read-only IBKR holdings, order drafts, quotes and stock rules                                                      |
| `singapore/`                                               | Read-only data.gov.sg and LTA DataMall tools for the Merlion agent                                                 |
| `mcp.ts` / `mcp-client.ts`                                 | Remote MCP connectors with explicit per-tool grants                                                                |
| `coding/` / `boxes/`                                       | Coding job controller, owner approvals, merge gates and the EC2 box layer                                          |
| `browser/`                                                 | Isolated browser service and egress policy for invoice gathering                                                   |
| `telegram.ts` / `telegram-topics.ts` / `telegram-views.ts` | Allowlist, voice, photo/PDF/location intake, topics, commands, views and approval cards                            |
| `miniapp.ts` / `canvases.ts`                               | Authenticated Mini App and revisioned canvases                                                                     |
| `attachments.ts`                                           | File classification and limits, PDF text extraction (unpdf), attachment notes for history                          |
| `ops-log.ts`                                               | Sanitized operational log lines                                                                                    |

## Coordinator and agents

Chief keeps the conversation, memory, work tracking, canvases and job alignment. Domain work runs as child agents started with `agent_run`. Each child has its own brief, tools, budget and model tier, and its report is validated against a host contract. Children cannot start other agents. See [coordinator and agents](agents.md) and [plugins](plugins.md).

The main model and agent tiers come from the reviewed [model policy](deployment.md#changing-the-production-model-through-a-release) in `config/model-policy.json`. Gemini Flash remains a separate public search helper. Speech transcription and synthesis are independent providers. Google OAuth ownership is enforced in the integration modules. Gmail stays read-only. Calendar creation is separate from model tools: a saved draft requires the owner to click its Telegram approval card before the Calendar service can write. See [Calendar approval](calendar-approval.md).

## Authority

The model never receives an execution capability, token or owner selector. The host supplies a callback closed over the authenticated user and run. No HTTP tool-execution endpoint exists. Tool schemas exclude identity fields, and the dispatcher rejects extra arguments. A child agent's calls are checked against the tool list the host recorded when it started.

`Agent.run` returns a reply, updated history and a stop reason: answer, awaiting_user, awaiting_approval, budget_exhausted, cancelled or failed. `ModelAdapter.generate` receives normalized messages, named tools, reasoning and an AbortSignal. Available provider and usage data are recorded without inventing cost.

## Context

History selection keeps tool calls and their results together. Full payloads stay in Postgres, and older messages are retrieved through conversation search and read tools. Large omitted observations remain available in the run checkpoint and domain records, and omission is traced. Skills are loaded on demand with `skill_read`; approved private heads override repository defaults. See [rolling conversation](rolling-conversation.md), [context management](context-management.md) and [authoritative storage](authoritative-storage.md).

## Execution outside the gateway

- **Coding.** The gateway never runs coding shell commands. Approved plans run in disposable EC2 boxes that hold no GitHub credential. A separate reviewer model reviews the work, the host publishes the reviewed artifact to a `chief/coding-*` branch, and the host merges only after the owner taps Merge on a card bound to the exact head. See [coding](coding.md), [boxes](boxes.md) and [coding automation](coding-automation.md).
- **Invoice browsing.** The browser and egress proxy run apart from the gateway. The owner logs in during a live handoff; the agent sees no password, cookie or full page text. See [gathering](gathering.md).

There is no realtime audio, public web client or general shell tool. Those require separate permission and execution designs.
