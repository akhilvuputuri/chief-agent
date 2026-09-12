# 02 — A durable task lost its target collection

Incident: 7 September 2026. Status: focused fixes released; broader candidate deferred.

## Observed failure

A request to review 22 saved roles retrieved the correct records, but later produced unrelated postings. The database remained intact. The incident report records 99 tool calls and eviction of 172 of 198 preceding messages from final context. Repeated bookkeeping competed with useful evidence. An operator acceptance prompt had also contaminated production conversation history.

## Diagnosis and intervention

Our hypothesis was that durable execution did not ensure durable access to the exact target set. Context loss created an opportunity for drift; it does not prove the model's internal cause for each invented posting.

We released compact observations with owner-scoped full-result retrieval, fresh task checkpoints, and compact inventories from actual tool results. A follow-up preserved both the initial and latest inventory so a filtered or empty later result could not erase the original collection. We clarified retrieval versus analysis and guided Telegram responses without fixed templates.

A broader scope/finding/evaluation candidate was checkpointed when the user requested deferral. Single trials failed in different ways; it is not a validated production feature. This scope expansion was itself a process lesson: isolate one regression and one mechanism before building a larger evaluation system.

## Evidence and limits

[PR #14](https://github.com/akhilvuputuri/companion-agent/pull/14) and [PR #15](https://github.com/akhilvuputuri/companion-agent/pull/15) shipped the focused changes. Read-only inspection recovered the incident's original 22 identities in 4,405 characters alongside the later empty inventory. That verifies availability, not a correct new model answer.

See [response improvements](../response-improvements.md), [experiment history](../development-process.md) and [deferred checkpoint](../checkpoints/runtime-evaluations.md). Do not describe the deferred migration-007 candidate as deployed.
