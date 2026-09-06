# Personal-agent architecture

One Node application owns the Telegram gateway, conversation runtime, tools and background workers. Postgres owns all durable state. Hermes is an external reference, not a runtime dependency.

## Modules

| Module                       | Responsibility                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `agent.ts`                   | Authenticated owner scope, per-user serialization, history, approvals and task continuation       |
| `custom-agent.ts`            | Sequential model → validated tool → observation loop and explicit stop reasons                    |
| `context.ts`                 | Core instructions, Singapore time, memories, compact skill catalogue, recent complete tool groups |
| `model.ts`                   | OpenRouter adapter, medium reasoning, price filters, normalized responses and usage               |
| `execution.ts`               | Persisted checkpoints, invocation journal, budgets, traces and restart recovery                   |
| `runtime.ts` / `protocol.ts` | Individual tool definitions from Zod; strict operation-specific arguments                         |
| `tools.ts`                   | Owner-scoped dispatcher and action receipts                                                       |
| `work.ts` / `work-worker.ts` | Task steps, evidence and automatic continuation within the task allocation                        |
| `schedule.ts` / `daily.ts`   | TypeScript cron parsing and persisted reminder/briefing delivery                                  |
| `telegram.ts`                | Allowlist, voice, commands, existing text renderer and approval previews                          |

The OpenRouter adapter uses Sol for the main loop. Gemini Flash remains a separate public search helper. ElevenLabs transcription and synthesis are independent providers. Google OAuth ownership and read-only Gmail/Calendar scopes remain in the integration modules.

The model never receives an execution capability, token or owner selector. The host supplies a callback closed over the authenticated user and run. No HTTP tool-execution endpoint remains. Tool schemas exclude identity fields, and the dispatcher rejects extra arguments.

`Agent.run` returns reply, updated history and a stop reason: answer, awaiting_user, awaiting_approval, budget_exhausted, cancelled or failed. `ModelAdapter.generate` receives normalized messages, named tools, reasoning and an AbortSignal; available provider and usage data are recorded without inventing cost.

Context selects at most 20 recent user turns and 100,000 conversational characters, keeping tool calls and their results together. Full payloads stay in Postgres. Large omitted observations remain available in the run checkpoint and domain records; omission is traced. Skills are loaded on demand with `skill_read`; approved private heads override repository defaults.

There is no generic code execution, delegation, realtime audio or public web client. Those require separate permission and execution designs.
