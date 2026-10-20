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
  - Each gives the direction (from, towards), the speed in km/h and how steady the motion was.
  - "nearly stationary" means the rain grew or faded in place rather than travelling.
- `outlook.estimate`: the level expected over the location in 10 to 60 minutes if the recent motion continues. It is null when the motion is too weak or erratic, or the newest frame is over 20 minutes old.
- `atLocationHistory.rainedForAboutMinutes` is null when only one frame came back; `framesMissing` counts frames the provider did not return.

## Pictures

- Pass `picture` to send the owner a radar picture after your reply:
  - `animation` for how rain moved or developed over the window (a looping GIF, oldest to newest, holding on the newest frame);
  - `map` for where rain is right now (the newest frame).
- Send one when the owner asks to see the radar, or with a movement story over 1 hour or more. Skip it for quick yes/no questions unless asked.
- `picture.status` "queued" means it will arrive right after your answer: mention it in a few words ("the radar loop follows"), and do not describe every frame. "unavailable" means it cannot be sent here; just answer in text.
- The picture marks the location with a red dot and shows Singapore's five regions; Johor is not drawn.

## Telling it

- **Answer the question first.** For example: "Rain is about 8 km west of you and moving east at around 20 km/h, so it may reach you in about 20–30 minutes."
- **For history questions, tell it as a short story from the timeline:** where the rain started, how it moved or spread, when it passed over the location and where it is now. Two to four sentences, not a frame-by-frame list.
- **Hedge outlooks:** "may" and "about". Thunderstorms grow, split and die quickly, so the outlook is a rough guide, not a forecast.
- **Combine when useful:** sg_weather gives the official 2-hour forecast and gauge readings, and sg_alerts gives lightning and floods.
- **Report times in Singapore time**, and mention the latest frame time when it is more than 10 minutes old.
- **Intensity levels:** these are mapped from the radar's colour scale, not measured rainfall. Do not give mm/h.
- **Source:** end with the returned source line.
