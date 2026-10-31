# 136 — Can Chief tell the owner when something goes wrong, without crying wolf at low volume?

Work date: 2026-10-31 (Singapore). Written: 2026-10-31.
Status: in progress. agentwatch's monitors are merged (agentwatch#17, `3bfb6c3`); this PR pins that image and adds Telegram delivery. The image reaches the host through an operator update.

## User-visible problem and preceding iteration

[Journal 134](134-agentwatch-on-the-host.md) put traces in agentwatch and [journal 135](135-jev-redirect-and-judge.md) added quality scores, but someone has to open the page to see any of it. Issue #323 plans drift detection and alerts through Chief. The owner asked to start them on 31 October.

## Evidence

**Measured, read-only, from agentwatch's backfilled history (6 September to 29 October, 56 days, 40 with activity):**

|                         |                                                    |
| ----------------------- | -------------------------------------------------- |
| Daily cost              | median $0.26, 90th percentile $2.07, highest $3.39 |
| Model call errors       | 2.3% overall                                       |
| Tool call errors        | 12.8% overall                                      |
| Daily p95 model latency | median 11.5 s, highest 35 s                        |
| Busiest day             | 90 model calls, 214 tool calls                     |

**Found in the same data:** tool errors are concentrated. `parcel_list` failed 48 of 50 calls and `parcel_record` 10 of 11. `agent_report` failed 39 of 95, `coding_cancel` 15 of 23, and `work_step` and `work_evidence` 12 of 28 and 12 of 24. The cause has not been investigated, and some of these failures may be refusals working as designed rather than faults.

**Tested:** `tests/trace-alerts.test.ts` covers the alert text in each metric's units, marking an alert delivered only after it was sent, retry when Telegram fails, agentwatch down or sending malformed alerts, at most five alerts per poll, and no overlapping polls.

**Not measured:** how often these limits would have fired on the history, and whether they are the right ones.

## Diagnosis and alternatives

- **Polling rather than a webhook.** A webhook needs an inbound route on the gateway and a shared secret, or agentwatch would need the Telegram token. Having the gateway poll undelivered alerts needs neither: agentwatch stores no URL or secret for alerts, so its API, which has no login, cannot be used to send them anywhere.
- **A statistical bound for rates.** Chief makes few calls, so one failure of three is 33%. A rate fires only when its 95% Wilson lower bound clears the limit, and recovers when the rate itself is back. Totals such as cost compare the value directly.
- **Limits from history.** Each limit sits above the busiest or worst day seen, or at about twice the baseline or more.

## Implementation and review

- agentwatch#17: monitors, the Wilson rule, the alert state machine, the Alerts page.
- [src/trace-alerts.ts](../../src/trace-alerts.ts): delivery from [src/main.ts](../../src/main.ts), only with export on.
- `compose.yaml`: pins the image from agentwatch `3bfb6c3`, installed by [scripts/deploy-agentwatch-update.py](../../scripts/deploy-agentwatch-update.py).
- Design: [tracing](../tracing.md#monitors-and-alerts).

Independent review (Opus 5.5) of agentwatch#17 requested changes:

- **Flapping (blocking).** Metrics compared by their value alone could flap: a simulated `trace_count` monitor wrote 17 alerts in 20 minutes. Monitors now have a cooldown (60 minutes by default), and the same simulation writes 1.
- **A low-volume outage was hidden.** 5 failures in 5 calls did not fire under a default of 10 samples. Rates now default to 3, since the bound already guards them.
- **Edits while firing.** A rename sent a second alert, and an edit that cleared a firing monitor sent nothing. Now a rename sends nothing, and an edit or delete sends a resolved alert with a reason.
- **Validation.** A rate limit of `5`, meaning 5%, could never fire, and a monitor name could carry newlines and bidi characters into Telegram. Both are refused, and the relay also reduces a name to one plain line.

Known and left: server downtime counts as good time for a firing monitor, so it can resolve early after an outage.

Review of this PR's first head (`facadde`) found nothing blocking and these to fix, all done:

- **Repeat messages.** A failed delivered mark, or a second owner who could not be reached, would have re-sent the same alert every minute indefinitely. The relay now remembers who has each alert, retries only what is missing, and after five polls stops waiting for an unreachable owner if another owner has it.
- **A stuck queue.** One unreadable alert would have blocked all later ones, with only an hourly log line to show for it. It is now reported as unreadable and marked. Failures carry `errorCode`.
- **Wording.** Singular units, scores as percentages, and alerts older than ten minutes say when they were raised.
- **The rollback claim.** The update script cannot restore an older image across a schema change, and [lightsail](../lightsail.md#traces-agentwatch) now says so.

## Follow-up and next iteration

- The operator update to the new image, then creating the six monitors.
- Replay the limits over the history to see how often they would have fired.
- Investigate the parcel tool failures.
