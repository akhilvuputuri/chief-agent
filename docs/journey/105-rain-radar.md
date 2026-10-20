# 105 — Rain radar: can Merlion tell where rain is, how it moved and where it is heading?

Work date: 2026-10-20. Written: 2026-10-20.
Status: released in `adbba7b` (20 October 2026); owner acceptance pending. Builds on [journal 103](103-singapore-plugin.md).

## User-visible problem and preceding iteration

Merlion's rain answers came from the 2-hour area forecast and rain gauges. Those say whether rain is falling or expected, but not where the rain is, which way it is moving, or how it passed over the last few hours. The owner asked for exactly that, as the myENV app shows it. They also wanted to give a location by sharing a Telegram pin or naming a place. Chief rejected Telegram location messages: "Please send text, a voice note, a photo or a PDF document."

## Evidence

- **Measured: NEA radar API** (20 October 2026, Mac, data.gov.sg key).
  - `weather-radar-images/70km` and `/240km` return one frame per call. Each frame has a georeferenced boundary box and a signed link to a 480 × 480, 8-bit palette PNG in NEA's S3 bucket.
  - `date=YYYY-MM-DDTHH:mm:ss` returns the frame at that time.
  - Each frame carries only the colours it uses. Across 16 afternoon frames from 13–20 October, the legend has 33 colours plus a transparent one: 6 teals and cyans (light), 10 greens, 5 yellows, 4 oranges, then reds and magentas (intense). Some palettes also hold an opaque white that no pixel used. No numeric scale is published with the image.
  - Timestamps carry a `+08:00` offset.
- **Measured: rate limit.** At 0.4 s spacing the radar route returned 429 even with the key. At 1 s and 2 s spacing, 14 of 14 requests passed each time. The radar now has its own rate group at 1.1 s.
- **Measured: OneMap without a token.**
  - Address search returns results for a postal code or "Bishan MRT", alongside an "Authentication token missing" message.
  - The static map returns a 512 × 512 RGBA PNG at zoom 11 or more. It is unused so far, kept for the planned radar picture.
- **Measured: live run of `sg_rain`** on the afternoon's real radar.
  - **Speed:** cold calls took 13–21 s for 13–25 frames, and cached frames are not fetched again.
  - **6-hour window for an eastern point:**
    - a rain mass sat 18 km E at 12:25 and 7 km SE at 13:25;
    - it was over the point at 13:55, then moved away north;
    - overall motion was south-east to north-west at about 16 km/h, labelled steady.
  - **Answer size:** about 3k characters.
- **Measured: speed estimates on synthetic discs** after sub-cell refinement. True speeds of 0, 8, 17, 27 and 53 km/h were estimated at 0, 9, 16, 27 and 53 km/h, all labelled steady. Before refinement, whole-cell shifts reported 8 km/h rain as 13 km/h.
- **Tested:** `tests/singapore-radar.test.ts` (15 tests) covers:
  - PNG decoding with filtered rows;
  - colour levels for all 33 legend colours, which never fall along the legend, and opaque white as no rain;
  - slow rain at about 8 km/h, estimated within 5–11 km/h, not called erratic and given an outlook;
  - zig-zagging rain on the 240 km view, called erratic with no outlook;
  - a wet 240 km cell counted at a pin near its corner, a pin in the dry cell next door read as dry, and an unknown duration from a single frame;
  - stop-go rain (one cell every other frame) called steady with an outlook;
  - lead times shifted by the newest frame's age, and no outlook from a frame over 20 minutes old;
  - a forecast-feed outage still resolving a postal code through OneMap, and reported as an outage when OneMap finds nothing;
  - bare timestamps read as Singapore time, and concurrent calls sharing each frame fetch;
  - a synthetic disc moving east at about 27 km/h, giving the right direction, speed and a 20–45 minute arrival;
  - stationary rain, dry frames and frame caching;
  - the radar bucket allow-list;
  - place resolution, including that OneMap never receives the key;
  - the Telegram location line;
  - registration.

## Diagnosis and alternatives

- **On the host, not the model:** frames are decoded and analysed on the host, without a model. The model gets a compact summary: now, rings, nearest rain, history at the point, a timeline of up to 13 points, movement and a rough outlook. It never gets pixels.
  - Rejected: passing radar images to a vision model. That is slower and costlier, and depends on the model reading a picture correctly.
- **Movement:** estimated by the best shift between consecutive frames (about 1.2 km cells on the 70 km view), weighted by rain level and limited to 90 km/h. A parabola through the best score and its neighbours refines the shift to a fraction of a cell. Consistency is one minus each pair's scatter from the average, as a share of the average speed. Stop-go rounding (a cell shift, then none) lies along the track, so half a cell's worth is forgiven there; a change of direction shows across the track, where only a quarter of a cell is forgiven.
  - Measured on synthetic discs: steady motion at 9–53 km/h and stop-go motion of one cell every 10 minutes are steady with an outlook. Zig-zags of half a cell to two cells on both views, and back-and-forth motion, are erratic or stationary with no outlook.
  - Known limit: stop-go that alternates between the two axes (one frame east, the next north) reads as erratic, so no outlook is given. That fails safe.
  - Earlier versions: a single allowance of a full cell was too lenient on the 240 km view (a zig-zag read as fairly steady); half a cell everywhere called stop-go rain erratic. The outlook moves the newest frame along the recent motion. It is labelled a rough guide, because thunderstorms grow and decay.
- **Location:**
  - a Telegram pin is exact (Telegram sends latitude and longitude);
  - typed places try NEA forecast areas, then OneMap search;
  - regions and the whole of Singapore are fallbacks.
- **Intensity:** colours map to five coarse levels. NEA does not publish mm/h with the image, so none is claimed.

## Implementation and review

- **Radar code (`src/singapore/`):**
  - `png.ts`: palette PNG decoder;
  - `radar.ts`: frames, cache and analysis;
  - `places.ts`: location resolution.
- **Network:** `routes.ts` adds the radar and OneMap routes and the radar-bucket allow-list. `http.ts` adds byte downloads, the radar rate group, and keeps the data.gov.sg key off OneMap.
- **Tool:** `sg_rain` (read-only) is in `protocol`, `readOperations` and the runtime description.
- **Telegram:** `src/telegram-location.ts`, plus `telegram.ts`, turn a shared pin or venue into a `[Shared location: …]` line.
- **Plugin:** the `sg-rain` skill; Merlion's tools, description and instructions; the registry grants, delegation and hash.
- **Independent review** (Opus 5.5) approved 753f7f4, then the follow-up 193200e, with no blocking findings. Non-blocking findings were fixed before merge:
  - slow rain was labelled erratic, and whole-cell shifts overstated its speed: sub-cell refinement and the new consistency measure;
  - only seven palette colours were tested: the full legend is now an exact table, with a hue fallback;
  - a timestamp without a zone would have been read as UTC: bare times are Singapore time, and unreadable times are dropped;
  - concurrent calls fetched the same frames twice: in-flight fetches are shared;
  - venue text could blend into the location note: it is now labelled as given, without quotes or brackets;
  - a doc comment sat above the wrong function;
  - on the follow-up: the consistency measure was lenient on the 240 km view (now half a cell's worth), and the slow-rain test's outlook check was vacuous.
- **Devin review** found four defects, now fixed and tested:
  - on the 240 km view (cells about 3 km across), a pin near a cell corner was more than 1.5 km from every cell centre, so rain over it read as none. The point radius now always covers the cell containing the pin, and the outlook uses the same rule.
  - Outlook lead times counted from the newest frame, not from now. They now add the frame's age, and a frame over 20 minutes old gets no outlook.
  - A two-hour forecast outage blocked typed places before OneMap was tried; the forecast-area shortcut is now optional.
  - With a single frame, rain duration read 0 minutes; it is now unknown (null). Missing frames are reported as `framesMissing`.
  - Devin also flagged venue text inside the location note; the note's instructions now come first, and the venue follows as labelled untrusted text.
- **Devin's second pass** found three more, also fixed and tested:
  - the wider point radius could borrow a neighbouring cell's rain on the 240 km view, so a dry pin read as wet. Rain at the location now comes from the cell containing the pin, for current rain, history and the outlook;
  - stop-go rain was called erratic: fixed by splitting along-track and cross-track scatter, as above;
  - a forecast outage plus no OneMap match was reported as an unknown place; it is now reported as a temporary outage.

## Verification and outcome

Released (closure below). Pending owner acceptance:

- live Telegram acceptance: share a pin and ask "is rain coming?", and ask "how did the rain move over the last 3 hours?";
- check the reply's time and direction against myENV.

### Release closure — 2026-10-20

- **What merged.** [PR 288](https://github.com/akhilvuputuri/chief-agent/pull/288) was squash-merged at approved head `97d6b53` as `d1c66bade2f075badae533e1b86b3d1bc034dc83`. Hosted CI and Devin passed on that head.
- **First release attempt.** It stopped at its own guard, which releases only the current `main`, because #290 had merged on top.
- **Live.** The release of `adbba7b` (#290 on top of this PR) succeeded at 12:56 UTC ([run](https://github.com/akhilvuputuri/chief-agent/actions/runs/39425373111)). `release:status` reports the exact commit deployed and startup health passed.
- **Production logs.** The gateway started on `adbba7b` and logged heartbeats until it was replaced by `8673bd5` at 14:54 UTC, which also contains this change.
- **No migration** and no Compose change.
- **Not yet observed:** an owner `sg_rain` call in production.

## Follow-up and next iteration

- **Radar picture or animation:** built in [106](106-radar-pictures.md), drawn over a bundled region outline instead of the OneMap basemap.
- **"Rain approaching home" alert:** a deterministic alert, which needs a table and a migration.
- **Location storage:** shared pins are kept only as conversation text. Saving "home" as coordinates in explicit memory is up to the owner.
