# Operating model

The allowlisted Telegram gateway uses our TypeScript conversation loop. OpenRouter supplies the main model pinned in `config/model-policy.json` (Claude Opus 5.5 since journal 100; Gemini 4 Argon from v0.3.72 before it) with medium reasoning and outage-aware provider routing, capped by that file's `priceCeilings` ($4/M input and $20/M output, owner-approved on 19 October 2026). Gemini Flash is the independent search helper. Postgres holds memories, history, task checkpoints, budgets, skills and domain records.

The agent selects named tools and observes actual results. It can research public sources, manage tasks and notes, schedule reminders, read Gmail/Calendar and mirror state to Sheets. It cannot edit executable code, run a shell or deploy itself.

Text skills can be drafted, evaluated and activated through exact owner approval. Current versions load by key; historical private versions load by UUID. Skill content cannot grant new permissions. See [versioned skills](versioned-skills.md).

Telegram voice uses ElevenLabs Scribe v2 and Flash v2.5 in the current deployment; OpenAI and Groq alternatives are implemented behind provider boundaries. Voice notes are asynchronous. Realtime voice still needs streaming, interruptions, turn detection and transcript reconciliation.

Future development workers would need isolated credentials, test data, bounded costs and review before deployment. Delegation and self-deployment are not present. Evaluate daily behavior through task success, factual support, latency, cost and recovery; do not substitute provider benchmarks for end-to-end results.
