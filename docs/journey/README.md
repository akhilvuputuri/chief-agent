# Companion Agent engineering journal

A chronological account of building and operating a personal assistant, with evidence and unfinished work preserved. Entries distinguish verified results from unfinished work. Entries reconstructed on 9 September 2026 use repository history and existing incident reports; dates on entries identify the work, not necessarily when the narrative was written.

## Start here

| Entry                                                          | Engineering question                                                                 | Status                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| [01 — Owning the runtime](01-owned-runtime.md)                 | Which components changed in the runtime cutover?                                     | Released                                                |
| [02 — Losing the target collection](02-context-and-targets.md) | Why can a durable task still forget what it is doing?                                | Focused fixes released; broader eval candidate deferred |
| [03 — Token cost investigation](03-token-cost.md)              | Why was useful output expensive, and which mechanisms could reduce waste?            | Released; comparative savings unmeasured                |
| [04 — Empty response recovery](04-empty-responses.md)          | What should happen when a provider returns no usable answer?                         | Released                                                |
| [05 — Development from anywhere](05-cloud-development.md)      | How can a coding task ship changes without a developer's laptop?                     | Release/metadata path released; parity work ongoing     |
| [06 — Observable memory](06-observable-memory.md)              | Which conversation created a memory, and when was it supplied to a model?            | Implementation in progress; not a release claim         |
| [07 — Reading photos and PDFs](07-attachments.md)              | How should a text-only Telegram agent accept files without bloating cost or history? | Released; production quality unmeasured                 |
| [11 — Media specialist](11-media-specialist.md)                | How should file reading get focused context without retaining raw bytes?             | Implemented; release pending review                     |

## Keep the record useful

Add an entry for meaningful incidents, architectural decisions or experiments, using [the template](TEMPLATE.md). Small related fixes can update an existing entry with a dated follow-up. Preserve original observations when adding new results. Link commits, tests and design documents; do not copy private conversations, credentials, job records or production trace artifacts here.

Label evidence precisely: production observation, synthetic test, hypothesis, implementation, verified release, or unmeasured outcome. A passing test is not proof of better conversational quality. A deployment health check is not a semantic evaluation. Report denominators, model/configuration and workload when comparing costs or success rates.

Do not claim benchmark wins, production scale or financial savings that have not been measured.
