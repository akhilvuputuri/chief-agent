# LTA DataMall API catalogue for Chief

## About this catalogue

- **Source:** LTA DataMall _API User Guide & Documentation_ **v6.10 (1 Oct 2026)**. The owner's copy has the same SHA-256 as the copy used to extract the text. The guide documents 33 dynamic APIs.
- **Checked live:** 20 Oct 2026, 01:26–01:31 SGT (UTC+8), at no more than 1 request per second. About 115 requests went out in total. Most of these were `$skip` pages.
- **Base URL:** `https://datamall2.mytransport.sg/ltaodataservice/` (HTTPS).
- **Authentication:** every call needs the HTTP header `AccountKey: <key>`. The key goes only in that header, never in the URL. The optional `accept: application/atom+xml` header switches the response to XML. JSON is the default.
- **Paging:** most list endpoints return at most **500 records per call**. Use `?$skip=500`, `?$skip=1000` and so on, and stop when a page has fewer than 500 records. Bus Arrival, Train Service Alerts, Passenger Volume (one link per call) and Taxi Stands are not paged.
- **Bulk endpoints** (Passenger Volume, Traffic Flow, Geospatial, EV Batch, GTFS) do not return data. They return a short-lived pre-signed S3 `Link`, which you then download.
- **Licence:** the datasets are under the **Singapore Open Data Licence v1.0**. Chief must show a visible attribution notice with a link to the licence, for example:

  > Contains information from LTA DataMall (_dataset name_) accessed on _date_ from LTA DataMall, which is made available under the terms of the Singapore Open Data Licence version 1.0 (https://datamall.lta.gov.sg/content/datamall/en/SingaporeOpenDataLicence.html).

  The API Terms of Service also say:
  - keep the AccountKey confidential;
  - do not release Planned Bus Routes data before its Effective Date.

**How to read this document:**

- "Measured" means it was observed in this run.
- "Guide" means it comes from v6.10 of the guide.
- "Hypothesis" means it is unverified.
- Sizes are response bytes; latency is wall-clock time from Singapore.

## 1. All APIs at a glance

Tiers rate value to Chief: **H** high, **M** medium, **L** low.

| #    | Endpoint (path after base)       | Params (req / opt)                     | Guide cadence        | Returns                                                 | Live result (measured)                                                                 | Chief use                                               | Tier                          |
| ---- | -------------------------------- | -------------------------------------- | -------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| 2.1  | `v3/BusArrival`                  | **BusStopCode** / ServiceNo            | 20 s                 | ETAs for the next 3 buses per service at a stop         | 200, 119 B, 120–170 ms; `Services: []` at 01:26 (night) for 83139 and 01012            | "When's my bus?" at a saved stop                        | H                             |
| 2.2  | `BusServices`                    | – / ServiceNo                          | Ad hoc               | Service, operator, category and headways                | 200; **800 rows, 2 pages**, 184 KB, ~140 ms/page. `ServiceNo=15`: 1 row, 345 B         | Headway and loop info; validating a service number      | M                             |
| 2.3  | `BusRoutes`                      | –                                      | Ad hoc               | Stop sequence and first/last bus times per stop         | 200; **26,833 rows, 54 pages**, 6.2 MB, ~196 ms/page                                   | First/last bus at a stop; which services serve a stop   | H (cache weekly)              |
| 2.4  | `BusStops`                       | – / BusStopCode                        | Ad hoc               | Stop code, road, description, coordinates               | 200; **5,209 rows, 11 pages**, 718 KB. `BusStopCode=01012`: 1 row, 242 B               | Stop name lookup; nearest stop                          | H (cache weekly)              |
| 2.5  | `PV/Bus`                         | – / Date (YYYYMM)                      | Monthly, by the 10th | Link to tap-in/out by stop and hour (zip CSV)           | 200, 1.9 KB; link to `/202609/transport_node_bus_202609.zip`; `Date=202607` also works | Historical stop busyness                                | L                             |
| 2.6  | `PV/ODBus`                       | – / Date                               | Monthly              | Link to origin–destination bus trips (zip CSV)          | 200, 1.9 KB; link to `202609`                                                          | Research only                                           | L                             |
| 2.7  | `PV/ODTrain`                     | – / Date                               | Monthly              | Link to origin–destination train trips (zip CSV)        | 200, 1.9 KB; link to `202609`                                                          | Research only                                           | L                             |
| 2.8  | `PV/Train`                       | – / Date                               | Monthly              | Link to tap-in/out by station and hour (zip CSV)        | 200, 1.9 KB; link to `202609`                                                          | Typical station busyness by hour                        | L                             |
| 2.9  | `Taxi-Availability`              | –                                      | 1 min                | Coordinates of available taxis                          | 200; first page 500 rows, 26.9 KB, 100 ms (more pages exist; not counted)              | "Taxis near me" count                                   | M                             |
| 2.10 | `TaxiStands`                     | –                                      | Monthly              | Taxi stands and stops                                   | 200; **316 rows**, 53 KB, 235 ms                                                       | Nearest taxi stand                                      | M                             |
| 2.11 | `TrainServiceAlerts`             | –                                      | Ad hoc               | Disruptions, affected stations, free bus/shuttle        | 200, 155 B, 173 ms; `Status: 1`, no segments                                           | Proactive MRT disruption alerts                         | H                             |
| 2.12 | `CarParkAvailabilityv2`          | –                                      | 1 min                | Available lots for HDB, URA and LTA carparks            | 200; **2,615 rows, 6 pages**, 453 KB, ~150 ms/page                                     | "Lots at my carpark / near destination"                 | H                             |
| 2.13 | `EstTravelTimes`                 | –                                      | 5 min                | Expressway segment travel times                         | 200; 192 rows, 24 KB, 84 ms                                                            | Drive-time hints on expressways                         | M                             |
| 2.14 | `v2/FaultyTrafficLights`         | –                                      | 2 min                | Faulty or maintained traffic lights (with SVY21 X/Y)    | 200; 0 rows, 103 B, 79 ms                                                              | Route caveats                                           | L                             |
| 2.15 | `RoadOpenings`                   | –                                      | 24 h                 | Planned road openings                                   | 200; first page **500 rows (full)**, 91 KB, 183 ms                                     | Rarely useful                                           | L                             |
| 2.16 | `RoadWorks`                      | –                                      | 24 h                 | Approved road works                                     | 200; first page **500 rows (full)**, 78 KB, 124 ms                                     | Commute caveats on a known road                         | L                             |
| 2.17 | `Traffic-Imagesv2`               | –                                      | 1–5 min              | Camera image links                                      | 200; **8 rows**, 12.8 KB, 59 ms                                                        | Woodlands/Tuas checkpoint snapshot                      | M                             |
| 2.18 | `TrafficIncidents`               | –                                      | 2 min                | Live incidents (type, coordinates, message)             | 200; 40 rows (38 Roadwork, 2 Miscellaneous), 7.2 KB, 71 ms                             | Incidents on the commute route                          | H                             |
| 2.19 | `v4/TrafficSpeedBands`           | –                                      | 5 min                | Speed band per road link                                | 200; first page 500 rows, 103 KB, 101 ms (many pages; not counted)                     | Congestion on a known road (needs link filtering)       | L–M                           |
| 2.20 | `VMS`                            | –                                      | 2 min                | Messages on expressway EMAS signs                       | 200; 25 rows, 3.5 KB, 64 ms                                                            | Supplementary traffic text                              | L                             |
| 2.21 | `BicycleParkingv2`               | **Lat, Long** / Dist (km, default 0.5) | Monthly              | Bicycle parking within a radius                         | 200; 26 rows (354 racks) near 1.2966,103.8522, 3.8 KB, ~100 ms                         | Bicycle parking near a destination                      | L                             |
| 2.22 | `GeospatialWholeIsland`          | **ID** (layer, case-sensitive)         | Ad hoc               | Link to a SHP zip                                       | 200, 1.9 KB; `ID=TrainStationExit` gives `/TrainStationExit.zip`                       | Offline enrichment (station exits)                      | L                             |
| 2.23 | `v2/FacilitiesMaintenance`       | –                                      | Ad hoc               | MRT lifts under maintenance                             | 200; 5 rows, 738 B, 137 ms                                                             | Accessibility note for a station                        | M                             |
| 2.24 | `PCDRealTime`                    | **TrainLine**                          | 10 min               | Station crowd level, current 10-minute slot             | 200; NSL 27 stations, 3.2 KB, 132 ms                                                   | "How crowded is my station now"                         | M                             |
| 2.25 | `PCDForecast`                    | **TrainLine**                          | 24 h                 | Crowd forecast in 30-minute slots for today             | 200; NSL 27 stations × 48 slots, 72 KB, 96 ms                                          | Best time to travel                                     | M                             |
| 2.26 | `TrafficFlow`                    | –                                      | Quarterly            | Link to hourly traffic-volume JSON                      | 200, 1.9 KB; `/traffic-flow/data/trafficflow.json`                                     | None                                                    | L                             |
| 2.27 | `PlannedBusRoutes`               | –                                      | Ad hoc               | Upcoming route changes with EffectiveDate               | 200; 0 rows, 97 B, 70 ms                                                               | Warn about route changes (only from the effective date) | L                             |
| 2.28 | `EVChargingPoints`               | **PostalCode**                         | 5 min                | Chargers and availability at a postal code              | 200; 018989 gives 1 location, 2 chargers, 807 B, 74 ms                                 | EV charger availability at a known place                | M (if the owner drives an EV) |
| 2.29 | `EVCBatch`                       | –                                      | 5 min                | Link to all chargers (JSON)                             | 200, 1.9 KB; `/ev-batch/2026-10-20/EVBatch-20261020012507.json`                        | Nearest available charger                               | L–M                           |
| 2.30 | `PubFloodAlerts`                 | –                                      | 3 min                | PUB flash-flood alerts (CAP-like)                       | 200; 0 rows, 95 B, 137 ms                                                              | Proactive flood alert near home or route                | H                             |
| 2.31 | `GTFSScheduleTrain`              | –                                      | Ad hoc               | Link to a GTFS static zip (trains)                      | 200, 1.9 KB; `timestamp` + `link`                                                      | Train timetable, first and last train                   | M                             |
| 2.32 | `GTFSRealTimeTrainServiceAlerts` | –                                      | Ad hoc               | Link to a GTFS-RT alerts `.pb`                          | 200, 2.0 KB                                                                            | Alternative to 2.11                                     | L–M                           |
| 2.33 | `GTFSRealtimeTrainTripUpdates`   | –                                      | Ad hoc               | Link to a GTFS-RT trip updates `.pb` (disruptions only) | 200, 2.0 KB                                                                            | Disruption delays                                       | L                             |
| –    | `ERPRates` (single probe)        | –                                      | removed in v6.1      | –                                                       | **404**, body `{"error":{}}`                                                           | Use the static ERP Rates file instead                   | –                             |

**Superseded paths, one probe each:**

- `FaultyTrafficLights` (v1) is **still live** (200, empty list).
- These return **404** with the body `The requested API was not found`:
  - `FacilitiesMaintenance` (v1)
  - `v3/TrafficSpeedBands`
  - `BusArrivalv2`

## 2. Fields per API (as returned live)

Type notation:

- `str` means a JSON string.
- `str(num)` means a string holding a number.
- `int` and `float` mean JSON numbers.
- `""` means an empty string was observed.

Unless stated otherwise, every list endpoint wraps its records as `{"odata.metadata": ..., "value": [ ... ]}`.

### 2.1 Bus Arrival (`v3/BusArrival`)

- **Top level:** `odata.metadata`, `BusStopCode` (str), `Services` (list).
- **Services[]:** `ServiceNo` (str), `Operator` (SBST, SMRT, TTS, GAS), plus `NextBus`, `NextBus2` and `NextBus3`. Each of those holds:
  - `OriginCode`, `DestinationCode` (str);
  - `EstimatedArrival` (ISO 8601 with +08:00);
  - `Monitored` (int: 0 = schedule, 1 = GPS);
  - `Latitude`, `Longitude` (**strings** in the guide sample; `"0.0"` when not monitored);
  - `VisitNumber` (**string** "1" or "2");
  - `Load` (SEA = seats available, SDA = standing available, LSD = limited standing);
  - `Feature` (WAB or "");
  - `Type` (SD, DD, BD).
- **Not verified live.** Every call at 01:26 SGT returned `Services: []`, so the nested types above come from the guide. Re-run after 05:30 SGT to confirm the bus-level types.
- When a NextBus2 or NextBus3 slot has no bus, the guide shows all of its fields as "".
- **Discrepancy:** the guide says that out of hours "no response is returned (not even the attribute tags)". Live, the envelope came back intact with an empty `Services` array.

### 2.2 Bus Services

| Field                                                        | Type | Notes                                                            |
| ------------------------------------------------------------ | ---- | ---------------------------------------------------------------- |
| ServiceNo                                                    | str  | Suffixes such as `107M` and `10e` (lowercase e)                  |
| Operator                                                     | str  | SBST 388, SMRT 151, TTS 136, GAS 125                             |
| Direction                                                    | int  | 1 or 2                                                           |
| Category                                                     | str  | Live values: TRUNK 585, FEEDER 113, **CITY_LINK 68**, EXPRESS 34 |
| OriginCode, DestinationCode                                  | str  | "" for 3 feeder loops                                            |
| AM_Peak_Freq, AM_Offpeak_Freq, PM_Peak_Freq, PM_Offpeak_Freq | str  | `"04-09"`, `"8-10"`, `"15"` or `"-"`                             |
| LoopDesc                                                     | str  | "" if not a loop                                                 |

There are 601 distinct services: 402 run in one direction and 199 in two.

### 2.3 Bus Routes

| Field                                                                         | Type   | Notes                                                                    |
| ----------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| ServiceNo                                                                     | str    |                                                                          |
| Operator                                                                      | str    |                                                                          |
| Direction                                                                     | int    |                                                                          |
| StopSequence                                                                  | int    |                                                                          |
| BusStopCode                                                                   | str    | 5 digits, with leading zeros                                             |
| Distance                                                                      | number | int or float, km                                                         |
| WD_FirstBus, WD_LastBus, SAT_FirstBus, SAT_LastBus, SUN_FirstBus, SUN_LastBus | str    | `"HHMM"`, or **`"-"`** when there is no service (20,792 of these values) |

There are 797 service-direction pairs, and they cover all 5,209 bus stops.

### 2.4 Bus Stops

| Field               | Type      |
| ------------------- | --------- |
| BusStopCode         | str       |
| RoadName            | str       |
| Description         | str       |
| Latitude, Longitude | **float** |

Codes are unique and none have zero coordinates. Every stop referenced in BusRoutes exists in BusStops.

### 2.5–2.8 Passenger Volume

- **Response:** `value: [{ "Link": str }]`.
- **Link:** `https://ltafarecard.s3.ap-southeast-1.amazonaws.com/<YYYYMM>/<file>_<YYYYMM>.zip`, pre-signed (SigV4: `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-Security-Token`, `X-Amz-Signature`, `X-Amz-SignedHeaders`).
- **File names:**
  - `transport_node_bus`
  - `origin_destination_bus`
  - `origin_destination_train`
  - `transport_node_train`
- **Default month:** the previous month (202609 on 20 Oct).
- **Expiry:** `X-Amz-Expires=300` (**5 min**; the guide says 15).
- **CSV columns (guide, Annexes A and B):**
  - per node: `YEAR_MONTH, DAY_TYPE, TIME_PER_HOUR, PT_TYPE, PT_CODE, TOTAL_TAP_IN_VOLUME, TOTAL_TAP_OUT_VOLUME`;
  - origin–destination: `..., ORIGIN_PT_CODE, DESTINATION_PT_CODE, TOTAL_TRIPS`.

### 2.9 Taxi Availability

- `Latitude`, `Longitude` (float). Nothing else: no IDs and no timestamp.

### 2.10 Taxi Stands

| Field               | Type  | Values seen                                                |
| ------------------- | ----- | ---------------------------------------------------------- |
| TaxiCode            | str   |                                                            |
| Latitude, Longitude | float |                                                            |
| Bfa                 | str   | Yes 293, No 23                                             |
| Ownership           | str   | LTA 188, Private 88, CCS 38, **SMRT 2** (not in the guide) |
| Type                | str   | Stand 264, Stop 52                                         |
| Name                | str   |                                                            |

### 2.11 Train Service Alerts

- **Live shape:** `value` is an **object**, not a list: `{"Status": int, "AffectedSegments": [], "Message": []}`.
- **Status:** 1 = normal or minor delay, 2 = disrupted.
- **AffectedSegments[]** (guide): `Line`, `Direction`, `Stations`, `FreePublicBus`, `FreeMRTShuttle`, `MRTShuttleDirection`. Lines: EWL, NSL, NEL, CCL, DTL, TEL, BPL, STL, PTL.
- **Message[]** (guide): `Content`, `CreatedDate` (`YYYY-MM-DD HH:MM:SS`, SGT).
- **Discrepancy:** the guide's attribute table lists these fields flat. The nesting shown here comes from the live envelope and Annex C. The inner fields were not seen live because there was no disruption.
- **`odata.metadata`** ends in `#TrainServicesAlerts`, with an extra "s".

### 2.12 Carpark Availability (`CarParkAvailabilityv2`)

| Field         | Type | Notes                                                                                                                                  |
| ------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| CarParkID     | str  | LTA: "1"–"66" (40 IDs, with gaps); URA: `A9999` pattern such as `A0007`; HDB: HDB codes such as `HE12`, `ACB`                          |
| Area          | str  | Only LTA rows have one: Orchard 19, Marina 7, Harbfront 4, JurongLakeDistrict 2, **Others 8** (not in the guide). "" for HDB and URA   |
| Development   | str  |                                                                                                                                        |
| Location      | str  | **`"<lat> <lon>"`, separated by a space, latitude first, for all three agencies** (2,614 of 2,614 non-empty). **One URA row has `""`** |
| AvailableLots | int  | 0 is common (300 HDB rows and 30 URA rows); no negative values                                                                         |
| LotType       | str  | C, H, Y, plus **`S`** on 2 HDB rows (not in the guide)                                                                                 |
| Agency        | str  | HDB, URA, LTA                                                                                                                          |

**Totals (measured):**

| Agency    | Distinct carparks | Rows      |
| --------- | ----------------- | --------- |
| HDB       | 1,997             | 2,418     |
| URA       | 92                | 157       |
| LTA       | 40                | 40        |
| **Total** | **2,129**         | **2,615** |

Each row is one carpark × lot type. There is one exact duplicate HDB row (same ID and lot type). There is no timestamp field.

### 2.13 Estimated Travel Times

| Field       | Type | Notes                                  |
| ----------- | ---- | -------------------------------------- |
| Name        | str  | PIE, AYE, CTE, ECP, TPE, SLE, BKE, KJE |
| Direction   | int  |                                        |
| FarEndPoint | str  |                                        |
| StartPoint  | str  |                                        |
| EndPoint    | str  |                                        |
| EstTime     | int  | Minutes; 0–4 at night                  |

### 2.14 Faulty Traffic Lights v2

- **Guide fields:** `AlarmID`, `NodeID` (str), `Type` (2 = blackout, 13 = flashing yellow), `StartDate`, `EndDate` (`YYYY-MM-DD HH:MM:SS.ms`, "" if unscheduled), `XCoordinate`, `YCoordinate` (SVY21), `Message`.
- **Live:** an empty list, so no types were verified.

### 2.15 / 2.16 Road Openings / Road Works

| Field              | Type | Notes                                                                                            |
| ------------------ | ---- | ------------------------------------------------------------------------------------------------ |
| EventID            | str  | `RMAPP-YYYYMM-NNNN`                                                                              |
| StartDate, EndDate | str  | `YYYY-MM-DD`                                                                                     |
| SvcDept            | str  | Mostly "PRIVATE"                                                                                 |
| RoadName           | str  |                                                                                                  |
| Other              | str  | Free text; Road Openings rows contain contact phone numbers, so do not surface or log this field |

**First page (measured):**

- Road Openings: all 500 records are future-dated (start 21 Oct 2026 – 15 Mar 2027).
- Road Works: all 500 records are active today (starts from 2019, ends up to 2032).

### 2.17 Traffic Images v2

| Field               | Type                    |
| ------------------- | ----------------------- |
| CameraID            | str                     |
| Latitude, Longitude | float                   |
| ImageLink           | str (pre-signed S3 URL) |

- **Link format:** `dm-traffic-camera-itsc.s3.ap-southeast-1.amazonaws.com/<YYYY-MM-DD>/<HH-MM>/<CameraID>_<HHMM>_<UTC yyyymmddHHMMSS>_<hex>.jpg`.
- **Expiry:** `X-Amz-Expires=900`.
- **Discrepancy:** the guide's change log (5.1) says image links last 5 minutes. Live, they last 15.
- **Only 8 cameras came back:** 2701, 2702, 2704, 4703, 4712, 4713, 4798 and 4799. That is exactly the updated Annex G list (Woodlands and Tuas checkpoints, Tuas Second Link, AYE Tuas, Sentosa).
- **No expressway cameras came back**, even though the description says "along expressways". This was measured once at 01:26. Whether expressway cameras have been withdrawn for good is a hypothesis.

### 2.18 Traffic Incidents

| Field               | Type  | Notes                                                              |
| ------------------- | ----- | ------------------------------------------------------------------ |
| Type                | str   |                                                                    |
| Latitude, Longitude | float |                                                                    |
| Message             | str   | Starts with `(D/M)HH:MM`, with no year. This is the only timestamp |

### 2.19 Traffic Speed Bands v4

- **Top level:** `lastUpdatedTime` (str `YYYY-MM-DD HH:MM:SS`, SGT, **no zone offset**) sits alongside `value`.

| Field                              | Type         | Notes                             |
| ---------------------------------- | ------------ | --------------------------------- |
| LinkID                             | str          | Number held as a string           |
| RoadName                           | str          |                                   |
| RoadCategory                       | **str**      | "1"–"8"; the guide implies an int |
| SpeedBand                          | int          |                                   |
| MinimumSpeed, MaximumSpeed         | **str**      | Band 8 has a maximum of **"999"** |
| StartLon, StartLat, EndLon, EndLat | **str(num)** |                                   |

### 2.20 VMS

| Field               | Type  |
| ------------------- | ----- |
| EquipmentID         | str   |
| Latitude, Longitude | float |
| Message             | str   |

There is no timestamp.

### 2.21 Bicycle Parking v2

| Field               | Type  | Notes                                                                                                                      |
| ------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| Description         | str   |                                                                                                                            |
| Latitude, Longitude | float |                                                                                                                            |
| RackType            | str   | Live: `Yellow Box`, `MRT_RACKS`, `HDB_RACKS`, `NLB_RACKS`, `LTA_RACKS`, `SLA_RACKS` (the guide says "Racks or Yellow Box") |
| RackCount           | int   |                                                                                                                            |
| ShelterIndicator    | str   | Y or N                                                                                                                     |

Leaving out `Dist` gave the same 26 rows as `Dist=0.5`.

### 2.22 Geospatial Whole Island

- **Response:** `value: [{ "Link" }]`.
- **Link:** `dmgeospatial.s3.ap-southeast-1.amazonaws.com/<ID>.zip`, expiry 300 s.
- **Layer IDs:** listed in Annex E, 34 layers, for example `TrainStationExit`, `ERPGantry`, `CyclingPath`, `BusStopLocation`, `TaxiStand`, `SilverZone`, `SchoolZone`.

### 2.23 Facilities Maintenance v2

| Field       | Type | Notes                                                     |
| ----------- | ---- | --------------------------------------------------------- |
| Line        | str  | Live values: DTL, NEL, **`BPLRT`** (other APIs say `BPL`) |
| StationCode | str  |                                                           |
| StationName | str  |                                                           |
| LiftID      | str  | May be ""                                                 |
| LiftDesc    | str  |                                                           |

### 2.24 Station Crowd Density Real Time

| Field              | Type | Notes                                 |
| ------------------ | ---- | ------------------------------------- |
| Station            | str  |                                       |
| StartTime, EndTime | str  | ISO 8601 with +08:00; 10-minute slots |
| CrowdLevel         | str  | `l`, `m`, `h` or `NA`                 |

- **TrainLine codes:** CCL, CEL, CGL, DTL, EWL, NEL, NSL, BPL, SLRT, PLRT, TEL. These differ from the Train Service Alerts codes STL and PTL.
- **Ordering:** records come back sorted as strings (NS1, NS10, NS11…).

### 2.25 Station Crowd Density Forecast

- **Shape:** `value: [{ "Date": ISO, "Stations": [{ "Station": str, "Interval": [{ "Start": ISO, "CrowdLevel": str }] }] }]`.
- **Content:** 48 half-hour slots covering 00:00–23:30 of today.
- **Live levels for NSL:** `l` 1,237, `m` 57, `h` 2.

### 2.26 Traffic Flow

- **Response:** `value: [{ "Link" }]`.
- **Link:** `dmprod-datasets.s3.ap-southeast-1.amazonaws.com/traffic-flow/data/trafficflow.json`, expiry 300 s.

### 2.27 Planned Bus Routes

- **Guide fields:** the Bus Routes fields plus `EffectiveDate` (example `20250302T00:00:00+0800`, a compact ISO form).
- **Live:** an empty list.

### 2.28 EV Charging Points

- **Live shape:** `value` is an **object**: `{ "evLocationsData": [ location ] }`.
- **location:**
  - `address`, `name` (str);
  - `longitude`, `latitude` (float). The guide spells it **"longtitude"**;
  - `locationId` (str: 6 longitude decimals followed by the postal code);
  - `status` (str; `""` observed even when a charger was available);
  - `chargingPoints[]`.
- **chargingPoints[]:**
  - `status` (**str** "0", "1" or "100");
  - **`operatingHours`** (the guide says `operationHours`; "" observed);
  - `operator`, `position`, `name` (str);
  - `id` ("");
  - `plugTypes[]`.
- **plugTypes[]:**
  - `plugType`, `powerRating` (AC or DC);
  - `chargingSpeed` (**str**, kW);
  - `price` (**str** such as "0.6980");
  - `priceType` ("kWh" or "h");
  - `evIds[]` with `id`, `evCpId` and `status` (**str** "0" or "1", or "" when unavailable).

### 2.29 EV Charging Points Batch

- **Response:** `value: [{ "Link" }]`.
- **Link:** `dmprod-datasets.s3.ap-southeast-1.amazonaws.com/ev-batch/<YYYY-MM-DD>/EVBatch-<YYYYMMDDHHMMSS SGT>.json`, expiry 300 s.
- **Discrepancy:** the guide's sample shows a different bucket (`dm-traffic-flow-data`).

### 2.30 PUB Flood Alerts

- **Guide fields:** `alertId`, `dateTime`, `msgType` (Alert or Cancel), `event` (Flood), `responseType`, `urgency`, `severity` (Extreme, Severe, Moderate or Minor), `expires`, `senderName` (PUB), `headline`, `description`, `instruction`, `areaDesc`, `circle` (`"lat,lon radius_km"`), `status`.
- **Live:** an empty list, so the shape was not verified.
- **Note on `circle`:** the guide gives `circle` as latitude first, a comma, then the radius after a space. The radius is the alert's broadcast radius, not the extent of the flood.

### 2.31–2.33 GTFS (Train)

- **Response:** `value: [{ "timestamp": ISO+08:00, "link": str }]`. Both keys are **lowercase**, unlike `Link` in the other link endpoints.
- **Link paths:**
  - `dmprod-datasets.s3.ap-southeast-1.amazonaws.com/train-gtfs-schedule/gtfs_schedule.zip`
  - `.../train-gtfs-real-time/gtfs_realtime.pb`
  - `.../train-gtfs-trip-update/gtfs_trip_update.pb`
- **Expiry:** 900 s.
- **`timestamp`** is when the link was signed. The schedule link was reused about 90 seconds after it was signed.

## 3. Freshness (measured, SGT, 20 Oct 2026)

| API                                                                       | Evidence                                                      | Age when fetched                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| v4/TrafficSpeedBands                                                      | `lastUpdatedTime` 01:20:00; fetched 01:26:50                  | ~7 min (cadence 5 min)                                                                    |
| PCDRealTime (NSL)                                                         | Latest slot 01:00–01:10; fetched 01:27:00                     | Slot ended 17 min earlier. Hypothesis: lag, or the feed freezes after train service hours |
| PCDForecast                                                               | `Date` 2026-10-20T00:00+08:00                                 | Today's forecast                                                                          |
| TrafficIncidents                                                          | Message stamps from 19/10 18:12 to 20/10 01:15; fetched 01:26 | Newest is 11 min old                                                                      |
| Traffic-Imagesv2                                                          | UTC capture stamp 17:25:20Z (01:25:20 SGT); fetched 01:26:48  | ~1.5 min. The second HHMM token reads 0107–0124, possibly the camera clock (hypothesis)   |
| EVCBatch                                                                  | File stamp 01:25:07; fetched 01:27:05                         | ~2 min (cadence 5 min)                                                                    |
| GTFS schedule / alerts                                                    | `timestamp` 01:25:40 / 01:27:03; fetched 01:27:06 / 01:27:08  | Link cached ≤ 90 s                                                                        |
| PV/*                                                                      | Default month 202609                                          | As documented (previous month, by the 10th)                                               |
| CarParkAvailabilityv2, Taxi-Availability, VMS, EstTravelTimes, TaxiStands | No timestamp in the payload                                   | Cannot be checked from the payload; record the fetch time yourself                        |
| v3/BusArrival                                                             | Empty at 01:26                                                | Recheck after 05:30 SGT                                                                   |

## 4. Join answers (measured)

- **HDB carparks:** DataMall `CarParkID` for Agency=HDB **matches HDB `car_park_no`**, as used in data.gov.sg _HDB Carpark Information_.
  - All 1,997 DataMall HDB IDs are present in that CSV, which lists 2,273 codes. So 276 HDB carparks have no live availability.
  - `HE12` is present in both.
- **URA carparks:** IDs for Agency=URA **look like URA `ppCode` values** (pattern `A9999`, for example `A0007`).
  - 91 of 92 match `PP_CODE` in data.gov.sg _Capacity of URA Parking Places_.
  - The one that does not is `D0030`, which is also the row with an empty Location.
- **LTA carparks:** IDs are small integers held as strings ("1"–"66"). They are not globally unique, so use `Agency + CarParkID + LotType` as the key.
- **Location order:** `"lat lon"` for every agency.

## 5. Gotchas

1. **Error responses are not uniform:**
   - A missing required parameter (for example BusStopCode or TrainLine) returns **403 with an HTML "Access Denied" page from the CDN**, not JSON.
   - An invalid key returns **401 with an empty body**.
   - No `AccountKey` header at all returns **404 `The requested API was not found`**, the same as an unknown path.
   - The removed `ERPRates` returns **404 `{"error":{}}`**.
   - So do not read 403 as "bad key".
2. **Pre-signed links expire in 300 s** for Passenger Volume, Traffic Flow, Geospatial and EV Batch, and in 900 s for GTFS and Traffic Images. The guide says 15 minutes for all of them. Download straight away; never cache or forward a link.
3. **Number types are inconsistent:**
   - These are strings: Speed Bands coordinates, speeds and RoadCategory; all EV status, speed and price fields; Bus Arrival latitude/longitude and VisitNumber (guide).
   - These are floats: Bus Stops, Taxi, Incidents, VMS and Bicycle coordinates.
   - Parse defensively.
4. **Placeholders:**
   - `"-"` in BusRoutes first/last bus times means no service that day.
   - `"-"` in BusServices frequencies means no service in that period; frequencies also come as single numbers such as `"15"` and unpadded ranges such as `"8-10"`.
   - Bus Arrival uses `"0.0"` coordinates when not monitored, and an all-"" NextBus slot when there is no bus.
5. **Bus service numbers** must stay strings. They have letter suffixes (A, B, C, M), a lowercase `e` for express, and G/W loop variants.
6. **Wrapper shapes differ:**
   - `TrainServiceAlerts` and `EVChargingPoints` have an object `value`.
   - `PCDForecast` nests stations inside a single `value` element.
   - `BusArrival` uses `Services`.
   - The GTFS endpoints use lowercase `link` and `timestamp`.
7. **Line codes differ between APIs:**
   - Train Service Alerts: BPL, STL, PTL.
   - PCD: BPL, SLRT, PLRT, CEL, CGL.
   - Facilities Maintenance: `BPLRT`.
   - Normalise them in one map.
8. **Carparks:**
   - one row per lot type;
   - one exact duplicate row;
   - an undocumented `S` lot type and `Others` area;
   - one empty Location;
   - no timestamp;
   - LTA coverage is only 40 malls and developments.
9. **Traffic Images** returned only 8 checkpoint and Sentosa cameras.
10. **Paging cost:**
    - BusRoutes takes 54 calls and about 6 MB.
    - CarPark availability takes 6 calls per refresh, so cache it for 1 minute and filter locally.
    - TrafficSpeedBands and Taxi-Availability have many pages; avoid full sweeps.
11. **Fields that can hold personal data:** Road Openings and Road Works `Other` contains phone numbers. Do not log or quote it.
12. **Bus Arrival at night:** the guide's front-end advice is to always show arrival data when present, and otherwise use BusRoutes first/last times to choose between "Not in operation" and "No estimate available". Round ETAs down to the minute; under 1 minute, show "Arr".
13. **Planned Bus Routes** must not be shown before `EffectiveDate` (Terms of Service clause).
14. **Superseded endpoints:** v1 `FaultyTrafficLights` still answers. Pin Chief to the versioned paths in section 1.

## 6. Static datasets (downloads, not APIs)

All of these come from the DataMall Static Datasets page, under `https://datamall.lta.gov.sg/content/dam/datamall/...`. They are plain downloads and do not need the AccountKey. The details come from the portal listing, checked on 19 Oct 2026; nothing was downloaded for this catalogue.

| Dataset                                                                                           | File                                                                                          | Size         | Last update / cadence | Chief use                                                                                           |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------ | --------------------- | --------------------------------------------------------------------------------------------------- |
| ERP Rates (PCU-based, effective 7 Sep 2026; free on Sundays and public holidays)                  | `datasets/Facts_Figures/Traffic_and_Trips/ERP Rates.zip`                                      | 17 kB        | Sep 2026 / ad hoc     | ERP charge estimates (replaces the `ERPRates` API). The ERP gantry-zone mapping is in guide Annex D |
| Train Station Codes and Chinese Names                                                             | `datasets/Geospatial/Train Station Codes and Chinese Names.zip`                               | 17 kB        | Jan 2025 / ad hoc     | Maps codes such as NS1 to names for alerts and PCD                                                  |
| Train Line Codes (includes shuttle directions)                                                    | `datasets/PublicTransportRelated/Train Line Codes.xlsx`                                       | 13 kB        | Feb 2024 / ad hoc     | Line-code normalisation                                                                             |
| Train Station (points)                                                                            | `datasets/Geospatial/TrainStation_Sep2026.zip`                                                | 255 kB       | Sep 2026 / ad hoc     | Nearest MRT                                                                                         |
| Train Station Exit Point                                                                          | `datasets/Geospatial/TrainStationExit.zip`                                                    | 26 kB        | Jul 2026 / ad hoc     | Exit-level directions                                                                               |
| Bus Stop Location (SHP)                                                                           | `datasets/Geospatial/BusStopLocation_Sep2026.zip`                                             | 241 kB       | Sep 2026 / quarterly  | Not needed (BusStops API)                                                                           |
| Premium Bus Service                                                                               | `datasets/PublicTransportRelated/PremiumBusServices.zip`                                      | 20 kB        | Sep 2026 / ad hoc     | Low                                                                                                 |
| ERP Gantry (SHP)                                                                                  | `datasets/Geospatial/ERPGantry_Sep2026.zip`                                                   | –            | Sep 2026 / quarterly  | Gantry positions on a route                                                                         |
| Electric Vehicle Charging Points                                                                  | `datasets/Facts_Figures/Electric-Vehicle-Charging-Network/EVChargingPoints.zip`               | 208 kB       | Jul 2026 / quarterly  | Static charger list (live status comes from the API)                                                |
| COE Bidding Results                                                                               | `datasets/Facts_Figures/Vehicle Registration/COE Bidding Results.zip` (also an xlsx)          | 28 kB        | Oct 2026 / monthly    | "Latest COE premiums"                                                                               |
| Average PT ridership (monthly / yearly)                                                           | `datasets/Facts_Figures/Public Transport/monthly_ave_daily_pt_ridership.csv`, `yearly_...csv` | 5 kB / 2 kB  | Apr 2025 / Apr 2026   | Low                                                                                                 |
| Taxi Stand, Cycling Path, Covered Linkway, Silver Zone, School Zone, Parking Standards Zone (SHP) | `datasets/Geospatial/<Layer>_Sep2026.zip` (School Zone is `_Apr2025`)                         | 29 kB – 1 MB | Quarterly or ad hoc   | Low; the same layers are also available through the Geospatial API                                  |
| Traffic Count (turning volumes)                                                                   | via portal                                                                                    | 518 MB       | Jun 2024 / yearly     | None                                                                                                |
| Planned Road Changes (road openings, closures, F1 closures)                                       | `datasets/Geospatial/Planned Map Update/...` (PDF or SHP)                                     | various      | Ad hoc                | Occasional manual notices                                                                           |
| Vehicle population and registration statistics (about 40 tables)                                  | `TempXLS/*.xlsx`, `datasets/Facts_Figures/...zip`                                             | small        | Monthly or yearly     | None                                                                                                |
| All static datasets bundle                                                                        | `datasets/Static_ 2026_03.zip`                                                                | 100 MB       | Mar 2026              | None                                                                                                |

The portal's other headings are Extended OBU Library (an SDK with its own terms of use) and On-Request Datasets. Neither is an API with an AccountKey.
