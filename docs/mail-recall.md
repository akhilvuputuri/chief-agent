# Email memory (mail recall) — MVP

Status (25 October 2026): released with a 30-day window in `d98f912` ([PR 320](https://github.com/akhilvuputuri/chief-agent/pull/320)); the window becomes 12 months in the follow-up PR. See [journal 120](journey/120-email-memory-mvp.md) for the question it tests and its results.

## What it does

The email agent gets one more tool, `gmail_recall(query, limit?)`. It finds emails by what they were about, for requests where the owner half-remembers an email ("the one where they apologised for the late delivery") and Gmail's keyword search needs words the owner does not have. It returns up to ten messages with sender, subject, date, a similarity score and a 300-character excerpt, closest first. The agent confirms a result with `gmail_thread` before reporting it; the closest result is not necessarily a match.

This is retrieval-augmented generation: the host retrieves the relevant emails, and the email agent answers from them with message and thread references.

## Scope

- **Mailbox:** the primary account only.
- **Mail:** `category:primary -in:sent -in:chats -in:spam -in:trash`, received in the last 12 months, at most 3,000 messages. Older mail leaves the index as it ages past 12 months. The first release used 30 days: 119 messages and 65,925 embedding tokens, built in 40 seconds. That fits in one prompt, so the window was widened to a size where retrieval is needed.
- **Text:** the plain-text part, or the HTML part as display text (`indexBody` in `src/gmail.ts`). Quoted earlier messages are dropped (`withoutQuotes`). Attachments are not read.
- `gmail_search` stays the tool for exact senders, subjects, dates, older or archived mail and the second account.

## How it works

`src/mail-recall.ts`:

1. **Backfill.** After the gateway starts, `MailIndex.start()` lists the window's message IDs (`GmailTools.indexPage`), then fetches and embeds them oldest first in groups of ten. These host reads are outside the per-turn Gmail request budget, but they share Gmail's per-user quota with the email agent: 6,000 query-cost units a minute (`totalQueryCostPerMinutePerUser`). So messages are read one at a time, about two a second.
   - On a 403 or 429 quota refusal, reading pauses for a minute and the message stays queued; five consecutive pauses without a successful read fail the build.
   - A message is marked indexed only when all its chunks are embedded.
   - A message that cannot be read for another reason is retried once, then left out and counted.
2. **Chunks.** Each body is split into chunks of 1,500 characters with 200 characters of overlap, at most six per message. Every chunk is prefixed with From, To, Date and Subject, so a chunk alone is findable.
3. **Embeddings.** OpenRouter's `/embeddings` endpoint with the existing OpenRouter key, model `openai/text-embedding-3-small`, one request per group. Vectors are cut to their first 512 values and re-normalised; text-embedding-3 models are trained to allow that. The query embedding and the top-up are part of the turn and are recorded in its spending ledger as `openrouter-embeddings`. A build, including a rebuild a turn triggers, runs outside any turn: it is not in the ledger, and `mail_index.built` logs its reported prompt tokens instead.
4. **Storage.** In the gateway's memory only. Nothing is written to Postgres or disk, so there is no migration. The index is rebuilt after every restart.
5. **Top-up on use.** Each `gmail_recall` first lists mail received since the previous listing (`after:`, with an hour of overlap) and queues it, oldest first. It then indexes up to 50 queued messages, within 10 seconds. Queued mail is never dropped: anything left waits for the next call, and the result says some recent mail is not indexed yet.
6. **Search.** The query is embedded and compared with every chunk (cosine similarity, brute force). Each message scores as its best chunk.

While the index is building, or after a failed build, the tool returns `building` or `unavailable` with a hint to use `gmail_search`. A failed build keeps what it indexed, and a call at least five minutes after the failure resumes it. The gateway logs:

- `mail_index.built`: message count, messages left out, duration and prompt tokens;
- `mail_index.failed`: error class, which dependency failed (Gmail or OpenRouter) and its HTTP status.

## Privacy

- The index sends the text of every message in the window to the embedding provider through OpenRouter, not only the messages the agent reads. The owner accepted this for the MVP on 25 October 2026. The agent's own model calls already send the emails it reads.
- The index itself (bodies, chunks and vectors) stays in gateway memory. It is never written to Postgres, the operational log or the repository.
- What `gmail_recall` returns to the agent is stored like every other Gmail tool result (`runtime_calls`): the query and up to ten senders, subjects, dates and 300-character excerpts.
- Results carry the untrusted-content warning, and email text remains data, never instructions.

## Configuration and availability

- `MAIL_INDEX` in `config/runtime.json` (`on` or `off`; `on`, matching the code default). Production Compose does not pass it, so the file is authoritative. Set it to `off` in a PR to stop the index on the next release.
- The index runs only with `MAIL_INDEX=on`, a connected primary Gmail account and an OpenRouter key. Otherwise `gmail_recall` is not offered.
- `gmail_recall` is a delegated email-agent tool. It is in the host's `OPTIONAL_OPERATIONS` (`src/plugins.ts`), so the email agent stays in the agent catalogue without it. Without that rule, an agent leaves the catalogue when any of its tools is unavailable.

## Eval

`node dist/mail-recall-eval.js [questions]` runs inside the production gateway container through the operator connection:

```sh
ssh -F "$OPS/ssh_config" chief-lightsail "sudo -n docker exec hermes-companion-gateway-1 node dist/mail-recall-eval.js 30" > "$OPS/mail-recall/$(date +%F).jsonl"
```

- It builds its own index, samples indexed messages and has `google/gemini-3.8-flash` write a question for each. The question must not reuse the subject's or sender's words; questions that reuse two subject words or any sender word are dropped.
- For each question it compares two retrieval conditions:
  - **keyword:** up to three Gmail searches the model writes, as the email agent does today;
  - **recall:** the same searches plus `gmail_recall`'s top eight results.
- A question counts as found when the target message is among the results.
- The summary reports `keywordRate`, `recallRate` (keyword plus `gmail_recall`), `recallAloneRate` (`gmail_recall` by itself) and `recallExtra` (questions only `gmail_recall` found).
- It measures retrieval, not the agent's final answer. Owner-written questions and live Telegram checks cover the end-to-end behaviour.
- Its output contains private questions and subjects. `docker exec` output goes to the operator's terminal, not the container log. Keep it in the private operations folder. Only the summary line's aggregates belong in the journal.
- Cost: about two Flash calls per question plus embeddings, well under a dollar for 30 questions (estimate).

## Not in the MVP

- persistence;
- background sync;
- attachments;
- the second account;
- keyword fusion and reranking;
- long-context and extra-search comparison arms.

Persistence would need an additive migration through the reviewed operator rollout ([operator procedure](cloud-development.md)).
