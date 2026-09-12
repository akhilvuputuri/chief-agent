# Interactive Telegram views — issue #26, phases 1/2

The model still writes conversational prose. An optional answer envelope gives it places for detailed sections, numbers, sources and references to actual saved records. Telegram renders these on demand in one editable message. Plain prose longer than 1,800 rendered UTF-16 units uses the same progressive disclosure automatically; the full text is preserved. This is not a Mini App, generated image or new response template.

## Using it

- `/roles`, `/items`, `/schedules`, `/drafts`: six-record pages with authoritative employer/title labels for roles, active/all filter, default/newest sort, detail and Back. Details read current saved data; they do not re-run analysis. `/drafts` has no approval action: use the original Telegram approval card.
- `/status`: latest task when opened, with Steps, Evidence and Costs. The view stays bound to that task, even after a newer task begins. Step drill-down shows results and available proofs. Evidence is bounded to the latest 100 records, as in the existing snapshot; the UI labels that bound. Counts validate recorded support, not semantic correctness or coverage of the user request. Reported model/research charges and unknown estimates remain distinct; speech is separate.
- `/briefing`: expand/collapse grouped saved records. It does not query Gmail or live Calendar. Existing scheduled briefings still use only explicitly configured email/calendar sources; their already-fetched results are delivered as sections. Their existing source limits are labeled.
- Longer responses: Show more, Previous/Next text, Sections, Sources and Records as appropriate. Summary returns to the model’s original reply. Record buttons are read-only references, never tool dispatches.
- Refresh reads current saved state. Answer sections remain the original answer snapshot; Refresh does not regenerate it. Display timestamps are Singapore time. Views expire after seven days; open a fresh command afterward.

Regular text, voice-note text replies, foreground progress, resumed work and scheduled deliveries share the view controller. Speech continues to read the main model reply, not every hidden section. Approval notices remain separate always-visible messages; Calendar uses its existing approval cards.

## Contract and persistence

`answer.ts` supplies strict Zod schemas. `finish_turn` accepts required reason/reply and optional `records[{kind,id}]`, `numbers[{label,value}]`, `sections[{title,body}]`, `sources[{label,url}]`. Kinds are role/item/schedule/calendar_draft. Record IDs must be UUIDs and every read rechecks authenticated ownership. Source URLs must use HTTP(S); presentation does not certify their truth or fetch them. Array/text bounds are enforced before accepting a finish. Invalid envelopes return a tool error to the model. Natural plain answers remain valid.

The runtime journals finish arguments/results and the complete model response before advancing. Assistant detailed response methods preserve the envelope and parent run ID. Existing string methods remain compatible with non-Telegram callers and existing tests. Full envelope fields stay in the persisted finish arguments and owner-retrievable result. A separate compact answer reference survives omission of the large tool-call group, and `observation_read` can recover the envelope in pages for follow-ups. These references follow the existing recent-history window; this is not an unlimited conversation-search index. No new memory extraction is introduced.

`telegram-views.ts` creates a random view UUID and stores a version-1 `telegram.view_state` JSONB row in existing `events`, keyed by its own run_id. This is explicitly mutable UI state, separate from immutable tool/approval records and with no authorization semantics. The existing run index makes lookup bounded. No schema migration or Compose change is needed. State contains the view, current position, last rendered keyboard actions, revision, owner, chat/message binding and expiry. Answer snapshots are private database content like conversation history, never printed in diagnostics.

The callback token carries only view ID, revision and action index (under 64 bytes). The selected action must exist in the server-stored keyboard. Stale revisions refresh the saved position instead of interpreting an old index against a new keyboard. A database lease serializes edits across instances; a 750-ms guard limits rapid updates, edits have a ten-second abort and leases expire after thirty seconds. Every callback is authenticated against the existing private-chat allowlist plus owner/chat/message binding. It bypasses the conversational queue and promptly acknowledges Telegram’s spinner. No user/model-provided SQL identifiers are used.

The controller edits the same message with existing text/entity formatting, keeping text below Telegram’s 4,096-character bound and preserving emoji/entity offsets. A failed edit releases its lease and can be retried as a read-only refresh. A crash after a send but before message binding can leave unusable buttons; open a new command rather than automatically sending again. A lost acknowledgement of an edit cannot trigger a write because views have no write actions.

Expired view payloads currently follow the same private database retention as events/conversations; expiry revokes navigation, not storage. A future cleanup policy should distinguish mutable UI snapshots from execution audit records. This release does not delete history or add backups.

## Observation and operations

New metadata events:

- `telegram.delivered`: parent run ID for conversational progress/final replies; kind, character count, old formatter chunk count, actual message count, approval-notice count and interactive flag. Schedules/commands use their own delivery group IDs.
- `telegram.view_opened`: view ID, kind and Telegram message ID, associated with the original run when available.
- `telegram.view_tapped`: view ID, kind, action index, stale flag and time to first tap (only once). No record bodies, callback tokens or source text in metrics.
- `telegram.view_failed`: view ID only; upstream errors are not logged verbatim.

The restricted production diagnostics script adds seven-day aggregates for delivery, view opens/taps/failures and first-tap latency. The runtime records raw events privately; GitHub diagnostics expose aggregate counts only. The root-owned release handler must be updated from the reviewed script as a one-time operator step before cloud diagnostics return the new fields. Ordinary app deployment does not update that handler automatically. No permissions or secrets are added.

`legacyChunks` is a counterfactual using the old formatter on the same reply, not a measured historical baseline. Compare actual delivery groups and taps after real usage. Text/voice replies can have additional speech or approval messages; the metadata identifies approval notice counts. Do not claim UX or cost improvements from synthetic tests alone.

## Checks, release and remaining work

Mocked/PGlite checks cover ownership, chat/message binding, stale/duplicate/expired buttons, restart persistence, leases/edit failures, full long-text reconstruction and entity bounds, all record families, evidence/costs including unknown charges, envelope validation/persistence, delivery metadata and actual grammy callbacks. Existing Calendar approval, cancellation and attachment suites remain required. No paid model call or production data mutation is needed for these checks.

Ship as patch v0.3.1 only after the required independent Astra review and passing CI; verify deployed SHA/health and publish immutable release notes. No DB/Compose migration. Reverting app code leaves inert view events and old buttons; it does not change saved data. Check ten real Telegram conversations for usefulness, both text and voice, and view navigation on the owner’s phone. Live acceptance has not yet occurred while preparing this candidate.

Phase 3 remains separate: a Mini App needs an owner-chosen domain and ingress decision (issue #25 currently favors no public ingress). No Cloudflare service, tunnel, public API or Mini App authentication is provisioned here. A later implementation must verify Telegram initData, freshness and owner binding before exposing private views. Media processing (issue #27) and Python trace analysis (issue #28) remain independent.

References: [Telegram editMessageText](https://core.telegram.org/bots/api#editmessagetext), [inline keyboard buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton), [Mini Apps](https://core.telegram.org/bots/webapps).
