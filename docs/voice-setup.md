# Voice setup

Transcription and speech can be selected independently. The cloud deployment now has ElevenLabs Scribe v2 and Flash v2.5 configured, with the stock River voice and voice replies enabled. A live server-side synthesis/transcription round trip passed on 2026-09-06. A real user Telegram voice note remains the final acceptance test. No provider key is included in Git.

For ElevenLabs, set these values in the private `.env`:

```dotenv
STT_PROVIDER=elevenlabs
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_STT_MODEL=scribe_v2
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
VOICE_REPLIES=true
```

Choose a stock voice accessible to your account; cloning is not needed. The API key and selected voice ID must be configured privately, not committed or sent through Telegram. Copy the updated private configuration securely to the server, then rebuild/recreate the gateway. Compose passes all relevant variables explicitly.

OpenAI remains available using `STT_PROVIDER=openai`, `TTS_PROVIDER=openai`, and `OPENAI_API_KEY` with the existing `STT_MODEL`, `TTS_MODEL`, and `TTS_VOICE` settings. Groq transcription uses `STT_PROVIDER=groq`, `GROQ_API_KEY` and `GROQ_STT_MODEL`; it can be paired with either TTS option.

Telegram accepts MP3 through sendVoice, so ElevenLabs requests `mp3_44100_128` and returns `reply.mp3`. OpenAI requests Opus and returns `reply.ogg`. No relabeling or transcoding is performed. Output is bounded to 10 MB. Notes must be at most three minutes / 10 MB; text always arrives before optional audio. Synthesis currently truncates replies to 4,000 characters.

Missing transcription configuration gets a specific text-only message. Provider failures remain sanitized. No automatic cross-provider failover is performed. Audio is not deliberately saved by this app, but transcripts persist in conversation history; provider retention policies remain separate. ElevenLabs zero-retention mode is account-tier dependent and is not claimed here.

Mock tests cover vendor credential separation, multipart fields, filename/format, missing credentials, oversized input and failure handling. Before claiming voice is live, send a real Telegram note, verify correct transcription and tool execution, play the returned bubble, and test TTS failure preserving text. Realtime audio, shared interaction traces, latency/cost metrics and per-user speech preferences remain future work.

Sources: [ElevenLabs STT](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [ElevenLabs TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [Telegram sendVoice](https://core.telegram.org/bots/api#sendvoice), [Groq STT](https://console.groq.com/docs/speech-to-text).
