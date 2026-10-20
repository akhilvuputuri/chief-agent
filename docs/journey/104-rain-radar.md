# 104 — Rain radar: can Merlion tell where rain is, how it moved and where it is heading?

Work date: 2026-10-20. Written: 2026-10-20.
Status: tested; not deployed. Builds on [journal 103](103-singapore-plugin.md).

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
- **Tested:** `tests/singapore-radar.test.ts` (14 tests) covers:
  - PNG decoding with filtered rows;
  - colour levels for all 33 legend colours, which never fall along the legend, and opaque white as no rain;
  - slow rain at about 8 km/h, estimated within 5–11 km/h, not called erratic and given an outlook;
  - zig-zagging rain on the 240 km view, called erratic with no outlook;
  - a wet 240 km cell counted at a pin near its corner, and an unknown duration from a single frame;
  - lead times shifted by the newest frame's age, and no outlook from a frame over 20 minutes old;
  - a forecast-feed outage still resolving a postal code through OneMap;
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
- **Movement:** estimated by the best shift between consecutive frames (about 1.2 km cells on the 70 km view), weighted by rain level and limited to 90 km/h. A parabola through the best score and its neighbours refines the shift to a fraction of a cell. Consistency compares each pair's scatter from the average with the average speed plus half a cell's worth of speed, so quantisation noise alone does not read as erratic. A full cell's worth was too lenient on the 240 km view, where one cell per 5 minutes is about 35 km/h: rain zig-zagging 45° either side of east read as fairly steady. The outlook moves the newest frame along the recent motion. It is labelled a rough guide, because thunderstorms grow and decay.
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

## Verification and outcome

Not deployed. After release:

- live Telegram acceptance: share a pin and ask "is rain coming?", and ask "how did the rain move over the last 3 hours?";
- check the reply's time and direction against myENV.

## Follow-up and next iteration

- **Radar picture or animation:** the OneMap basemap with the radar layer and a location marker, sent to Telegram as an image or GIF. It needs an image delivery path for agents.
- **"Rain approaching home" alert:** a deterministic alert, which needs a table and a migration.
- **Location storage:** shared pins are kept only as conversation text. Saving "home" as coordinates in explicit memory is up to the owner.
