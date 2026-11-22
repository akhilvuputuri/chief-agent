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

> **Update, 22 November 2026 ([journal 204](journey/204-email-search-redesign.md)):** the owner's direction for every phase: assume the model is capable and do not restrict it. The tools offer capability; a limit stays only for safety or to shape one result when the model can fetch the rest. Under it, Phase 1 removed the request budget rather than keeping it as a backstop. Phase 1 is described below.

## Phase 1: tools

Written 22 November 2026 ([journal 204](journey/204-email-search-redesign.md)). Code: `src/gmail.ts`, `src/observations.ts`, `src/protocol.ts`, `src/tool-errors.ts`, the tool descriptions in `src/runtime.ts`, and `plugins/core/agents/email.md`.

### What changed

- **Readable bodies.** `gmail_read` and `gmail_thread` return the `text/plain` part when it has content, otherwise the HTML part converted to reading text by `readerText` in `src/gmail.ts`, marked `fromHtml`: comments and script, style, head, title and noscript content dropped; tags stripped before entities are decoded, so an escaped address such as `&lt;name@example.com&gt;` stays text; block boundaries (paragraphs, line breaks, divs, list items, headings, table rows) kept as line breaks and table cells as tabs, so a receipt's line items stay one per line; runs of spaces and of line breaks collapsed; invisible characters and lone surrogates removed. Quoted, forwarded and bottom-posted content and signatures are included: only the mail index (`indexBody`, unchanged) cuts HTML at the first quote container, because it wants only what a message adds. Link text is kept; link targets are not shown yet. HTML is converted to text only: never executed, and no link, image or attachment is fetched. `bodyless` now means a message has neither part; its snippet (at most 200 characters) stands in, and `fromHtml` is never set on it.
- **Sizes.** `gmail_read` shows 20,000 characters of one message and continues with `offset`; a cut result carries `truncated`, `nextOffset` and `totalChars`. `gmail_read` with `messageIds` reads 1 to 25 messages in one call, sharing 50,000 characters fairly, each with its own `truncated` and `nextOffset`; a message that fails or is rate limited carries a `detail` instead of text. A `messageId` read keeps its earlier result shape, with optional new fields only, and returns From, To, Cc, Subject and Date in full; batch-read and thread entries keep the search-row caps and say so. An offset at or past the end returns empty `text` with a `note` and `totalChars`, and a message with neither a body nor a snippet returns empty `text` with a `note`, so a placeholder is never presented as message text. `gmail_thread` shows up to 50 messages, 20,000 characters each and 50,000 in total, shared fairly, and lists every message after the 50th by ID and received time in `omittedMessages`, whatever the thread's length. Every cut, `nextOffset` and header cap lands on a code-point boundary, and an `offset` inside a surrogate pair starts at its first half, because Postgres refuses lone surrogates in stored results.
- **Projection.** `src/observations.ts` has per-operation limits. For `gmail_search`, `gmail_thread` and `gmail_read` a field may be 20,000 characters and a result 110,000 before it is excerpted; every other tool keeps 8,000 and 12,000. The adapter shortens the longest text, then drops trailing entries, until a result serialises below 108,000, so the untrusted-content warning stays the first field; dropped search rows and thread messages are listed in `omittedMessages`, and the search hint says to read them with `messageIds`. A single read's full headers are sender-controlled, so they are fitted first: when the result would not fit, they are levelled down evenly (escaping counted, cuts on code points) to the room the rest leaves, aiming to keep about 40,000 serialised characters, and named in `headersTruncated`; the body is shortened only after that, by its own escaping ratio. Ordinary headers are never cut, and the body keeps its full 20,000 characters unless it is itself escape-dense.
- **Search.** `pageSize` defaults to 20 and goes up to 100, Gmail's own default page. A page's metadata comes from Gmail batch requests of at most 50 parts, so a page costs one list request plus one batch request per 50 rows instead of 1 + N; a failed batch or a part it did not answer is fetched once on its own, four at a time. Each row adds `received` (Gmail's `internalDate`, ISO in Singapore time), `category` (primary, social, promotions, updates, forums) and `folder` (inbox, archived, sent, spam, trash). A maximal 100-row page serialises to about 88,000 characters (measured, synthetic). An empty page returns a `hint` saying the result does not show the email is absent and how to broaden; a page with `nextPageToken` says to follow it. Gmail leaves spam and trash out of a list unless `includeSpamTrash` is set, whatever the query says, so it is set when the query, outside quoted text, contains `in:anywhere`, `in:spam`, `in:trash`, `label:spam` or `label:trash` at the start of a token; a negated form (`-in:spam`) leaves the default, which already excludes them. The result says `includeSpamTrash: true` when it was set.
- **Dates.** Gmail reads a calendar date in `after:`, `before:`, `older:` and `newer:` as midnight Pacific time. An operator at the start of a token (optionally negated) has its date sent as epoch seconds at Singapore midnight, `older:`/`newer:` as `before:`/`after:`; relative forms, numeric values, quoted text and dates that would give a non-positive epoch are left alone. The result echoes the query sent and, when it differs, `requestedQuery`. Gathering opts out to keep its query text.
- **Request budget removed.** The per-run Gmail budget (40 requests) is gone for model tools and host callers alike. Journal 23 added it as the host-enforced form of "stop after about three searches", to steer rather than for safety; runs are bounded by their own tool, model and time allocations, and Gmail enforces its quota.
- **Rate limits.** A 429, or a 403 whose reason is a rate or quota limit (`rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, the ErrorInfo reason `RATE_LIMIT_EXCEEDED`), is `RATE_LIMITED`, retryable, "Wait a few seconds and retry". `dailyLimitExceeded` is `RATE_LIMITED` but not retryable, and says Google's daily quotas reset at midnight Pacific time. Before, both read as "reconnect if authorization expired" and mapped to `AUTHORIZATION_REQUIRED`. Missing scopes and other 403s still do. A rate-limited batch part or batch-read message degrades its own row and is not fetched again at once. The mail index pauses on the new error as it did on a "(403)"/"(429)" message.
- **Instructions.** The email agent prompt, the personal-assistance skill (version 6) and the tool descriptions state what the tools do and the facts a searcher needs: operators, Singapore dates, readable HTML, paging, batch reads, and that an empty narrow search does not prove absence. "At most three searches" and "anchor on an exact quoted phrase" are gone.
- **Internal callers.** Gathering, mail recall's keyword searches, the daily briefing and the mail-recall eval pass `pageSize: 10`, as before.
- **Unchanged safety.** Gmail stays read-only (the strict schema test stands), owner-only, identity-checked per mailbox with no fallback to the other one; IDs are validated before any URL; requests refuse redirects; the response guards and MIME limits stand; the untrusted-content warning leads every result; responsibility investigations still read one confirmed message per call. The warning stays the first key whatever a sender puts in the headers or body. An unattended parcel record cuts a read's full sender and subject to the parcel schema's 200 characters (code-point safe), within `parcel_updates.source_ref`'s size constraint.

### Remaining limits

| Limit                                                     | Value                                                                                                                                                                                            | Class                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Response guards                                           | 2 MB per response, 29 MB for attachment messages                                                                                                                                                 | Safety                                                                                    |
| Attachments                                               | 20 MB file, 28,000,000 encoded characters                                                                                                                                                        | Safety                                                                                    |
| MIME walk                                                 | 200 parts, depth 16                                                                                                                                                                              | Safety                                                                                    |
| ID format                                                 | hexadecimal, up to 64 characters                                                                                                                                                                 | Safety                                                                                    |
| Request timeout                                           | 15 s                                                                                                                                                                                             | Safety                                                                                    |
| Error body read                                           | 65,536 bytes, only for 403/429, to classify the refusal                                                                                                                                          | Safety                                                                                    |
| Concurrent single fetches                                 | 4                                                                                                                                                                                                | Other: Gmail's per-user concurrency                                                       |
| Batch size                                                | 50 parts                                                                                                                                                                                         | Other: Google's advice                                                                    |
| Search cache                                              | 5 minutes, 50 entries                                                                                                                                                                            | Other: repeated queries                                                                   |
| Page size                                                 | 20 default, 100 max                                                                                                                                                                              | Result size; next page via `nextPageToken`                                                |
| Single read                                               | 20,000 characters                                                                                                                                                                                | Result size; rest via `offset`/`nextOffset`                                               |
| Batch read                                                | 25 IDs sharing 50,000 characters                                                                                                                                                                 | Result size; rest per message via `nextOffset`, more IDs in another call                  |
| Thread                                                    | 20,000 per message, 50,000 total, 50 messages                                                                                                                                                    | Result size; rest via `nextOffset`, later messages via `omittedMessages`                  |
| Header caps in search rows, batch-read and thread entries | from/to 120, subject 160, snippet 120, date 40                                                                                                                                                   | Result size; a single-message `gmail_read` returns From, To, Cc, Subject and Date in full |
| Single-read headers                                       | in full; under an oversized result levelled to the room left, aiming for about 40,000 serialised characters (escape-dense headers can end shorter; see journal 204), named in `headersTruncated` | Safety: keeps the warning first against sender-controlled headers                         |
| Parcel record sender and subject                          | 200 characters                                                                                                                                                                                   | Safety: the parcel schema and `source_ref` size constraint                                |
| Briefing digest lines                                     | subject 160, sender 80                                                                                                                                                                           | Result size: a briefing line, not a tool result                                           |
| Attachment name                                           | 120 characters                                                                                                                                                                                   | Result size: a display name                                                               |
| Page token                                                | 1,000 characters                                                                                                                                                                                 | Result size                                                                               |
| Snippet stand-in                                          | 200 characters                                                                                                                                                                                   | Result size: Gmail's whole snippet                                                        |
| Projection                                                | 20,000 per field, 110,000 total; the adapter fits to 108,000                                                                                                                                     | Result size; dropped entries in `omittedMessages`, the full result via `observation_read` |
| Body conversion bound                                     | 2,000,000                                                                                                                                                                                        | Result size: the response guard                                                           |
| Mail index                                                | 100 IDs per page, 12,000 characters of text                                                                                                                                                      | Result size: the host-driven index                                                        |
| Mail index quota pause                                    | 60 s, up to 5 consecutive pauses                                                                                                                                                                 | Other: Gmail quota handling, unchanged                                                    |
| Mail recall                                               | 1 to 3 keyword searches, 10-hit page                                                                                                                                                             | Other: the fusion was measured with these                                                 |
| Gathering, briefing, eval                                 | 10-hit page                                                                                                                                                                                      | Other: unchanged by design in this phase                                                  |

The email agent's own allocation (24 tool calls, 10 model calls, 150 seconds) is a routing setting for Phase 2, not part of the tools.

### Tested and not measured

Tested with mocked Gmail (`tests/gmail.test.ts` and the caller suites): HTML-only reads and threads; offset continuation reassembling the exact text, including across an emoji; batch reads with a failing, rate-limited or over-sized message and fair shares; batched search metadata, a failed batch and failed or rate-limited parts; 100-row pages in two batches inside the projection with the warning first; rows the fit drops listed in `omittedMessages`; the date rewrite and its token rule; the empty-page hint; every rate-limit and permission 403 shape for search, thread and read; the mail index pausing on a real 429; internal callers' page sizes; no request refused across 150 searches and 250 reads in one run.

Measured, tools only, read-only against the real mailbox on 22 November 2026 (run by the coordinator on the reviewed builds): on `03b028a`, a 50-row search returned 50 rows with metadata in two requests and a 12-message batch read returned 12 HTML-converted bodies; on `2907c5a`, a 100-per-page search, twelve more searches and a 12-message batch read ran with nothing refused, HTML bodies came back converted, no result held a lone surrogate, and offset continuation worked.

Not measured: whether the email agent now finds the 13 receipts or how the eval scores move (no baseline or Phase 1 run of the eval yet); Gmail's per-user quota under heavy paging; model token cost per email task.

## Eval

`src/email-eval.ts` is an operator-run script, following [the mail recall eval](mail-recall.md#eval). It runs inside the production gateway container, reads the private tasks from standard input, and prints one private line per task and a summary line.

### What it runs

For each task it runs a model in a tool loop over the real Gmail tools: `GmailTools.call` with its per-run request budget, result fitting and untrusted-content warning. Every result passes through `projectObservation` before the model sees it, as in the agent loop, so each tool result is the one an agent would receive; the conversation around it is simpler (see [differences from a real agent run](#differences-from-a-real-agent-run)). Tool names, descriptions and parameter schemas come from `runtimeContext` (`src/runtime.ts`, schemas in `src/protocol.ts`), and calls are validated by the runtime's own `action` schema, so the eval follows later tool changes. The tools offered are `gmail_accounts`, `gmail_search`, `gmail_thread` and `gmail_read`, plus one eval-only tool, `eval_report({messageIds: [{account, messageId}], answer})`, which ends the task. A valid `eval_report` ends the task at once: the other calls of the same step are not dispatched, because their results would never reach the model, and they are counted as `skippedWithReport` rather than as searches, reads, surfaced or readable messages. An invalid one is refused like any tool error, and the step's other calls run and are returned with it.

`gmail_recall` is not offered. Its mail index tops itself up and prunes old messages on every call, both database writes, so a `--recall` flag was not cheap without one.

Each task runs under its own run ID, so the 40-request Gmail budget applies per task as it does per agent run. Each task also gets a fresh Gmail client, so the five-minute search cache does not carry from one task to the next; in the gateway that cache is shared by every run.

> **Update, 22 November 2026 ([journal 204](journey/204-email-search-redesign.md), Phase 1):** the per-run Gmail request budget no longer exists, so a task's run ID now only names it. The eval passes `pageSize`, `messageIds` and `offset` to `GmailTools.call` exactly as `src/tools.ts` does, after the runtime's own schema validates them.

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
    {
      "account": "primary",
      "messageId": "18c0ffee0000a001",
      "bodyChars": 2400,
      "htmlOnly": true
    }
  ],
  "answerContains": ["monthly"]
}
```

`kind` is `collect` (find all of a set) or `lookup` (find one fact). `expected` lists at least one message, each once and in one of the task's `accounts`. `bodyChars`, optional, is the true length of the message's body text as the task builder measured it; `htmlOnly`, optional, is `true` when the message has no `text/plain` part. A malformed line, a repeated task ID or an empty input refuses the whole run. The error gives the line number, the field path and the issue code only (for example `expected.0.messageId: invalid_string`), never a received value.

> **Update, 22 November 2026 ([journal 204](journey/204-email-search-redesign.md), Phase 1):** `htmlOnly` means the message has no non-empty `text/plain` part, which is what the read tools test; an empty plain part would otherwise have let a snippet stand-in be credited. The current tools flag every stand-in `bodyless` themselves, so `htmlOnly` matters only when scoring results from tool versions before Phase 1.

### Scoring

Deterministic; no judge model. Keys are account plus lowercased message ID, and a thread ID is not a message ID.

- **found**: expected messages listed in `eval_report.messageIds`.
- **surfaced**: expected messages that appeared, with their metadata, as a row of any `gmail_search` result the model received (after projection; if projection ever reduces a page to an excerpt, rows are read from the excerpt text).
- **surfacedIdOnly**: expected messages that appeared only as rows without metadata (rows carrying `detail`, such as one the request budget left unretrieved), counted separately and not as surfaced.
- **readable**: expected messages whose body the model received as real text. Only text from `gmail_thread` entries and `gmail_read` results for that message ID is considered, after projection, not reduced to an excerpt. Two steps decide, per message.
  - **Which received texts are the body**, in this order:
    - a result flagged `bodyless` never counts;
    - a text flagged `fromHtml` counts: a tool converted the body from HTML (Phase 1 adds the flag; today's tools never set it);
    - when the task gives `htmlOnly` (from the builder): with `true`, an unflagged text is Gmail's snippet stand-in and does not count, since a plain-text-only tool cannot have returned that body; with `false`, it counts. The snippet guess below is not used;
    - only when `htmlOnly` is absent, a guess: a text does not count when it is a probable snippet stand-in, that is, text of 400 characters or fewer whose first 100 characters, after decoding the common HTML entities and collapsing whitespace (and dropping a half entity at the end of the search row's snippet), match the start of a snippet the model saw for that message in a search row. `gmail_thread` flags a message without a plain-text part `bodyless`, while `gmail_read` returns Gmail's snippet in its place without saying so; the guess is what tells them apart without the builder. It rests on an unverified assumption that Gmail's snippet runs to about 200 characters before entities. It cannot tell a stand-in from a genuine plain-text email of 400 characters or fewer that starts with its own snippet, so it counts that email as not readable even with `bodyChars`; and it misses a stand-in longer than 400 characters, or for a message the model read without first seeing it in a search.
  - **Then the length rule** over the texts that count:
    - with `bodyChars` (measured): the distinct texts add up to at least half of `min(bodyChars, 20000)`. A continuation read adds to the total; a repeated read of the same text does not, and a thread's cut of a body that a later read returned whole counts once;
    - without `bodyChars`: some text is longer than 200 characters, so a genuine email of 200 characters or fewer is not readable.
  - Give both `htmlOnly` and `bodyChars` where they matter: together they decide every case from the builder's facts, and `htmlOnly: false` with `bodyChars` makes a short genuine email readable.
  - Ceiling with today's tools: the observation projection cuts a `gmail_read` text to 8,000 characters, so the model receives at most 8,000 characters of a body, and a message whose `bodyChars` is over 16,000 cannot count as readable until the tools change.
  - Each task line and the summary report how many expected messages were scored by each length rule (`scoredByBodyChars`, `scoredByHeuristic`) and by whose signal the body was decided (`bodyByBuilder` with `htmlOnly`, `bodyByGuess` without).

> **Update, 22 November 2026 ([journal 204](journey/204-email-search-redesign.md), Phase 1):** scoring follows the Phase 1 result shapes. **surfacedIdOnly** also counts IDs listed in a search's or a thread's `omittedMessages`, which the model saw without metadata. **readable** reads a batch `gmail_read` result's `messages[]` as well as single reads and thread entries; an entry carrying `detail` (not retrieved) or flagged `bodyless` is never a body, and `fromHtml` is now set by the tools. Under `bodyChars`, a text from a current tool result is placed at its `offset` (0 when the result carries the `truncated` flag without one), so offset continuations add up and overlapping texts, such as one shortened by the adapter's fit and its continuation, count once; a text with no position, from an older or hand-made result, keeps the prefix de-duplication. The 8,000-character projection ceiling is gone: the model now receives up to 20,000 characters of a read, so any `bodyChars` can count as readable. `budgetExhausted` is removed; each task and the summary report `rateLimitedCalls` (results with code `RATE_LIMITED`) and `rateLimitedRows` (search rows and batch-read messages Gmail's rate or daily limit left unretrieved), and the summary `rateLimitedTasks`.

- **extra**: reported messages that were not expected.
- **answerHits**: `answerContains` strings found in `eval_report.answer`, case-insensitive.
- Per task also: searches, Gmail tool calls, tool errors by code, `budgetExhausted` (a call refused by the Gmail request budget, or a search row left unretrieved by it), model calls, input, output and cached tokens, cost when the provider reports it, wall time, and calls skipped beside a report (`skippedWithReport`), and why the task ended: `reported`, `step_limit`, `unreported` (the model answered without a tool call) or `error` (class only, never provider text).

The summary line has aggregates only: tasks, total expected, found, surfaced and readable totals and rates, ID-only surfaced, messages scored by `bodyChars` and by the heuristic, messages whose body was decided by the builder's `htmlOnly` and by the guess, tasks fully found, extras, answer hits, searches per task (median, max), Gmail calls, tool errors by code, budget-exhausted tasks, calls skipped beside a report, endings, model calls, tokens, cost, wall time and the arm: flags, plugin or skill version, a short hash of the instruction text, model ID and route.

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
- **Report contract.** A real run appends `FINDINGS_CONTRACT` to the instructions and ends with `agent_report`, which the host checks. The eval replaces that with a note and `eval_report`, which it checks only against its schema. A real agent loop would still dispatch the sibling calls the model makes alongside its final report, and their results go into the run's records; the eval does not dispatch them (`skippedWithReport`), because the model never sees their results.
- **Tools.** `finish_turn` and `observation_read` are not offered. `gmail_recall` is not offered, although real runs offer it when the mail index is on. Any agent type gets only the four Gmail tools.
- **Retries and allocations.** A real run retries a transient Gmail read failure; the eval reports it as a tool error. A real run consumes one model call of its allocation per attempt, retries included; the eval's step count ignores retries. There is no time allocation, no tool-call allocation (the email agent's is 24) and no repeated-failure refusal.
- **Search cache.** A fresh cache per task, against the gateway's shared five-minute cache.
- **Model and effort.** Resolved as `runAgentType` resolves them, with `--model` standing in for a coordinator's tier. A coordinator's own choice of tier or effort for a given brief is not modelled, nor is the brief it would write: the request goes in verbatim as the objective.
- **No conversation.** No history, memories or other turns.

### Limits

- Because of the differences above, absolute numbers are not those of a live conversation. Arms are comparable with each other only under the same flags, on the same tasks, and only for what the eval reproduces: the tools, their results and the instructions.
- `readable` keys on `gmail_thread` and `gmail_read` result shapes. A new reading tool or result shape in Phase 1 needs the scoring updated in the same change.

> **Update, 22 November 2026 ([journal 204](journey/204-email-search-redesign.md), Phase 1):** the scoring was updated with the Phase 1 tools for batch reads, `omittedMessages`, offsets and rate limits (see the scoring note above). The snippet-stand-in guess and `htmlOnly` now matter only for results from earlier tool versions. Any later result shape still needs the scoring updated in the same change.

> **Update, 22 November 2026 ([journal 204](journey/204-email-search-redesign.md), Phase 1):** comparing a run on the tools before Phase 1 with a run on these. `found`, `surfaced`, `extra` and `answerHits` are comparable. `budgetExhausted` has no counterpart (the budget is gone; `rateLimitedCalls` and `rateLimitedRows` are new). `surfacedIdOnly` is broader, since it now also counts IDs in `omittedMessages`. `gmailCalls` and `searches` measure effort differently: a batch read of 25 messages is one call, and a page can hold 100 rows instead of 10. `readable` uses the same rule, but the tools can now return HTML bodies as text and up to 20,000 characters instead of 8,000, and only text inside `bodyChars` counts.

- `found` needs the exact message ID; a reported thread ID does not count.
- Expected IDs come from the operator. A message missing from `expected` counts as extra when reported.
