# Verification record

Initial local verification is recorded here; live provider verification requires configured credentials.

- Telegram bot token authenticated successfully with `getMe`; user pairing and live message delivery remain pending.
- TypeScript strict typecheck and production build.
- Node test suite: real SQL via PGlite; save/list/update/analyze evidence; cross-user denial; approval ownership/expiry/denial/replay; capability lifecycle; history reload; redacted trace payloads; private Telegram authorization and duplicate handling; mocked speech/search contracts; bounded downloads.
- Real pinned Hermes smoke test passed on Python 3.13: a local fake OpenAI-compatible server requests `companion_action`; the actual registry dispatch makes an authenticated callback, receives role evidence, and returns a final answer. No paid model was called.
- Compose configuration validated with placeholder credentials (no engine needed).
- Python unit suite: request envelope, exact tool allowlist, history handoff, capability cleanup and fail-closed behavior.
- Dependency lockfile generated; npm reported no known vulnerabilities at installation.

Not yet verified: Docker image builds/startup (engine unavailable on authoring host), actual Telegram delivery, paid LLM/STT/TTS/search responses, cloud deployment, audio quality, live agent evaluation, load or chaos testing. These limitations must remain visible when presenting the project.

## Reproduce the real-runtime smoke test

Install the exact checkout used by `services/hermes/Dockerfile` using `uv sync --frozen --no-dev` with Python 3.11–3.13. Then, from this repository:

```sh
# Set this to your separate pinned Hermes checkout.
HERMES_CHECKOUT=/absolute/path/to/hermes-agent
PYTHONPATH="$HERMES_CHECKOUT" "$HERMES_CHECKOUT/.venv/bin/python" services/hermes/smoke_runtime.py
```

The script creates a temporary Hermes home and a fake local provider. It verifies the real tool registry and conversation loop, not live model intelligence. The pinned version enables progressive tool discovery by default; the bridge initializes `tools.tool_search.enabled: "off"` in its dedicated home so only `companion_action` is exposed. Existing operator config is preserved; an incompatible tool configuration fails the allowlist check.
