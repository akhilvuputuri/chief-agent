> Runtime update: production now uses our TypeScript loop and scheduler. Hermes-specific architecture and pass limits below describe the earlier prototype; [current architecture](architecture.md) and [execution/recovery](reliable-execution.md) take precedence. Integration-specific permission boundaries remain enforced.

# Operating model and self-development

## Daily assistant

The private, allowlisted Telegram gateway routes conversations through Hermes. The first deployment uses `google/gemini-3.8-flash` via OpenRouter; `HERMES_MODEL` is configurable. A bounded live function-call check passed on 2026-09-06. This confirms connectivity and function-call formatting, not general task quality.

Postgres owns user memory, job state, approvals and metadata traces. The daily runtime exposes only companion tools. It cannot execute shell commands or edit its own running application.

## Development mode: next foundation milestone

The intended routing is GPT-6 Astra for planning and review, with GLM 5.3 Flash workers. These roles are not wired into the daily runtime yet.

A Telegram development request should create a durable job with a user-approved spending limit. Run it in a disposable sandbox against a repository branch, with test data and scoped model access. Never mount production database credentials, the bot token, deployment SSH key or Docker socket.

The worker can edit code and skills, run checks, and produce a diff, test report and cost summary. An independent review pass evaluates acceptance criteria and regressions. A trusted deployment component must bind user approval to the exact reviewed commit and deploy that artifact with health checks and rollback. A model saying “approved” is not authorization.

The first dogfooding task should be a small, reversible skill improvement with explicit acceptance criteria.

## Voice

Telegram notes follow OGG download → speech-to-text → assistant turn → text or synthesized Opus reply. This is asynchronous voice messaging. Realtime conversation requires streaming transport, turn detection, interruptions and cancellation.

The current implementation supports OpenAI STT/TTS and requires a separate OpenAI key. OpenRouter reasoning credentials do not configure speech. ElevenLabs and Groq adapters remain planned.

Portfolio evaluation should measure transcription and intent accuracy, proper-name accuracy, task completion, cost and latency. A later realtime client should measure end-of-speech to first audio (p50/p95), interruption handling and misunderstanding recovery. Provider synthesis latency alone is not end-to-end conversation latency.
