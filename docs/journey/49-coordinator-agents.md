# 49 — Chief as coordinator: typed agents behind one generic tool

Work date(s): 2026-10-01. Written/revised: 2026-10-01.
Status: in review. Tested with mocked models; the production effect is not measured.

## User-visible problem and preceding iteration

The owner asked for delegation to work the way Claude Code's Task tool does: one generic call that names an agent type, so custom and plugin agents can be added without new tools. Before this change, delegation was three tools with fixed fields:

- `research_delegate(objective, context, jobIds, urls)`;
- `plugin_delegate(agentId, …)`, usable only by agents on the research contract;
- `media_delegate(objective, context, attachmentIds, sourceIds)`.

A plugin could add another researcher but not a new kind of agent.

The owner also asked whether Chief itself was doing domain work that belongs in subagents, and wanted Chief to coordinate only. They chose GPT-6.1 Sol for Chief (PR #126) and Gemini 3.8 Flash for subagents.

## Evidence

**Measured, production.** Tool calls by operation, from the CloudWatch operational log, 25–30 September. That is six days, which is all the log covers.

| Domain                                                                           | Calls made by Chief |
| -------------------------------------------------------------------------------- | ------------------: |
| Parcels (`parcel_list` 46, `parcel_record` 10, `parcel_match` 7)                 |                  63 |
| Email (`gmail_search` 14, `gmail_thread` 13, `gmail_read` 7, `gmail_accounts` 2) |                  36 |
| Recall (`conversation_search/read`, `observation_read`)                          |                  32 |
| Calendar                                                                         |                  13 |
| Stocks, news, schedules and routines                                             |                  22 |
| Web                                                                              |                   9 |
| Delegated to a subagent (`media_delegate`)                                       |                   2 |

25 of the `parcel_list` calls came from one repeated-failure loop ([journal 44](44-repeated-tool-failure.md)).

**Measured, offline.** `runtimeContext` with every integration connected:

- before: 76 tools, 42,765 characters of schema;
- coordinator mode: 34 tools, 22,210 characters, before domain selection;
- the always-offered core alone: 11 tools, 4,437 characters (down from 12 tools, 4,001 characters, which included `web_search` and `web_read` but not `agent_run`).

The agent catalogue adds 1,963 characters of runtime state.

**Not measured.** Latency, cost and answer quality with real models. Each delegation adds a model hop. Whether Flash handles every domain's instructions well is a hypothesis until real messages run through it.

## Diagnosis and alternatives

- **Chosen:** every agent is a plugin agent. The built-in domain agents are a bundled `core` plugin in the ordinary package format. One tool, `agent_run(type, objective, context?, model?, effort?)`, starts any of them.
  - The brief is free text. The host resolves the IDs and links in it against what the owner owns, so no agent-specific fields reach the interface. The owner rejected an `inputs` object with per-agent fields as not generic.
  - Model choice is a tier mapped in the reviewed model policy, never a raw model ID, so a call cannot pick an arbitrary or expensive model.
- **Chosen:** a general report contract, `findings/v1`. A new plugin agent works with no code as long as the host can validate its report: quotes against sources it read, observation IDs against its own calls, refs against its tool results or brief. `public-research/v1` and `media/v1` stay as stricter contracts.
- **Chosen:** domain agents may write. The existing approval gates still apply. Approvals carry the child's run ID, so the coordinator's approval checks were widened to the run and its children (`runFamily`).
- **Kept on Chief:** canvases, work tracking, recall, memory, skills administration, job alignment, preparation saves and the prep Sheet. Job alignment is a multi-step workflow with frozen scopes that already runs its own workers. Preparation saves need alignment links that only Chief reads.
- **Rejected:** keeping direct tools on Chief as the default and delegating only heavy reads. The owner asked for coordination only.
- **Kept as an option:** direct mode (`availability.delegation: false`) for tests that exercise one domain tool through Chief.

## Implementation and review

- `src/agent-schema.ts`: `agent_run` and `agent_report`.
- `src/agents.ts`:
  - `runAgentType` resolves the type, pins its definition, resolves the model tier and effort, resolves references, and dispatches by contract;
  - `runFindingsAgent` runs a findings agent;
  - `checkReport` validates its report.
- `src/plugins.ts`:
  - contracts `findings/v1` and `media/v1`;
  - any operation as a tool, subject to the host grant and `NEVER_GRANTED`;
  - per-agent `model` tier, `effort` and `invocable`;
  - registry `aliases` and `delegated`;
  - `agentCatalogue` and `resolve`;
  - the host model override renamed `hostModel`.
- `plugins/core/`: 10 agents (email, parcels, calendar, daily, jobs, stocks, news, library, web, media). Their instructions come from the domain paragraphs that used to be in Chief's system prompt. `plugins/registry.json` enables them, with aliases and the delegated operations.
- `src/runtime.ts`: coordinator mode offers `agent_run` and `agentCatalogue` and withholds delegated operations, while agents keep every definition (`allTools`).
- `src/agent.ts`:
  - `executeAgent` authorizes each child call against the tool list the host recorded for that child;
  - `agentState` gives the calendar and library agents their pending approvals;
  - the coordinator switch.
- `src/custom-agent.ts`: `agent_run` dispatch, child model resolution (default tier for any child without one), and reasoning effort.
- `src/model-policy.ts` and `config/model-policy.json`: agent tiers, with `fast` = Gemini 3.8 Flash as the default and `standard` = GPT-6.1 Sol.
- `src/run-family.ts`: widens approval queries in `agent.ts`, `custom-agent.ts` and `conversation-state.ts`, and the record-context query, to child runs.
- `src/context.ts`: Chief's instructions describe coordination. Domain guidance moved into the agent files.
- `src/ops-log.ts`: the `agent.child_started`, `agent.completed` and `agent.failed` projections.
- `src/protocol.ts`: removed the three delegate tools and the unused `TOOL_DESCRIPTION`.
- `src/plugin-schema.ts`: deleted.
- **Tests.**
  - `tests/agents.test.ts`:
    - coordinator toolset and catalogue;
    - tiers;
    - a jobs agent on the `standard` tier with high effort whose deletion approval ends Chief's turn `awaiting_approval`, including refusal of a foreign tool, of nested `agent_run`, and of an invented ref or observation;
    - the host's refusal of an unrecorded tool;
    - a new plugin agent enabled only through registry configuration;
    - a refused `memory_set` grant.
  - The research, media and plugin tests now call `agent_run`. Domain-behaviour tests that drive a tool through Chief run in direct mode.
- Independent review: pending.

## Verification and outcome

`npm test` passes 529 TypeScript tests and 21 Python context-eval tests. This is mocked-model behaviour only. After release, check:

- `agent.completed` counts by `agentType` and `state`;
- `model.completed` tokens and cost for child runs against Chief's;
- `context.selected` `toolsChars` for Chief;
- whether answers that used to come from direct tools are still right, especially email and parcels on Flash.

## Follow-up and next iteration

- **Measure first:** production latency and cost per delegation, and Flash quality per domain. If a domain needs more, raise its definition's default tier rather than moving its tools back to Chief.
- **The Jev picker now chooses only among Chief's remaining domains** (canvas, jobs, work and skills). Whether it is still worth its call is a measurement question.
- **Job alignment and preparation stay on Chief** for now.
