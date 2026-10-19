# 99 — Singapore open data: which government data is worth wiring into Chief, and how?

Work date: 2026-10-19. Written: 2026-10-19.
Status: proposed. The research and the design are done; nothing is implemented or deployed. Tracking: [issue 271](https://github.com/akhilvuputuri/chief-agent/issues/271) (data.gov.sg) and [issue 270](https://github.com/akhilvuputuri/chief-agent/issues/270) (LTA DataMall).

## User-visible problem and preceding iteration

Chief answers weather, haze and "is it a public holiday" questions through general web search. The routing eval fixtures still expect that: `evals/decisions/fixtures/routing.json` gold `"web"` for a weather question, and `evals/picker/scenarios.json` gold `[]`. Live Singapore data such as forecasts, PSI, flood alerts, carpark lots and hawker centre closures is published by government agencies through data.gov.sg. Chief does not use any of it.

This iteration surveyed what exists before writing code. The owner chose a first scope from the survey:

- live weather and air quality;
- live alerts;
- carpark data and speed or red-light cameras;
- public holidays and hawker centre closures.

The owner also asked for the whole catalogue to be recorded so it can be added later.

## Evidence

All measurements were taken on 19 October 2026 between about 22:20 and 23:30 SGT, from a Singapore IP without an API key.

- **Measured: real-time endpoints.** Sequential `curl` probes covered 16 real-time endpoints on v2 and legacy v1. For each, the probe recorded status, response size, latency and the age of the latest reading.
  - Latency was 35–140 ms.
  - Payloads ranged from 199 bytes (lightning, with no strikes) to 307,889 bytes (HDB carpark availability, 2,024 records).
  - Air temperature and rainfall on v2 stayed unchanged for 32 and 40 minutes respectively.
  - 24-hour PSI read 114 in the West and 109 in Central at 22:00.
- **Measured: rate limits.**
  - Without a key, v2 returned 429 after 4–6 back-to-back requests, counted across different endpoints.
  - After a throttle, 2-second spacing was throttled again. After a 60-second cooldown, 2-second spacing passed 15 of 15 requests, and 3-second spacing passed 22 and 17 in a row.
  - Datastore search throttled after about 5 quick calls. At one call per 21 seconds, 7 parallel sweep agents saw 4 throttles in about 110 samples, all recovered after 60 seconds.
  - Legacy v1 accepted 30 requests in 2.3 seconds.
  - No response carried `Retry-After` or rate-limit headers.
- **Measured: first catalogue pass.** Before the sweep, one agent shortlisted 23 datasets and sampled their rows on 19 October 2026: through datastore search, or for hawker centres and dengue clusters through a GeoJSON download.
  - Datasets: public holidays, HDB resale prices, the HDB resale price index, HDB median rents, URA private non-landed rentals, COE results, HDB carpark information, hawker centre closures, hawker centres, dengue clusters, CPI, bank interest rates, monthly exchange rates, electricity and gas tariffs, MRT/LRT and trunk bus fares, CPF contribution rates, occupational wages, job vacancies, the unemployment rate, licensed pharmacies and general school information.
  - The sweep agents reused these results instead of re-sampling. The catalogue marks them "rows (first catalogue pass)".
- **Measured: catalogue.** The metadata API listed 4,663 datasets from 74 agencies, in 1,370 collections. Seven agents split the catalogue by theme. Each read metadata for its candidates and fetched sample rows for unclear ones; the totals were 41–127 metadata calls and 14–20 row samples per agent. Every dataset was assigned to a listed entry or to a "set aside" group with a reason. The result has 250 entries, recorded in the [catalogue](../singapore-open-data-catalogue.md).
- **Measured: parking datasets.** On 19 October 2026, paced metadata calls and small downloads measured:
  - HDB carpark information: 2,273 rows; `free_parking` "SUN & PH FR 7AM-10.30PM" 1,675, "NO" 587.
  - JTC carpark information: 28 rows.
  - URA parking places: 774 WGS84 points.
  - Camera layers: red-light 240 (the digital red-light layer repeats the same coordinates), fixed speed 20, laser 48, mobile 3, with record stamps from 2016–2017.
  - OneMap search answered without a token; its coordinate-conversion endpoint returned 401.
  - A local SVY21 conversion matched OneMap's output for one postal code to about 0.1 m.
- **Reported (documentation and web pages):** URA Data Service carpark APIs and terms; LTA DataMall `CarParkAvailabilityv2` fields; OneMotoring mall rate pages; SPF camera pages (July 2026). HDB short-term and season rates were seen only in search snippets, because hdb.gov.sg blocks scripted clients. They are unverified.
- **Reported (documentation):** documented rate limits, key types and expiry reminders, the Singapore Open Data Licence v1.0 attribution requirement, and the API terms. Links are in the [design](../singapore-open-data.md#sources-and-access).
- **Reported (documentation):** the LTA DataMall API User Guide v6.10 (1 October 2026) was read in full, and the request form was inspected without submitting it. Endpoints were probed only with no key and with an invalid key, so real DataMall responses are unverified.
- **Reported (documentation):** the four NLB Open Web API OpenAPI specs were read; every operation is a `GET`. No key was requested, so response contents are unverified.

## Diagnosis and alternatives

- **Where the code lives.** Plugins cannot make HTTP calls or grant themselves tools ([plugins](../plugins.md)). The owner wants the feature packaged as a plugin, so a small generic host client does the fetching and the plugin carries the agent and the dataset knowledge.
  - Rejected: an MCP server. It would need separate hosting, and MCP tools are coordinator-only, so plugin agents could not use them.
  - Rejected: one host tool per dataset. Every dataset added later would need code.
- **Pacing and caching.** The anonymous limit is shared across endpoints and recovers slowly. A tool that fans out to several feeds at once would be throttled. The host therefore serializes requests, caches per feed cadence and backs off for at least 60 seconds after a 429. A production key raises the documented limit fivefold for real-time calls, but adding it is a Compose environment change and needs an operator rollout. The first code release can run without a key.
- **Reduce before the model.** Staleness is silent and payloads vary 1,500-fold, so reducers on the host attach reading ages and filter by region before anything reaches the model.
- **Coarse location.** The owner chose region-level location (North, South, East, West, Central) over geocoding. PSI and the 24-hour forecast are already regional, and area and station coordinates map to regions through a static table.
- **Hypothesis: anonymous throttling in production.** The early throttling partly reflects our own parallel probes from one IP. Production traffic from the Lightsail host's own IP would be lower, but it is unmeasured.

## Implementation and review

This change is documentation only:

- [design](../singapore-open-data.md);
- [catalogue](../singapore-open-data-catalogue.md), generated from the sweep results;
- this entry.

Raw probe responses and sweep scripts stayed outside the repository. One catalogue sample that named an individual estate agent was replaced with a description of the fields.

## Verification and outcome

Not applicable yet: no runtime behaviour changed. Implementation, tests, the picker eval and live acceptance are tracked in the issues above.

## Follow-up and next iteration

- **Phase 1:** host client, tools and the `singapore` plugin with no key. Add cue words for the new domain so background routines get it, since they skip the picker. Update the eval fixtures, run `npm run eval:picker`, then live acceptance on weather, PSI, carpark and holiday questions.
- **Key rollout:** an operator rollout for `DATAGOVSG_API_KEY`, sharing a window with the LTA DataMall key from issue 270.
- **Deterministic alerts:** flood, PSI and hawker closure alerts need a migration.
- **Unverified until live:**
  - the shape of a real flood alert;
  - DataMall response contents;
  - whether the anonymous limit is per IP or global.
