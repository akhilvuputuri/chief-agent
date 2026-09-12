# 01 — From Hermes prototype to an owned runtime

Work: 6–7 September 2026. Status: released.

## Implementation change

The initial prototype used Hermes with Telegram, voice and Google integrations. The production Hermes bridge was replaced with a TypeScript loop while retaining those integrations and Postgres data.

The application owns context selection, named tool schemas, owner-scoped dispatch, persisted observations, stop reasons, budgets and recovery. Tools execute sequentially. Telegram presentation remains model-written. An interrupted write with an uncertain outcome requires inspection rather than automatic replay.

## Evidence and tradeoffs

[Runtime cutover PR #7](https://github.com/akhilvuputuri/companion-agent/pull/7), commit `f1664bb`, introduced the runtime. [Architecture](../architecture.md) and [recovery](../reliable-execution.md) describe the current contracts. Historical Hermes code and attribution remain in Git history.

Owning a small loop makes failures inspectable but makes us responsible for execution and context correctness. Durable task storage alone subsequently proved insufficient to preserve the user's target collection. Integration reuse kept this change narrower than rebuilding the whole product.
