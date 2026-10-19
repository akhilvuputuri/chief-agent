# 103 — Singapore plugin: can Chief answer weather, haze, carpark and bus questions from government data?

Work date: 2026-10-20. Written: 2026-10-20.
Status: tested; not deployed. Phase 1 of [issue 271](https://github.com/akhilvuputuri/chief-agent/issues/271) (data.gov.sg) and [issue 270](https://github.com/akhilvuputuri/chief-agent/issues/270) (LTA DataMall). Design: [Singapore open data](../singapore-open-data.md).

## User-visible problem and preceding iteration

[Journal 99](99-singapore-open-data.md) surveyed data.gov.sg and recorded the owner's first scope:

- live weather and air quality;
- flood, lightning and heat alerts;
- carparks and speed or red-light cameras;
- public holidays and hawker centre closures.

The owner then asked for LTA DataMall as well, mainly for bus arrivals, and supplied keys for data.gov.sg and DataMall. Until now, Chief answered these questions through general web search.

## Evidence

- **Measured: key behaviour (20 October 2026, about 01:20 SGT, from the Mac).**
  - With the data.gov.sg key, 12 back-to-back v2 real-time requests all returned 200. Without a key, journal 99 saw throttling after 4–6.
  - A bogus key also returned 200, so an invalid key is not rejected; it presumably falls back to the anonymous limit.
  - The DataMall key returned 200 on Bus Arrival, Bus Stops, Train Service Alerts, Carpark Availability, Traffic Incidents and PUB Flood Alerts.
- **Measured: DataMall catalogue.** A sweep at 1 request per second called every API in the v6.10 guide live. Results are in the [DataMall catalogue](../lta-datamall-catalogue.md):
  - **Sizes:** 5,209 bus stops; 26,833 bus route rows (54 pages); 2,615 carpark rows covering 2,129 carparks (HDB 1,997, URA 92, malls 40).
  - **Carpark joins:**
    - HDB carpark IDs are HDB carpark codes, and all 1,997 appear in the HDB carpark information dataset.
    - 91 of 92 URA IDs match URA `PP_CODE`.
    - `Location` is "lat lon" for every agency.
  - **Deviations from the guide:** bus arrival at night returns an empty `Services` list rather than nothing. The ERP rates route returns 404. Download links last 5 or 15 minutes.
- **Measured: live smoke run of the new tools** with both keys, from the Mac, between 01:30 and 02:00 SGT.
  - Weather, air and alerts answered in 0.8–1.6 s. Responses were 0.5–1.5k characters.
  - Holidays, hawker closures and carpark joins returned correct records. The first carpark call took 5.3 s to load the reference data.
  - Bus stop search took 3.3 s on the first call, which pages the stop list.
  - A bus arrival at night returned the first and last bus times. It took 11.8 s on the first call, which pages Bus Routes.
  - Camera layers took 12–23 s on the first call; downloads are limited to about 5 a minute.
- **Measured: one datastore 429 during the smoke run.** It came right after a 12-request burst test. It opened the then-shared data.gov.sg breaker, which also blocked the real-time feeds. Repeating the same datastore calls a minute later passed, with and without the key.
- **Tested:** `tests/singapore.test.ts` (13 tests) with mocked HTTP covers:
  - routes and the origin boundary;
  - SVY21 conversion and regions;
  - pacing and per-group breakers;
  - key scoping;
  - every reducer;
  - the busy result;
  - registration, delegation and catalogue gating.
- **Measured: picker eval** (`npm run eval:picker`, 20 October, 3 runs, 188 scenarios, Jev 1.13; cost $0.061):
  - recall 98.3% pooled (tuning 98.1%, held-out 98.6%), fully covered 98.4%, 0.43 extra groups per call, result pass;
  - the five Singapore scenarios (the updated weather case none-7 and the new sg-1 to sg-4) picked `singapore` in all 3 runs;
  - no other scenario loaded `singapore`;
  - the three misses (jobs-8, lib-6, t-rout-1) are in other domains.
- **Measured: picker eval rerun after rebasing onto #274**, which added a `coding` domain (20 October, 3 runs, 194 scenarios; cost $0.066):
  - recall 98.2% pooled, fully covered 98.3%, 0.42 extra groups per call, result pass;
  - the Singapore scenarios were picked in 15 of 15 cases, and no other scenario loaded `singapore`;
  - the misses are jobs-8, lib-6, t-rout-1 and t-work-2 (1 of 3 runs), all in other domains.

## Diagnosis and alternatives

- **Separate breakers per rate-limit group.** The smoke-run 429 showed that one shared data.gov.sg breaker turns a datastore throttle into a weather outage. data.gov.sg documents separate limits for real-time APIs, datastore search and downloads, so each now has its own queue and breaker.
- **Patient downloads.** Downloads are spaced 12 seconds apart and retried once after a 429, timeout or server error. They are rare, because results are cached for a day.
- **Two agents instead of one.** An agent appears in Chief's catalogue only when all of its tools are available ([plugins](../plugins.md)). DataMall tools must stay hidden without the key, so they form a separate `transport` agent. A single agent would either vanish without the key or carry tools that always fail.
- **Delegated tools.** Chief does not hold the `sg_`/`lta_` tools; it delegates with `agent_run`, as for every other domain. Each question costs one extra fast-model call.
  - Rejected: keeping quick weather tools on the coordinator. That would break the pattern and lengthen Chief's tool list.
- **Whole-word matching.** The first carpark search for "Bishan Street 22" also matched carpark code BE22 and a block range containing "227", because words were matched as substrings. Numbers now match whole words, and other words match as a prefix.
- **Region by nearest NEA label point.** This is coarse: Clementi falls in "south", not "west". The skills tell the agent to name the region it used.
- **No new process or infrastructure.** Everything runs in the gateway with in-memory caches. There is no migration.

## Implementation and review

- **Host:** `src/singapore/`:
  - `routes.ts`: the only origins;
  - `http.ts`: pacing, breakers, key scoping;
  - `datagov.ts`, `datamall.ts`, `carparks.ts`: reducers;
  - `geo.ts`: SVY21 and regions;
  - `schema.ts`, `tools.ts`.
- **Wiring:** `src/protocol.ts`, `src/execution.ts` (`readOperations`), `src/runtime.ts` (availability and descriptions), `src/tool-domains.ts` (domain, prefixes, cues), `src/tools.ts`, `src/main.ts`, `src/config.ts`.
- **Plugin:** `plugins/singapore` with two agents and four skills. `plugins/registry.json` holds the hash, grants, aliases `singapore` and `transport`, and the delegated tools.
- **Evals:** `config/tool-picker.json` has the new domain, and `evals/picker/picker.py` has the domain list. `evals/picker/scenarios.json` adds sg-1 to sg-4 and changes none-7 to `singapore`; `evals/decisions/fixtures/routing.json` gets matching cases.
- **Generator not rerun:** `gen_routing.py` was updated, but it already fails on `main` (`KeyError: 'mcp'`), so `routing.json` was edited by hand.
- **Local checks:**
  - `evals/coding` fails locally with Python 3.14 on the two `chief-protocol` fixtures. It fails the same way on unmodified `main`.
- **Independent review, first round (Claude Opus 5.5, head `3537db2`): REQUEST CHANGES.**
  - **Blocking:** a closure with a known start and a "TBC" end date became a one-day closure, and the dataset's `status` was ignored. A centre under open-ended works was therefore reported as open, which is a wrong answer to the very question the tool exists for.
    - Fixed: an unpublished end date now means the closure continues (`endPublished: false`).
    - Centres that are not trading go into `notTrading`.
    - Quarters with TBC dates are reported as `closureDatesTbc`.
    - The skill wording now matches, and there are regression tests.
  - **Smaller findings, fixed:**
    - A query with no ASCII letters or digits matched everything; it now matches nothing.
    - DataMall carpark lots claimed an age of 0. They now report null, with the feed's fetch age.
    - One failed reference download (for example URA) failed every carpark search. Reference loads are now settled independently and live-lot outages degrade to null lots.
    - Docs now say downloads retry after a 429, timeout or server error, and that keyed spacing assumes a production key.
    - Tests now check that file downloads carry no API key and that only `http.ts` calls `fetch`.
  - **Devin Review findings (head `a0a281f`), all fixed:**
  - **Downloads:** they polled without `initiate-download`. GeoJSON is documented as ready to poll, and that worked live, but an empty poll now initiates the download and polls up to three more times.
  - **Bus arrivals:** a service LTA lists with all-empty estimates now gets its first and last bus times, like a service that is absent.
  - **Flood alerts:** they ignored the region filter. Alerts with a readable location (location fields or a "lat lon radius" circle) are now filtered by region. Alerts without one are kept and counted as `unlocatedAlerts`, because the live alert shape is still unverified.
  - **DataMall pages:** a page without a `value` array became an empty result. It now raises an error instead of reporting no matches.
- **Devin Review, second pass (head `00a1639`):** the bus fix above set the stop-wide `noEstimates` flag even while other services had live arrivals. `noEstimates` now means nothing is arriving (at the stop, or for the requested service). A mixed result keeps its arrivals and names the services without one in `servicesWithoutEstimates`. The transport skill and a test match this.
- **Final review (head `ad506d6`, APPROVE with one low finding):** the schedule guidance used a `note` key that a later `note` in the same object overwrote, so it never reached the model. This had been true since the first version. It is now `scheduleNote`, with a test assertion.
- **Recorded as follow-ups:**
  - Cancellation signals are not passed into the Singapore tools.
  - The body cap counts characters after buffering rather than streamed bytes.
  - The registry's `delegated` list (76 of 80) and the agent catalogue (about 11k of 12k characters) are close to their limits for the next plugin.

## Verification and outcome

Tested, not deployed. Remaining after the code release:

1. **Operator rollout:** add `DATAGOVSG_API_KEY` and `LTA_DATAMALL_ACCOUNT_KEY` to `compose.yaml` and the production environment through the operator procedure. Until then production runs data.gov.sg at the anonymous pace, and the transport agent is hidden.
2. **Live acceptance on Telegram:**
   - rain or haze in a region;
   - lots at a saved carpark;
   - a public holiday and a hawker closure;
   - a bus arrival during service hours;
   - MRT status.
3. **Bus arrival in service hours:** check live minutes and load. The smoke run was at night, so only the no-service path was observed live.

## Follow-up and next iteration

- **Deterministic alerts** (flood near a saved region, PSI thresholds, MRT disruption, hawker closure) need tables, so a migration and an operator rollout.
- **More data:** URA rates and season parking, and more catalogue datasets, can follow through the catalogue skill.
- **Not planned:** the LTA OBU SDK is mobile-only Bluetooth, so it would need a companion phone app.
