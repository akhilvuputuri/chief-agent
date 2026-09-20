# 23 — Making mailbox search usable through the agent

Status: candidate v0.3.13 on `feature/gmail-search`, branched from `b850a83`; app-only, no schema or Compose change. No phone acceptance has been recorded yet, so everything about real-world quality below is a hypothesis, not a measurement.

## The observed problem

Asked to find an email, the assistant was unreliable in a specific, diagnosable way. `gmail_search` returned only message and thread identifiers. To learn what it had found, the model had to call `gmail_read` once per hit, and each read could return 16,000 characters. Ten hits therefore cost eleven requests and a large share of the turn's context, so in practice the model read two or three, formed a guess from them, and answered. Nothing told it how to phrase a Gmail query, nothing let it read a conversation as a unit, and an identical repeated search cost the same as the first.

The weak part was the tool contract, not Gmail's index. That distinction decided the approach: fix what the tools return and what the model is told, before considering a local index or embeddings.

## What changed

Search now fetches `format=metadata` for each of the ten hits, restricted to From, To, Subject and Date, and returns sender, recipient, subject, date, snippet and an unread flag with every field capped at 200 characters. A search costs eleven Gmail requests where it cost one, but it replaces the blind reads that followed, and Gmail's quota is nowhere near a concern at this volume. A metadata fetch that fails degrades its own row to identifiers plus a `detail` note; the search still answers. A computed `hint` asks for a narrower query when the estimate exceeds 50 and suggests widening when nothing matched. Identical searches are cached five minutes in process.

`gmail_thread` reads one conversation oldest first, 4,000 characters per message and 16,000 in total, flagging truncation so `gmail_read` can still fetch one message whole.

A per-turn ceiling of 40 Gmail API requests is charged in the adapter against the run identifier and raises a non-retryable validation error when spent. This is deliberately a host limit rather than an instruction, because the instruction-shaped version of this rule is the one the model can talk itself out of.

Guidance was added in two places: a runtime context paragraph on triaging from the result list and stopping after about three searches, and a Gmail operator sheet in `personal-assistance` (bumped to version 3) covering `from:`, `subject:`, quoted phrases, `OR`, negation, relative and absolute dates, `has:attachment`, `filename:`, `label:` and `in:anywhere`, with a widen-then-narrow strategy.

The daily briefing builds its digest from search metadata alone. That removes five message reads but is not a saving in requests: it went from six (one list and five reads) to eleven, because search fetches metadata for all ten hits while the digest shows five. What it saves is context, since no message body enters the briefing at all. The briefing is now charged under its own synthetic run identifier, so it is subject to the same ceiling.

## A limitation worth recording

Gmail's metadata format returns headers, labels and a snippet, but no parts listing, so the result cannot carry an attachment flag. `has:attachment` still works as a search operator, which covers the common request; a caller wanting the flag itself would need a `format=full` read per hit, which is exactly the cost this change removed.

## What independent review caught

The first head passed 275 tests and was still wrong in a way the tests could not see. Every thread test used plain-text messages, and the total-character budget was charged only against the extracted plain body. A message with no `text/plain` part therefore cost nothing, the loop never terminated early, and a forty-message HTML newsletter thread returned every message and about 70,000 characters against a documented 16,000 cap. Because the model-facing projection replaces anything above 12,000 characters with a bare excerpt, the practical effect was that the untrusted-content warning silently disappeared from the very tool this work added, on its most common input.

The fix is three independent bounds rather than one: a hard cap of 12 messages, a minimum of one character charged per message, and per-message header fields capped like the search fields. The sizes were then chosen against the 12,000-character projection rather than picked for roundness, and tests now assert that a full page and a full thread both survive the projection with the warning intact.

Review also found that a search page degraded by the request ceiling was cached for five minutes and served to a later turn that could have afforded the rest, that a conversation past the two-megabyte response guard failed the whole call instead of degrading, that the briefing bypassed the ceiling entirely, and that a sentence added to the security document claimed email bodies are never stored outside their turn when every tool result is persisted in `runtime_calls`. All are corrected here.

A second review pass approved the result and left minor points, of which the useful ones were closed: the character caps bound source text rather than JSON, so quote-dense content could still double under escaping, and the result is now trimmed by entry until it serialises below 11,000 characters; a caller with no run identifier shared an exemption rather than a bucket; each briefing firing now gets its own budget instead of sharing one per schedule; a row that could not be retrieved no longer becomes a blank bullet in the briefing; and four fixes that survived being reverted with the suite still green now have tests, including the one that actually preserves the warning under overflow. The lesson worth keeping is that the bound and the test fixture were written from the same assumption, so the fixture could never contradict the bound.

## A note on sequencing

While this was being built, the reviewed migration 016 rollout for the library work completed and `v0.3.12` was published at `71de810`, so live `db/` and `compose.yaml` again match main and the ordinary release works. An earlier draft of this entry recorded the opposite, because main had carried an undeployed migration for part of the day. The ordinary release refuses any candidate whose `db/` or `compose.yaml` differs from the live source, which is why an app-only change still has to wait out an unfinished migration rollout; this one no longer does.

## Open checks

Phone acceptance, to be recorded here with dates and observed request counts:

1. A precise ask naming a person and a topic.
2. A vague ask over a wide window, such as a receipt from last month.
3. A follow-up asking for the whole thread.
4. A genuine miss, checking that the reply states which queries were tried instead of guessing.

Until those are recorded, the claim that this removes most misses is untested. If misses persist and turn out to be vocabulary mismatches rather than bad queries or shallow reading, the next step is the local metadata index described in [issue #53](https://github.com/akhilvuputuri/companion-agent/issues/53), not embeddings.
