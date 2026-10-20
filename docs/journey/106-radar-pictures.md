# 106 — Radar pictures: can Merlion show the owner the rain, not just describe it?

Work date(s): 2026-10-20. Written/revised: 2026-10-20.
Status: released in `8673bd5` (20 October 2026); owner acceptance pending. Merlion can queue a radar map (PNG) or a loop of the window (GIF), and Chief sends it on Telegram right after the text reply.

## User-visible problem and preceding iteration

[105 — Rain radar](105-rain-radar.md) gave Merlion a text summary of NEA radar: rain now, its movement and a rough outlook. The owner asked for images or animations too, the way myENV shows rain moving across the island. Chief had no way for a tool to send a picture: replies were text, and only the voice path and coding documents sent files.

## Evidence

- **Measured: OneMap static map** (20 October 2026, Mac).
  - Earlier that day it returned a 512 × 512 RGBA PNG at zoom 11 without a token ([105](105-rain-radar.md)).
  - Later, for both `default` and `grey` layers, two requests returned 504 and two more timed out after 60 s.
  - Zoom 11 is the widest allowed: one 512-pixel image covers about 39 km, less than the island's width.
- **Measured: URA region boundaries.** data.gov.sg dataset `d_4ce0038f7ac689652350bb91b7fb92ed` (Master Plan 2025 Region Boundary, no sea) has 5 regions and about 30,000 WGS84 points. Simplified at 0.0003° (about 30 m, below the picture's pixel size) and dropping islets under about 0.02 km², it keeps 30 rings and 1,722 points. Encoded as Google polylines, that is 7.8 KB.
- **Measured: rendering on live frames** (20 October, 3-hour window at 10-minute steps, light scattered rain).
  - Map: 960 × 634, 9.8 KB, rendered in 64 ms.
  - Loop: 720 × 476, 19 frames, 186 KB, rendered in 116 ms.
  - Viewed by eye: regions, coastline, outlying islands, rain speckles in legend colours, the location marker and the time label are all legible. Heavier rain will compress less; sizes for a wet afternoon are not yet measured.
- **Tested:**
  - `tests/singapore-radar-image.test.ts` (6 tests):
    - GIF LZW round-trips through an independent decoder, written from the specification and refusing to read past the data. It covers runs, noise, table resets and every length up to 599 at code sizes 2, 4, 7 and 8. The end code is as wide as the decoder expects, which fails without the end-code fix below;
    - polylines decode as in Google's reference example;
    - palette PNGs decode back exactly, and GIFs loop with the set delays;
    - the map shows sea, land, rain blended over land, the marker and the time label;
    - the loop plays oldest to newest and holds the newest frame;
    - one radar pixel lands on exactly the map pixels whose centres it covers. This fails if the mapping rounds instead of flooring.
  - `tests/telegram-media.test.ts` (2 tests): pictures go to the owner in the reply's thread, in order, each sent on its own so one failure does not stop the next. A withheld reply sends nothing and leaves the pictures queued.
  - `tests/media-outbox.test.ts` (3 tests):
    - the outbox keeps at most 3 pictures per run and 10 runs for 15 minutes, hands each out once, and caps captions at 1,024 characters;
    - pictures from several runs come out in the order they were queued;
    - the run-family query, on PGlite, includes the delegated agent's pictures and excludes another owner's;
    - `sg_rain` queues a GIF or PNG only when asked and when it knows its run.
  - `tests/steering-telegram.test.ts`: the pictures a delegated agent queued follow the text reply, with their caption. Another run's picture stays queued, and a failed send neither fails the turn nor triggers the failure notice.

## Diagnosis and alternatives

- **Basemap:** the bundled outline of the five regions is drawn locally, instead of a OneMap tile.
  - It never depends on a map service being up, and it costs no request.
  - The picture shows all of Singapore in one view, which a single OneMap image cannot do.
  - Rejected: OneMap as the base with the outline as a fallback. Its recent 504s and timeouts would add up to a minute to a reply, and it would need tile stitching.
  - Cost: Johor and street detail are not drawn, and the caption says so.
- **Pixels on the host:** the radar is drawn from the frame's own pixels inside the island box, kept with each cached frame (about 30 KB per 70 km frame), rather than from the 1.2 km analysis grid. Each NEA pixel is about 4.5 picture pixels wide.
- **Fixed palette, no quantiser:**
  - 8 map colours, plus the 33 legend colours blended at 75 % over sea and over land: 74 colours.
  - Every frame is written directly as palette indices: a palette PNG for the map, and a 7-bit GIF for the loop.
  - The GIF encoder is about 60 lines in the repository, rather than a new dependency.
- **Delivery:**
  - `sg_rain` gains `picture: "map" | "animation"`. The tool renders the picture and puts it in an in-memory outbox keyed by its run.
  - After sending the text reply for a run, Chief takes the pictures queued under that run and the agent runs it started, and sends them. The runs are found by the same run-family query approvals use.
    - This covers direct replies, under the same delivery guard as voice replies, and background work replies such as routines, in the same topic thread.
    - The pictures go out with `sendPhoto` or `sendAnimation`.
  - Nothing is persisted. A withheld reply or a restart drops the pictures, which expire after 15 minutes; the owner can ask again.
  - Rejected: putting image bytes on the reply object. Views persist replies, and binary payloads do not belong there.
  - Rejected: a separate "send picture" write tool. The picture is part of answering the owner's question, sent to the owner only, in the same turn.

## Implementation and review

- **Code:**
  - `src/singapore/radar-image.ts`: base map, drawing, palette PNG and GIF encoders;
  - `src/singapore/region-outlines.ts`: generated outlines with their source and licence;
  - `src/singapore/radar.ts`: legend index and island detail per frame;
  - `src/media-outbox.ts`;
  - the `picture` option in `schema.ts` and `tools.ts`; `tools.ts` passes the run;
  - `main.ts` and `telegram.ts`: send after the reply.
- **Plugin:** Singapore v1.3.0. The `sg-rain` skill says when to send a picture and how to refer to it, and the hash is re-pinned. No new tool, so registry grants and delegation are unchanged.
- **Independent review** (Opus 5.5) approved 28742b4 with no blocking findings. It checked:
  - every PNG chunk CRC with Python's zlib;
  - a GIF that forces several table resets, pixel for pixel, with macOS ImageIO;
  - the worst case of 37 frames of noise: 414 ms to render, a 5.2 MB GIF, about 175 MB peak in the test process.

  Non-blocking findings fixed before merge:
  - background and scheduled runs were told a picture would follow, but only direct replies sent pictures. Background work replies now send them too.
  - the end code could be one bit narrower than a decoder expects after the final entry. The encoder now grows the code size there, as the decoder does.
  - one failed picture skipped the rest; each is now sent on its own.
  - the caption's time came from the timestamp text rather than the frame's instant. A place outside the picture, which the 240 km view allows, was still said to be marked, and the caption did not credit URA for the map. All three are fixed.
  - there were no tests for a withheld reply, the topic thread, or a one-pixel georeferencing offset. All three now have tests.

- **Second review** (Opus 5.5) approved d4392c0 with no blocking findings.
  - It found that the old end code was narrower than the decoder expected in 33 of 9,600 random streams, and in none after the fix.
  - Its two remaining points were fixed: the stricter decoder alone could not catch that bug, so the end-code width is now compared directly; and a guard error before the first picture could fail the turn, so it is now caught.
- **Devin** found two issues, both fixed:
  - when a reply fell back to General because its topic had become unusable, the pictures were sent afterwards, outside that fallback, and could be redirected to Main. They are now sent inside the same delivery callback, right after the text, with its thread.
  - pictures from two delegated runs could arrive in run-ID order rather than the order they were made. The outbox now numbers them as they are queued.

## Verification and outcome

Released (closure below). Pending owner acceptance:

- ask "show me how the rain moved over the last 3 hours", and check the loop arrives after the reply and plays in Telegram;
- ask "show me the radar now" with a shared pin, and check the marker sits on the pin;
- check the rain's position against myENV for the same time.

### Release closure — 2026-10-20

- **What merged.** [PR 291](https://github.com/akhilvuputuri/chief-agent/pull/291) was squash-merged at approved head `6a454f5` as `9c184b59aec0155095d9b549471f6166ff779fb9`. Hosted CI and Devin passed on that head.
- **First release attempt** ([run](https://github.com/akhilvuputuri/chief-agent/actions/runs/39429738495)): cancelled by the job's 15-minute timeout while the deploy step was still running. The handler builds the image before its idle check, and it printed nothing.
  - **Production logs (CloudWatch, 12:50–15:20 UTC)** show the gateway stayed on `adbba7b`, healthy, until `8673bd5` replaced it:
    - heartbeats every 5 minutes from 13:31 to 14:51 UTC, with uptime rising steadily from 2,100 s to 6,900 s, so there was no restart;
    - `gateway.stopping` for `adbba7b` at 14:54:21 UTC;
    - no `9c184b5` line at all.

    So the cancelled attempt deployed and rolled back nothing, including after the job was cancelled.

  - Successful deploy steps earlier that day took about 4–6.5 minutes, apart from one 17-second outlier. The cause of the slow attempt is not established.
  - **Follow-up:** the host handler pipes its build output and does not handle the SSH session closing, so a cancelled release could in principle keep running and deploy unannounced. It did not here (above), but the handler should stop with its session or log its outcome.
- **Live.** The release of `8673bd5` (#292 on top of this PR) succeeded at 14:54 UTC ([run](https://github.com/akhilvuputuri/chief-agent/actions/runs/39443054854)), with `release:status` success.
- **Production logs.** The gateway started on `8673bd5` at 14:54 UTC, with heartbeats at 15:14 and no errors in the following 20 minutes.
- **No migration** and no Compose change.
- **Not yet observed:** a picture sent to the owner in production.
- **Remaining follow-up from review:** if the delivery-guard check inside the picture loop throws a database error, the turn can still fail after the text was sent. Voice replies have the same exposure.

## Follow-up and next iteration

- **Georeferencing:** the radar's position is taken as linear in its published latitude/longitude box. NEA describes the image as an azimuthal equidistant projection. Over 70 km the difference should be well under a pixel; this is a hypothesis to check against myENV.
- **Telegram's handling of the GIF** (it converts it to a video) and the loop's size on a wet afternoon are not yet measured.
- **Optional context:** a Johor outline, or place labels.
