# 106 — Radar pictures: can Merlion show the owner the rain, not just describe it?

Work date(s): 2026-10-20. Written/revised: 2026-10-20.
Status: tested; not deployed. Merlion can queue a radar map (PNG) or a loop of the window (GIF), and Chief sends it on Telegram right after the text reply.

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
  - `tests/singapore-radar-image.test.ts` (5 tests):
    - GIF LZW round-trips through an independent decoder, written from the specification, for runs, noise and table resets at code sizes 2, 4, 7 and 8;
    - polylines decode as in Google's reference example;
    - palette PNGs decode back exactly, and GIFs loop with the set delays;
    - the map shows sea, land, rain blended over land, the marker and the time label;
    - the loop plays oldest to newest and holds the newest frame.
  - `tests/media-outbox.test.ts` (3 tests):
    - the outbox keeps at most 3 pictures per run and 10 runs for 15 minutes, hands each out once, and caps captions at 1,024 characters;
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
  - After sending the text reply for a run, the Telegram client takes the pictures queued under that run and the agent runs it started. These are found by the same run-family query approvals use.
  - The pictures go out with `sendPhoto` or `sendAnimation`, under the same delivery guard as voice replies.
  - Nothing is persisted. A background run that never replies, or a restart, drops its pictures; the owner can ask again.
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
- **Independent review:** pending.

## Verification and outcome

Not deployed. Stacked on the rain radar PR ([105](105-rain-radar.md)).

After release, live acceptance:

- ask "show me how the rain moved over the last 3 hours", and check the loop arrives after the reply and plays in Telegram;
- ask "show me the radar now" with a shared pin, and check the marker sits on the pin;
- check the rain's position against myENV for the same time.

## Follow-up and next iteration

- **Georeferencing:** the radar's position is taken as linear in its published latitude/longitude box. NEA describes the image as an azimuthal equidistant projection. Over 70 km the difference should be well under a pixel; this is a hypothesis to check against myENV.
- **Telegram's handling of the GIF** (it converts it to a video) and the loop's size on a wet afternoon are not yet measured.
- **Optional context:** a Johor outline, or place labels.
