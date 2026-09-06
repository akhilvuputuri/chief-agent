# Runtime protocol

`ModelAdapter.generate({messages, tools, reasoning, signal})` returns a normalized assistant message, tool calls and available model/provider/usage fields. The OpenRouter transport always includes medium reasoning and the configured price ceilings.

`Agent.run` receives the latest user request, prior history, explicit memories, runtime context and host-owned execution callbacks. It returns a natural reply, updated history and explicit stop reason. The host identity is never represented as model-selected tool arguments.

Each enabled Zod operation becomes its own model tool. `finish_turn` supplies a model-written reply and answer/awaiting_user/awaiting_approval reason. This is flow control, not a text template. Tool calls execute sequentially, after strict parsing and enabled-operation checks. Actual result messages are fed back into the loop.

The production Fastify server exposes only `/healthz`; `/internal/tools` and the Python callback protocol have been removed. Telegram is the authenticated client. A future web or realtime-voice client should reuse the normalized runtime boundary and provide its own authenticated owner scope.
