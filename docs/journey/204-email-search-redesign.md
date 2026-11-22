# 204 — Why did Chief miss most of a set of receipt emails, and how will a redesign be measured?

Work date: 2026-11-22. Written: 2026-11-22.
Status: in progress. Phase 0, the eval, is written and tested with a fake Gmail and a scripted model; it has not been run against the real mailbox, so there is no baseline yet. Phases 1 to 4 are planned. Design: [email search](../email-search.md).

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

## Verification and outcome

Tested only. No run against the real mailbox and no paid model call has been made, so there is no baseline. The eval is a simplified loop, not the runtime; its limits are listed in the design doc.

## Follow-up and next iteration

- Write the private task set (the receipts request and others) in the operations folder and run the baseline with `--instructions agent:email`.
- Phase 1 tool changes, re-run on the same tasks. If Phase 1 adds a reading tool or changes result shapes, the `readable` scoring changes with it.
