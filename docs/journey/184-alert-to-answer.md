# 184 — Can an alert take the owner straight to what went wrong?

Work date: 2026-11-13. Written: 2026-11-13.
Status: in progress. agentwatch's trace page, sign-in and address changes are merged ([agentwatch#22](https://github.com/akhilvuputuri/agentwatch/pull/22), [#23](https://github.com/akhilvuputuri/agentwatch/pull/23)); alerts that point at traces are in review ([agentwatch#24](https://github.com/akhilvuputuri/agentwatch/pull/24)); Chief's relay passes the pointers on (this change). Nothing of it is on the host yet: the agentwatch image has to be pinned and rolled out with its public address.

## User-visible problem and preceding iteration

agentwatch has been on the host since 29 October ([journal 134](134-agentwatch-on-the-host.md)) and reachable from a phone behind a sign-in since 12 November ([journal 166](166-traces-from-anywhere.md)). On 13 November the owner asked for a review of the whole tool: what to improve, what other tools do better, what would make it more helpful.

The review's main finding was that the tool had not yet answered one production question. Every incident in this journal since 29 October was investigated from Postgres, server logs or scripts. The first step of the plan that followed is the path from an alert to the answer, because an alert is the one moment the tool asks for the owner's attention.

## Evidence

**Measured on the host, 12 November (UTC), through agentwatch's API with its key; counts only, no content.** 367 traces and 3,708 spans over about 67 days; 82 traces (22%) hold at least one failed span; 4 alerts ever raised, 2 of them tests and 2 from muted drift monitors, so no real alert has reached the owner; 4 sessions; no datasets, experiment runs or prices; a 29 MB database; API calls answered in 5 to 100 ms.

**Read in the record (reviewer, 13 November).** [Journal 136](136-monitors-and-alerts.md) found one tool failing 48 of 50 calls while the global tool-error rate, 12.8%, stayed under its 30% limit. `alertText` in [src/trace-alerts.ts](../../src/trace-alerts.ts) ended every alert with "Details in agentwatch." and no link; an alert held no reference to any trace.

**Seen in screenshots (reviewer, 13 November; emulated Chromium at 390×844, synthetic data).** From a trace link to "what went wrong in this turn" took one tap and four long scrolls. What the user asked appeared only as escaped JSON in an attribute table; a failing tool's name was cut to "u…"; tapping a span showed its detail below the fold; one wrong password at sign-in lost the linked trace.

**Read on the host, 12 November (structure only).** Chief's turns end with a `finish_turn` tool call whose `reply` argument is the reply, and a failed tool span has no status message: the reason is in its result. Both shaped the trace page's summary.

Not measured: how the owner reads a real trace on a real phone. The acceptance check below is that.

## Diagnosis and alternatives

Three separate causes sat between an alert and its answer:

1. **The alert named nothing.** A global rate crossing a line does not say which tool, and the message gave no way in. Fixed where the knowledge is: agentwatch records, when a monitor fires, the worst tool or model and up to three traces behind the figure, and gives each a link when it is told its public address.
2. **The trace page opened on the wrong thing.** It showed a span tree and raw attributes. It now opens on what was asked, what was replied and the first error, with the failed span selected.
3. **Small losses on the way.** A wrong password dropped the link; filters did not survive a reload.

Alternatives considered:

- **Chief builds the links itself** from a new `AGENTWATCH_PUBLIC_URL` variable. That needs a second Compose line and its own rollout, and Chief would have to learn agentwatch's routes. agentwatch already has to be told its address to be reachable, so it builds the links and Chief only checks their shape.
- **A monitor per tool.** It would have caught the 48-of-50 case, and remains worth doing (step 3 of the plan, as issue grouping), but every alert needs to point at its evidence whatever the monitor.
- **A model-written explanation in the alert.** Not while the plain facts are missing from it.

## Implementation and review

agentwatch:

- [#22](https://github.com/akhilvuputuri/agentwatch/pull/22), merged as `090cca1`: the trace page. Review (Opus 5.5) of `e8d0767`: **request changes**. Reproduced by the reviewer: a turn that failed after asking for a tool showed that tool's argument as "Replied"; the first-error choice missed a failure below a span that succeeded; on a narrow screen a tap could do nothing after a resize, and close then needed two taps. Fixed in `41d735e` (a tool call is a reply only with a `reply`, `answer`, `response` or `message` argument; failed ancestors are explained through any depth; the panel follows the address through the History API). Re-review: **approve with nits**, all four addressed in `0c06c36`.
- [#23](https://github.com/akhilvuputuri/agentwatch/pull/23), merged as `5acc163`: a refused sign-in keeps the route and the user name; the trace list's and dashboard's filters live in the address. Review (Opus 5.5): **approve with nits**; it confirmed cross-site posts to the sign-in are refused, the escaping, and the page's content policy hash, and found an unknown service filter showing as "All", fixed.
- [#24](https://github.com/akhilvuputuri/agentwatch/pull/24), in review: `detail` and `examples` on a firing alert, and `serve --public-url`.

Chief (this change):

- [src/trace-alerts.ts](../../src/trace-alerts.ts): a firing alert's text is followed by its detail and up to three examples, each a label and, on its own line, its link. Labels are reduced to one plain line and 120 characters, as a monitor's name is. The link field is passed on only when it is an `https` link to a trace page (`TRACE_URL`). That bounds the links this change adds, not what Telegram links by itself: a label, like a monitor's name, is plain text, and Telegram may still make a link of an address written in one. The names that can reach a label are a tool's (the model APIs allow letters, digits, `_` and `-`), a model's, an error type's and a score's; agentwatch makes each one word of at most 64 characters. Without any link the text still ends "Details in agentwatch.". A resolved alert shows none of it. An alert without the new fields reads exactly as before, so this can release ahead of agentwatch.
- [src/main.ts](../../src/main.ts): alerts are sent with link previews off; a preview could only show the sign-in page.

## Verification and outcome

Tested: 15 tests in [tests/trace-alerts.test.ts](../../tests/trace-alerts.test.ts), 3 new (the text with pointers, the text without links, and hostile labels and links). Independent review (Opus 5.5) of this branch's first commit: **approve with nits**. It found the claim about addresses overstated (corrected above and in the code), a test that still passed with the link pattern's anchor removed (a case added), and that a cut could halve a character (the half is now dropped, also from a monitor's name). It compared 20 alerts without the new fields against `main` and found the text identical. agentwatch's own tests and browser tests are in its pull requests.

Not yet verified: anything on the host. What the rollout has to show: a firing alert arrives in Telegram with a link; the link opens the trace on a phone at its summary, with the failed span one tap away.

Limits: examples are read when an alert fires and not updated; a trace named in an old alert may since have been removed by retention, and its page then says so. Labels carry tool, model and error-type names, which reach the owner's chat; they never carry message content.

> **Update, 13 November 2026:** agentwatch#24 merged as `b11b4a3` after a second review. The first (Opus 5.5, **request changes**) reproduced a "worst" tool named on a tie-break when each tool had failed once, a long name pushing the numbers out of the detail line, and a cost alert for a figure that was too low pointing at the costliest traces. The fix names a tool only when it failed more than any other, makes each name from a span one word of at most 56 characters, and points at nothing for a figure that is too low. Re-review: **approve with nits**, addressed. Chief's relay change merged as `723d04f` and released automatically (gateway healthy); with the old agentwatch it changes nothing.
>
> The rollout pins agentwatch to `sha256:3a00e227…` (the image of `b11b4a3`) and adds `--public-url https://traces.52-77-47-24.sslip.io` to its command. That image moves agentwatch's database to schema 12, which the image now on the host cannot open. Until now [the update procedure](../../scripts/deploy-agentwatch-update.py) "restored the previous agentwatch" by restoring only the container, so after a schema change a rollback would have ended with agentwatch down ([lightsail](../lightsail.md) said so, and two earlier schema changes were covered by a volume archive made by hand). The procedure now stops agentwatch, copies its data files to `/var/backups/agentwatch-update/`, and on a rollback puts them back before starting the previous image. Tested offline: the harness models an old image that cannot open what the new one wrote, and the two copy scripts are run on real directories.
>
> Independent review (Opus 5.5) of that first version: **request changes**. Inferred from agentwatch's source and reproduced on scratch directories: a killed agentwatch leaves scratch directories in its volume, the restore removed entries with `os.remove`, which fails on a directory, and by then it could already have deleted the database, leaving the volume part emptied and the message saying "volume kept". Also: Ctrl-C or `systemctl stop` skipped the rollback altogether; a copy that failed half-way stayed on disk looking finished; and the runbook did not say how to put a copy back. Fixed: the copy and the restore handle directories and links, the restore refuses to empty anything unless the copy holds a database, a copy is named only when complete, a stop request leads to the rollback, a failed rollback says at which step and what state that leaves, and `--restore <copy>` puts a copy back.
>
> **Rehearsed, 13 November, on Docker Desktop 28.1.1 (macOS, the amd64 images under emulation), with [scripts/rehearse-agentwatch-update.py](../../scripts/rehearse-agentwatch-update.py), the live image `sha256:4db1c295…` and the new one, on a throwaway volume.** The first run stopped at the copy: the volume held a hidden directory (`.cache`, made by the emulator, absent on the host), which the copy then refused; that is why it now copies directories as they are. The second run: the old image started and recorded a trace; the copy was made (mode 700, scratch directories left out); the new image started on the same volume, answered `/api/alerts` and recorded a second trace, and was killed; the old image then refused to start, "database schema 12 is newer than this agentwatch supports (11)", which is the premise; after the restore the volume held the copied entries only, owned by 10001:999 as before, and the old image started and listed the first trace and not the second. A copy from a volume that does not exist was refused, and no volume was created. Not rehearsed: Compose's own stop and start, and Docker 29 on the host.

### Release closure

Pending: review and merge agentwatch#24; pin its image and add `--public-url` to the agentwatch command through the reviewed update procedure; owner acceptance from a phone.
