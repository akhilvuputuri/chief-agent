# Singapore open data

Status: researched 19 October 2026, not implemented. Tracking: [issue 271](https://github.com/akhilvuputuri/chief-agent/issues/271) (data.gov.sg) and [issue 270](https://github.com/akhilvuputuri/chief-agent/issues/270) (LTA DataMall). Research record: [journal 99](journey/99-singapore-open-data.md). Full dataset reference: [catalogue](singapore-open-data-catalogue.md).

Chief gets Singapore government data through a `singapore` plugin: weather and air quality now, alerts, parking, public holidays and hawker centre closures. The plugin holds the agent and skills. A small read-only host client does the fetching, because plugins cannot make HTTP calls.

## First release scope

| Area               | Data                                                                                                                                                                                                                             | Source                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Weather now        | 2-hour forecast for 47 areas, 24-hour forecast by region, 4-day outlook                                                                                                                                                          | data.gov.sg real-time v2              |
| Air quality        | 24-hour PSI and pollutant sub-indices by region, 1-hour PM2.5 by region, hourly UV index                                                                                                                                         | data.gov.sg real-time v2              |
| Current conditions | Temperature, humidity, wind and rainfall from 18–90 stations                                                                                                                                                                     | data.gov.sg real-time v2              |
| Alerts             | PUB flood alerts, lightning strikes, heat stress (WBGT) from 30 stations                                                                                                                                                         | data.gov.sg real-time v2              |
| Parking            | Live HDB carpark lots; HDB and JTC carpark information (address, type, free and night parking, gantry height); URA parking places and capacity; speed and red-light cameras. See [Parking](#parking) for rates and other sources | data.gov.sg real-time v1 and datasets |
| Calendar           | Public holidays 2020–2027; hawker centre cleaning and repair closures, with hawker centre locations                                                                                                                              | data.gov.sg datasets                  |

Out of scope for now: everything else in the [catalogue](singapore-open-data-catalogue.md), including PSI and climate history, housing prices, COE and car buying, job-market statistics and prices. Live bus arrivals and MRT alerts come from LTA DataMall ([issue 270](https://github.com/akhilvuputuri/chief-agent/issues/270)).

## Sources and access

The data.gov.sg facts below were measured on 19 October 2026 from a Singapore IP without an API key, unless marked as documented.

### API families

| API                   | Base                                                                                               | Notes                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real-time v2          | `https://api-open.data.gov.sg/v2/real-time/api/{name}`                                             | Weather, air quality, lightning (`weather?api=lightning`), WBGT (`weather?api=wbgt`), flood alerts (`weather/flood-alerts`). Envelope `{code, data, errorMsg}`. `?date=` gives history in pages of 25 with a `paginationToken`. |
| Real-time v1 (legacy) | `https://api.data.gov.sg/v1/transport/{carpark-availability, taxi-availability, traffic-images}`   | Still the documented server for transport feeds. v1 weather paths still answer but return far fewer stations (4 rainfall stations, compared with 90 on v2).                                                                     |
| Datastore search      | `https://data.gov.sg/api/action/datastore_search?resource_id={datasetId}`                          | CSV datasets only. `filters` (exact match, lists allowed), `limit`, `offset`, `sort`; `sort=_id desc` reliably returns the latest rows. Every value is a string.                                                                |
| Downloads             | `https://api-open.data.gov.sg/v1/public/api/datasets/{id}/initiate-download`, then `poll-download` | Returns a short-lived S3 link. GeoJSON datasets use this path.                                                                                                                                                                  |
| Metadata              | `https://api-production.data.gov.sg/v2/public/api/datasets/{id}/metadata`                          | Columns, coverage and last update. Paging through the whole catalogue did not throttle.                                                                                                                                         |

### Keys and limits

- **Documented limits per 10 seconds** ([rate limits](https://guide.data.gov.sg/developer-guide/api-overview/api-rate-limits)):
  - real-time: 6 without a key, 12 with a developer key, 30 with a production key;
  - datastore: 4 / 8 / 20;
  - downloads: 2 / 4 / 10.
- **Measured:** without a key, v2 throttled after 4–6 quick requests. The limit is shared across endpoints. Recovery took up to about a minute, longer than the 10 seconds the 429 body suggests. One request every 2–3 seconds ran 15–22 times in a row without a 429.
- **Throttle signal:** HTTP 429 `{"code":24,"name":"TOO_MANY_REQUESTS"}`, with no `Retry-After` or rate-limit headers.
- **Legacy v1:** 30 requests in 2.3 seconds were all accepted.
- **Getting a key:**
  - Log in at data.gov.sg (email OTP) and choose Create API Key. Pick Production and describe the use.
  - The key is shown once and expires; reminders are emailed from three months before.
  - It is sent as the `x-api-key` header.
- **Licence:** [Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence). It allows caching and redistribution with a conspicuous attribution notice. The API terms forbid masking the client's identity, so requests send an honest User-Agent.

### Data quirks that shape the design

- **Silent staleness.**
  - v2 air temperature and rainfall did not change for 30–40 minutes during the probe, although their history shows 1- and 5-minute cadence.
  - Nine HDB carparks had not updated in over a day.
  - Every answer must carry the reading's age.
- **Payload size.**
  - Carpark availability is about 300 KB (roughly 77k tokens), and rainfall about 13 KB.
  - The host must reduce feeds before anything reaches the model.
  - Everything else is under about 1.5k tokens.
- **Carpark identifiers.**
  - Live availability gives carpark codes only. The HDB carpark information dataset maps codes to addresses.
  - HDB coordinates are SVY21 x/y and need conversion to WGS84.
  - URA parking places are a GeoJSON download.
- **Inconsistent types and casing.**
  - Lightning and WBGT use string coordinates and values; station feeds use numbers.
  - Field names mix `area_metadata` with `regionMetadata`.
  - Carpark timestamps have no time zone.
- **PSI.** There is no national figure; it is reported for five regions only.
- **UV.** No readings at night.
- **Lightning.** Includes strikes outside Singapore.
- **Flood alerts.** No live alert was observed, so the alert payload shape is unverified.
- **Retention.** History requests far in the past return 404 `REAL_TIME_API_DATA_NOT_FOUND`.

## Region model

Location is coarse. The owner has a home region and optionally a work region: North, South, East, West or Central.

- **Native by region:** PSI, PM2.5 and the 24-hour forecast.
- **Mapped once to a region:** the 2-hour forecast areas and weather stations carry coordinates, so a reviewed static table assigns each one.
- **By town:** hawker centres, carparks and cameras are matched by town name or region.
- **Storage:** the owner's regions live in explicit memories (for example `home_region`), so no migration is needed. The model passes the region to the tools.
- **URA difference:** URA's planning regions differ (North, North-East, East, West, Central). Housing data, if added later, uses town names instead.

## Architecture

Plugins are text and configuration only. They "cannot execute scripts … add HTTP endpoints, grant themselves tools" ([plugins](plugins.md)). The work is therefore split in two.

### Host

A read-only client in core code, modelled on the library client ([library](library.md)) and `stock_lookup`:

- **Routes:** all hosts and route templates in one routes module. A boundary test fails if a hostname appears anywhere else.
- **Pacing and backoff:**
  - one serial queue with at least about 2.5 seconds between v2 and datastore calls when no key is configured, shorter with a key;
  - a 429 breaker with at least 60 seconds of cooldown;
  - 15-second timeouts and body caps.
- **Caches** in memory per endpoint, matched to cadence:
  - forecasts 30 minutes, PSI and PM2.5 one hour;
  - stations and alerts 1–5 minutes, carpark availability one minute;
  - datasets daily, holidays monthly.
- **Reducers** turn each feed into a compact, region-aware answer with reading ages and a source line. Raw carpark or rainfall payloads never reach the model.
- **Tools** in a new domain, all in `readOperations`:
  - **conditions** for a region: current forecast, PSI and PM2.5 band, UV, heat stress, rain now and the age of each reading;
  - **outlook:** 24-hour and 4-day forecasts;
  - **alerts:** active flood alerts, recent lightning near a region, high heat stress;
  - **carparks:** search by carpark code, address text or town; joins HDB information and URA places with live lots; capped result count;
  - **dataset query:** a paced datastore search for CSV datasets (holidays, hawker closures), with field selection and capped rows.
  - Exact names and schemas are settled in the implementation review.
- **Dataset access:** the dataset query tool accepts any `d_` plus 32-hex dataset ID on the fixed hosts. Which datasets Chief uses is decided by the plugin's catalogue skill, so adding a dataset later needs a plugin change, not new host code. The host still enforces pacing, size caps and read-only access.
- **Key:** optional `DATAGOVSG_API_KEY`. Without it the client runs at the anonymous pace.

### Plugin

The `singapore` plugin package (`plugins/singapore`):

- **Agent:** `singapore/sgdata`, a `findings/v1` agent for multi-step questions, such as carpark comparisons or holiday planning.
- **Skills:**
  - **weather and air:** feeds, the region table, PSI bands (0–50 good, 51–100 moderate, 101–200 unhealthy, 201–300 very unhealthy, above 300 hazardous), heat-stress bands, and staleness rules;
  - **catalogue:** the enabled datasets with IDs, fields, query recipes and caveats. It is generated from this document's scope and the [catalogue](singapore-open-data-catalogue.md);
  - **parking:** carpark sources, free and night parking rules, camera layers;
  - **attribution:** how to name sources in answers, plus the licence notice.
- **Registry:** an entry with the content hash and tool grants.
- **Coordinator access:** quick weather and air questions should not pay for an extra agent call. The coordinator keeps the conditions and outlook tools; heavier questions go to the agent. This is decided by the registry's `delegated` list.

### Proactive use

- **Routines, no new code:** scheduled routines already run full agent tasks with every enabled tool. For example: "every weekday at 7:30, tell me if rain or haze is expected in the East". Each run costs model calls.
- **Deterministic alerts, later:** alerts without model calls, modelled on the stock monitor. Examples: a flood alert in a saved region, PSI crossing 100 or 200, a favourite hawker centre closing this week. These need tables for dedupe and settings, so a migration and an operator rollout.

## Release path

- **Automatic release:** host client, tools, plugin and tests with no key: no migration and no Compose change.
- **Operator rollout:** adding `DATAGOVSG_API_KEY` (and later `LTA_DATAMALL_ACCOUNT_KEY`) changes the gateway environment list in `compose.yaml`. That needs the reviewed operator rollout ([cloud development](cloud-development.md)). The keys live only in the production environment, never in the repository, logs or PRs.
- **Picker eval:** changing `config/tool-picker.json` for the new domain requires a manual `npm run eval:picker` run. Existing eval fixtures that treat weather questions as web search must be updated.

## Expanding later

1. Pick an entry in the [catalogue](singapore-open-data-catalogue.md) and recheck its metadata: last update, coverage and columns.
2. Add it to the catalogue skill with its ID, fields, query recipe and caveats.
3. If the data is CSV, the existing dataset query tool covers it.
4. GeoJSON or a new real-time feed needs a host reducer, which is code.
5. Update the plugin hash, then follow the normal review and release loop.

## Other official sources

- **LTA DataMall** ([issue 270](https://github.com/akhilvuputuri/chief-agent/issues/270)):
  - bus arrivals, train service alerts, traffic incidents, station crowding;
  - carpark availability across HDB, URA and mall carparks with coordinates;
  - PUB flood alerts with severity and an alert radius.
  - The ERP rates API was removed in 2024.
- **NLB Open Web API:**
  - read-only discovery: physical-book availability per copy and branch, reservation queue length, new arrivals, branch opening hours and closures, recommendations;
  - no borrowing, holds or patron accounts.
  - Chief's eBook features use OverDrive ([library](library.md)).
- **URA Data Service:**
  - URA carpark rates, season parking rates and URA live lots;
  - private property transactions and rentals.
  - Needs an access key and a daily token. See [Parking](#parking).

## Parking

Researched 19 October 2026. Rates, season parking and mall carparks are not in data.gov.sg; this section records where each piece lives.

### Sources

| Need                                 | Source                                                                                                                           | Auth                                            | Notes                                                                                                                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HDB live lots                        | data.gov.sg `v1/transport/carpark-availability`                                                                                  | None                                            | About 2,000 HDB carparks, one minute, codes only                                                                                                                                                                                                                                     |
| HDB carpark details                  | data.gov.sg `d_23f946fa557947f93a8043bbef41dd09`                                                                                 | None                                            | 2,273 carparks: address, SVY21 x/y, type, parking system, `free_parking` ("SUN & PH FR 7AM-10.30PM" for 1,675, "NO" for 587), `night_parking`, gantry height. Updated monthly                                                                                                        |
| JTC carpark details                  | data.gov.sg `d_3b0c377cde41041c93f893d0a92e9fe7`                                                                                 | None                                            | 28 industrial-estate carparks, same schema as HDB                                                                                                                                                                                                                                    |
| URA carpark places                   | data.gov.sg `d_9bf8620ecfdc8a5f8f77e3f02160af5c` (GeoJSON)                                                                       | None                                            | 774 places, WGS84 points, car/motorcycle/heavy-vehicle lot counts. `PP_CODE` matches URA `ppCode`                                                                                                                                                                                    |
| URA live lots, rates, season rates   | [URA Data Service](https://eservice.ura.gov.sg/maps/api/) `Car_Park_Availability`, `Car_Park_Details`, `Season_Car_Park_Details` | Access key by email, plus a token fetched daily | Rates per vehicle type and time band for weekday, Saturday and Sunday/public holiday; season monthly rates. SVY21 coordinates. Live lots every 3–5 minutes                                                                                                                           |
| HDB, URA and mall live lots together | LTA DataMall `CarParkAvailabilityv2` ([issue 270](https://github.com/akhilvuputuri/chief-agent/issues/270))                      | `AccountKey`                                    | One-minute lots for HDB, URA and malls in Orchard, Marina, HarbourFront and Jurong Lake District, with lat/long. The ID joins to HDB and URA codes are unverified                                                                                                                    |
| HDB parking rates                    | hdb.gov.sg pages                                                                                                                 | None (HTML only)                                | Short-term and season rates are fixed tables: for example, $0.60 per half hour outside the Central Area, with a list of central and peak-hour carpark codes. The figures came from search snippets because the pages block scripted clients. They must be checked by hand before use |
| Mall rates                           | OneMotoring parking-rates pages                                                                                                  | None (HTML only)                                | Free text per mall. The data.gov.sg mall rates dataset dates from November 2018 and must not be used as current                                                                                                                                                                      |
| Speed and red-light cameras          | data.gov.sg GeoJSON layers (red-light 240, fixed speed 20, laser 48, mobile 3)                                                   | None                                            | Record stamps are 2016–2017. The SPF web pages are fresher (as of July 2026) but are HTML only                                                                                                                                                                                       |
| Address to coordinates               | OneMap search API                                                                                                                | None for search                                 | Returns SVY21 and WGS84 for a postal code or address. The coordinate-conversion endpoint needs a token, so conversion is done locally                                                                                                                                                |

Not available from any API: current mall rates, HDB season-lot availability, Parking.sg.

### Design notes

- **Reference cache, keyless.** Build a daily reference cache of carparks from HDB, JTC and URA places: ID, agency, name or address, WGS84 position, type, free and night parking, gantry height. Convert SVY21 locally using EPSG:3414, a Transverse Mercator on WGS84 with origin 1.366666°, 103.833333°, false easting 28001.642 and false northing 38744.572.
- **"Lots at my saved carparks."**
  - Phase 1 uses the HDB feed. Saved carparks are explicit memories holding carpark codes.
  - With the DataMall key, one paged sweep covers HDB, URA and malls.
- **"Free parking on Sunday near X?"** Answer from `free_parking`, `night_parking` and the public holiday calendar.
- **"Rates now" and "season parking."**
  - URA rates need the URA Data Service key, a follow-up.
  - HDB rates would come from a reviewed static table checked against hdb.gov.sg.
  - Mall rates have no machine-readable current source.
- **Cameras.**
  - Phase 1 lists cameras by road name and region from the data.gov.sg layers, labelled with their age.
  - Removing the duplicate red-light layer is required.
  - A route buffer match is later work.
