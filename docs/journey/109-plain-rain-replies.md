# 109 — Plain rain replies: can Merlion answer about rain without a data dump?

Work date(s): 2026-10-21. Written/revised: 2026-10-21.
Status: tested; not deployed. Rain replies are short and in everyday words, and the radar picture's caption is one line.

## User-visible problem and preceding iteration

The rain radar ([105](105-rain-radar.md)) and its pictures ([106](106-radar-pictures.md)) worked in production. The owner found the replies "too statistical and a data dump".

On 21 October, "is rain coming?" got three paragraphs. They covered:

- the 2-hour forecast and rain gauges;
- radar patches with distances and a speed;
- lightning and flood alerts.

"Show me how the rain moved" got headed bullet lists with speeds, distances and a coverage percentage. It also said the animation "has been queued … as a separate message". The picture's caption was a paragraph that said "Singapore marked" when no location had been given, and used 24-hour times while the reply used 12-hour.

## Evidence

- **Reported:** the owner pasted both replies and the caption (summarised above; not copied here).
- **Measured: production trace metadata.** The first question ran Chief (Opus 5.5) → Merlion (Gemini 3.8 Flash), which called `sg_rain`, `sg_weather` and `sg_alerts`. The run took 51 s.
- **Diagnosis from the prompts:** three things pushed the replies towards statistics.
  - The `sg-rain` skill listed every result field, said "combine when useful" with forecasts and alerts, and asked for a source line.
  - Merlion's `findings/v1` report allows a 3,000-character summary and 12 findings, which Chief relays.
  - Nothing said the summary is what the owner reads.
- **Measured: offline replay** (21 October, about 1:15 am SGT).
  - Method:
    - two live `sg_rain` results (1 hour, and 2 hours with an animation queued), with no location given;
    - each given to Merlion's production model, `google/gemini-3.8-flash`, with the old and the new brief and skill;
    - three samples per case, asking for the report summary only.
  - Old: 567–887 characters, with 10–15 numbers (speeds, percentages, coordinates) and the licence URL.
  - New: 108–218 characters, with no numbers. Example: "Over the past two hours, rain hovered mostly off to the north-east and barely moved. Recently, it has begun drifting slowly west, with moderate showers now falling over central areas. The radar loop follows."
  - Limits:
    - the replay skips the tool loop, so whether Merlion still calls the forecast or alerts tools is untested here;
    - it skips Chief's rewrite of the report.
- **Tested:**
  - `tests/media-outbox.test.ts`: the exact one-line caption in 12-hour time; a red dot and "Red dot: your location" for a shared pin; no dot and no location claim when no location was given; the picture note.
  - `tests/singapore-radar.test.ts`: still air reads "barely moving".

## Diagnosis and alternatives

- **Fix at the source.** Merlion's report summary is now written as the owner's reply: short, in everyday words, answering only what was asked.
  - The skill sets the length: one or two sentences for "is rain coming?", two or three for movement.
  - It bans speeds, percentages, coverage rings, frame counts and times, and headings or bullets.
  - It allows at most one distance, and numbers only when the owner asks.
  - Rain questions use the radar only; forecasts and alerts are added only when asked, or when the radar is unavailable.
- **Plain words in the tool result.** Movement now comes as "drifting slowly west", "moving quickly east", "barely moving" or "shifting around without a clear direction". The numbers stay alongside for follow-up questions.
- **Rejected:** a host-side template reply. It would read mechanically and lose the model's judgement about what matters.
- **Rejected:** trimming the tool result. Follow-up questions ("how fast?") still need the numbers.
- **Picture:**
  - The caption is one line, "Rain radar, 11:05 pm – 1:05 am. Red dot: your location.", then a short credit.
  - The dot appears only for a location the owner gave.
  - The tool tells the agent to say only that the picture follows.

## Implementation and review

- `plugins/singapore/skills/sg-rain/SKILL.md` ("Telling it", "Pictures") and `plugins/singapore/agents/merlion.md`. The plugin moves to v1.4.0 and the hash is re-pinned.
- `src/singapore/radar.ts`: plain-word movement summaries.
- `src/singapore/tools.ts` and `radar-image.ts`: the caption, the 12-hour time, and the marker only for a given location.
- **Independent review:** pending.

## Verification and outcome

Not deployed. Acceptance after release: the owner asks "is rain coming?" and "show me how the rain moved", and the replies should read as one or two plain sentences, with no statistics.

## Follow-up and next iteration

- If Chief's rewrite still adds detail from the findings, consider having agents mark a report "owner-ready" so the coordinator relays the summary as is.
- The same plain-language rule may suit Merlion's other domains (weather, air, transport) if their replies read like data.
