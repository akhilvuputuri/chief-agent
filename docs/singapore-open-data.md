# Singapore open data

Status: researched 19 October 2026. Phase 1 released 20 October 2026 as `becf234` (#277, [journal 103](journey/103-singapore-plugin.md)), and both keys went live through the rollout of `7f83158` (#282). The single Merlion agent and v0.3.92 ship in #284. Tracking: [issue 271](https://github.com/akhilvuputuri/chief-agent/issues/271) (data.gov.sg) and [issue 270](https://github.com/akhilvuputuri/chief-agent/issues/270) (LTA DataMall). Research record: [journal 99](journey/99-singapore-open-data.md). Full dataset reference: [catalogue](singapore-open-data-catalogue.md).

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
  - real-time: 6 without a key, 12 with a developer key, 30 with a production key (the keyed spacing in the client assumes a production key; with a developer key or an expired one, which data.gov.sg silently treats as anonymous, it can be throttled and backs off);
  - datastore: 4 / 8 / 20;
  - downloads: 2 / 4 / 10.
- **Measured:** without a key, v2 throttled after 4–6 quick requests. The limit is shared across endpoints. Recovery took up to about a minute, longer than the body's "Please try again in 10 seconds" suggests. One request every 2–3 seconds ran 15–22 times in a row without a 429.
- **Throttle signal:** HTTP 429 `{"code":24,"name":"TOO_MANY_REQUESTS","errorMsg":"Rate limit exceeded. Please try again in 10 seconds…"}`, with no `Retry-After` or rate-limit headers.
- **Legacy v1:** 30 requests in 2.3 seconds were all accepted.
- **Documented: getting a key.**
  - Log in at data.gov.sg (email OTP) and choose Create API Key. Pick Production and describe the use.
  - The key is shown once and expires; reminders are emailed from three months before.
  - It is sent as the `x-api-key` header.
- **Documented: licence.** [Singapore Open Data Licence v1.0](https://data.gov.sg/open-data-licence). It allows caching and redistribution with a conspicuous attribution notice. The API terms forbid masking the client's identity, so requests send an honest User-Agent.

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

Plugins are text and configuration only. They "cannot execute scripts … add HTTP endpoints, grant themselves tools" ([plugins](plugins.md)). The work is split into a read-only host client in `src/singapore/` and the `singapore` plugin. Both run inside the existing gateway process; there is no new service or infrastructure.

### Host (`src/singapore/`)

- **Routes (`routes.ts`):** the only module that names the API origins. It holds a fixed inventory of GET routes with validated parameters. Dataset files are polled, initiated when a poll has no link, and followed only to the data.gov.sg S3 bucket. A boundary test fails if an origin appears anywhere else in `src`.
- **Client (`http.ts`):** one serial queue and one 429 breaker (60 seconds) per rate-limit group, because data.gov.sg limits real-time APIs, datastore search and downloads separately. It sends an honest User-Agent, uses 15-second timeouts, refuses redirects and caps bodies at 4 MB (8 MB for files). A data.gov.sg key is sent only to data.gov.sg and the DataMall `AccountKey` only to DataMall. Minimum spacing between requests:

  | Group            | Without key                                                                                  | With key |
  | ---------------- | -------------------------------------------------------------------------------------------- | -------- |
  | Real-time feeds  | 2.5 s                                                                                        | 0.4 s    |
  | Datastore search | 3 s                                                                                          | 0.6 s    |
  | Downloads        | 12 s (also documented as 5 a minute; one patient retry after a 429, timeout or server error) | 12 s     |
  | DataMall         | 0.2 s                                                                                        | 0.2 s    |

- **Caches:** in memory, with in-flight sharing and failures never cached.
  - Forecast 10 minutes (24-hour 30, 4-day 60).
  - Rain 3 minutes.
  - PSI, PM2.5 and UV 15 minutes.
  - Alerts 2 minutes.
  - Carpark lots 1 minute.
  - Bus arrivals 20 seconds.
  - Bus stops and routes, holidays, carpark reference and camera layers daily.
  - Hawker closures 6 hours.
- **Reducers** (`datagov.ts`, `datamall.ts`, `carparks.ts`) turn each feed into a compact answer. Every reading carries `observedAt`, `ageMinutes` and `stale`, and every answer ends with a source line. Raw carpark, rainfall and bus route payloads never reach the model.
- **Tools** in the new `singapore` domain (prefixes `sg_` and `lta_`), all in `readOperations`:

  | Tool                                                                 | Returns                                                                                                              |
  | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
  | `sg_weather(region?, outlook?)`                                      | 2-hour forecast areas grouped by region, 24-hour periods, rain falling now; optionally the 4-day outlook             |
  | `sg_air(region?)`                                                    | 24-hour PSI and band, 1-hour PM2.5 and band, UV (07:00–19:00), worst heat stress per region                          |
  | `sg_alerts(region?)`                                                 | PUB flood alerts, lightning in Singapore in the last 30 minutes, heat stress above Low                               |
  | `sg_carparks(query/codes/region, limit?)`                            | HDB, JTC and URA reference data joined with live lots, including mall carparks when DataMall is configured. No rates |
  | `sg_holidays(from?, to?)`                                            | Gazetted public holidays, with the last published date                                                               |
  | `sg_hawker_closures(query?, region?, from?, to?)`                    | Cleaning and repair closures that overlap the range; for a query, the next closure of open centres                   |
  | `sg_cameras(query?, region?, kind?)`                                 | Red-light and fixed speed cameras; laser or mobile sites on request                                                  |
  | `sg_dataset(dataset, filters?, fields?, sort?, q?, limit?, offset?)` | A paced datastore search on a CSV dataset the catalogue skill names                                                  |
  | `lta_bus_arrival(stop, service?)`                                    | The next three buses per service, or first and last bus times when nothing runs                                      |
  | `lta_bus_stops(query)`                                               | Bus stop codes by description, road or code                                                                          |
  | `lta_train_alerts()`                                                 | MRT/LRT status, affected segments, free bus and shuttle arrangements, LTA messages                                   |
  | `lta_traffic(query?)`                                                | Current traffic incidents, optionally by road or expressway                                                          |

- **Availability:**
  - All twelve tools are offered with the plugin.
  - data.gov.sg works without a key.
  - Without `LTA_DATAMALL_ACCOUNT_KEY`, the `lta_` tools return "LTA DataMall is not configured"; the availability context reports `ltaDataMall`.
  - A throttled provider returns `{status: "busy", retryAfterSeconds}` instead of failing the turn.
- **Dataset access:** `sg_dataset` accepts any `d_` dataset ID on the fixed host. Which datasets Chief uses is decided by the plugin's catalogue skill, so enabling a CSV dataset later is a plugin change, not host code.

### Plugin (`plugins/singapore`)

One agent, **Merlion** (`singapore/merlion`, alias `merlion`), holds all twelve tools and the four skills `sg-weather`, `sg-places`, `sg-transport` and `sg-catalogue`. It uses `findings/v1`, the fast tier and low effort. Its description tells Chief what it covers; the name is branding.

- **Phase 1 had two agents:** `singapore` and `transport`. An agent appears in Chief's catalogue only when all of its tools are available, so splitting kept DataMall's tools hidden until the key existed. Once both keys were live, the owner chose a single agent.
  - The `lta_` tools are now offered with the plugin.
  - Without the DataMall key they return "not configured", so Merlion stays listed and weather keeps working.
- **Delegation:** the registry lists every `sg_` and `lta_` tool as `delegated`, so Chief does not see them. Chief briefs Merlion with `agent_run`, including the owner's region and saved stop or carpark codes from its explicit memories. This matches every other Chief domain. Each question costs one extra cheap model call.

### Proactive use

- **Routines, no new feature code:** scheduled routines run agent tasks, for example "every weekday at 7:30, tell me if rain or haze is expected in the East". `agent_run` is a core tool and the catalogue is always in context, so a routine can delegate. The domain also has cue words (weather, rain, haze, PSI, carpark, bus, MRT, traffic, public holiday, hawker) in `CUES` for background steps, which skip the picker.
- **Deterministic alerts, later:** examples include a flood alert in a saved region, PSI crossing 100 or 200, an MRT disruption, or a favourite hawker centre closing. They need tables for dedupe and settings, so a migration and an operator rollout.

## Rain radar

`sg_rain` reads NEA's rain radar ([journal 104](journey/104-rain-radar.md)).

- **Source:**
  - `weather-radar-images/70km` (and `/240km`) gives one frame every 5 minutes, with past frames available by `date`.
  - Each frame is a 480 × 480 palette PNG with a lat/lon boundary box, served from a signed link to NEA's S3 bucket. Only that bucket is followed.
  - Requests are spaced 1.1 s apart: sub-second spacing was throttled even with the key.
- **Location:** a shared Telegram pin (exact coordinates), a typed place (NEA forecast areas, then OneMap search, which is keyless and never gets the data.gov.sg key), a region, or all of Singapore.
- **Analysis on the host, no model:**
  - frames become a grid of about 1.2 km cells with five levels (light to intense) from the radar colours;
  - per call it reports: rain at the location; coverage within 5, 10 and 25 km (25, 50 and 100 km on the 240 km view); the nearest rain and nearest heavy rain; rain history at the location; a timeline of up to 13 points; movement from the best shift between frames (recent and over the window); and a 10–60 minute advection outlook, labelled a rough guide.
- **Window:** up to 6 hours. Frames are spaced 5–15 minutes apart and cached by timestamp; without a key, at most 9 frames are used.
- **Not yet built:** a radar picture or animation sent to Telegram, and alerts.

## Release path

1. **Code release (automatic):** host client, tools, plugin, picker entry, eval fixtures and tests. No migration and no Compose change. In production, data.gov.sg tools then run at the anonymous pace, and DataMall tools stay hidden.
2. **Key rollout (operator):** `DATAGOVSG_API_KEY` and `LTA_DATAMALL_ACCOUNT_KEY` are added to the gateway environment list in `compose.yaml` and to the production `.env`, through the reviewed operator procedure ([cloud development](cloud-development.md)). The keys live only in the production environment, never in the repository, logs or PRs.
3. **Picker eval:** `config/tool-picker.json` gains the `singapore` domain, so `npm run eval:picker` is run by hand and recorded in the journal.

### Key rollout procedure

`scripts/deploy-singapore-keys.py` is the one-time reviewed operator rollout. Its baseline is the live release recorded in the script. Recheck the server's `RELEASE` before running it; a different baseline needs reconciliation and review.

**What the script checks and does:**

1. **Before anything changes:**
   - the archive matches the exact requested commit;
   - `db/` is unchanged;
   - the release handler is unchanged;
   - `compose.yaml` differs only by the two gateway environment names after `TWELVE_DATA_API_KEY`;
   - the private `.env` already sets both keys to non-empty values, using the last assignment of each name as Compose does. It checks names only; values are never printed, logged or written.
2. **Then:**
   - builds the candidate first;
   - refuses, without cancelling anything, while a run, pending input, active coding job or coding cleanup exists; rerun it when idle;
   - stops the gateway, switches `compose.yaml` and the image, starts the gateway and checks health.
3. **On failure:** restores the previous application, source and Compose file. It neither cancels nor replays owner work.

**Steps:**

1. Run the offline tests: `python3 scripts/test-deploy-singapore-keys.py`.
2. Once the PR is approved and merged, add the two keys to `/opt/hermes-companion/.env` (root, mode 600) through the pinned Lightsail operator connection ([lightsail.md](lightsail.md)). Pipe the values from local private files over SSH, so they never appear in a command line, a log or the chat.
3. Create the `git archive` of the exact merge commit, and transfer it and the reviewed script.
4. Run:

   ```sh
   sudo python3 /tmp/deploy-singapore-keys.py /tmp/singapore-release.tar FULL_REVIEWED_MAIN_SHA
   ```

5. Verify the exact `RELEASE` and health. Then check that both keys reached the gateway, printing only the word "present":

   ```sh
   sudo docker compose --project-directory /opt/hermes-companion -p hermes-companion exec -T gateway sh -c 'test -n "$DATAGOVSG_API_KEY" && test -n "$LTA_DATAMALL_ACCOUNT_KEY" && echo present'
   ```

6. Dispatch the normal release for the same commit, which should be a no-op redeploy. That confirms later automatic releases accept the installed Compose file.
7. Live acceptance follows: a bus arrival during service hours, MRT status, and weather.

**Until the script runs:** a merged `compose.yaml` change makes the automatic release refuse every later merge. Run it immediately after the merge.

## Expanding later

1. Pick an entry in the [catalogue](singapore-open-data-catalogue.md) and recheck its metadata: last update, coverage and columns.
2. Add it to the catalogue skill with its ID, fields, query recipe and caveats.
3. If the data is CSV, the existing dataset query tool covers it.
4. GeoJSON or a new real-time feed needs a host reducer, which is code.
5. Update the plugin hash, then follow the normal review and release loop.

## Other official sources

- **LTA DataMall** ([issue 270](https://github.com/akhilvuputuri/chief-agent/issues/270)): bus arrivals, stops and routes, train service alerts, traffic incidents and carpark lots are in phase 1. The full live-checked API list is in the [DataMall catalogue](lta-datamall-catalogue.md). The ERP rates API was removed in 2024.
- **LTA Extended OBU Library:** a native Android/iOS SDK. It talks Bluetooth to a vehicle's ERP 2.0 on-board unit and reports ERP and parking charges, card balance and traffic messages. A server cannot use it. It would need a companion phone app relaying events to Chief, which is not planned.
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
