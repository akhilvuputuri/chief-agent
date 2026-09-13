# 19 — Building the phone assistant before owning its runtime

Work: 6 September 2026, with a Calendar follow-up on 9 September. Written: 14 September 2026.
Status: foundation, integrations and voice implementation released. This backfill describes the earlier architecture; [entry 01](01-owned-runtime.md) covers its replacement.

## Problem and first boundary

The first milestone was a persistent assistant usable from a phone: conversation, explicitly saved preferences, research and saved records. The model needed tools without acquiring account credentials or deciding its own permissions. [Initial commit `4dba0ed`](https://github.com/akhilvuputuri/companion-agent/commit/4dba0ed) put a pinned Hermes reasoning service behind a TypeScript gateway. Telegram supplied authenticated identity; short-lived run capabilities scoped tool access; Postgres retained records, conversation history and exact-action approvals. A model request could propose deletion, but only an owner-scoped, expiring, single-use approval could execute it.

Telegram long polling avoided a public webhook or web client. Reusing Hermes supplied the first reasoning loop while the application owned its data and authorization. This left execution limits and recovery partly across the Python/TypeScript boundary. The [initial deployment record](https://github.com/akhilvuputuri/companion-agent/blob/4dba0ed/docs/live-deployment.md) verifies pairing, healthy services and real model connectivity, while explicitly separating those checks from conversational acceptance. Later durable-work changes and the owned-runtime cutover address that boundary in [entry 01](01-owned-runtime.md) and [reliable execution](../reliable-execution.md).

## Voice: configured capability and usable transport

The initial voice path depended on OpenAI credentials. Its start message invited voice input even when transcription was unavailable. [Commit `4792561`](https://github.com/akhilvuputuri/companion-agent/commit/4792561) separated transcription from synthesis, added ElevenLabs and Groq choices, and made Telegram report actual configuration. Each provider needed its own authentication and request fields. Synthesized audio now carried its correct filename and format: ElevenLabs MP3 and OpenAI Opus/OGG, without relabeling bytes.

Voice notes entered the ordinary agent turn after bounded download and transcription. Text arrived before optional audio, so synthesis failure could preserve the answer. Tests exercised credentials, multipart fields, formats, missing configuration, size limits and sanitized failures. These checks established the integration contract, not transcription quality or low latency. [Voice setup](../voice-setup.md) owns current configuration and limits.

[Commit `05a7d3a`](https://github.com/akhilvuputuri/companion-agent/commit/05a7d3a) records a successful server-side ElevenLabs synthesis/transcription round trip on 6 September. The owner subsequently reported sending and testing a Telegram voice note after setup. That is user-reported acceptance; an exact test timestamp and linked interaction trace were not captured in this reconstruction. Earlier setup notes still saying that Telegram acceptance remains pending predate that report. Neither observation supplies a measured success rate, latency distribution or speech-cost comparison.

## Adding useful state and integrations

The early integration work kept Postgres authoritative and narrowed each external capability:

- [Encrypted backups, `a157a91`](https://github.com/akhilvuputuri/companion-agent/commit/a157a91), addressed the fact that persistent volumes are not recovery evidence. An encrypted dump was restored into a separate database and checked. Automatic off-server replication remained unfinished; [backup operations](../backups.md) records the limits.
- [Read-only Gmail, `3c58296`](https://github.com/akhilvuputuri/companion-agent/commit/3c58296), and [preparation/Sheets, `735e522`](https://github.com/akhilvuputuri/companion-agent/commit/735e522), added account-scoped reads, source-backed records and a one-way viewing surface. The first Sheets consent granted identity without file access. [Fix `45f8e81`](https://github.com/akhilvuputuri/companion-agent/commit/45f8e81) validated granted scopes, normalized the email-scope alias and returned specific safe diagnostics; the later live export succeeded. The failure was authorization setup, not missing database records.
- [Daily-assistant commit `9c98e22`](https://github.com/akhilvuputuri/companion-agent/commit/9c98e22) added tasks, notes, reminders, briefings and Calendar reads. [PR #17](https://github.com/akhilvuputuri/companion-agent/pull/17) later introduced Calendar drafts with exclusive Telegram-button approval and read-only reconciliation for uncertain writes. The [Calendar contract](../calendar-approval.md) explains why natural-language assent cannot perform that write.

These releases established a usable foundation and exposed concrete configuration, transport and persistence boundaries. Historical provider checks, restore tests and exports do not establish general agent reliability. The later journal follows the failures that remained: [lost scope](02-context-and-targets.md), [cost](03-token-cost.md), [memory provenance](06-observable-memory.md) and [skill loading](20-versioned-skills.md). This documentation pass ran no new provider or production tests.
