# Five-minute portfolio demo

Use an isolated database, a test Telegram bot and synthetic personal information. The goal is to demonstrate inspectable behavior, not imply successful real job applications.

1. **Conversational intent.** “I’m exploring AI engineering. Help me decide where to focus.” Let the assistant ask about experience and preferences.
2. **Explicit memory.** “Remember that I’ve built Python APIs and want to learn agent evaluation.” Restart the gateway, then ask what background it has saved.
3. **Research and state.** Search for a role, inspect its source, and ask to save it. If live search is not configured, paste synthetic role text and clearly label it as fixture data.
4. **Grounded comparison.** Ask “Where do I match, where am I weak, and what do you still need to know?” Show the role/profile evidence and unknowns rather than a made-up numeric score.
5. **Voice.** Send a short voice note asking to mark the role as interested. Show the same saved state through a follow-up text query.
6. **Control.** Ask to delete it, show the precise approval preview, deny, verify it remains, then approve a fresh request if desired.
7. **Trace.** Show metadata events and explain that domain tools, permissions and state are owned by the app while Hermes supplies the reasoning loop.

Before recording: verify live provider access, keep keys out of the terminal, redact personal data, and label synthesized speech. After recording: document one real failure and how it informed the roadmap.

Suggested project description:

> Built a persistent Telegram personal assistant using Hermes, TypeScript and Postgres, with voice-note input, conversational job-search tools, per-run authorization and database-enforced approvals. Separated the agent runtime from durable product state to support future clients and tool providers.

Only add performance, usage or quality numbers after measuring them. Pair the demo with the architecture diagram and an explanation of the current delivery/recovery tradeoff.
