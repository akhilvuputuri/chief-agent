# 111 — US AQI from NEA: can Merlion give the aqicn.org comparison without a new data source?

Work date(s): 2026-10-21. Written/revised: 2026-10-21.
Status: released in `eb03a02` (21 October 2026); owner acceptance pending. `sg_air` now adds each region's US EPA AQI, computed from NEA's 1-hour PM2.5. This is the number aqicn.org shows for Singapore.

## User-visible problem and preceding iteration

For haze, the owner compares NEA with aqicn.org and asked whether Chief could integrate aqicn. Merlion's `sg_air` ([99](99-singapore-open-data.md), [103](103-singapore-plugin.md)) gave NEA's 24-hour PSI and 1-hour PM2.5. During the 21 October haze, aqicn showed 164 for the West while NEA's PSI was 131.

## Evidence

- **Measured: aqicn's Singapore readings are NEA's PM2.5 on the US scale.**
  - At 11:00 SGT on 21 October, NEA's 1-hour PM2.5 was 33, 46, 53, 67 and 82 µg/m³ for north, south, east, central and west.
  - Converted with the US EPA PM2.5 breakpoints in force before May 2024, these give 95, 127, 144, 157 and 165.
  - aqicn's map showed 95, 127, 144, 157 and 164 for the five NEA regional stations: four exact, and the West within 1. aqicn's 164 implies about 80–81.6 µg/m³, so it probably used a slightly different hourly value. A later check showed the same four that were visible.
  - Its Singapore page also shows about 15 further points that NEA does not publish. They were not identified; they may be citizen or low-cost sensors, which aqicn says can be unreliable.
- **Measured: why the figures differ.**
  - For the same PM2.5, PSI and the US AQI agree at about 12 µg/m³ (50) and at 150 µg/m³ (200), but the US scale is much higher in between. For example, 50 µg/m³ is PSI 94 and US 137.
  - On 21 October the 24-hour and 1-hour PM2.5 were almost equal (west about 84 and 82), so the whole gap that day came from the scale.
  - In a fast-changing haze episode, the hourly figure also leads the 24-hour average.
- **Reviewed: aqicn's API and terms** (aqicn.org/api, json-api/doc, api/tos, 21 October).
  - A free token, given a name and email.
  - Feeds by city, station ID, lat/lng or map bounds, with official versus citizen networks, a 3–8 day PM2.5 forecast, and search.
  - It must not be sold or used in a paid service. WAQI and the originating agency must be credited, cached data must not be redistributed, and all data is unvalidated.
  - No Johor or Riau stations appeared near Singapore on its map.
- **Tested** (`tests/singapore.test.ts`):
  - the five readings above convert to 95, 127, 144, 157 and 165, which track aqicn (four exact, the West within 1);
  - non-finite and negative readings give no value;
  - the band edges, the top of the scale and missing readings;
  - the band names;
  - `sg_air` includes `usAqi`, `usBand` and the explanatory note.

## Diagnosis and alternatives

- **Chosen:** compute the US AQI on the host from NEA's PM2.5. It needs no key, no new terms, no new request and no Compose change, and it tracks aqicn for NEA's stations.
- **Breakpoints:** the older US EPA PM2.5 breakpoints, because those match aqicn's values. The 2024 US breakpoints would read slightly higher above 55 µg/m³ (west: 170), so replies call it "the US AQI aqicn uses", not the current official US figure. EPA defines its PM2.5 AQI on 24-hour averages; aqicn applies it to the hourly reading.
- **Deferred:** the aqicn API itself. It would add the unidentified extra points and a PM2.5 forecast. It needs a token, and adding a new environment key means a Compose change and the operator rollout. Revisit if the owner wants neighbourhood readings or the forecast.
- **The skill:** for haze questions, give PSI and the US AQI side by side in one line. Explain the difference only if asked.

## Implementation and review

- **Code:** `src/singapore/format.ts` (`usAqi`, `usAqiBand`) and `datagov.ts` (`pm25OneHour.byRegion[*].usAqi`, `usBand` and `usAqiNote`).
- **Model guidance:** the `sg-weather` skill and the runtime description.
- **Plugin:** Singapore v1.5.0, with the hash re-pinned.
- **Independent review** (Opus 5.5) approved fc2e129 with no blocking findings. Its non-blocking points were addressed before merge:
  - "matches" was corrected to four exact and the West within 1;
  - the model-facing wording now says "the US AQI aqicn uses", with the pre-2024 breakpoints, rather than "the US EPA AQI";
  - the figure is offered for haze questions or aqicn comparisons, not every PSI question;
  - a guard returns no value for a non-finite reading.

## Verification and outcome

Released (closure below). Pending owner acceptance: ask "how's the haze?" and check that the reply gives PSI and a US AQI matching aqicn's regional stations.

### Release closure — 2026-10-21

- **What merged.** [PR 306](https://github.com/akhilvuputuri/chief-agent/pull/306) was squash-merged at approved head `601b78b` as `eb03a0257c00679faf67e9379f9f328924e6cb7a`. Hosted CI and Devin passed on that head.
- **Live.** `release:status` reports success: the exact commit deployed and startup health passed. CloudWatch shows `eb03a02` logging from 04:59 UTC (12:59 pm SGT) on 21 October, after `3b67e44`. No migration and no Compose change.
- **Not yet observed:** a haze reply in production that gives the US AQI.

## Follow-up and next iteration

- The aqicn API for extra sensors and the PM2.5 forecast, if wanted.
- A haze alert (for example, PSI above 100 or US AQI above 150 near home) would need a table and a migration, as with rain alerts.
