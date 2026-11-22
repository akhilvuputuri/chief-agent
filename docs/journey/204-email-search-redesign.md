# 204 — Why did Chief miss most of a set of receipt emails, and how will a redesign be measured?

Work date: 2026-11-22. Written: 2026-11-22.
Status: in progress. Phase 0, the eval, is written and tested with a fake Gmail and a scripted model; it has not been run against the real mailbox, so there is no baseline yet. Phases 1 to 4 are planned. (Updated 22 November 2026: Phase 1, the tools, is reviewed and tested, not released; see the last update below.) (Updated 22 November 2026: Phases 0 and 1 are live in `4ee82e6`, with the eval run before and after Phase 1; see the release closure below.) (Updated 22 November 2026: Phase 2 is live in `bb3c399` and measured on the eval; Phase 3, part 1 is tested, not reviewed or released; see the last update below.) Design: [email search](../email-search.md).

## User-visible problem and preceding iteration

The owner asked Chief for every monthly receipt from one store. The email agent ran one search of the primary mailbox and reported 4 of the 13 that exist (measured, production, 22 November 2026).

This builds on [27 — Separate Gmail accounts](27-multiple-gmail-accounts.md), which set up explicit mailbox routing, and [120 — Email memory MVP](120-email-memory-mvp.md), which added `gmail_recall` for emails the owner only half remembers. Neither changed how a search for a whole set of emails, or a read of an HTML-only email, works.

## Evidence

**Measured, production traces over the 90 days to 22 November 2026, counts only:**

- 13 of 29 email-agent runs made exactly three searches, the most its instructions allow.
- 13 of 52 messages opened through `gmail_thread` had no plain-text body.
- 29 of 72 searches had further pages.
- All 24 `gather_search` calls returned zero results.
- `gmail_recall` was never called in a real conversation.

**Read from the code at `4668853`:** `gmail_read` and `gmail_thread` return only the `text/plain` part, so an HTML-only email becomes its snippet (`plainBody`, `src/gmail.ts`). A search page costs 11 of a turn's 40 Gmail requests. The email agent's instructions (`plugins/core/agents/email.md`) say "at most three searches" and to anchor on an exact quoted phrase.

**Reported, research on 22 November 2026:** eight open-source Gmail connectors and Google's Gmail MCP reference server pass queries through as written, convert or return HTML bodies, cap bodies at 20,000 characters or not at all, do not cap searches, and leave email to the main agent.

## Diagnosis and alternatives

Hypothesis, to be measured by the eval: three causes compound. A small-model agent told to stop after three searches and to anchor on a quoted phrase stops early on a request for a set; the request budget makes further pages expensive; and an HTML receipt the agent does open shows it only a snippet. The traces show each cause occurring, not how much each costs on its own.

Fixing them one at a time without a fixed measure would leave each step judged by anecdote, so Phase 0 is a replayable eval, run before and after every later phase on the same private tasks. A judge model was rejected for scoring: whether the expected message IDs were surfaced, read as real text and reported can be checked exactly.

The plan (owner approved the coordinator reading email text and the invoice collector change on 22 November 2026): 1, tool fixes (HTML to text, larger pages and bodies, batched metadata, budget as a backstop only, batch read, empty-result guidance); 2, the coordinator gets the Gmail tools and an `email-search` skill and the email agent is retired; 3, the invoice collector stops owning email search and can save HTML receipts as files; 4, `gmail_recall` judged on the same eval.

## Implementation and review

`src/email-eval.ts` runs each task in a tool loop over the real `GmailTools.call` and `projectObservation`, with tool definitions from `runtimeContext`, the email agent's shipped instructions or a plugin skill, and a model resolved through the model policy and called through `ModelRouter`. An eval-only `eval_report` tool ends a task. Scoring is in [email search](../email-search.md#scoring), including the conservative definition of `readable`. `gmail_recall` is left out because its index writes to the database on every call.

Tests: `tests/email-eval.test.ts`, with the real `GmailTools` over a fake Gmail and a scripted model (tested): found, surfaced, readable and extra counts; an HTML-only message counted as not readable both through `gmail_thread` (`bodyless`) and `gmail_read` (snippet stand-in); a task that spends the request budget; a step-limit stop whose last call offers only the report tool; malformed input refused; a summary without request text or IDs; arms resolved from the runtime and the shipped plugin.

Independent review: pending.

> **Update, 22 November 2026:** the independent review of `ec53d6e3` requested changes. `gmail_read` falls back to Gmail's whole snippet without a `bodyless` flag, and HTML entities can take a snippet past 200 characters, so a stand-in could count as readable. A task may now give each expected message its true `bodyChars`, which decides readability by how much of the body the model received; without it a tightened heuristic also rejects short text that starts like a snippet the model saw, and each line and the summary say how many messages were scored each way. Search rows without metadata count as `surfacedIdOnly`, not surfaced. Task errors give only the line, field path and issue code. Message IDs are compared in lower case. The model tier now resolves as `runAgentType` resolves it. The design doc lists the differences from a real agent run. Tests were added for each case (tested). Re-review pending.

> **Update, 22 November 2026:** two automated-review findings on `81aa9c57`, both affecting baseline numbers. Gmail calls made in the same step as `eval_report` were scored as surfaced or read although their results never reached the model; a valid report now ends the task before its sibling calls are dispatched, and they are counted as `skippedWithReport`. Under `bodyChars`, Gmail's snippet returned by `gmail_read` for a short HTML-only email could reach half the body length and count as readable, while `gmail_thread` flags the same message `bodyless`; a probable snippet stand-in now counts for nothing in either rule. Tests were added for both and for the prefix de-duplication, `bodyless` under `bodyChars` and a registry-pinned host model (tested).

> **Update, 22 November 2026:** the delta review of `24d67347` requested changes: checking for a snippet stand-in before the length rule made a genuine plain-text email of 400 characters or fewer, found by search and then read, unreadable even when `bodyChars` vouched for it, and a stand-in and a short real email cannot be told apart from the text. A task may now give each message `htmlOnly` from the builder: `true` makes an unflagged text a stand-in, `false` makes it count, and the snippet guess is used only without it; a text a tool flags `fromHtml` (Phase 1) counts. Lines and the summary report `bodyByBuilder` and `bodyByGuess`. Tested, with the reviewer's 321-character probe.

## Verification and outcome

Tested only. No run against the real mailbox and no paid model call has been made, so there is no baseline. The eval is a simplified loop, not the runtime; its limits are listed in the design doc.

## Follow-up and next iteration

- Write the private task set (the receipts request and others) in the operations folder and run the baseline with `--instructions agent:email`.
- Phase 1 tool changes, re-run on the same tasks. If Phase 1 adds a reading tool or changes result shapes, the `readable` scoring changes with it.

> **Update, 22 November 2026 — Phase 1, tools (branch `fix/gmail-tools`):** implemented, independently reviewed through three rounds, tested; not released, and the eval has not been run on it. Design and the full list of remaining limits: [email search, Phase 1](../email-search.md#phase-1-tools).
>
> **What changed.** `gmail_read` and `gmail_thread` read HTML-only mail as converted text (`fromHtml`), with `bodyless` only for a message with neither part. `gmail_read` shows 20,000 characters and continues with `offset`, or reads 1 to 25 `messageIds` sharing 50,000; threads show 20,000 per message, 50,000 in total and 50 messages, listing later ones in `omittedMessages`. Email results get their own projection limits (20,000 per field, 110,000 per result), which also fixes `gmail_read` advertising 16,000 characters while the projection cut it to 8,000. Search pages default to 20 and go up to 100, with metadata from Gmail batch requests (one list request plus one batch per 50 rows instead of 1 + N), received time, category and folder per row, calendar dates sent as Singapore midnight, and guidance on an empty page. The email agent prompt and the skill describe capabilities instead of "at most three searches" and "anchor on an exact quoted phrase". Internal callers keep ten-hit pages.
>
> **The owner's direction (22 November 2026).** Assume the model is capable; limits stay only for safety or to shape one result when the model can fetch the rest. Under it the per-run Gmail request budget was removed rather than kept as a 200-request backstop: journal 23 added it to steer, runs are already bounded by their allocations, and Gmail enforces its own quota.
>
> **What review found.** The first review of `03b028a` found that cuts at 20,000 characters, share boundaries and the size fit could split a surrogate pair, which Postgres refuses in stored results, so one emoji would fail a whole read, batch or thread on every retry; every cut now lands on a code-point boundary. It also found that a Gmail 429, or a rate-limit 403, reached the model as "reconnect if authorization expired" (`AUTHORIZATION_REQUIRED`); it is now `RATE_LIMITED` with a wait-and-retry message, and a daily quota says when it resets. The second review of `fbdeeb4` found a regression the new error type caused: the mail index recognised a quota refusal only by "(403)"/"(429)" in the message, so a rate-limited index read would have counted as the message's own failure and abandoned it after two tries instead of pausing; the index now recognises the error type, with a test that drives the real `GmailTools` with a 429. The same round added the daily and ErrorInfo rate-limit shapes, listed rows the size fit drops, and found that the search description had been trimmed to fit a 56,000-character test fixture; the description was restored and the fixture, a padding target rather than a limit, raised to 64,000. The third review approved `2907c5a`.
>
> **Measured, tools only.** On 22 November the coordinator ran the reviewed builds read-only against the real mailbox: a 50-row search returned 50 rows with metadata in two requests and a 12-message batch read returned 12 HTML-converted bodies (`03b028a`); a 100-per-page search, twelve more searches and a 12-message batch read ran with nothing refused, HTML converted, no lone surrogates, and offset continuation working (`2907c5a`). This shows the tools work on real mail; it is not an eval result.
>
> **Eval.** `src/email-eval.ts` now passes `pageSize`, `messageIds` and `offset` through as `src/tools.ts` does and scores the Phase 1 shapes: batch-read `messages[]`, `detail` entries as not read, `omittedMessages` as ID-only, offset continuations placed by offset, and rate-limited calls and rows in place of `budgetExhausted` (tested).
>
> **Not measured.** Whether Chief now finds the 13 receipts, and how found, surfaced and readable move: the eval has run neither the baseline nor Phase 1. Gmail's quota under heavy paging, and token cost per email task.

> **Update, 22 November 2026 — Phase 1 delta review of `b727a5f`:** two required fixes. A `gmail_read` at an offset at or past the end put "No text at this offset…" in `text`, and the eval counted it as body text placed at the body's end, so an 88-character email scored readable although the model received none of it. The tools now return empty `text` with the explanation in `note` (likewise for a message with neither a body nor a snippet), and under `bodyChars` the eval drops text placed at or past the body's end and clips text that runs past it; the reviewer's probe is a regression test. And a single-message `gmail_read` capped its headers like a search row, so a long subject or recipient list could not be read whole by any tool; it now returns From, To, Cc, Subject and Date in full, while batch-read and thread entries keep the short caps and say where the full headers are. The design doc now says what is and is not comparable between eval runs on the previous tools and these (tested).

> **Update, 22 November 2026 — tools review of `9f0758b`:** the full headers added in that commit opened a safety regression. Each header was cut only at the 20,000-character field limit and the size fit shortened only the body, so five quote- or control-character-dense headers, which the sender controls, could serialise to 200,000–600,000 characters and the projection would fall back to a bare excerpt whose first key is `id`, dropping the untrusted-content warning; even plain 20,000-character headers left 7,620 characters for the body. Headers are now fitted first, levelled evenly with escaping counted to the room the rest of the result leaves (never below 40,000 serialised characters) and named in `headersTruncated`, and the body's own trim now converts the excess at its escaping ratio instead of overshooting to nothing. The same review found that an unattended parcel record copied the read's now-uncut sender and subject past the parcel schema's 200-character limit, which could breach `parcel_updates.source_ref`'s size constraint; both are cut to the schema's limit. Tested with maximal quote-, control- and plain-character headers, an escape-dense body, long recipient lists left whole, and a long parcel sender and subject.

> **Update, 22 November 2026 — automated review of PR 520:** three capability losses in the read path, all from reusing the mail index's HTML conversion for reading (the coordinator's instruction, and wrong for reads: the index wants only new text, a reader wants everything). Reads cut HTML at the first quote container, so a forwarded message's content, an inline or bottom-posted reply and the signature were invisible without notice; `cleanText` decodes entities before stripping tags, so an address written `&lt;name@example.com&gt;` was removed as markup, and it collapses all whitespace, so receipt line items ran together; and search never set Gmail's `includeSpamTrash`, which defaults to false, although the prompt and the empty-page hint said `in:anywhere` includes spam and trash. Reads now use their own linear-time conversion (`readerText`: hidden content dropped, tags stripped before entities are decoded, blocks as lines and cells as tabs, the whole message including quoted and forwarded content), while `indexBody` keeps its output byte for byte (tested against the previous commit's code). `includeSpamTrash` is set when the query asks for spam or trash outside quoted text (tested; to be checked against real Gmail before merge). Known low item from the last tools review: the header fit can shorten escape-dense headers below the documented share of about 40,000 serialised characters, because it converts by an average escaping ratio; the warning-first guarantee is unaffected, and the design doc now says "about".

> **Update, 22 November 2026 — batched metadata under Gmail's burst limit:** measured, production mailbox, read-only, counts only (run by the coordinator on `1c01eb0`): after a 75-second pause, the first 50-row page had 4 of 50 rows rate limited and a 5-row page ten seconds later was clean; under heavier use, several 100-row pages within a minute, one page had 77 of 100 rows rate limited and the next list call was refused; earlier single runs of 50- and 100-row pages had none. Gmail rate-limits parts of a batch as a burst limit even in a fresh quota window, as Google's batch guide warns, and returning those rows without retrying left the model with bare IDs in ordinary use. The tools now send a page's metadata in sequential batches of 25, retry only the refused parts (or a refused batch) with exponential backoff and jitter within a 15-second window per call, retry plain calls and batch-read messages the same way, never retry a daily-quota refusal, and keep row metadata in a ten-minute per-mailbox cache so narrowing searches fetch only new rows. The `gmail_search` description says rows count against Gmail's per-user rate limit and how to fetch a rate-limited row again (tested; not yet re-measured live). 25 parts is a judgement from this measurement, not a documented figure.

## Release closure — 2026-11-22

- **Phase 0, live (measured from GitHub).** PR 519 merged as `4586732`; release run 44994632126 succeeded.
- **Phase 1, live (measured from GitHub and the production host).** PR 520 merged as `4ee82e6` on 22 November 2026; release run 45001140371 succeeded. The host reports `4ee82e6` with a healthy gateway, and the mail index loaded 1,499 messages with none omitted.
- **Review.** Independent review (Claude Opus 5.5) requested changes on `03b028a`, `fbdeeb42`, `b727a5f` (docs) and `9f0758b` (header fit), and approved `5e7913eb`. The eval's scoring was approved separately at `9f0758b`.

### Measured: the eval before and after Phase 1

Production mailbox, 22 November 2026: 15 private tasks with 144 expected emails, of which 98 have no plain-text part. The same arm both times: the email agent's instructions, `claude-haiku-5.5`, 10 steps. One run each, so task-level figures can vary between runs.

|                                              | Before (`4586732`, old tools) | After (`4ee82e6`) |
| -------------------------------------------- | ----------------------------- | ----------------- |
| Expected emails found                        | 115 of 144                    | 131 of 144        |
| Expected emails surfaced in search results   | 120 of 144                    | 144 of 144        |
| Tasks with every email found                 | 12 of 15                      | 14 of 15          |
| Lookup answers containing the expected value | 2 of 3                        | 3 of 3            |
| Searches per task, median and maximum        | 3 and 4                       | 4 and 7           |
| Unexpected emails reported                   | 16                            | 19                |
| Rate-limited calls or rows                   | not applicable                | 0                 |
| Model cost for the run                       | $0.025                        | $0.072            |

- The receipts task went from 1 of 12 to 12 of 12, with all 12 bodies read. One 17-email task went from 10 (one page) to 17.
- In the "after" run one 13-email task scored 0: the model surfaced and read all 13, then answered in plain text without calling the eval's report tool. Rerunning that task alone twice found 13 of 13 both times, so 131 understates the tools.
- `readable` is not comparable as a rate between the runs: on collection tasks the model usually answers from search rows without opening messages.

**Measured, read-only on the production mailbox with the final code before merge:** 470 result rows across seven back-to-back searches with no row missing its metadata, and twelve HTML receipts returned as multi-line text of 38 to 107 lines.

**Not measured:** the coordinator using the tools, a real Telegram turn, and token cost in real use.

### Low review items left open

- Gathering searches can include spam and trash when their query names them, so a spam PDF could become an invoice candidate. To be addressed in Phase 2.
- A search row's folder, category and unread flag can come from the ten-minute row cache, and the `gmail_search` description does not say so. To be addressed in Phase 2.
- An unclosed `<script>` or `<style>` element in HTML mail leaks its contents into the converted text.
- Rate-limit retry waits cannot be interrupted by a cancelled turn.
- The header fit shortens escape-dense headers more than needed (see the `9f0758b` update above).

> **Update, 22 November 2026 — Phase 2, the coordinator (branch `feat/email-coordinator`):** implemented and tested; not reviewed or released, and the eval has not been run on it. Design, the run-kind table, the safety and context analysis: [email search, Phase 2](../email-search.md#phase-2-coordinator).
>
> **What changed.** The Gmail tools are no longer delegated, so Chief searches and reads mail itself (`gmail_recall` with the mail index), under every picker mode. The email agent, its alias, its prompt and the grants only it used are gone; `parcels` keeps its Gmail tools, and an `agent_run` for `email` is refused with a message naming the Gmail tools. A new plugin skill, `core/email-search`, describes the tools and the facts a searcher needs; the Gmail domain guidance and one line of the instructions point to it. `observation_read` of a stored Gmail result leads with the untrusted-content warning on every page. Two low items from the Phase 1 review are addressed: gathering's searches leave `includeSpamTrash` unset (see the correction below: spam stays out because the query cannot name it), and the search description says how old a row's flags can be (up to fifteen minutes, not the ten of the review note: rows are reused for ten minutes and whole searches for five). The routing decision eval labels email messages `chief`.
>
> **Run kinds.** Foreground turns and background task passes (continuations and routine occurrences) now call the Gmail tools directly; before, they reached the same five through the email agent. Responsibility investigations still get only `gmail_read` within a confirmed scope, the daily briefing reads its digest in host code, and no other agent gained Gmail tools (tested for investigations and background passes).
>
> **Context.** The coordinator's fixed instructions, tools and configuration grow from 74,345 to 78,699 characters with every integration on. Within a turn, earlier results stay whole until about 1,080,000 characters, roughly eight maximal Gmail results; then all of them become excerpts with their `observationId` at once. Nothing is dropped silently, but the cut is abrupt; whether real turns reach it is not measured.
>
> **Eval.** The default arm is now `skill:email-search`: a coordinator turn assembled by `context()` on the main model, with the skill offered through `skill_read`. `retired:email` replays the retired agent from instructions frozen in `src/email-eval.ts`, whose hash matches the `agent:email` arm of the Phase 1 runs, so the earlier result stays comparable at the cost of 3,019 characters of text in the eval module. `docs/email-search.md` lists what still differs from a real coordinator turn.
>
> **Not measured.** The `skill:email-search` arm on the private tasks; a real Telegram turn; token cost of email turns.

> **Correction and update, 22 November 2026 — after the review of `5d0773f`:** measured read-only on the production mailbox by the coordinator on 22 November 2026, counts only. A default search already returns archived mail (a query excluding inbox and sent returned 35 rows, all `archived`, without `in:anywhere`); `in:anywhere` added only spam and trash (the same 35 and 25 spam rows). And Gmail honours `in:spam` and `in:anywhere` written in the query whether or not `includeSpamTrash` is set (15 rows both ways for one `in:spam` query, 28 both ways for one `in:anywhere` query). So the automated review of PR 520 above, and Phase 1, were wrong to say spam and trash were unreachable without the parameter; setting it is harmless and stays. The Phase 2 gathering opt-out therefore does not by itself keep spam out: what does is that the model's gathering `query` cannot hold a colon, hence no operator, and labels go in quoted (see the next correction: quoting does not hold). The tool description, the empty-result hint, the personal-assistance skill (version 7) and the email-search skill now say searches cover all mail including archived, except spam and trash. The reviewer approved `5d0773f` with low findings; the email-search skill now also gives the search rows' header caps and the large-conversation fallback, and the plugin is re-pinned.

> **Correction, 22 November 2026 — after `7ada8d6f`:** measured read-only on the production mailbox by the coordinator on 22 November 2026, counts only. Gmail reads an operator inside quotes, and inside braces, as an operator: `"in:spam" newer_than:14d` returned the same 15 spam rows as the unquoted form, and so did `{"acme in:spam x" "in:spam"} newer_than:14d`. So a gathering target label carrying `in:spam` or `in:anywhere` would have pulled spam into invoice candidates whatever `includeSpamTrash` said. Gathering now drops spam and trash rows by their `folder` before anything is recorded, returned, inspected or counted for coverage, and says how many in the result's notice; a row without metadata stays a result, so coverage still accounts for it, and its folder is read from the message itself at inspection and capture: a message in spam or trash is inspected with no files and can never be captured, whichever search or earlier attempt named it. Pagination is unchanged. Tested with a label carrying `in:spam`.

## Follow-ups after Phase 2

- Read text includes content hidden only by CSS (`display:none`, white text on white), which the owner never sees in Gmail and which is an easy carrier for injected instructions. Dropping it is a candidate hardening.
- `evals/decisions/fixtures/gen_routing.py` fails on the current picker scenarios (it does not map newer domains such as `links`) and needs repair; the routing fixture was edited in place.
- `OPTIONAL_OPERATIONS` (`src/plugins.ts`) has no user now that no shipped agent lists `gmail_recall`.
- In a long turn, crossing the compaction threshold turns every earlier result of the turn into an excerpt at once, not the oldest first. Whether real email turns reach it is not measured.
- Still open from Phase 1: an unclosed script or style element leaks its contents into read text; retry waits cannot be interrupted by a cancelled turn; the header fit shortens escape-dense headers more than needed.

> **Update, 22 November 2026 — Phase 2 release and measurement, and Phase 3, part 1 (branch `feat/email-receipts`).**
>
> **Phase 2, live (measured from GitHub and the production host).** PR 525 merged as `bb3c399`. The first release attempt was skipped because the image-publish job's provenance attestation failed with a 404 from the transparency log; the job was rerun and release run 45008299249 succeeded. The host reports `bb3c399` with a healthy gateway, the `email-search` skill present and the email agent gone. Independent review (Claude Opus 5.5) approved `5d0773f`, then `0048f545` after the rebase and two further commits.
>
> **Measured: the eval on Phase 2.** Production mailbox, 22 November 2026, the same 15 private tasks (144 expected emails), a coordinator turn with the skill available, `claude-opus-5.5`, one run:
>
> |                                              | Before the redesign | Phase 1 (retired helper prompt) | Phase 2 (coordinator and skill) |
> | -------------------------------------------- | ------------------- | ------------------------------- | ------------------------------- |
> | Expected emails found                        | 115 of 144          | 131 of 144                      | 144 of 144                      |
> | Expected emails surfaced in search results   | 120 of 144          | 144 of 144                      | 144 of 144                      |
> | Tasks with every email found                 | 12 of 15            | 14 of 15                        | 15 of 15                        |
> | Lookup answers containing the expected value | 2 of 3              | 3 of 3                          | 3 of 3                          |
> | Searches per task, median and maximum        | 3 and 4             | 4 and 7                         | 4 and 6                         |
> | Rate-limited calls or rows                   | not applicable      | 0                               | 0                               |
> | Model cost for the run                       | $0.025              | $0.072 (small model)            | $2.96                           |
>
> The skill was read once in every task; the run made 72 model calls and 91 Gmail calls. It reported 25 emails outside the answer key; checked privately, they were related emails the key omits (for example the same statements from a second sender address, and the second mailbox), not wrong answers. The arms differ in model as well as in prompt and placement, so the cost and the found counts are not a comparison of prompts alone. Still not measured: a real Telegram turn, and token cost in real use.
>
> **Measured read-only on the production mailbox (recorded above in the Phase 2 corrections, restated here):** a default search already returns archived mail; Gmail honours `in:spam` and `in:anywhere` in the query whether or not `includeSpamTrash` is set; and it honours them even inside quotes and braces.
>
> **Phase 3, part 1: what changed.** Implemented and tested; not reviewed or released, and not run against the real mailbox. A real request to gather one store's receipts for eleven months was sent to the invoice collector because of how the tools described themselves, and the collector's PDF-only search found nothing. Now `gmail_read` and `gmail_thread` list each message's attachments (part number, name, type, size; 20 per message) from the payload they already fetch; a new read-only `gmail_attachment` returns an attachment's text (PDF through the existing extractor, text, CSV and calendar files as UTF-8, HTML through `readerText`) in 20,000-character windows, reading a message in spam or trash and saying so, while gathering's own lookup still refuses those; `gmail_read` with one message takes `links: true` for the HTML part's http, https and mailto targets, never opened. The collection and Gmail descriptions, the domain cues, the gathering and bills catalogue entries and the email-search skill now say that finding and reading receipts is Gmail work and a collection is for saving files, which today from email means PDF attachments only. Design, limits and safety notes: [email search, Phase 3, part 1](../email-search.md#phase-3-part-1-attachments-link-targets-and-routing).
>
> **Decisions.** Attachment lists are omitted for a message without attachments, so a single read's shape is unchanged; part numbers are computed in the walk (each part's index under its parent, joined by dots) rather than read from Gmail's response, and the top-level part is never listed; a PDF is recognised by type or `.pdf` name as gathering does; names, types and link text drop control, zero-width and bidirectional-override characters, since a reversed name can disguise a file type; a refusal repeats the sender-written type only when it is a clean MIME token; responsibility investigations are refused `links: true`, so unattended runs gain nothing; the eval's retired arm keeps its four tools. The decision eval's routing fixture was not extended: its gold labels come from the picker scenarios through a generator that has no gathering label and is itself broken (see the follow-ups above), so a receipts case would mean unrelated churn.
>
> **Tested.** See the design doc for the list. Not measured: anything on real mail, how often receipts arrive as files, and whether the new wording changes the model's choice for a receipts request (no paid eval was run).
