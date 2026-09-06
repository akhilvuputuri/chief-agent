# Personal-agent handover

Updated 6 September 2026. The owned TypeScript runtime is deployed on the existing DigitalOcean server. PR #7 introduced the cutover (`f1664bb`); consult server `RELEASE` for subsequent revisions. The gateway and Postgres are healthy, and the Hermes container has been removed without deleting its volume.

## Intent and constraints

Build a useful general personal assistant and an AI engineering portfolio project. Telegram text and voice are the initial interface; job preparation is one domain. The user chose our own runtime and accepts iterative conversational bugs. Protect credentials, ownership and approvals. Keep Gmail and Calendar read-only. No extra paid infrastructure. No automatic shell execution, delegation or self-deployment.

## Locations

- Source: `/Users/akhilvuputuri/Dev/hermes-companion`
- Private operations directory: `/Users/akhilvuputuri/Dev/hermes-companion-ops`
- Repository: https://github.com/akhilvuputuri/hermes-companion
- Existing DigitalOcean host: `188.166.246.143`, `/opt/hermes-companion`, $24/month, Singapore.
- SSH identity: private ops `hermes_do`, with pinned `known_hosts`.

Secrets live only in private environment/operations files and server configuration. Never print or commit their contents. Existing Telegram pairing and Google authorization should be reused. The user authorized merging passing changes and deploying on this server.

## Current target architecture

`telegram.ts` → `agent.ts` → `custom-agent.ts` → `model.ts` and the in-process owner-scoped dispatcher. `context.ts` builds context; `execution.ts` persists runs, calls and budgets. Postgres retains all state. Production Compose has gateway + Postgres and a one-shot migration service. No production Hermes service or HTTP tool callback.

- Main model: `openai/gpt-5.6-sol`, explicit medium reasoning, OpenRouter price-first, default ceilings $2/M input and $10/M output.
- Search helper: `google/gemini-3.8-flash`.
- Voice: ElevenLabs `scribe_v2`, `eleven_flash_v2_5`, existing stock River voice. The audio-provider boundary remains unchanged.
- Read-only Gmail/Calendar, preparation Sheet and daily Sheet integrations are retained.
- Skills: repository catalogue plus owner-approved immutable private versions, loaded on demand.
- Telegram output: model-written prose guided by phone delivery context; existing renderer only. `/status` is the separate deterministic ledger.

## Durable execution

Initial task allocation: 15 minutes active execution, 40 model calls, 100 tool calls. `/continue` adds capacity without resetting completed steps. `/workcancel` aborts an in-flight model request and prevents later dispatch. Already-started tools can finish and remain recorded.

Migration `006_runtime.sql` archives old histories, seeds text-only context and pauses active tasks once. Do not automatically resume the 22-role request or erase its steps. Restart recovery conservatively pauses work and marks started writes uncertain. Uncertain writes require inspection before further writes. See [recovery](docs/reliable-execution.md).

## Verification and next work

Run `npm run check`, `npm run build`, `npm run format:check`. `npm run smoke:runtime` makes bounded paid Sol calls against a synthetic PGlite database, never the production user's records. Check deployment status in `docs/verification.md` and server `RELEASE`.

Improve from actual daily conversations: context selection, memory retrieval, deduplication, tracing and voice responsiveness. Realtime voice, subagents, sandbox execution, self-deployment and a web client remain later milestones.

The previous detailed Hermes handover is retained under `docs/history/hermes-handover.md` as historical context. Its architecture and model defaults are obsolete. Do not deploy the historical bridge as a prerequisite.

## Live cutover results

All 22 roles remain. Task `aaf59b66-dc61-4c1c-8afa-bdc50d8ff850` remains paused at revision 3 with 26 done and 21 pending steps. Its previous history is archived. Live Sol, Telegram bot authentication, read-only Gmail/Calendar, both three-tab Sheet mirrors and an ElevenLabs speech/transcription round trip passed. No automatic resumption was performed. A fresh user-sent Telegram voice note remains a useful hands-on acceptance check after the automated and provider checks.
