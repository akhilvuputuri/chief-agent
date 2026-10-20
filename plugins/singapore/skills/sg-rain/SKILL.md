---
name: sg-rain
description: How to read NEA rain radar with sg_rain and describe where rain is, where it went and where it is heading for a location.
---

# Rain radar

Use `sg_rain` for questions about rain moving, approaching or passing. Examples: "is rain coming my way?", "where's the rain now?", "how did the rain move over the last 3 hours?", "when will it stop?".

## Choosing the location

- **Shared pin:** the brief may contain a shared Telegram pin (`[Shared location: lat …, lon …]`). Pass `lat` and `lon` exactly.
- **Typed place:** for a postal code, building, MRT station or town, pass `place`.
- **Saved home:** if the brief gives the owner's saved home coordinates or area, use them.
- **Nothing given:** pass `region`, or omit everything for all of Singapore.
- **Always:** say which location you used. If the tool cannot find the place, ask for a postal code, a nearby MRT station or a shared location.

## Choosing the window

- `hours` defaults to 1. Use 3 or 6 when the owner asks how rain moved or developed, or for "today so far".
- The tool spaces frames automatically, every 5 to 15 minutes.
- Use `range` 240km for systems still far away, such as a squall line approaching from Sumatra or a monsoon band. The default 70km view is more detailed near Singapore.

## Reading the result

- `now.atLocation`: rain over the location: none, light, moderate, heavy, very heavy or intense.
- `now.within5km`, `within10km`, `within25km` (on the 240km view: `within25km`, `within50km`, `within100km`): the share of the area with any rain (`rainPct`) and with heavy rain (`heavyPct`).
- `nearestRain` and `nearestHeavyRain`: distance and compass direction from the location, for example "12 km SW".
- `atLocationHistory`: about how long it rained there in the window, when it last rained, and the heaviest level and when.
- `timeline`: up to 13 points from oldest to newest. Each gives the rain at the location, the share of the surrounding area with rain, where the main rain mass sat, and the peak level.
- `movement`:
  - `recent` covers the last 45 minutes and `overWindow` the whole window.
  - Each gives `summary` in everyday words ("drifting slowly west", "moving quickly east", "barely moving", "shifting around without a clear direction"), plus the direction, speed in km/h and steadiness for when the owner asks.
  - "barely moving" means the rain grew or faded in place rather than travelling.
- `outlook.estimate`: the level expected over the location in 10 to 60 minutes if the recent motion continues. It is null when the motion is too weak or erratic, or the newest frame is over 20 minutes old.
- `atLocationHistory.rainedForAboutMinutes` is null when only one frame came back; `framesMissing` counts frames the provider did not return.

## Pictures

- Pass `picture` to send the owner a radar picture after your reply:
  - `animation` for how rain moved over the window (a looping GIF, oldest to newest);
  - `map` for where rain is right now.
- Send one when the owner asks to see the radar or how rain moved. Skip it for quick questions unless asked.
- When `picture.status` is "queued", say only that it follows ("The radar loop follows."). Never mention frames, queues or separate messages. When it is "unavailable", just answer in text.

## Telling it

The owner wants an answer, not the radar's numbers. Your report's summary is what the owner reads, so write it as that reply.

- **Short.** "Is rain coming?" gets one or two sentences. "How did the rain move?" gets two or three. No headings, no bullet lists, no sections such as "What's next".
- **Everyday words, not statistics.** Say "a few patches just north-west of you", "a bigger area off to the north-east", "drifting slowly west", "it may reach the east in the next hour".
  - Leave out speeds, percentages, coverage shares, the distance rings, intensity labels beyond light or heavy, frame counts and frame times.
  - At most one distance, and only when it matters ("about 10 km away").
  - Give numbers only if the owner asks for them.
- **Answer first, then the one thing that matters next.** For example: "No rain near you right now. There are some showers off to the north-east, drifting slowly west, so the east might get a light shower in the next hour." For history: where the rain was, how it moved, where it is now, in two or three sentences.
- **Hedge outlooks** with "may" or "might". Storms grow and fade quickly.
- **Rain questions use the radar only.** Do not also call sg_weather or sg_alerts unless the owner asks about the forecast, lightning or floods, or the radar is unavailable.
- **Times:** mention a time only when the radar is more than 10 minutes old ("as of 12:40 am").
- **Location:** name it only if the owner gave one or it is not where they are.
- **Source:** keep the returned source line as the last line of your report, not in the summary.
