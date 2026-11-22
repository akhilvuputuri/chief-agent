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

For each task it runs a model in a tool loop over the real Gmail tools: `GmailTools.call` with its per-run request budget, result fitting and untrusted-content warning. Every result passes through `projectObservation` before the model sees it, as in the agent loop, so each tool result is the one an agent would receive; the conversation around it is simpler (see [differences from a real agent run](#differences-from-a-real-agent-run)). Tool names, descriptions and parameter schemas come from `runtimeContext` (`src/runtime.ts`, schemas in `src/protocol.ts`), and calls are validated by the runtime's own `action` schema, so the eval follows later tool changes. The tools offered are `gmail_accounts`, `gmail_search`, `gmail_thread` and `gmail_read`, plus one eval-only tool, `eval_report({messageIds: [{account, messageId}], answer})`, which ends the task.

`gmail_recall` is not offered. Its mail index tops itself up and prunes old messages on every call, both database writes, so a `--recall` flag was not cheap without one.

Each task runs under its own run ID, so the 40-request Gmail budget applies per task as it does per agent run. Each task also gets a fresh Gmail client, so the five-minute search cache does not carry from one task to the next; in the gateway that cache is shared by every run.

The messages borrow the parts of an agent run (`src/agents.ts`) but not its assembly by `context()`: the instructions, a runtime-context system message with the Singapore time, and a brief `{objective, context, references}` whose objective is the task's request and whose context names the task's mailboxes. A note after the instructions replaces `agent_report` with `eval_report`. The step before the last and the last step get the host's own budget notices (`budgetNotice` in `src/custom-agent.ts`), and the last step offers only `eval_report`, as the agent loop does with `agent_report`.

### Arms

- `--instructions agent:email`: the email agent's text as shipped in the image, read through the plugin registry (`src/plugin-registry.ts`, the `plugins/` directory beside `dist/`). Another agent type the registry resolves is accepted, but it still gets only the four Gmail tools, not its own.
- `--instructions skill:<key>`: a plugin skill's text (`core/<id>` or just `<id>`), under one base line, for the future `email-search` skill.
- `--model fast|standard`: a tier (or `strong`, once the policy configures one), called through the same `ModelRouter` the gateway builds, so Anthropic-mapped models go direct when the gateway's key is set. The model is resolved as `runAgentType` resolves it, with `--model` standing in for the tier the coordinator may ask for: a registry-pinned host model wins, else `--model`, else the agent's own tier, else the policy's default tier (`resolveAgentModel` over `config/model-policy.json`). A skill arm has no agent tier, so without `--model` it gets the policy default; the coordinator's main model is not one of the choices.
- `--max-steps N`: model calls per task. Default: the agent's `limits.models` from `plugins/core/plugin.json` (10 for the email agent), or 40 for a skill.
- `--max-tasks N`: run only the first N tasks.

Reasoning effort is the agent's own (`medium` for the email agent), or `medium` for a skill. Output allowance is `CHIEF_MAX_OUTPUT_TOKENS`, as in the agent loop. A transient model error is retried twice.

The defaults differ between arms (the email agent gets 10 steps, a skill 40), so two arms are comparable only on the flags their summaries record; state `--model` and `--max-steps` explicitly when comparing.

### Task format

One JSON object per line on standard input. Synthetic example:

```json
{
  "id": "receipts-store",
  "kind": "collect",
  "request": "Find every monthly receipt from Example Store this year",
  "accounts": ["primary"],
  "expected": [
    { "account": "primary", "messageId": "18c0ffee0000a001", "bodyChars": 2400 }
  ],
  "answerContains": ["monthly"]
}
```

`kind` is `collect` (find all of a set) or `lookup` (find one fact). `expected` lists at least one message, each once and in one of the task's `accounts`. `bodyChars`, optional, is the true length of the message's body text as the task builder measured it. A malformed line, a repeated task ID or an empty input refuses the whole run. The error gives the line number, the field path and the issue code only (for example `expected.0.messageId: invalid_string`), never a received value.

### Scoring

Deterministic; no judge model. Keys are account plus lowercased message ID, and a thread ID is not a message ID.

- **found**: expected messages listed in `eval_report.messageIds`.
- **surfaced**: expected messages that appeared, with their metadata, as a row of any `gmail_search` result the model received (after projection; if projection ever reduces a page to an excerpt, rows are read from the excerpt text).
- **surfacedIdOnly**: expected messages that appeared only as rows without metadata (rows carrying `detail`, such as one the request budget left unretrieved), counted separately and not as surfaced.
- **readable**: expected messages whose body the model received as real text. Only text from `gmail_thread` entries and `gmail_read` results for that message ID counts, after projection, not reduced to an excerpt and not flagged `bodyless`. Two rules decide, per message:
  - **With `bodyChars`** (measured): the distinct texts the model received for the message add up to at least half of `min(bodyChars, 20000)`. A continuation read adds to the total; a repeated read of the same text does not, and a thread's cut of a body that a later read returned whole counts once.
  - **Without `bodyChars`** (heuristic): some text is longer than 200 characters and is not a probable snippet stand-in, that is, text of 400 characters or fewer whose first 100 characters, after decoding the common HTML entities and collapsing whitespace, match the start of a snippet the model saw for that message in a search row. Both read tools fall back to Gmail's snippet for a message without a plain-text part, and `gmail_read` does so without saying so. This rule rests on an unverified assumption that Gmail's snippet runs to about 200 characters before entities. It misjudges a genuine plain-text email of 200 characters or fewer (and one of 400 or fewer that starts with its own snippet) as not readable, and misses a stand-in for a message the model read without first seeing it in a search. Give `bodyChars` where it matters.
  - Each task line and the summary report how many expected messages were scored each way (`scoredByBodyChars`, `scoredByHeuristic`).
- **extra**: reported messages that were not expected.
- **answerHits**: `answerContains` strings found in `eval_report.answer`, case-insensitive.
- Per task also: searches, Gmail tool calls, tool errors by code, `budgetExhausted` (a call refused by the Gmail request budget, or a search row left unretrieved by it), model calls, input, output and cached tokens, cost when the provider reports it, wall time, and why the task ended: `reported`, `step_limit`, `unreported` (the model answered without a tool call) or `error` (class only, never provider text).

The summary line has aggregates only: tasks, total expected, found, surfaced and readable totals and rates, ID-only surfaced, messages scored by `bodyChars` and by the heuristic, tasks fully found, extras, answer hits, searches per task (median, max), Gmail calls, tool errors by code, budget-exhausted tasks, endings, model calls, tokens, cost, wall time and the arm: flags, plugin or skill version, a short hash of the instruction text, model ID and route.

### How to run

The tasks file stays in the private operations folder; it is piped through `docker exec -i` and never written on the host:

```sh
ssh -F "$OPS/ssh_config" chief-lightsail "sudo -n docker exec -i hermes-companion-gateway-1 node dist/email-eval.js --instructions agent:email" < "$OPS/email-eval/tasks.jsonl" > "$OPS/email-eval/$(date +%F)-agent-email.jsonl"
```

It makes paid model calls: up to `--max-steps` model calls per task (10 for the email agent), and up to three times that if every call fails transiently and is retried, plus Gmail requests within each task's budget.

### Privacy

- Tasks name real requests and message IDs. They come in on standard input and are never written to disk by the script; the per-task output lines repeat them and stay in the private operations folder.
- `docker exec` output goes to the operator's terminal, not the container log. Nothing is written to the database; Gmail is only read.
- Only the summary line's aggregates belong in the repository. Examples in this repository are synthetic.
- If the direct Anthropic call falls back to OpenRouter, the router's structural `model.provider_fallback` line is printed among the output lines.

### Differences from a real agent run

The eval reproduces the tool results an agent receives, not the whole run. Known differences:

- **Message assembly.** A real run's messages come from `context()` in `src/context.ts`: the instructions followed by an "Explicit memories" line and stable configuration in the opening system message, the runtime state as a trailing system message rebuilt on every call (with the Singapore time and a count of omitted or compacted results), and older tool results compacted to source-linked excerpts as the turn grows. The eval sends its fixed opening messages and every tool result in full.
- **Report contract.** A real run appends `FINDINGS_CONTRACT` to the instructions and ends with `agent_report`, which the host checks. The eval replaces that with a note and `eval_report`, which it checks only against its schema.
- **Tools.** `finish_turn` and `observation_read` are not offered. `gmail_recall` is not offered, although real runs offer it when the mail index is on. Any agent type gets only the four Gmail tools.
- **Retries and allocations.** A real run retries a transient Gmail read failure; the eval reports it as a tool error. A real run consumes one model call of its allocation per attempt, retries included; the eval's step count ignores retries. There is no time allocation, no tool-call allocation (the email agent's is 24) and no repeated-failure refusal.
- **Search cache.** A fresh cache per task, against the gateway's shared five-minute cache.
- **Model and effort.** Resolved as `runAgentType` resolves them, with `--model` standing in for a coordinator's tier. A coordinator's own choice of tier or effort for a given brief is not modelled, nor is the brief it would write: the request goes in verbatim as the objective.
- **No conversation.** No history, memories or other turns.

### Limits

- Because of the differences above, absolute numbers are not those of a live conversation. Arms are comparable with each other only under the same flags, on the same tasks, and only for what the eval reproduces: the tools, their results and the instructions.
- `readable` keys on `gmail_thread` and `gmail_read` result shapes. A new reading tool or result shape in Phase 1 needs the scoring updated in the same change.
- `found` needs the exact message ID; a reported thread ID does not count.
- Expected IDs come from the operator. A message missing from `expected` counts as extra when reported.
