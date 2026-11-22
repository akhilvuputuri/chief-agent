# Email search

Written 22 November 2026 ([journal 204](journey/204-email-search-redesign.md)). This is the design record for redesigning how Chief searches and reads Gmail. Like every doc here it is a dated log: the code and `config/` are the source of truth.

## The problem

Chief did not find most of a set of monthly receipt emails that were in the owner's Gmail. The owner asked for every monthly receipt from one store. The email agent made one search of the primary mailbox and reported 4 of the 13 that exist (measured, production, 22 November 2026).

Production traces over the 90 days to 22 November 2026 (measured, counts only):

- 13 of 29 email-agent runs made exactly three searches, the most the agent's instructions allow.
- 13 of 52 messages opened through `gmail_thread` had no plain-text body, so the agent saw only Gmail's snippet.
- 29 of 72 searches had further pages.
- All 24 `gather_search` calls returned zero results.
- `gmail_recall` was never called in a real conversation.

The causes in the code as of `4668853`:

- `gmail_read` and `gmail_thread` return only the `text/plain` MIME part (`plainBody` in `src/gmail.ts`). An HTML-only email, which most receipts are, becomes its snippet.
- One search page costs 11 of a turn's 40 Gmail requests: one list call and one metadata call for each of its ten hits (`GMAIL_RUN_BUDGET`, `SEARCH_RESULTS`). Four pages use the whole budget.
- The email agent's instructions (`plugins/core/agents/email.md`) say to make at most three searches and to anchor on an exact quoted phrase, which a request for "every receipt" does not have.

Research into eight open-source Gmail connectors and Google's Gmail MCP reference server (reported, 22 November 2026): they pass the query through to Gmail as written, convert HTML bodies to text or return them, cap a body at 20,000 characters or not at all, do not cap the number of searches, and leave email to the main agent rather than a separate small-model agent.

## Phased plan

Each phase is measured with the [eval](#eval) below, on the same private tasks, before and after.

0. **Eval.** A replayable, deterministic measure of whether the expected emails are surfaced, readable and reported. This entry.
1. **Tools.** HTML converted to text in reads; larger pages and bodies; metadata fetched in batches so a page no longer costs a request per hit; the request budget kept as a backstop only; a batch read; guidance in the result when a search is empty.
2. **Coordinator.** The main coordinator gets the Gmail tools and an `email-search` skill, and the email agent is retired. The owner approved email text in the coordinator's context on 22 November 2026.
3. **Invoices.** The invoice collector stops owning email search and can save HTML receipts as files (owner approved, 22 November 2026).
4. **Recall.** `gmail_recall` is judged on the same eval.

## Eval

`src/email-eval.ts` is an operator-run script, following [the mail recall eval](mail-recall.md#eval). It runs inside the production gateway container, reads the private tasks from standard input, and prints one private line per task and a summary line.

### What it runs

For each task it runs a model in a tool loop over the real Gmail tools: `GmailTools.call` with its per-run request budget, result fitting and untrusted-content warning. Every result passes through `projectObservation` before the model sees it, as in the agent loop. Tool names, descriptions and parameter schemas come from `runtimeContext` (`src/runtime.ts`, schemas in `src/protocol.ts`), and calls are validated by the runtime's own `action` schema, so the eval follows later tool changes. The tools offered are `gmail_accounts`, `gmail_search`, `gmail_thread` and `gmail_read`, plus one eval-only tool, `eval_report({messageIds: [{account, messageId}], answer})`, which ends the task.

`gmail_recall` is not offered. Its mail index tops itself up and prunes old messages on every call, both database writes, so a `--recall` flag was not cheap without one.

Each task runs under its own run ID, so the 40-request Gmail budget applies per task as it does per agent run, and with a fresh Gmail client, so the five-minute search cache does not carry from one task to the next.

The messages follow an agent run (`src/agents.ts`): the instructions, a runtime-context system message with the Singapore time, and a brief `{objective, context, references}` whose objective is the task's request and whose context names the task's mailboxes. A note after the instructions replaces `agent_report` with `eval_report`. The step before the last and the last step get the host's own budget notices (`budgetNotice` in `src/custom-agent.ts`), and the last step offers only `eval_report`, as the agent loop does with `agent_report`.

### Arms

- `--instructions agent:email`: the email agent's text as shipped in the image, read through the plugin registry (`src/plugin-registry.ts`, the `plugins/` directory beside `dist/`). Any agent type the registry resolves works the same way.
- `--instructions skill:<key>`: a plugin skill's text (`core/<id>` or just `<id>`), under one base line, for the future `email-search` skill.
- `--model fast|standard`: a tier (or `strong`, once the policy configures one) resolved through `config/model-policy.json` (`resolveAgentModel`), called through the same `ModelRouter` the gateway builds, so Anthropic-mapped models go direct when the gateway's key is set. Default: the agent's own tier, or `standard` for a skill.
- `--max-steps N`: model calls per task. Default: the agent's `limits.models` from `plugins/core/plugin.json` (10 for the email agent), or 40 for a skill.
- `--max-tasks N`: run only the first N tasks.

Reasoning effort is the agent's own (`medium` for the email agent), or `medium` for a skill. Output allowance is `CHIEF_MAX_OUTPUT_TOKENS`, as in the agent loop. A transient model error is retried twice.

### Task format

One JSON object per line on standard input. Synthetic example:

```json
{
  "id": "receipts-store",
  "kind": "collect",
  "request": "Find every monthly receipt from Example Store this year",
  "accounts": ["primary"],
  "expected": [{ "account": "primary", "messageId": "18c0ffee0000a001" }],
  "answerContains": ["monthly"]
}
```

`kind` is `collect` (find all of a set) or `lookup` (find one fact). `expected` lists at least one message, each in one of the task's `accounts`. A malformed line, a repeated task ID or an empty input refuses the whole run, naming the line and the field but not its content.

### Scoring

Deterministic; no judge model. Keys are account plus message ID, and a thread ID is not a message ID.

- **found**: expected messages listed in `eval_report.messageIds`.
- **surfaced**: expected messages that appeared as a row of any `gmail_search` result the model received (after projection; if projection ever reduces a page to an excerpt, IDs are read from the excerpt text).
- **readable**: expected messages whose body the model received as real text. A message counts only when the model received, after projection and not reduced to an excerpt, a `gmail_thread` entry or a `gmail_read` result for that message ID that is not flagged `bodyless` and whose text is longer than 200 characters. Gmail's snippet runs to about 200 characters and both read tools fall back to it for a message without a plain-text part (`gmail_read` without saying so), so snippet stand-ins, placeholders, identifier-only listings of large threads and bodies cut to a snippet's length do not count. A genuine plain-text email of 200 characters or fewer is therefore counted as not readable; that is the conservative side.
- **extra**: reported messages that were not expected.
- **answerHits**: `answerContains` strings found in `eval_report.answer`, case-insensitive.
- Per task also: searches, Gmail tool calls, tool errors by code, `budgetExhausted` (a call refused by the Gmail request budget, or a search row left unretrieved by it), model calls, input, output and cached tokens, cost when the provider reports it, wall time, and why the task ended: `reported`, `step_limit`, `unreported` (the model answered without a tool call) or `error` (class only, never provider text).

The summary line has aggregates only: tasks, total expected, found, surfaced and readable totals and rates, tasks fully found, extras, answer hits, searches per task (median, max), Gmail calls, tool errors by code, budget-exhausted tasks, endings, model calls, tokens, cost, wall time and the arm: flags, plugin or skill version, a short hash of the instruction text, model ID and route.

### How to run

The tasks file stays in the private operations folder; it is piped through `docker exec -i` and never written on the host:

```sh
ssh -F "$OPS/ssh_config" chief-lightsail "sudo -n docker exec -i hermes-companion-gateway-1 node dist/email-eval.js --instructions agent:email" < "$OPS/email-eval/tasks.jsonl" > "$OPS/email-eval/$(date +%F)-agent-email.jsonl"
```

It makes paid model calls: about ten agent-model calls per task at most, plus Gmail requests within each task's budget.

### Privacy

- Tasks name real requests and message IDs. They come in on standard input and are never written to disk by the script; the per-task output lines repeat them and stay in the private operations folder.
- `docker exec` output goes to the operator's terminal, not the container log. Nothing is written to the database; Gmail is only read.
- Only the summary line's aggregates belong in the repository. Examples in this repository are synthetic.
- If the direct Anthropic call falls back to OpenRouter, the router's structural `model.provider_fallback` line is printed among the output lines.

### Limits

- A simplified loop, not the runtime: no `agent_report` contract or host report checks, no coordinator brief (the request goes in as the objective, verbatim), no `observation_read`, no conversation history or memories, no time allocation, no tool-call allocation (the email agent's is 24) and no repeated-failure refusals. Comparisons between arms are fair; absolute numbers are not those of a live conversation.
- `readable` keys on `gmail_thread` and `gmail_read` result shapes. A new reading tool or result shape in Phase 1 needs the scoring updated in the same change.
- `found` needs the exact message ID; a reported thread ID does not count.
- Expected IDs come from the operator. A message missing from `expected` counts as extra when reported.
