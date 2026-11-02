# 147 — Can agentwatch say a metric moved, without crying wolf on Chief's traffic?

Work date: 2026-11-02 (Singapore). Written: 2026-11-02.
Status: live and muted since 2 November 2026 ([release closure](#release-closure--2026-11-02)). No drift alert has reached the owner, and the results under Evidence are simulated or measured on a laptop, not on real traffic.

## User-visible problem and preceding iteration

[Journal 136](136-monitors-and-alerts.md) added monitors that compare a metric with a fixed limit. A limit set from history says nothing when something moves within it: a tool error rate going from 3% to 12% stays under a 30% limit. Issue #323 plans drift detection, and the owner asked to start it.

## Evidence

**Simulated, false firings a month with no lasting change, and shifts detected, for a monitor at 7-day and 3-day windows (40 and 60 simulated months):**

| Traffic           | False firings a month, 7-day / 3-day | Shift detected, 7-day / 3-day |
| ----------------- | ------------------------------------ | ----------------------------- |
| Independent       | 0.07 / 0.17                          | 20 of 20 / 20 of 20           |
| Bunched in traces | 0.20 / 0.15                          | 10 of 10 / 9 of 20            |
| Session bursts    | 0.75 / 1.83                          | 10 of 10 / 16 of 20           |
| Lognormal daily   | 0.50 / 1.12                          | 10 of 10 / 20 of 20           |
| Weekly pattern    | 0.07 / 0.97                          | 10 of 10 / 20 of 20           |
| Incidents         | 0.23 / 0.28                          | 10 of 10 / 20 of 20           |

The first figure given to the owner, about 0.1 a month, came from tidy traffic only and was too rosy. Chief's traffic is more likely to look like the session and lognormal rows, but that has not been measured.

**Measured on simulated data by the reviewer:**

- A true change of the reported `detectable` size shows 57 to 77% of the time (the 57% at a 99% level, 200 runs), so it is about 60 to 80% power, not the 80% it aims at.
- A page of 5 metrics with no true difference shows a false "changed" 8.5 to 12.8% of the time, against a 5% target. Uncorrected it would be roughly 30%: an estimate, 1 − 0.93⁵, assuming independent metrics, not a measurement.
- Ingest p50 with 8 clients on the drift endpoints over 200,000 spans: 71 ms with one comparison at a time, against 2,163 ms when they ran freely, both over a real socket to a separate server process with p95 clients. The 2,163 ms predates the switch-interval change. Through the ASGI app, with summary clients, the same gate measured 65 ms.

**Seen by hand:** the Drift page and mute controls in a browser on demo data, with no console errors. Its "changed" verdict and a firing drift alert have been seen only in tests.

## Diagnosis and alternatives

- **Unpaired, resampling whole traces.** Two windows of production traffic have no pairs, and calls within a trace are not independent, so the bootstrap resamples traces. agentwatch's paired experiment statistics do not apply.
- **A trial before any alert.** With about one false alert a month plausible, a drift monitor can run `muted`: it records what it would have sent, and no client sees it. Tightening the rule further would have cost detection on traffic that has not been measured, so it stays as it is until the trial gives a real rate.
- **Repeated testing.** A monitor re-tests overlapping windows, so it evaluates hourly at 99.5% and fires only on six breaches in a row. A gap over 3 hours or an underpowered reading ends the run.

## Implementation and review

- agentwatch#18 (`ce4db9f`) and #19 (`d3f4e1c`): the comparison, the Drift page, drift monitors, `muted`, schema 10. Design: [agentwatch's design notes](https://github.com/akhilvuputuri/agentwatch/blob/main/docs/design.md).
- [src/trace-alerts.ts](../../src/trace-alerts.ts): drift alerts say what moved from what, and a resolve says no clear rise or fall of that size is left, and gives both values. The threshold wording, "back to 40.2%", would have been false.
- `compose.yaml`: pins the image from agentwatch `d3f4e1c`, installed by [scripts/deploy-agentwatch-update.py](../../scripts/deploy-agentwatch-update.py). Schema 10 cannot be read by the older image, so this update cannot roll back automatically.
- Design: [tracing](../tracing.md#drift).

Independent review (Opus 5.5) of agentwatch#18 requested changes twice before approving `5f7005c`:

- **The false-alarm claim.** Harder traffic models showed the figures above; the docs now give them, and `muted` was added.
- **Ingest starved.** Concurrent comparisons took ingest to about 2 s. They now run one at a time, with a 30-second result cache and 429 when busy, and `serve` shortens the interpreter's switch interval.
- **Double firing.** The cooldown was too short for one shift, so it now defaults to the window.
- **Mute mid-incident.** A muted resolve could leave a client on "firing" forever. A resolve now goes the way its firing alert went, recorded in the monitor's state so retention cannot break it.
- **Outage counted twice.** The first fix for downtime counting as good time added the gap twice before an underpowered reading, delaying a resolve by the outage's length.

Review of this PR's first head (`3d3b676`) requested changes:

- **"No longer differs" was false.** A drift monitor resolves on any non-breach. A simulated two-day incident at 60% on 10% traffic resolved while the verdict was still `changed` in 5 of 6 runs, with the incident now in the earlier window: baseline 25.9%, current 10.1%. Both the relay and agentwatch now say no clear rise or fall of at least the threshold is left, and give both values. The same claim had got through review of agentwatch#18.
- **Rounding printed contradictions.** A doubled cost read "from $0.001 to $0.001", and 24 to 40 ms read "0.0 s to 0.0 s". Drift text now keeps three significant figures, or milliseconds, and threshold text is unchanged.
- **Mixed units.** A 0-5 score could read "1.37 to 80.7%". A score is a percentage only when both windows are within 0 to 1.

Known and left: threshold monitors still count downtime as good time, as journal 136 records. A database already at schema 10 from an unreleased commit will not gain later columns; none has reached the host.

## Follow-up and next iteration

- Done, as the release closure below records: snapshot the agentwatch volume, since the update cannot roll back automatically; run the update; create drift monitors muted on the host; release the gateway, which carries the relay text. The monitors were created about two minutes before that release finished, not after it as planned. They were muted, so nothing they raised could reach the old relay. Unmute only once the new relay is live.
- After a few weeks of muted running: compare what they would have sent with what happened, and decide whether to unmute.

### Release closure — 2026-11-02

With the owner's approval, on 2 November from about 03:28 to 03:32 UTC:

- [PR 409](https://github.com/akhilvuputuri/chief-agent/pull/409) merged at the reviewed head `b432451` as `6409f9a`.
- agentwatch was stopped while its volume was archived on the host, under `/var/backups/agentwatch-pre-schema10/`. The archive is 3.8 MB and holds the 25 MB database. It has been listed, not restored.
- The operator update ran from an exact archive of `6409f9a`, with hashes matching on both sides and the Compose change a single line. It reported `sha256:cd3fd562…` healthy, its test span included, and the gateway stayed up. The live `compose.yaml` hashes the same as main.
- The automatic release of `6409f9a` then succeeded (run 41383531512), and `RELEASE` matches.

No `trace.export_dropped` or `trace.alerts_failed` line appears in the gateway's logs from 03:20 to 03:32. That window includes the gateway's restart, so it does not prove that no span was lost.

All five drift monitors were created muted on 7-day windows, with a 7-day cooldown, and their first evaluation left them OK. That says little, because a drift monitor fires only after six hourly breaches in a row:

| Monitor                      | Bad direction, smallest change | Previous 7 days | Last 7 days         |
| ---------------------------- | ------------------------------ | --------------- | ------------------- |
| Model errors                 | rise, 5 points                 | 4.8%            | 4.9%                |
| Tool errors                  | rise, 5 points                 | 16.4%           | 7.2%                |
| Cost per trace               | rise, any clear                | $0.252          | $0.214              |
| Mean model latency           | rise, any clear                | 7.76 s          | 8.08 s              |
| Judged answers (`answer_ok`) | fall, 10 points                | no data         | 100% (underpowered) |

Not yet observed: a real drift firing, the new relay wording on Telegram, and the real false-firing rate. agentwatch had raised no alert since the release when read at 03:32 UTC, and the gateway's logs show no relay failure line. That line is written at most once an hour, and a successful empty poll logs nothing, so this does not show the relay reading the new image. Judged answers stays underpowered until both windows have enough judged traces. The old image cannot read schema 10, so going back means re-pinning it and restoring that archive by hand, which loses what was written since.

Next: after a few weeks muted, compare what the monitors would have sent with what happened, and the owner decides whether to unmute.
