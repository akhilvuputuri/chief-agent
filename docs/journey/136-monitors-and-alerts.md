# 136 — Can Chief tell the owner when something goes wrong, without crying wolf at low volume?

Work date: 2026-10-31 (Singapore). Written: 2026-10-31.
Status: in progress. Telegram delivery is written and tested; agentwatch's monitors are in review, and the image reaches the host through an operator update.

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

- **Polling rather than a webhook.** A webhook needs an inbound route on the gateway and a shared secret, or agentwatch would need the Telegram token. Having the gateway poll undelivered alerts needs neither: agentwatch stores no URL or secret, and its API, which has no login, cannot be used to send data anywhere.
- **A statistical bound for rates.** Chief makes few calls, so one failure of three is 33%. A rate fires only when its 95% Wilson lower bound clears the limit, and recovers when the rate itself is back. Totals such as cost compare the value directly.
- **Limits from history.** Each limit sits above the busiest or worst day seen, or at about twice the baseline or more.

## Follow-up and next iteration

- agentwatch's monitors, the operator update to the new image, then creating the six monitors.
- Replay the limits over the history to see how often they would have fired.
- Investigate the parcel tool failures.
