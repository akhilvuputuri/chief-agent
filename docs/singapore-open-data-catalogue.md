# Singapore open data catalogue

Snapshot of everything [data.gov.sg](https://data.gov.sg) offered on 19 October 2026, surveyed for Chief's Singapore plugin. The [design](singapore-open-data.md) explains how Chief uses it; this file is the reference for adding datasets later.

All 4,663 catalogue datasets and the real-time APIs were checked. 250 entries are listed below by theme; related datasets are folded into one entry. Every other dataset is counted under its theme's "set aside" table with a reason. Entries marked **Selected** are in the first release scope; the rest are candidates for later.

How each entry was checked: **rows** means sample rows were fetched; **metadata** means only the dataset metadata (columns, coverage, last update) was read; **listing-only** means only the catalogue listing. Freshness is as of 19 October 2026 and will drift. Recheck a dataset's metadata before enabling it.

Tiers are a judgement of usefulness to a single resident's assistant: high, medium or low.

Contains information from data.gov.sg datasets accessed on 19 October 2026, made available under the terms of the [Singapore Open Data Licence version 1.0](https://data.gov.sg/open-data-licence).

## Themes

- [Live feeds](#live-feeds): 14 entries, 12 selected
- [Environment & health](#environment--health): 40 entries, 2 selected
- [Housing & property](#housing--property): 36 entries, 3 selected
- [Transport & travel](#transport--travel): 21 entries
- [Money, work & energy](#money-work--energy): 36 entries, 1 selected
- [Education, community & government](#education-community--government): 48 entries, 1 selected
- [Statistics (SingStat) A](#statistics-singstat-a): 34 entries
- [Statistics (SingStat) B](#statistics-singstat-b): 21 entries

## Live feeds

Agencies: NEA, PUB, HDB and LTA (real-time APIs).

Real-time APIs probed live on 19 Oct 2026. Weather and air quality come from the v2 API; carpark, taxi and traffic images exist only on the legacy v1 API. Without a key the v2 API throttles after 4-6 quick calls, so these are served through a paced, cached host client.

Coverage: 17 datasets, 14 in 14 entries, 3 set aside.

### Live feeds: Air quality

#### PSI air quality by region — **Selected**

- ID: `rt:psi`
- NEA · tier high · API via realtime · updates hourly · latest live · last updated 2026-10-19
- Location: region · checked: rows
- Use: Haze alerts and briefing line; advise on outdoor exercise when PSI is unhealthy.
- Example question: "Is the haze bad in the West right now?"
- Sample: 24h PSI West 114, Central 109 (Unhealthy) on 19 Oct 22:00
- Caveats: No national figure; derive the max across regions.

#### PM2.5 by region (1-hour) — **Selected**

- ID: `rt:pm25`
- NEA · tier medium · API via realtime · updates hourly · latest live · last updated 2026-10-19
- Location: region · checked: rows
- Use: Short-term haze spikes that the 24h PSI smooths out.
- Example question: "Is the air OK for a run this evening?"
- Sample: West 89, Central 77 ug/m3

#### UV index (hourly) — **Selected**

- ID: `rt:uv`
- NEA · tier medium · API via realtime · updates hourly, 07:00-19:00 · latest live · last updated 2026-10-19
- Location: none · checked: rows
- Use: Sun-protection nudge for outdoor plans.
- Example question: "How strong is the sun at the beach this afternoon?"
- Sample: Peak 5 at 14:00
- Caveats: No readings at night.

### Live feeds: Alerts

#### Flood alerts — **Selected**

- ID: `rt:flood-alerts`
- PUB · tier high · API via realtime · updates 2 min · latest live · last updated 2026-10-19
- Location: point · checked: rows
- Use: Push a flood alert for the owner's region or commute route.
- Example question: "Any flash floods right now?"
- Sample: No active alerts during probing
- Caveats: Shape of an actual alert not yet observed.

#### Lightning strikes — **Selected**

- ID: `rt:lightning`
- NEA · tier medium · API via realtime · updates 2 min · latest live · last updated 2026-10-19
- Location: point · checked: rows
- Use: Lightning nearby warning for outdoor plans.
- Example question: "Is there lightning near Changi now?"
- Sample: Empty when calm
- Caveats: Includes strikes outside Singapore; filter by bounding box.

### Live feeds: Driving

#### HDB carpark lot availability — **Selected**

- ID: `rt:carpark-availability`
- HDB · tier medium · API via realtime · updates 1 min · latest live · last updated 2026-10-19
- Location: point · checked: rows
- Use: Lots free at a saved carpark right now.
- Example question: "How many lots are free at my usual carpark?"
- Sample: HE12: 102/105 car lots
- Caveats: ~300 KB raw (77k tokens): must be filtered by host. Codes need the HDB carpark information dataset (SVY21 coordinates).

#### Taxi availability (positions)

- ID: `rt:taxi-availability`
- LTA · tier low · API via realtime · updates 1 min · latest live · last updated 2026-10-19
- Location: point · checked: rows
- Use: Rough taxi availability count near a region.
- Example question: "Are there many taxis around Orchard now?"
- Sample: 2,527 taxis
- Caveats: ~57 KB GeoJSON; little practical value.

#### Traffic camera images

- ID: `rt:traffic-images`
- LTA · tier low · API via realtime · updates 1-3 min · latest live · last updated 2026-10-19
- Location: point · checked: rows
- Use: Send a causeway/expressway camera image.
- Example question: "How's the Woodlands Causeway traffic?"
- Sample: 8 cameras returned
- Caveats: Only 8 cameras currently; legacy v1 API.

### Live feeds: Heat & rain

#### Heat stress (WBGT, 30 stations) — **Selected**

- ID: `rt:wbgt`
- NEA · tier medium · API via realtime · updates 15 min · latest live · last updated 2026-10-19
- Location: point · checked: rows
- Use: Warn before outdoor exercise when heat stress is moderate or high.
- Example question: "Is it too hot to jog at 5pm?"
- Sample: All stations Low
- Caveats: String values; map stations to regions.

#### Rainfall (90 stations, 5-minute totals) — **Selected**

- ID: `rt:rainfall`
- NEA · tier medium · API via realtime · updates 5 min · latest live · last updated 2026-10-19
- Location: point · checked: rows
- Use: Is it raining right now in my region; how heavy.
- Example question: "Is it raining in Tampines right now?"
- Sample: 90 stations, mm per 5 min
- Caveats: Observed stalling for 30-40 min; always show reading age. About 3k tokens raw, so reduce per region.

#### Air temperature, humidity and wind (stations) — **Selected**

- ID: `rt:air-temperature`
- NEA · tier low · API via realtime · updates 1 min · latest live · last updated 2026-10-19
- Location: point · checked: rows
- Use: Current conditions line ('29 C, humid, light wind').
- Example question: "How hot is it outside now?"
- Sample: Ang Mo Kio Ave 5: 29.3 C
- Caveats: Feeds can stall; fewer stations on the legacy API.

### Live feeds: Weather now

#### 2-hour weather forecast (47 areas) — **Selected**

- ID: `rt:two-hr-forecast`
- NEA · tier high · API via realtime · updates 30 min · latest live · last updated 2026-10-19
- Location: region · checked: rows
- Use: Tell the owner whether rain is coming in their region in the next two hours; morning and commute nudges.
- Example question: "Will it rain in the East before 6pm?"
- Sample: Bedok: Cloudy (valid 21:30-23:30)
- Caveats: 47 areas mapped to N/S/E/W/Central by a static table; off-cycle amendments happen.

#### 24-hour forecast by region — **Selected**

- ID: `rt:twenty-four-hr-forecast`
- NEA · tier high · API via realtime · updates ~4x daily · latest live · last updated 2026-10-19
- Location: region · checked: rows
- Use: Briefing line per region: morning/afternoon/night outlook, temperature range, wind.
- Example question: "What's tomorrow's weather like in Central?"
- Sample: Thundery showers, 25-34 C, wind SE 10-20 km/h

#### 4-day outlook — **Selected**

- ID: `rt:four-day-outlook`
- NEA · tier high · API via realtime · updates ~2x daily · latest live · last updated 2026-10-19
- Location: none · checked: rows
- Use: Plan outdoor activities and weekend suggestions.
- Example question: "Is the weekend going to be wet?"
- Sample: Tuesday: afternoon thundery showers, 25-34 C

### Live feeds: set aside

| Group                       | Datasets | Reason                      |
| --------------------------- | -------- | --------------------------- |
| Weather radar images (beta) | 3        | Images, not data; beta API. |

## Environment & health

Agencies: NEA, MOH, HPB, HSA, NParks, PUB, SCDF.

NEA, MOH, HPB, HSA, NParks, PUB and SCDF datasets. The most valuable for Chief are the monthly climate series since 1982 (updated to 2026-09) and the regional historical PSI/PM2.5 series (to 2026-08), which can tell the owner whether today's weather or haze is normal. Also useful are HPB Healthier Dining outlets tagged by region, NParks parks, park connectors and facilities (refreshed 2026-10), polyclinic/CHAS/PHPC clinic directories, AED locations, recycling and donation points, and the reused hawker and dengue datasets. There is no healthcare bill-size or fee dataset in this bucket. The PUB "Potable Water Tariff" dataset actually holds sales volumes up to 2021, and "Flood Prone Areas" holds only a national hectare total. Many clinic and recycling layers are stale 2024 or 2022 snapshots.

Coverage: 389 datasets, 110 in 40 entries, 279 set aside.

### Environment & health: Air quality

#### Historical 24-hr PSI and 1-hr PM2.5 by region (Apr 2014-present)

- ID: `d_b4cf557f8750260d229c49fd768e11ed` (plus 1 related: `d_6c0d5fc34838b12472475fdb73c0af29`)
- NEA · tier high · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-01 · 108,864 rows
- Location: region · checked: rows
- Fields: `24hr_psi`, `north`, `south`, `east`, `west`, `central`
- Use: Show whether today's PSI/PM2.5 in the owner's region is unusual versus the same period in past years, and summarise haze episodes.
- Example question: "Is the air in the West worse than usual for this time of year?"
- Sample: 1-hr PM2.5 at 1/9/2026 00:00: north 24, south 20, east 26, west 33, central 36
- Caveats: Wide format: one row per hour, columns north/south/east/west/central; timestamp column is d/m/yyyy H:MM string; monthly lag of ~1 month.

#### Annual ambient air pollutant levels (PM2.5, PM10, NO2, SO2, O3, CO, lead)

- ID: `d_397fe8de643aea9927bdee32e49307ff` (plus 6 related: `d_fdf8b7d640136ddd3bf461abf33d9b40`, `d_f71b15a17a8ce278d3d3d55383f86687`, `d_88dcbdd26f7adbb5a469491378abfedc`, `d_dc29ecdc06f1f2b42c3dd06dd1ab8e6b`, `d_ec484d9610a22c57fa873b14f9baa57a`, `d_12e90ff1178704ebd56dc2fff04eef56`)
- NEA · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-04-01
- Location: none · checked: metadata
- Fields: `year`, `pm25_mean`
- Use: Long-term air-quality trend context (e.g. annual PM2.5 mean vs WHO guideline).
- Example question: "Is Singapore's air getting cleaner over the years?"
- Caveats: One national value per year; coverage 2002-2025 for PM2.5.

### Environment & health: Dengue & vector risk

#### Dengue clusters (live, with case counts)

- ID: `d_dbfabf16158d1b0e1c420627c0819168`
- NEA · tier high · GeoJSON via download · updates daily · latest snapshot 2026-10-19 · last updated 2026-10-19
- Location: point (lat/lon or SVY21 or address) · checked: rows (first catalogue pass)
- Use: Alert when a dengue cluster appears near the owner's town.
- Example question: "Are there dengue clusters near Sengkang right now?"
- Caveats: Rows sampled in the first catalogue pass.

#### Areas with high Aedes mosquito population (Gravitrap) and Wolbachia release sites

- ID: `d_5d060d8b7838a15e8906fb22c50dbf51` (plus 1 related: `d_533d673fe769e58f71609c18080ea7a7`)
- NEA · tier medium · GeoJSON via download · updates monthly · latest snapshot 2026-10 · last updated 2026-10-08
- Location: town/planning-area · checked: metadata
- Use: Add a mosquito-risk note to the briefing when the owner's area is flagged.
- Example question: "Is my estate a high-Aedes area this month?"
- Caveats: Description text still says "April to June 2019" though file refreshed 2026-10-08 - confirm period in properties before use. Polygons, need point-in-polygon or name matching.

#### Weekly infectious disease bulletin cases, polyclinic attendances for ARI/diarrhoea, weekly dengue cases

- ID: `d_ca168b2cb763640d72c4600a68f9909e` (plus 2 related: `d_5d5508f1c954f5630d7b3aa7875d01f9`, `d_ac1eecf0886ff0bceefbc51556247015`)
- MOH · tier low · CSV via datastore · updates weekly (stale) · latest 2022-W52 · last updated 2024-06-06
- Location: none · checked: metadata
- Fields: `epi_week`, `disease`, `no._of_cases`
- Use: Seasonal baseline for "is flu/HFMD/dengue season bad" comparisons.
- Example question: "Is HFMD usually high around this time of year?"
- Caveats: Stale: bulletin and polyclinic series end 2022, dengue weekly ends 2018. Baseline only.

### Environment & health: Emergency & civil defence

#### AED locations (public access defibrillators)

- ID: `d_e8934d28896a1eceecfe86f42dd3c077` (plus 1 related: `d_4e6b82c58a8a832f6f1fee5dfa6d47ea`)
- SCDF · tier medium · GeoJSON via download · updates annual · latest snapshot 2025-11 (GeoJSON) / 2024-12 (CSV) · last updated 2025-11-13 · 11,637 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `Postal_Code`, `Building_Name`, `Location_Description`
- Use: Tell the owner where the nearest AED is in their building/estate (and remind them of myResponder).
- Example question: "Where is the nearest AED at my block?"
- Sample: Goldbell Towers (228233) - Level 4 Office beside Server Room; 411B Northshore Trio - Level 1 Lift Lobby B
- Caveats: CSV has postal code + location description only; GeoJSON (7 MB) adds lat/lon and operating hours. In a real emergency, call 995 first.

#### Civil Defence public shelters and fire stations

- ID: `d_291795a678b8cf82f108780a6235ce18` (plus 1 related: `d_5d3d2c4f3556edb5d8c995f42e603b24`)
- SCDF · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2024-12 · last updated 2024-12-03 · 589 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `NAME`, `ADDRESS`, `POSTALCODE`, `DESCRIPTION`
- Use: Answer "where is my nearest CD public shelter / fire station" (e.g. during siren tests on 15 Feb/15 Sep).
- Example question: "Where is the nearest civil defence shelter to my home?"
- Sample: Northbrook Secondary, 585 Yishun Ring Road 768692 - CD Public Shelter (School)

### Environment & health: Food & healthier dining

#### Dates of hawker centre closures (cleaning/repairs) — **Selected**

- ID: `d_bda4baa634dd1cc7a6c7cad5f19e2d68`
- NEA · tier high · CSV via datastore · updates ad-hoc · latest current quarter · last updated 2026-10-19
- Location: point (lat/lon or SVY21 or address) · checked: rows (first catalogue pass)
- Fields: `serial_no`, `name`, `q1_cleaningstartdate`, `q1_cleaningenddate`, `remarks_q1`, `q2_cleaningstartdate`, `q2_cleaningenddate`, `remarks_q2`, `q3_cleaningstartdate`, `q3_cleaningenddate`, `remarks_q3`, `q4_cleaningstartdate`, `q4_cleaningenddate`, `remarks_q4`, `other_works_startdate`, `other_works_enddate`, `remarks_other_works`, `latitude_hc`, `longitude_hc`, `photourl`, `address_myenv`, `no_of_market_stalls`, `no_of_food_stalls`, `description_myenv`, `status`, `google_3d_view`, `google_for_stall`
- Use: Warn in the daily briefing when the owner's usual hawker centre is closed for cleaning.
- Example question: "Is Old Airport Road hawker open this Thursday?"
- Caveats: Rows sampled in the first catalogue pass.

#### Hawker centres (locations, stall counts) — **Selected**

- ID: `d_4a086da0a5553be1d89383cd90d07ecd` (plus 2 related: `d_a57a245b3cf3ec76ad36d55393a16e97`, `d_68a42f09f350881996d83f9cd73ab02f`)
- NEA · tier high · GeoJSON via download · updates annual · latest snapshot 2026-10 · last updated 2026-10-19
- Location: point (lat/lon or SVY21 or address) · checked: rows (first catalogue pass)
- Use: Answer "nearest hawker centre" and pair with closure dates for food suggestions.
- Example question: "Which hawker centres are in Tampines?"
- Caveats: Rows sampled in the first catalogue pass. NEA Market and Food Centre layer adds stall counts; d_68a42f09 list is a stale 2016 snapshot.

#### Healthier Dining Partners - F&B outlets (with healthier menu items), plus Healthier Eateries/Caterers maps

- ID: `d_c475b9170c08f90580f4041bffd51639` (plus 3 related: `d_2925c2ccf75d1c135c2d469e0de3cee6`, `d_a93d46bbf91f3a9126a2e08a1982d5ad`, `d_fcc28368ec87ef1f03b3e7de05a0c6db`)
- HPB · tier high · CSV via datastore · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-02 · 3,762 rows
- Location: region · checked: rows
- Fields: `Company_Name`, `Brand_Name`, `FnB_Setting`, `Dining_Concept`, `Category`, `Name_of_Outlet`, `Outlet_Address`, `Regions`, `Menu_Item_Endorsement_Criteria`
- Use: Suggest healthier food options near the owner by filtering outlets on the Regions column (North/North-East/East/West/Central) and outlet address, incl. halal/non-halal and setting (hawker, restaurant).
- Example question: "Any healthier-choice hawker stalls in the North-East I can try for lunch?"
- Sample: Wonderful Fried Food @ Punggol Coast HC, 84 Punggol Way, Regions: North-East, Hawker, Non-Halal, "Lower in calories"
- Caveats: Outlet-level rows (one row per brand x outlet); Regions uses 5 regions incl. North-East. Healthier Eateries/Caterers GeoJSON are older (Jan 2026) map layers.

#### Healthier Choice Symbol (HCS) product list

- ID: `d_d3774efc273016babcea619974eb6873` (plus 1 related: `d_6725eed000bf5b3c5d310eb08de0851f`)
- HPB · tier low · CSV via datastore · updates half-yearly · latest 2026-06-30 · last updated 2026-07-07 · 5,370 rows
- Location: none · checked: rows
- Fields: `brand_and_product_name`, `package_size`
- Use: Check whether a grocery product carries the Healthier Choice Symbol when the owner is shopping.
- Example question: "Does Zico coconut water have the Healthier Choice logo?"
- Sample: Zico Coconut Water 330 ml; ZHEN Whole Cup Bird's Nest 180 g
- Caveats: Only brand/product name and pack size; no nutrition values. New dataset ID each half-year (title "as of 30 June 2026").

#### NEA licensed eating establishments with hygiene grades/demerit points; supermarket licences

- ID: `d_227473e811b09731e64725f140b77697` (plus 1 related: `d_11edd0117280c5776651d7891114c88c`)
- NEA · tier low · CSV via datastore · updates quarterly (stale) · latest 2016-09 · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Fields: `licensee_name`, `licence_number`, `premises_address`, `grade`, `demerit_points`, `suspension_start_date`, `suspension_end_date`
- Use: Look up an eatery's hygiene grade or suspension history (historical only).
- Example question: "Has this restaurant ever been suspended by NEA?"
- Caveats: Coverage ends 2016 (supermarkets 2016-06); not refreshed despite "quarterly" label - historical curiosity only.

### Environment & health: Health products & medicines

#### Healthier SG whitelisted (subsidised) drugs at GP clinics

- ID: `d_2a57d4e672be2a52118ae0bf4a0f4a4b`
- MOH · tier medium · CSV via datastore · updates ad-hoc · latest snapshot 2026-09 · last updated 2026-09-29 · 224 rows
- Location: none · checked: rows
- Fields: `sn`, `medication`, `subsidy`
- Use: Tell the owner whether a chronic medication is subsidised under Healthier SG at their enrolled GP.
- Example question: "Is warfarin covered under Healthier SG drug subsidies?"
- Sample: Warfarin Sodium 5 mg Tablet - SDL; White Soft Paraffin Ointment - SDL
- Caveats: Subsidy tier only (e.g. SDL), no prices.

#### HSA registered therapeutic products (plus Chinese proprietary medicines and notified cosmetics)

- ID: `d_767279312753558cbf19d48344577084` (plus 3 related: `d_2ae2e6beb458d059318c1c14ad899f98`, `d_1ef20e7df81a229f4b4085beefeac2f9`, `d_5d2998b45537a144d8b3458a9a743858`)
- HSA · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2026-08 · last updated 2026-08-07 · 5,511 rows
- Location: none · checked: rows
- Fields: `LicenceNo`, `Productname`, `Licenseholder`, `Approvaldate`, `Forensicclassification`, `ATCCode`, `Dosageform`, `RouteofAdministration`, `Manufacturer`, `Countryofmanufacturer`, `Activeingredients`, `Strength`
- Use: Check if a medicine is registered in Singapore and whether it is prescription-only, pharmacy-only or general sale.
- Example question: "Is this cough syrup prescription-only in Singapore?"
- Sample: SIN00378C PMS-NYSTATIN SUSPENSION - Prescription Only, ATC A07AA02
- Caveats: Cosmetics list is ~20 MB; use datastore search rather than download.

#### Healthcare schemes and subsidies (names and types)

- ID: `d_586ee0cbc5c79ff8167a46132a405239`
- MOH · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2024-06 · last updated 2024-06-26 · 26 rows
- Location: none · checked: rows
- Fields: `schemes_and_subsidies`, `type`
- Use: Remind the owner which national schemes (MediShield Life, CHAS, MediFund, Merdeka Generation, etc.) exist.
- Example question: "What healthcare subsidies exist for elderly parents?"
- Sample: Merdeka Generation Package (Aged Care); Pioneer Generation Package; ElderFund
- Caveats: Names only, no eligibility or amounts.

### Environment & health: Healthcare facilities & services

#### CHAS clinics (GP and dental clinics accepting CHAS subsidies)

- ID: `d_548c33ea2d99e29ec63a7cc9edcccedc`
- MOH · tier high · GeoJSON via download · updates daily (label) · latest snapshot 2024-06 or earlier · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find CHAS-accredited GP/dental clinics in the owner's town for subsidised visits.
- Example question: "Which CHAS GP clinics are near Bedok?"
- Caveats: Labelled daily but lastUpdated 2024-06-06; KML-style Name/Description properties (address/hours embedded in HTML description). Verify against CHAS website before relying on it.

#### Polyclinics (address, phone, vaccine types and operating hours)

- ID: `d_b22489c7dc4065b6e7e45f177fdb33be`
- MOH · tier high · GeoJSON via download · updates ad-hoc · latest snapshot 2025-11 · last updated 2025-11-13
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: List polyclinics in the owner's region with phone numbers and vaccination hours.
- Example question: "Which polyclinic near me offers flu/COVID jabs on Saturday?"
- Caveats: Framed as COVID-vaccination layer but effectively a full polyclinic directory; check new polyclinics opened after Nov 2025.

#### Licensed retail pharmacies (list + map locations)

- ID: `d_bc50d72a9d61457964c6ea8d8ba7dce2` (plus 1 related: `d_bb92615f43de22933e4479558b1f6c36`)
- HSA · tier medium · CSV via datastore · updates ad-hoc · latest snapshot 2026-08 · last updated 2026-08-07
- Location: point (lat/lon or SVY21 or address) · checked: rows (first catalogue pass)
- Fields: `PharmacyName`, `Pharmacistincharge`, `PharmacyAddress`
- Use: Find a pharmacy near the owner's area.
- Example question: "Where is the nearest Guardian/Watsons pharmacy in Jurong?"
- Caveats: CSV sampled in the first catalogue pass (reused); GeoJSON layer (2025-11) has postal codes and building names.

#### Public Health Preparedness Clinics (GP clinics offering COVID vaccines) and Joint Testing & Vaccination Centres

- ID: `d_d7865f18a9f49f7120f1fb6b3581bcd4` (plus 4 related: `d_86c255436322859ab5e13a08ce8ea3a0`, `d_c5d9b8fd490a8473c563f5e6b221585f`, `d_4d54e8cd8ebb283d5caa5306557a5860`, `d_3a72361ccec412c344d90a662b767cf3`)
- MOH · tier medium · CSV via datastore · updates ad-hoc · latest snapshot 2024-12 · last updated 2024-12-23 · 533 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `name`, `address`, `vaccine`
- Use: Find a nearby GP that stocks the current COVID vaccine for a given age group.
- Example question: "Which GPs in Bukit Batok give the JN.1 COVID vaccine for kids?"
- Sample: The Local Doctor Clinic, 61 Telok Blangah Heights - Pfizer/Comirnaty (JN.1) and Moderna (JN.1)
- Caveats: Vaccine strain list dated (JN.1); geo layer updated 2025-11; also a decent proxy GP-clinic directory with addresses.

#### Screening centres (breast, cervical) and HPB Quit Centres

- ID: `d_0cdfbf7e277e8bfa1ef79fadf4b71b56` (plus 2 related: `d_3ca2a28059588f297908b32da4ac3cbe`, `d_527eb9ff7e89d0499f1dcbf85d3f8c32`)
- HPB · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2025-05 to 2026-08 · last updated 2026-01-04
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Point the owner (or family) to the nearest mammogram/Pap screening centre or smoking-cessation centre when a health reminder fires.
- Example question: "Where can my mum go for a subsidised mammogram near Yishun?"
- Caveats: Quit Centres updated quarterly (2026-08); screening layers 2026-01.

#### Blood bank (donation centre) locations with opening hours

- ID: `d_7ebcb46ff488d37a315148a38b23f19f` (plus 1 related: `d_b5c426c38eee223a5a2299ce3dc61f77`)
- HSA · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2025-10 · last updated 2025-11-12
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Suggest where and when to donate blood.
- Example question: "Where can I donate blood on a Sunday?"
- Caveats: Only a handful of sites; older duplicate d_b5c426c3 (2024).

#### Eldercare services and Dementia-Friendly Go-To Points

- ID: `d_f0fd1b3643ed8bd34bd403dedd7c1533` (plus 1 related: `d_e2d10e591bc8560b8946a0da24790fa5`)
- MOH · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2024-06 (eldercare) / 2025-10 (GTPs) · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find eldercare centres or dementia go-to points near a parent's home.
- Example question: "Are there eldercare centres near my parents in Ang Mo Kio?"
- Caveats: Eldercare layer is a 2024 KML-style snapshot; GTPs refreshed 2026-08.

#### Institutions participating in the National Electronic Health Record (NEHR)

- ID: `d_2864c425e22ddb89969585820629adf8`
- MOH · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2026-10-16 · last updated 2026-10-16 · 4,149 rows
- Location: none · checked: rows
- Fields: `S_N`, `Organization_Institution`, `Effective_Date`
- Use: Check whether a clinic shares records with NEHR (and as a fresh name list of licensed clinics).
- Example question: "Is The Clifford Clinic on NEHR?"
- Sample: DA MedSuites (Imaging), West Family Clinic, The Clifford Clinic (effective 16.10.2026)
- Caveats: Names and effective dates only, no address.

### Environment & health: Misc civic places

#### After-death facilities: crematoria, columbaria, funeral parlours, cemeteries, ash scattering gardens

- ID: `d_8057b4f4c7eca22c3c51c4ac05440f21` (plus 5 related: `d_7c7c57950ceda95e8efa6cec46029b5d`, `d_9b0752e9d3f1f9d957d5d8be2b58dfff`, `d_054b67adc211306beaf5c005be8f5381`, `d_4a9b83ee745c10c3aa5829fb80e09d9c`, `d_8dc64019ee16bda33f7758bc4e9d2223`)
- NEA · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2025-11 · last updated 2025-11-13
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Help with funeral or Qing Ming logistics (locations of columbaria, crematoria, parlours).
- Example question: "Where is Mandai columbarium and what are nearby funeral parlours?"

#### Designated smoking areas, No-Smoking Zones, NParks no-smoking locations

- ID: `d_d0fa8f07ef80ab23feaa3b870323bf27` (plus 2 related: `d_491641889c8add4c7835721bd72aa84a`, `d_3c8343c1efaeb05d4d1dbcdd0f599077`)
- NEA · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2026-09 · last updated 2026-09-19
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Answer whether smoking is allowed in an area and where the nearest designated smoking area is.
- Example question: "Is Orchard Road a no-smoking zone?"

### Environment & health: Parks, nature & recreation

#### NParks parks (points) and parks & nature reserves (polygons)

- ID: `d_0542d48f0991541706b58059381a6eca` (plus 2 related: `d_77d7ec97be83d44f61b85454f844382f`, `d_99b71f5d34cf57a3a592fbfdef1f42b6`)
- NParks · tier high · GeoJSON via download · updates half-yearly · latest snapshot 2026-10 · last updated 2026-10-18
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Suggest parks near the owner's town for weekend plans, walks or runs.
- Example question: "What parks are near Punggol for a weekend walk?"
- Caveats: Points have NAME + X/Y (SVY21); polygon file ~3 MB. HPB Parks@SG (2024) folded as older duplicate.

#### Central Nature Reserve hiking trails, biking route and amenities

- ID: `d_84e6db6c43ffb8b17803334ec2b5c95d` (plus 2 related: `d_147e0d9d2f38453d2aa58d52716b78f1`, `d_19a87bbb86b2c14601a1745076812438`)
- NParks · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-14
- Location: region · checked: metadata
- Use: Suggest MacRitchie/Bukit Timah hiking trails and nearby amenities (toilets, shelters).
- Example question: "What hiking trails are in the Central Catchment?"
- Caveats: Central region only.

#### Park connector loops (PCN), Nature Ways and NParks tracks (walk/cycle/PMD permissions)

- ID: `d_a69ef89737379f231d2ae93fd1c5707f` (plus 2 related: `d_af948e3f29cd12bc8b0caea19ae68286`, `d_306cc1018cb733346681883ee6d73054`)
- NParks · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-07 · last updated 2026-07-15
- Location: region · checked: metadata
- Use: Recommend a park-connector cycling/running loop in the owner's region and whether PMDs/cycling are allowed.
- Example question: "Which park connector loop is good for cycling in the East?"
- Caveats: Line geometries; PCN loop names (e.g. Eastern Coastal Loop) are region-matchable; Tracks file is 25 MB.

#### Park facilities (toilets, playgrounds, fitness corners, shelters), BBQ pits, NParks car park lots

- ID: `d_14d807e20158338fd578c2913953516e` (plus 2 related: `d_5e5442d0766b00d2d09fd6f7768362a6`, `d_d5594e4c43e838380155f05f53f58567`)
- NParks · tier medium · GeoJSON via download · updates half-yearly · latest snapshot 2026-10 · last updated 2026-10-18
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Answer "does park X have BBQ pits/toilets/playground/fitness corner".
- Example question: "Does East Coast Park have BBQ pits near area C?"
- Caveats: 6 MB facilities file with CLASS field; BBQ pits only have tag numbers (booking via AXS/NParks).

#### ABC Waters (Active, Beautiful, Clean) completed sites, projects and construction

- ID: `d_b5f239cc954bb7920245a7b8ad95dde8` (plus 2 related: `d_b76264072198a51af7f7a8b8e1005591`, `d_e45aa3ec4053d81046060bab03579281`)
- PUB · tier low · GeoJSON via download · updates half-yearly · latest snapshot 2026-10 · last updated 2026-10-18
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Suggest scenic waterfront/ABC Waters spots near home.
- Example question: "Any nice waterfront promenades near Bishan?"

#### Gyms@SG, SportsFields@SG, WaterActivities@SG (public gyms, sports fields, water sports)

- ID: `d_b3ae090692ecf632116c9885cfbd3424` (plus 2 related: `d_f71b449b4b43a69b5ecfe411b440d249`, `d_3db7e1a18c685a2a61ced5a0deb83dae`)
- HPB · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2024-06 or earlier · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Point the owner to public gyms or sports fields near their town.
- Example question: "Any ActiveSG gyms near Woodlands?"
- Caveats: Stale KML-style layers (Name/Description only).

#### Heritage trees, Community in Bloom gardens, drone no-fly areas in NParks sites

- ID: `d_644ff187b6d14d6316f47284a4a6c81f` (plus 2 related: `d_f91a8b057cfb2bebf2e531ad8061e1c1`, `d_15457a8f67905fb6ed890fca2ebac5f7`)
- NParks · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2026-08 · last updated 2026-08-22
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Leisure trivia: heritage trees and community gardens near home; check if drone flying is banned at a park.
- Example question: "Can I fly my drone at Pasir Ris Park?"

### Environment & health: Recycling & waste disposal

#### Channels for donation, resale and repair (plus 2nd-hand goods points and Cash-for-Trash)

- ID: `d_7e1f0da76a744c85e3d3ecc76642dcb5` (plus 2 related: `d_455844a90d985206b684851d2a8648d6`, `d_51995b625307f3953f7ba344722acd79`)
- NEA · tier medium · GeoJSON via download · updates half-yearly · latest snapshot 2024-01+ · last updated 2025-11-13
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Suggest where to donate, resell or repair items (with accepted item types), or trade recyclables for cash.
- Example question: "Where can I donate old clothes or get a toaster repaired?"
- Caveats: Has ACCEPTEDITEMS and REUSETYPE fields; 2nd-hand/Cash-for-Trash layers are 2024 KML-style snapshots.

#### E-waste recycling points (and lighting waste collection points)

- ID: `d_db40d004afeb5a7f0f555fdcc34934cc` (plus 1 related: `d_6226f69998ed0cb62151af37706508cd`)
- NEA · tier medium · GeoJSON via download · updates annual · latest data as of 2022-06 · last updated 2025-11-08
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Tell the owner where to drop old phones, batteries, laptops or bulbs near their town.
- Example question: "Where can I recycle an old laptop near Clementi?"
- Caveats: Description warns data last updated 2022-06-02; ALBA/e-waste bin locations may have changed.

#### Licensed general waste collectors (contacts)

- ID: `d_b4de98f706379b787ab86d1e69412910`
- NEA · tier low · CSV via datastore · updates ad-hoc · latest 2026-01 · last updated 2026-01-19
- Location: none · checked: metadata
- Fields: `class_of_waste`, `Licensee_Name`, `Address`, `Email_Address`, `Contact_No`
- Use: Find a licensed collector for bulky-item or renovation waste disposal.
- Example question: "Who can I call to dispose of an old sofa?"
- Caveats: Business listing with contact details; check terms before surfacing personal contact names.

#### Recycling bins (blue bins) locations

- ID: `d_4dde14826642f49eefff48b7832b90db`
- NEA · tier low · GeoJSON via download · updates annual · latest snapshot 2024-06 or earlier · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Locate recycling bins near an address.
- Example question: "Is there a recycling bin near Blk 123?"
- Caveats: 19 MB KML-style file, stale; low marginal value since bins are at every HDB block.

### Environment & health: Water & flooding

#### Drinking water quality (annual parameter averages)

- ID: `d_f397c39929978d3047e0e32430c6763b`
- PUB · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-06-18 · 384 rows
- Location: none · checked: rows
- Fields: `Year`, `Parameter`, `Units`, `Average`, `Range`
- Use: Answer tap-water safety questions with PUB's published parameter averages.
- Example question: "Is Singapore tap water safe to drink?"
- Sample: 2025 Uranium avg 0.006 ug/L (range 0.001-0.019); Xylenes < 15
- Caveats: Units column has encoding glitch (shows "æg/L" for ug/L).

#### PUB water level sensor and CCTV locations; flood-prone area total (hectares)

- ID: `d_31333fa5cf0834f012d840365b336610` (plus 2 related: `d_1de1c45043183bec57e762d01c636eee`, `d_c4aed98f1533eb3a66f65dbb1a30da46`)
- PUB · tier low · XLSX via download · updates half-yearly · latest 2026 (sensors) / 2025 (flood-prone hectares) · last updated 2026-04-13
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Use: Pair live flood alerts with nearby drain sensor names; report national flood-prone area trend.
- Example question: "Is there a PUB water-level sensor near my road?"
- Sample: Flood-prone areas: 2025 23.3 ha, 2024 23.6 ha
- Caveats: Flood Prone Areas dataset is ONLY an annual national hectare total (4 rows), not a list of locations. Live flood alerts are the real-time API (covered elsewhere).

### Environment & health: Weather & climate

#### Monthly climate series (rainfall total/rain days/max daily rain, mean/max/min/extreme temperature, humidity, sunshine) 1982-present

- ID: `d_b16d06b83473fdfcc92ed9d37b66ba58` (plus 13 related: `d_134857f63c76d227b6fa045f31ce59c1`, `d_53ffdaa97e48ce934cf92799d381f3b1`, `d_755290a24afe70c8f9e8bcbf9f251573`, `d_b0fb69de67054d6d741bea78274ecc2a`, `d_c92edf841336f03ab51c6693ac8d33ad`, `d_72a4d7402d4014f1999a009864f64a11`, `d_3b4b0418948847eaca93546f7574e365`, `d_8e72ca09d5000b490126e3cd492f942b`, `d_be96fc5a86b96f228efd7addaf7e61a8`, `d_e3b1111a26b2aefef4f386c068d4ca5d`, `d_54445baa32ffe4d46f5bef168c4e0538`, `d_31dbf162e94f76065e1e4c60a80a4264`, `d_9a80d732aa5de0a68be0557fc9437ad0`)
- NEA · tier high · CSV via datastore · updates monthly · latest 2026-09 · last updated 2026-10-08 · 537 rows
- Location: none · checked: rows
- Fields: `month`, `total_rainfall`
- Use: Compare this month's rainfall/temperature/sunshine with the 1982-present record for the same month to answer "is this normal" and add climate context to briefings.
- Example question: "Was September unusually dry or hot compared to past Septembers?"
- Sample: Rainfall monthly total 2026-09: 145.2 mm (2026-08: 41.8 mm); monthly mean temp 2026-09: 29.3 C
- Caveats: Single island-wide station series (Changi climate station), one row per month; each metric is a separate small dataset (~540 rows). Annual-mean variants (d_31dbf162, d_8e72ca09, d_be96fc5a) are updated each January.

#### Wet bulb temperature, hourly (1982-present)

- ID: `d_f222c70a7c00c5a5a9d4ec432d67f6e8`
- NEA · tier medium · CSV via datastore · updates monthly · latest 2026-09-30 · last updated 2026-10-08 · 392,256 rows
- Location: none · checked: rows
- Fields: `wbt_date`, `wbt_time`, `wet_bulb_temperature`
- Use: Give heat-stress context: compare recent hourly wet-bulb readings with historical norms for outdoor exercise planning.
- Example question: "Has this been an unusually muggy week by wet-bulb standards?"
- Sample: 2026-09-30 hour 24: 25.6 C
- Caveats: Monthly batch (lags ~1-3 weeks); single station; live WBGT already comes from the real-time API.

### Environment & health: set aside

| Group                                                                                                                                                                                                            | Datasets | Reason                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real-time NEA/PUB API datasets (forecasts, readings, PSI/PM2.5/UVI/WBGT, lightning, radar, flood alerts)                                                                                                         | 15       | Already covered by the existing real-time integration (brief says skip).                                                                                                                                                                            |
| Historical per-station weather readings 2016-2024 (rainfall, air temperature, humidity, wind direction/speed) and 2009-2017 daily weather records                                                                | 46       | Multi-GB per-reading archives (e.g. 2024 rainfall file is ~1.2 GB) ending 2024; the monthly climate series candidate answers "is this normal" far more cheaply.                                                                                     |
| Archived historical 2-hour / 24-hour / 4-day weather forecasts 2016-2024                                                                                                                                         | 27       | Past forecasts (not observations) have no use for a personal assistant; large files.                                                                                                                                                                |
| Per-year historical PSI, PM2.5 and UVI archives 2016-2024                                                                                                                                                        | 27       | Superseded by the continuous regional historical 24-hr PSI / 1-hr PM2.5 series (2014-present); UVI hourly archives end 2024 and are large.                                                                                                          |
| COVID-19 statistics (weekly stats, daily figures, vaccination progress)                                                                                                                                          | 9        | Pandemic-era series frozen since 2023-2024.                                                                                                                                                                                                         |
| Stale dengue-case, Aedes-breeding-habitat and Zika snapshots by region                                                                                                                                           | 12       | Frozen 2024 (or older) snapshots despite "daily" label; live dengue clusters cover the need.                                                                                                                                                        |
| HPB population health statistics and surveys (student health, immunisation coverage, nutrition/behaviour/mental-wellbeing surveys, disease incidence)                                                            | 23       | National aggregate or one-off survey tables, mostly pre-2024; no personal action value.                                                                                                                                                             |
| MOH national health statistics (workforce counts, facilities/beds, admissions, attendances, mortality, life expectancy, expenditure, Medisave/MediShield/ElderShield aggregates, long-term care, top conditions) | 60       | Macro national aggregates; little direct use for one resident (no bill-size or fee data in this bucket).                                                                                                                                            |
| HSA business licensing registries (medical devices, licensed health-product companies, tobacco retailers/importers, poison licences)                                                                             | 7        | Trade/regulatory registries aimed at businesses.                                                                                                                                                                                                    |
| NEA annual environmental, waste, energy and licensing statistics                                                                                                                                                 | 25       | National aggregates (waste generated/recycled, CO2, green vehicles, food-establishment and hawker-stall counts, radiation/hazardous licence counts).                                                                                                |
| NEA operator registries and facility internals                                                                                                                                                                   | 9        | Registries of pesticides, ECOs, vector-control operators, cleaning contractors, radiation licences, waste disposal/treatment sites, NEA offices, PWC sectors - not resident-facing.                                                                 |
| HPB Healthier Ingredient Development Scheme partner list                                                                                                                                                         | 1        | B2B supplier contact list for food manufacturers.                                                                                                                                                                                                   |
| NParks technical and ecological layers                                                                                                                                                                           | 8        | Habitat/shoreline maps, leaf area index, tree conservation and heritage-road buffers, nature-reserve gazette, building footprints - planning layers, not leisure-useful.                                                                            |
| PUB water-supply statistics and non-residential tariffs                                                                                                                                                          | 6        | NEWater/industrial tariffs, pipe leaks, volumes sold. NOTE: "Potable Water Tariff" d_115300b3 is mislabeled - it actually holds annual potable water SALES volumes 2008-2021 (sampled), so there is no current household water tariff dataset here. |
| SCDF administrative datasets (fire posts, enforcement counts, HQs/training establishments)                                                                                                                       | 3        | Agency-internal or enforcement statistics.                                                                                                                                                                                                          |
| Precision Health Research PRECISE-SG100K project list                                                                                                                                                            | 1        | Research project registry.                                                                                                                                                                                                                          |

## Housing & property

Agencies: HDB, URA, SLA, BCA, CEA.

544 datasets from HDB, URA, SLA, BCA, JTC, CEA, PEB and BOA; about two-thirds are URA Master Plan GIS layers (mostly superseded editions) and most HDB items are 2018 household-survey cross-tabs or annual agency stats. The valuable core is small and current: HDB Property Information (every block's max floor, completion year, unit mix), block-level HDB rentals (monthly, to 2026-09), median resale prices by town (2026-Q2), the CEA agent register (daily) plus agent transaction records, URA private price/rental indices and transaction volumes (2026-Q2), and URA car park capacity. Master Plan 2025 land use and planning-area/region boundaries are useful but need one-off offline preprocessing. No ethnic-integration/SPR quota, season-parking, street-directory or town-council dataset exists here (NRP layer gives town-council names/emails).

Coverage: 544 datasets, 86 in 36 entries, 458 set aside.

### Housing & property: Agents, contractors & professionals

#### CEA Register of Salespersons (property agents)

- ID: `d_07c63be0f37e6e59c07a4ddc2fd87fcb`
- CEA · tier high · CSV via datastore · updates ad-hoc · latest snapshot 2026-10-19 · last updated 2026-10-19 · 38,650 rows
- Location: none · checked: rows
- Fields: `salesperson_name`, `registration_no`, `registration_start_date`, `registration_end_date`, `estate_agent_name`, `estate_agent_license_no`
- Use: Verify that a property agent is currently registered: name/registration number lookup returning agency, licence no. and registration validity.
- Example question: "Is the agent with registration number R000000X still registered, and with which agency?"
- Sample: One row per registered salesperson: name, registration number, registration period, estate agent and licence number.
- Caveats: Updated daily; registration end dates roll yearly. Rows name individual salespersons; look up only an agent the owner names.

#### BCA Management Corporation Strata Title (MCST) register

- ID: `d_1f9391a2f1476cdaf4f05a8d3a05c257` (plus 1 related: `d_f988c57e16e99ad3a649aa04572efd1c`)
- BCA · tier medium · CSV via datastore · updates half-yearly · latest 2026-09 · last updated 2026-10-08 · 3,826 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `usr_mcno`, `usr_mctype`, `sub_mcno`, `usr_mcstuen`, `usr_devtname`, `devt_location`, `mcst_houseno`, `mcst_roadname`, `mcst_unitno`, `mcst_buildingname`, `mcst_postalcode`, `mcst_telno`, `ust_status`, `mcst_stratalota`, `managementname`, `mc_form_date`
- Use: Find a condo's MCST number, UEN, address and managing agent (e.g. for a condo the owner lives in or is buying into).
- Example question: "What is the MCST number and managing agent for Lumina Grand?"
- Sample: LUMINA GRAND, MCST 5022, UEN T26MC0030C, 3 Bukit Batok West Ave 5 659755, 512 strata lots
- Caveats: Unit numbers are mangled by Excel (e.g. "29-Jun"). XLSX copy folded in.

#### CEA Salespersons' Property Transaction Records (residential)

- ID: `d_ee7e46d3c57f7865790704632b0aef71`
- CEA · tier medium · CSV via datastore · updates monthly · latest 2026 (rolling) · last updated 2026-10-16 · 1,411,116 rows
- Location: town/planning-area · checked: rows
- Fields: `salesperson_name`, `transaction_date`, `salesperson_reg_num`, `property_type`, `transaction_type`, `represented`, `town`, `district`, `general_location`
- Use: Show an agent's track record (counts by property type, sale vs rental, district) before the owner engages them.
- Example question: "How many HDB resale deals has the agent with registration number R000000X closed in the last year?"
- Sample: One row per transaction: salesperson registration number, property type, transaction type, side represented, town or district, month.
- Caveats: Large (135 MB, 1.4M rows): query by salesperson_reg_num via datastore filters, never bulk. Month-level dates; no prices. Rows name individual salespersons; look up only an agent the owner names.

#### HDB Directory of Renovation Contractors (DRC)

- ID: `d_9973d2c119ed4dd1560aebf8f0829b86`
- HDB · tier medium · CSV via datastore · updates ad-hoc · latest snapshot 2026-03 · last updated 2026-03-24 · 2,708 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `uen`, `directory_ref_no`, `company_name`, `address`, `postal_code`, `email_address`, `contact_no`
- Use: Check whether a renovation firm the owner is considering is on HDB's Directory of Renovation Contractors (allowed to do HDB flat works) and get its contact details.
- Example question: "Is "Ocet Renoway" an HDB-registered renovation contractor?"
- Sample: OCET RENOWAY PTE. LTD., HB-12-6461F, BLK 125 PIONEER ROAD 639592
- Caveats: Updated ad hoc (last 2026-03); trailing spaces in fields.

#### BCA Licensed Builders and Registered Contractors

- ID: `d_19573c579879be15623f2e1e3854926d` (plus 1 related: `d_dcda79be4aded5f9e769b8e23ff69b47`)
- BCA · tier low · CSV via datastore · updates half-yearly · latest snapshot 2026-01 · last updated 2026-01-12
- Location: none · checked: metadata
- Fields: `company_name`, `uen_no`, `class`, `class_code`, `additional_info`, `expiry_date`, `building_no`, `street_name`, `unit_no`, `building_name`, `postal_code`, `tel_no`
- Use: Verify a builder's licence class or contractor registration grade/expiry before hiring for larger works.
- Example question: "Is ABC Builders a licensed builder and when does it expire?"
- Caveats: Half-yearly listing (last 2026-01).

#### Board of Architects registers (architects and firms)

- ID: `d_d77de0f78ca589a5c61da7a60fdee6ba` (plus 4 related: `d_d5c0a4ffd076a3e40d772275619bbb66`, `d_65f6a92f8902a09caf2256855d3de376`, `d_8540719f90fef1eae60dc2810f6a42d8`, `d_521e0b73946484e83269d8ab4c7889cd`)
- BOA · tier low · CSV via datastore · updates annual · latest snapshot 2026-10 · last updated 2026-10-19
- Location: none · checked: metadata
- Fields: `name`, `reg_no`, `firm_name`, `firm_address`, `firm_phone`
- Use: Verify that an architect or architecture firm is registered.
- Example question: "Is this architect registered with the Board of Architects?"
- Caveats: APEC/ASEAN/foreign architect registers folded in.

#### PEB Directory of Professional Engineers (incl. specialists and suspended/deregistered)

- ID: `d_f92927723e0894a14ee3acca6411e73d` (plus 4 related: `d_597617c00b02ec9c509614b986b57a17`, `d_662d69b0919fc752a43175eb178030d5`, `d_8f5388aadc999c645d5a68baa79c41a1`, `d_50c58ff1ca87758b8adc2cadd66d60b9`)
- PEB · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-19
- Location: none · checked: metadata
- Fields: `RegNo`, `Fullname`, `Branch`, `DateofRegistration`, `Practice_EmployerName`, `Practice_EmployerType`, `Practice_EmployerAddress`, `ContactNo`
- Use: Verify a professional engineer (e.g. for structural works/endorsements) and check the suspension list.
- Example question: "Is engineer X a registered PE with a practising certificate?"

### Housing & property: Buildings & accessibility

#### BCA Friendly Buildings (accessibility-rated buildings)

- ID: `d_f19704cb6ce76309f3ec0c3a513bdeab`
- BCA · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2026-04 · last updated 2026-04-18
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Suggest wheelchair/family/elderly-friendly buildings when planning outings with elderly parents or a pram.
- Example question: "Which malls near me are rated family-friendly?"
- Caveats: Not sampled; 2.4 MB GeoJSON.

#### BCA Green Mark Buildings

- ID: `d_c4bd082b48fa7611713f39e23d250c27` (plus 1 related: `d_da116ef216e3fb501846e1c9faf7e683`)
- BCA · tier low · CSV via datastore · updates ad-hoc · latest 2026-09 · last updated 2026-10-16
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Fields: `Reference_No`, `Project_Name`, `Actual_Project_Name`, `Postal_Code`, `Rating`, `SLE_ZE_PE`, `CN`, `HW`, `IN`, `MT`, `RE`, `Prov_Letter`, `e_cert`, `Expiry`, `Project_Type`, `GFA`, `Re_Certification`, `Previous_GM_Cert_Reference_No`, `GM_Version`, `Developer`, `Architect`, `ME_Engineer`, `CS_Engineer`, `Facility_Manager`, `ESD_Consultant`
- Use: Check a building/condo's Green Mark rating.
- Example question: "Is my office building Green Mark certified?"
- Caveats: GeoJSON copy folded in.

#### HDB Existing Building footprints (+ building lines, closed 100%-vacant buildings)

- ID: `d_16b157c52ed637edd6ba1232e026258d` (plus 2 related: `d_b713993fbf0d147ad4a009a1c1db3bd6`, `d_fa7159e32843947846e4d756d1aa4d7f`)
- HDB · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2026-06 · last updated 2026-06-21
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Geocode an HDB block to a footprint/centroid for distance questions; flag blocks closed and fully vacated (e.g. SERS).
- Example question: "Which HDB blocks near me have been vacated?"
- Caveats: 57 MB; only useful after offline preprocessing.

#### SLA Lamp Post locations

- ID: `d_1ad7921e25264140dc361e193c095c52`
- SLA · tier low · GeoJSON via download · updates half-yearly · latest snapshot 2026-08 · last updated 2026-08-12
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Resolve a lamp-post number (commonly used to report locations/incidents) to a place.
- Example question: "Where is lamp post 123 on my running route?"
- Caveats: Small file (91 KB) suggests partial coverage; not sampled.

### Housing & property: HDB flats & estate

#### HDB Property Information (every HDB block: max floor, year completed, unit mix, facilities)

- ID: `d_17f5382f26140b1fdae0ba2ef6239d2f`
- HDB · tier high · CSV via datastore · updates quarterly · latest snapshot 2026-10 (blocks completed to 2025) · last updated 2026-10-08 · 13,392 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `blk_no`, `street`, `max_floor_lvl`, `year_completed`, `residential`, `commercial`, `market_hawker`, `miscellaneous`, `multistorey_carpark`, `precinct_pavilion`, `bldg_contract_town`, `total_dwelling_units`, `1room_sold`, `2room_sold`, `3room_sold`, `4room_sold`, `5room_sold`, `exec_sold`, `multigen_sold`, `studio_apartment_sold`, `1room_rental`, `2room_rental`, `3room_rental`, `other_room_rental`
- Use: Look up the owner's (or a prospective) HDB block by block number + street to answer max storey, completion year, unit mix (sold vs rental, flat types) and whether it has a market/hawker, MSCP or pavilion.
- Example question: "How old is Blk 999B Buangkok Crescent and how many floors does it have?"
- Sample: Blk 999B BUANGKOK CRES: max_floor_lvl 17, year_completed 2018, 126 units (31x3-room, 95x4-room sold), town code HG
- Caveats: No explicit lease-commencement date (year_completed is a proxy; the resale dataset has lease_commence_date per transaction). Town is a 2-letter code (bldg_contract_town). Address only, no coordinates. No ethnic-integration/SPR quota data exists in this bucket.

#### HDB Renting Out of Flats (approved rentals by block, Jan 2021 onwards)

- ID: `d_c9f57187485a850908655db0e8cfe651` (plus 2 related: `d_dad4567fc02596774010f765567780e3`, `d_2f2c29c3f821461f36c24c6c1dbbe059`)
- HDB · tier high · CSV via datastore · updates monthly · latest 2026-09 · last updated 2026-10-02 · 212,597 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `rent_approval_date`, `town`, `block`, `street_name`, `flat_type`, `monthly_rent`
- Use: Show actual approved monthly rents for whole-flat rentals in the owner's block/street/town, e.g. to sanity-check a renewal or listing price.
- Example question: "What are 4-room flats renting for in Bishan Street 22 lately?"
- Sample: 2026-09 BISHAN 255 BISHAN ST 22 4-ROOM $3600; 2026-09 JURONG EAST 244 JURONG EAST ST 24 3-ROOM $3000
- Caveats: Monthly granularity (approval month). Related: older quarterly rental-approval counts (stale, 2024) and annual active rental cases.

#### HDB resale flat prices (Jan 2017 onwards) + historical resale archives

- ID: `d_8b84c4ee58e3cfc0ece0d773c8ca6abc` (plus 4 related: `d_2d5ff9ea31397b66239f245f57751537`, `d_43f493c6c50d54243cc1eab0df142d6a`, `d_ea9ed51da2787afaf8e51f827c304208`, `d_ebc5ab87086db484f88045b47411ebc5`)
- HDB · tier high · CSV via datastore · updates monthly · latest 2026-10 · last updated 2026-10-19
- Location: point (lat/lon or SVY21 or address) · checked: rows (first catalogue pass)
- Fields: `month`, `town`, `flat_type`, `block`, `street_name`, `storey_range`, `floor_area_sqm`, `flat_model`, `lease_commence_date`, `remaining_lease`, `resale_price`
- Use: Answer "what did flats in my block/street sell for" and track resale prices for a target town/flat type; older archives give long history.
- Example question: "What did 4-room flats on my street sell for in the last 6 months?"
- Caveats: Rows sampled in the first catalogue pass. Related archives (1990-2016) are static and only useful for long-run history.

#### Median HDB Resale Prices by Town and Flat Type (quarterly)

- ID: `d_b51323a474ba789fb4cc3db58a3116d4` (plus 2 related: `d_02aa4bb51bc674f3a2d0b9bb6911d934`, `d_27af98d638a80103319cb7499c220fe6`)
- HDB · tier high · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-08-13 · 12,012 rows
- Location: town/planning-area · checked: rows
- Fields: `quarter`, `town`, `flat_type`, `price`
- Use: Give a one-line quarterly benchmark ("median 4-room in Yishun is $545k") for the owner's town without scanning raw transactions; pair with resale application counts for market activity.
- Example question: "What is the median 5-room resale price in Yishun now?"
- Sample: 2026-Q2 YISHUN 4-room 545000, 5-room 690000, Executive "-"
- Caveats: "-" where too few transactions. Related: quarterly resale application counts by flat type (2007-2026-Q2) and an annual resale-transactions table.

#### HDB Branch Offices (locations and hotline)

- ID: `d_3535361f967e8005dc44b4ce4d2c5276`
- HDB · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-15 · 21 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Use: Tell the owner where their nearest HDB branch is, its address/level and service line.
- Example question: "Where is the HDB branch for Ang Mo Kio?"
- Sample: Ang Mo Kio Branch, AMK Hub Blk 53 Ang Mo Kio Ave 3 #04-02, 569933, 6225-5432
- Caveats: Small static list; branch-to-town mapping is by name only.

#### HDB Lift Upgrading (LUP) and Neighbourhood Renewal (NRP) works, proposed and under construction

- ID: `d_9b5886a025c8db1192a8fada42bd4330` (plus 1 related: `d_156a38dc024d2b20a6c1d0c0179e797c`)
- HDB · tier medium · GeoJSON via download · updates quarterly · latest snapshot 2025-01 (feature LAST_UPDATED) · last updated 2026-09-04 · 41 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Use: Tell the owner whether upgrading works affect their precinct, expected completion quarter, contractor contact, and (NRP) which town council implements it with its feedback email.
- Example question: "Is there any lift upgrading or NRP happening near my block, and when will it finish?"
- Sample: LUP BISHAN STREET 22 (BIS27) U/C, est. completion 3Q 2026, Teambuild Engineering; NRP HOUGANG CENTRAL (HOU14) Proposed, implementer AHTC, feedback@ahtc.sg
- Caveats: Polygons; needs point-in-polygon or name matching. Feature LAST_UPDATED is 2025-01 although the dataset was republished 2026-09, so statuses may lag. Proposed items use placeholder date "4Q 2999". NRP layer (103 features) folded in; gives town-council names/emails, the only town-council info in this bucket.

#### HDB Median Rent by Town and Flat Type (quarterly)

- ID: `d_23000a00c52996c55106084ed0339566`
- HDB · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-24
- Location: town/planning-area · checked: rows (first catalogue pass)
- Fields: `quarter`, `town`, `flat_type`, `median_rent`
- Use: Quarterly town-level rent benchmark to complement block-level rentals.
- Example question: "What is the median rent for a 3-room in Bedok?"
- Caveats: Rows sampled in the first catalogue pass.

#### HDB Resale Price Index (1Q2009=100)

- ID: `d_14f63e595975691e7c24a27ae4c07c79`
- HDB · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-24
- Location: none · checked: rows (first catalogue pass)
- Fields: `quarter`, `index`
- Use: Quarterly island-wide HDB price trend for a briefing line when URA/HDB release new figures.
- Example question: "Did HDB resale prices go up last quarter?"
- Caveats: Rows sampled in the first catalogue pass.

#### Price Range of HDB Flats Offered (new flats by town and room type, annual)

- ID: `d_2d493bdcc1d9a44828b6e71cb095b88d` (plus 1 related: `d_6f3c2c819680fb139b66869d7aa4bd6e`)
- HDB · tier medium · CSV via datastore · updates annual · latest FY2024 · last updated 2026-01-20 · 357 rows
- Location: town/planning-area · checked: rows
- Fields: `financial_year`, `town`, `room_type`, `min_selling_price`, `max_selling_price`, `min_selling_price_less_ahg_shg`, `max_selling_price_less_ahg_shg`
- Use: Give a historical guide to new-flat (BTO/SBF) price ranges in a town, before and after grants, when the owner is weighing a BTO application.
- Example question: "Roughly how much did new 4-room flats in Yishun cost, after grants?"
- Sample: FY2024 Yishun 4-room $316k-$395k ($236k-$315k after AHG/SHG)
- Caveats: Annual and lagged (FY2024 = Apr 2024-Mar 2025). Not current launch prices. Footnotes PDF folded in.

#### HDB Under Construction Buildings (new HDB blocks being built)

- ID: `d_e4aaf26891bfe398666f7a96fe81a972` (plus 3 related: `d_930e662ac7e141fe3fd2a6efa5216902`, `d_157d034c579e12a095c967ca2a463d01`, `d_9e363d0eb7910dc7f53c44e4fe654586`)
- HDB · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-15
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Answer "what new HDB projects are being built near me" for a town, or track a BTO project the owner applied for.
- Example question: "Which new HDB blocks are under construction in Tengah?"
- Caveats: 4.8 MB GeoJSON, not sampled. The older "HDB Public Housing Building Under-Construction" layer (930e662a) was sampled and is stale (2018 records, e.g. Fengshan Greenville est. 4Q 2018); HDB roads/cycling paths under construction folded in.

### Housing & property: Parking

#### HDB Carpark Information (+ realtime availability API, outlines) — **Selected**

- ID: `d_23f946fa557947f93a8043bbef41dd09` (plus 2 related: `d_ca933a644e55d34fe21f28b8052fac63`, `d_7e8ecc485c30c0f22eb323f02b9075f1`)
- HDB · tier high · CSV via datastore · updates monthly · latest snapshot 2026-10 · last updated 2026-10-08
- Location: point (lat/lon or SVY21 or address) · checked: rows (first catalogue pass)
- Fields: `car_park_no`, `address`, `x_coord`, `y_coord`, `car_park_type`, `type_of_parking_system`, `short_term_parking`, `free_parking`, `night_parking`, `car_park_decks`, `gantry_height`, `car_park_basement`
- Use: HDB car park attributes (free parking, night parking, type) near the owner.
- Example question: "Is there free parking on Sunday at the HDB car park near Blk 123?"
- Caveats: Rows sampled in the first catalogue pass. Realtime carpark availability API (ca933a64) is the live feed rt:carpark-availability; car park outline polygons folded in.

#### URA Parking Places and Capacity (street/backlane/public car parks) — **Selected**

- ID: `d_9bf8620ecfdc8a5f8f77e3f02160af5c` (plus 1 related: `d_d959102fa76d58f2de276bfbb7e8f68e`)
- URA · tier medium · GeoJSON via download · updates quarterly · latest snapshot 2026-10 · last updated 2026-10-07 · 774 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Use: Find URA-managed public car parks near a destination with car/motorcycle/heavy-vehicle lot counts.
- Example question: "Are there URA car parks near Jalan Besar and how many car lots?"
- Sample: A0048 Ang Mo Kio Street 63: 43 car, 10 motorcycle lots; BL141 Backlane Townshend Rd / Jalan Besar: 8 motorcycle
- Caveats: WGS84 points keyed by PP_CODE, which matches URA Data Service ppCode. Record dates are 2022-2023. No rates; URA rates need a URA Data Service key.

#### JTC Carpark Information — **Selected**

- ID: `d_3b0c377cde41041c93f893d0a92e9fe7`
- JTC · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2025-07 · last updated 2025-07-03
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Fields: `car_park_no`, `address`, `x_coord`, `y_coord`, `car_park_type`, `type_of_parking_system`, `short_term_parking`, `free_parking`, `night_parking`, `car_park_decks`, `gantry_height`, `car_park_basement`
- Use: Parking details at JTC industrial/business parks (free/night parking, gantry height).
- Example question: "Is there night parking at the JTC car park in one-north?"
- Caveats: Small; last updated 2025-07.

### Housing & property: Planning & neighbourhood maps

#### URA Master Plan 2025 Planning Area / Region boundaries (+ MP2019 subzones)

- ID: `d_2cc750190544007400b2cfd5d7f53209` (plus 2 related: `d_4ce0038f7ac689652350bb91b7fb92ed`, `d_8594ae9ff96d0c708bc2af633048edfb`)
- URA · tier high · GeoJSON via download · updates ad-hoc · latest MP2025 · last updated 2026-02-27
- Location: region · checked: metadata
- Use: Lookup table to map the owner's town/planning area to North/North-East/East/West/Central and to filter any town-coded dataset to their region.
- Example question: "Which datasets cover my planning area, and which region is Sengkang in?"
- Caveats: Polygons (2-3 MB each); preprocess once into a planning-area->region table. Subzone boundary only exists for MP2019 in this bucket.

#### URA Master Plan 2025 Land Use (zoning, GPR) + amendments

- ID: `d_a8c3546b26712e35021f3a681d0353ae` (plus 1 related: `d_7a03324bed531cdff76a16239b0e84e1`)
- URA · tier medium · GeoJSON via download · updates ad-hoc · latest MP2025 (amendments to 2026-09) · last updated 2026-03-27
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Answer "what is the empty plot next to my block zoned for" (residential, park, commercial, reserve site) via point-in-polygon on the owner's address.
- Example question: "What is the land next to my flat zoned for in the Master Plan?"
- Caveats: Very large (190 MB each); must be preprocessed offline into a spatial index, not fetched per question.

#### Government Land Sales sites (URA Sale Sites + SLA Sale Sites results)

- ID: `d_0e2b42f98535686282031a42c9c7b05a` (plus 1 related: `d_7a043a1e4dee8041cff62b2cdd152b03`)
- URA · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2026-06 · last updated 2026-06-18
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Use: Tell the owner about government land sale sites (future condos/commercial) near home and tender results.
- Example question: "Is the government selling any land near me for new condos?"
- Sample: SLA Sale Sites: Tanjong Katong Road commercial site awarded 28/6/2025 to Jun Jie Development (GPR 2.3)
- Caveats: URA layer not sampled; SLA CSV (41 rows) is sparse and mostly historical.

#### URA Development Register Map (planning applications and approvals)

- ID: `d_5fea232c6e60ea4a896e355e3c05141c`
- URA · tier low · GeoJSON via download · updates half-yearly · latest snapshot 2026-09 · last updated 2026-09-30
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Alert the owner to new development applications/approvals near home.
- Example question: "Has anything been approved for development on the land behind my estate?"
- Caveats: 90 MB GeoJSON; half-yearly; needs offline preprocessing.

#### URA Master Plan 2025 Park Connectors, Cycling Network and Parks

- ID: `d_cebde179d5cd6b85be36d618c8fe3b85` (plus 2 related: `d_8fd4e04e7058ee19521d123caf28a855`, `d_3fad8acbb848e6a3aad053cc438815da`)
- URA · tier low · GeoJSON via download · updates ad-hoc · latest MP2025 · last updated 2026-06-04
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Leisure suggestions: park connectors and cycling routes near home.
- Example question: "Is there a park connector near me I can cycle on?"
- Caveats: Planning layers; NParks datasets (other buckets) may be better for park connectors.

#### URA Master Plan 2025 Rail Stations and Lines (incl. planned)

- ID: `d_2c06c9fe8ae724b5d33efa1f203e2c38` (plus 5 related: `d_1c6365f0cad13a77bd79bdbb499131bf`, `d_449ee0cec1f9574f8f34712da6f7456f`, `d_6f5107a8cf6c9a32439cffbfa9013423`, `d_6615da031916f656152eafa013748d73`, `d_1bf289de76ed0b5b32afc0b725625bd7`)
- URA · tier low · GeoJSON via download · updates ad-hoc · latest MP2025 · last updated 2026-01-30
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Identify existing and planned MRT stations near home.
- Example question: "Is a new MRT station planned near me?"
- Caveats: Master Plan cartography, not an operational station list.

### Housing & property: Private property market

#### URA Private Residential Property Price Index (2009-Q1=100), incl. non-landed by region

- ID: `d_97f8a2e995022d311c6c68cfda6d034c` (plus 3 related: `d_f65e490a8ad430f60a9a3d9df2bff2a0`, `d_c0c26484c655113b0ab5abaa0a49952b`, `d_f76411aa34d98559b6194419d796ce59`)
- URA · tier high · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-27 · 618 rows
- Location: region · checked: rows
- Fields: `quarter`, `property_type`, `index`
- Use: Quarterly private-home price trend (all/landed/non-landed, plus non-landed CCR/RCR/OCR) for briefings and condo planning.
- Example question: "How much have condo prices in the Outside Central Region moved this year?"
- Sample: 2026-Q2 All Residential 219.4, Landed 258.4, Non-Landed 210.6; non-landed by locality OCR 271.1, RCR 226.2, CCR 161.5
- Caveats: Market segments (CCR/RCR/OCR) are not the same as North/East/West regions. Older duplicate PPI collection (stale 2024 copy) folded in.

#### URA Private Residential Rental Index (2009-Q1=100) by type and region

- ID: `d_8e4c50283fb7052a391dfb746a05c853`
- URA · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-27 · 520 rows
- Location: region · checked: rows
- Fields: `quarter`, `property_type`, `locality`, `index`
- Use: Quarterly condo/landed rent trend by CCR/RCR/OCR, useful when the owner renews a private lease.
- Example question: "Are condo rents in the Rest of Central Region going up or down?"
- Sample: 2026-Q2 Non-Landed OCR 169.0, RCR 172.3, CCR 152.9
- Caveats: Index only; for project-level rents use URA non-landed rentals.

#### URA Private Residential Transactions (new sale / sub-sale / resale), whole SG and by CCR/RCR/OCR

- ID: `d_7c69c943d5f0d89d6a9a773d2b51f337` (plus 3 related: `d_c287c8be114bfa7d055b27ab2c87de83`, `d_1a7823f3d31e7db4b426833833762bab`, `d_5785799d63a9da091f4e0b456291eeb8`)
- URA · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-27 · 428 rows
- Location: region · checked: rows
- Fields: `quarter`, `type_of_sale`, `sale_status`, `units`
- Use: Report private market activity (units transacted by sale type) each quarter, optionally for the owner's market segment.
- Example question: "How many private homes changed hands last quarter?"
- Sample: 2026-Q2 whole SG: Resale 3813, Sub Sale 194, New Sale (uncompleted) 2125

#### URA Rentals of Non-Landed Residential Buildings (quarterly)

- ID: `d_149ac00a2734bb0a03867bbe2ec0e7b0`
- URA · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-27
- Location: region · checked: rows (first catalogue pass)
- Fields: `qtr`, `project_name`, `postal_district`, `25th_percentile`, `median`, `75th_percentile`, `rental_contracts`
- Use: Quarterly rental benchmarks for private non-landed homes.
- Example question: "What do condos rent for in my area?"
- Caveats: Rows sampled in the first catalogue pass.

#### URA Executive Condominium Units Launched/Sold and Sale Position

- ID: `d_19c79027c2e6be3c39d637151bd2188d` (plus 1 related: `d_8b71bc3e1386261039d7ad95efdc3328`)
- URA · tier low · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-27
- Location: none · checked: metadata
- Fields: `quarter`, `ec_launched_status`, `type_of_sale`, `units`
- Use: Quarterly EC supply and take-up, relevant if the owner considers an EC.
- Example question: "How many EC units were sold last quarter?"

#### URA Private Residential Launches, Sales and Unsold Supply by market segment

- ID: `d_84d05d45049108f0fd2e99b66bd19cfe` (plus 3 related: `d_70824d34defde87d88faccc5d5b1c6ea`, `d_e1c5b0df62729e69c82716355ef295ba`, `d_a283de8cb3b4e80a228bf5f5e0bc4449`)
- URA · tier low · CSV via datastore · updates ad-hoc · latest 2026-Q2 · last updated 2026-07-27 · 960 rows
- Location: region · checked: rows
- Fields: `quarter`, `market_segment`, `completion_status`, `launch_status`, `pre_requisites_status`, `units`
- Use: Answer supply questions (units launched/sold this quarter, unsold inventory) when the owner tracks the condo market.
- Example question: "How many unsold private units are there in the Rest of Central Region?"
- Sample: 2026-Q2 RCR uncompleted launched with pre-requisites 1512 unsold

### Housing & property: set aside

| Group                                                                                                                               | Datasets | Reason                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URA Master Plan historical editions and amendments (MP1998/2003/2008/2014/2019, MP08 mapsheets, MP14 SDCP, unversioned SDCP layers) | 270      | Superseded by Master Plan 2025; cartographic/text/annotation layers with no question a resident would ask.                                                                                                                                                                                                                |
| URA Master Plan 2025 cartographic, text and SDCP urban-design layers not picked                                                     | 41       | Annotation, building, height-control, urban-design and conservation layers for planners; land use, boundaries, rail and park layers were kept as candidates.                                                                                                                                                              |
| URA hexagonal analysis grids                                                                                                        | 9        | Generic analysis grids with no content.                                                                                                                                                                                                                                                                                   |
| URA stale or non-residential market statistics                                                                                      | 16       | Commercial/office indices, 2014-2018 supply pipeline and vacancy tables (stale, last 2024 republish), conservation/vacant sites sold, development charge sectors, conserved-building sites, dwelling-unit counts: not actionable for a resident.                                                                          |
| HDB Sample Household Survey 2018 demographic cross-tabs                                                                             | 45       | One-off survey tables by flat type/ethnic group (population, age, income earners, dependency ratios); static since 2024 and macro-level.                                                                                                                                                                                  |
| HDB annual operational statistics                                                                                                   | 27       | Annual agency aggregates (flats constructed, cumulative completions, bookings, loan/grant counts, SERS sites, home office cases, fixed-rate notes, households billed for upgrading, dwelling units by town): no per-person use beyond trivia.                                                                             |
| JTC industrial land and ready-built facility statistics and layers                                                                  | 14       | Industrial allocation/occupancy stats (stale 2024) and estate/land/kerb GIS layers; no resident use.                                                                                                                                                                                                                      |
| SLA land administration statistics and cadastral/state-land layers                                                                  | 28       | Land/strata lot approvals, document lodgement counts, INLIS/DIPS search volumes, state-land utilisation, cadastral parcels, survey controls, national map lines/polygons, SLA-managed dwellings (1,420 state-owned houses), master tenants, community-use sites and vacant state land: administrative or GIS base layers. |
| BCA building energy data and public-sector consultant panels                                                                        | 4        | Commercial-building energy performance (2019-2020, stale) and government consultant panels: not relevant to a resident.                                                                                                                                                                                                   |
| PEB/BOA administrative lists                                                                                                        | 4        | CPD event calendar, course organisers, licensed engineering corporations, foreign PE register: professional-administration only.                                                                                                                                                                                          |

## Transport & travel

Agencies: LTA, PTC, MPA, CAAS, ICA, STB.

Bucket mixes LTA transport (stations, stops, fares, vehicles, road assets), PTC fares, CAAS/Changi traffic, MPA port stats, STB tourism, Hotels Licensing Board hotels and ICA vital/enforcement stats. The useful core is small: COE, concession-pass and fare tables, MRT exits, bus stops, taxi stands, cycling paths, licensed hotels, attractions, and monthly Changi traffic. Most LTA statistics stopped between 2013 and 2020, all STB statistics end in 2015, and there are no ERP rates, EV chargers, park connectors, road tax or ARF schedules, or ferry terminals in this bucket.

Coverage: 184 datasets, 37 in 21 entries, 147 set aside.

### Transport & travel: Air travel & checkpoints

#### Changi Airport monthly air traffic (passengers, flights, cargo)

- ID: `d_744e62bfb1c524508bce0a64a2488243` (plus 2 related: `d_8d7c6138029eea4d7ffae4f13e3a6458`, `d_3f23c3c7ce5f72eab16ed999e7271f2f`)
- CAAS · tier medium · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-09-25 · 140 rows
- Location: none · checked: rows
- Fields: `Year`, `Month`, `Aircraft_Arrival`, `Aircraft_Departure`, `Aircraft_Total`, `Passenger_Arrival`, `Passenger_Departures`, `Passenger_Transit`, `Passenger_Total`, `AirMail_Incoming`, `AirMail_Outgoing`, `AirMail_Total`, `Cargo_Total_Import`, `Cargo_Total_Export`, `Cargo_Total`
- Use: Tell the owner how busy Changi has been before a trip, and note new city links from CAAS annual KPIs.
- Example question: "How busy was Changi last month?"
- Sample: 2026-08: 5,997,977 passengers, 30,393 aircraft movements, 190,030 t cargo
- Caveats: Numbers stored as strings with thousands separators; ~1 month lag. Related: airline-type split (d_8d7c) and CAAS annual KPIs incl. new airlines/city links (FY2024/25: 67.7m passengers, ~170 cities).

#### Passengers cleared at checkpoints (ICA)

- ID: `d_e78db35440a41c0baff4e5f669532bd9`
- ICA · tier low · CSV via datastore · updates annual · latest 2022 · last updated 2024-06-06 · 19 rows
- Location: none · checked: rows
- Fields: `year`, `arrival_passengers_count`, `depart_passengers_count`
- Use: Historical context on arrivals/departures through all checkpoints.
- Example question: "How many people passed through Singapore checkpoints in 2022?"
- Sample: 2022: 52,344,000 arrivals, 52,536,000 departures
- Caveats: Stale: ends 2022; no per-checkpoint (e.g. Woodlands) split, so no causeway-jam use.

### Transport & travel: Driving & roads

#### Cycling path network

- ID: `d_8f468b25193f64be8a16fa7d8f60f553`
- LTA / Town Councils · tier medium · GeoJSON via download · updates half-yearly · latest snapshot 2026-07 · last updated 2026-07-14
- Location: point (lat/lon) · checked: metadata
- Use: Tell the owner whether there are cycling paths in/near their town and how to link two places by bike path.
- Example question: "Is there a cycling path from my place to the park connector?"
- Caveats: Line geometry with path type and maintaining agency only; no names. ~4.9 MB; needs spatial matching. Park connectors may live in another bucket (NParks).

#### Taxi stands and stops

- ID: `d_fa1896e73ded89dd513788d501d45033`
- LTA · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-07 · last updated 2026-07-07 · 371 rows
- Location: point (lat/lon) · checked: rows
- Use: Find the nearest taxi stand/stop or pick-up point to a place.
- Example question: "Where's the nearest taxi stand to Raffles Place?"
- Sample: 265 TAXI STAND, 80 TAXI STOP, 24 PICK UP / DROP OFF points
- Caveats: No names or addresses; must reverse-geocode or match by distance.

#### Bicycle racks

- ID: `d_937424cca6d1617288a82a7aeb89f76d`
- LTA · tier low · GeoJSON via download · updates annual · latest unknown (published 2024-06 or earlier) · last updated 2024-06-06
- Location: point (lat/lon) · checked: metadata
- Use: Find bicycle parking near a destination or MRT station.
- Example question: "Is there bike parking near Bishan MRT?"
- Caveats: KML-converted Name/Description attributes; undated.

#### Peak-hour road speed & traffic entering the city

- ID: `d_26f6afadf2f86b2004f9a1e28f5564cc` (plus 1 related: `d_3136f317a1f282a33fe7a2f6a907c047`)
- LTA · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-07-10 · 22 rows
- Location: none · checked: rows
- Fields: `year`, `ave_speed_expressway`, `ave_speed_arterial_roads`
- Use: Context for commute talk: average peak speed on expressways/arterials and traffic volume into the city.
- Example question: "Is traffic getting worse in Singapore?"
- Sample: 2025: expressway 55 km/h, arterial 29 km/h (2024: 58/30)
- Caveats: Annual national averages only.

#### School zones and Silver zones

- ID: `d_abf023b38d9bc451484e3d67b562bc5c` (plus 1 related: `d_dc343c021aa470fc71da90d31e552a9a`)
- LTA · tier low · GeoJSON via download · updates ad-hoc · latest unknown (published 2024-06 or earlier) · last updated 2024-06-06
- Location: point (lat/lon) · checked: metadata
- Use: Warn a driver that a route passes through school or Silver Zones (reduced speed).
- Example question: "Are there school zones on my drive to work?"
- Caveats: KML-converted (Name/Description HTML attributes); undated, likely not current.

#### Shopping-mall carpark rates

- ID: `d_9f6056bdb6b1dfba57f063593e4f34ae`
- LTA · tier low · CSV via datastore · updates ad-hoc · latest 2018-11 · last updated 2024-06-06 · 357 rows
- Location: region · checked: rows
- Fields: `carpark`, `category`, `weekdays_rate_1`, `weekdays_rate_2`, `saturday_rate`, `sunday_publicholiday_rate`
- Use: Rough guide to parking charges at a named mall, grouped by region.
- Example question: "How much is parking at Westgate?"
- Sample: Westgate (West): $1.30 1st hr, $0.50 per 15 min; 6pm-11.59pm $2.50/entry
- Caveats: Stale: last updated Nov 2018, rates have changed; useful only as a rough reference with a clear staleness warning.

#### Speed and road cameras

- ID: `d_6e33866de96454529f98b5d99d21a5db` (plus 1 related: `d_147f4906651f5b32925dfe6560296161`)
- LTA · tier low · GeoJSON via download · updates ad-hoc · latest unknown (published 2024-06 or earlier) · last updated 2024-06-06
- Location: point (lat/lon) · checked: metadata
- Use: Mention fixed speed/road camera locations along MCE/KPE or a route.
- Example question: "Are there speed cameras on the KPE?"
- Caveats: Older LTA layers; superseded by the SPF camera layers and pages.

### Transport & travel: Public transport

#### MRT/LRT station exits

- ID: `d_b39d3a0871985372d7e1637193335da5`
- LTA · tier high · GeoJSON via download · updates ad-hoc (refreshed often) · latest snapshot 2026-10 · last updated 2026-10-18 · 613 rows
- Location: point (lat/lon) · checked: rows
- Use: Resolve 'nearest MRT exit' for a named place or postal-code point and tell the owner which exit to use; list stations in their town.
- Example question: "Which exit of Marine Parade MRT should I use?"
- Sample: 613 exits across 188 stations, e.g. MARINE PARADE MRT STATION / Exit 2 at 1.3025,103.9046
- Caveats: No line codes or station codes; station names upper-case with 'MRT STATION' suffix. Small file (213 KB), safe to cache.

#### Monthly concession passes (effective 27 Dec 2025)

- ID: `d_b2d044a38a87a3f04d1802103b27f1bb`
- PTC · tier high · CSV via datastore · updates annual (fare review) · latest effective 2025-12-27 · last updated 2025-12-26 · 8 rows
- Location: none · checked: rows
- Fields: `cardholders`, `bus_price`, `train_price`, `hybrid_price`
- Use: Compare the owner's monthly fare spend against the Monthly Travel Pass price to say whether a pass is worth buying.
- Example question: "Is the monthly travel pass worth it for me?"
- Sample: Adult (Monthly Travel Pass) hybrid $122; Senior hybrid $55; WTCS hybrid $92
- Caveats: Prices in dollars; bus/train-only columns 'na' for some cardholder types; changes once a year after PTC fare review.

#### Bus & train fare tables (express, feeder, trunk, MRT/LRT; effective 27 Dec 2025)

- ID: `d_bf2ed06b8fcda382b0f83133b174e07f` (plus 3 related: `d_5c9bcc72089fb094f654ebf10854feda`, `d_828dcf144fe4f82c85c53d15a19e920f`, `d_2ca29f673b89e0cfddbb7c74516fa4d3`)
- PTC · tier medium · CSV via datastore · updates annual (fare review) · latest effective 2025-12-27 · last updated 2025-12-26 · 39 rows
- Location: none · checked: rows
- Fields: `distance`, `cash_fare_per_ride`, `adult_card_fare_per_ride`, `senior_citizen_card_fare_per_ride`, `student_card_fare_per_ride`, `workfare_transport_concession_card_fare_per_ride`, `persons_with_disabilities_card_fare_per_ride`
- Use: Quote card/cash fares by distance band and fare type (adult, senior, student, WTCS, PwD) for any bus or train trip.
- Example question: "How much is an express bus ride of 25 km on card?"
- Sample: Express >40.2 km: adult card 357c, cash 410c; feeder flat adult card 128c / cash 210c
- Caveats: Distance-banded, needs trip distance from elsewhere. Trunk (d_828d...) and MRT/LRT (d_2ca2...) tables sampled in the first catalogue pass and folded in here.

#### LTA bus stop locations

- ID: `d_3f172c6feb3f4f92a2f47d93eed2908a`
- LTA · tier medium · GeoJSON via download · updates ad-hoc (refreshed often) · latest snapshot 2026-10 · last updated 2026-10-06
- Location: point (lat/lon) · checked: metadata
- Use: Map a bus stop code to coordinates so Chief can find the stops near a place (pairs with already-covered real-time arrival APIs).
- Example question: "What bus stops are near my office?"
- Caveats: Only BUS_STOP_NUM and roof number; no stop names or services served. 1.9 MB file. Real-time arrivals are covered elsewhere.

#### Average daily public transport ridership by mode

- ID: `d_75248cf2fbf340de6a746dc91ec9223c`
- LTA · tier low · CSV via datastore · updates annual · latest 2024 · last updated 2025-07-09 · 90 rows
- Location: none · checked: rows
- Fields: `year`, `mode`, `ridership`
- Use: Give context on how busy buses/MRT/LRT are year on year.
- Example question: "How many people take the MRT each day?"
- Sample: 2024: bus 3,837,000; MRT 3,412,000; LRT 210,000
- Caveats: Annual only, ~1 year lag.

#### Train station & bus stop Chinese names

- ID: `d_d312a5b127e1ae74299b8ae664cedd4e` (plus 1 related: `d_54592963dbd23464b875379a21c2cfe9`)
- LTA · tier low · CSV via datastore · updates ad-hoc · latest 2017-06 · last updated 2024-06-06
- Location: none · checked: metadata
- Fields: `stn_code`, `mrt_station_english`, `mrt_station_chinese`, `mrt_line_english`, `mrt_line_chinese`
- Use: Translate station/stop names into Chinese for a family member or a bilingual briefing.
- Example question: "What is Tampines station called in Chinese?"
- Caveats: Frozen at 2017 (DTL2); misses TEL and later stations. Bus stop list covers tourist-attraction stops only.

### Transport & travel: Tourism & hotels

#### Licensed hotels

- ID: `d_654e22f14e5bb817423f0e0c9ac4f632`
- Hotels Licensing Board · tier medium · GeoJSON via download · updates half-yearly · latest snapshot 2026-03 · last updated 2026-03-08 · 468 rows
- Location: point (lat/lon + postal code) · checked: rows
- Use: Suggest hotels/staycations in a region with room counts and contact email; check whether a hotel is licensed.
- Example question: "What hotels are near Bugis for a staycation?"
- Sample: Hotel Bencoolen, 84 rooms, postal 189626; Hotel Calmo Bugis, 33 rooms
- Caveats: Feature-level timestamps 2022; no star rating or price. Includes keeper names (personal data) - do not surface.

#### Tourist attractions

- ID: `d_0f2f47515425404e6c9d2a040dd87354`
- STB · tier medium · GeoJSON via download · updates ad-hoc · latest content 2015 (republished 2025-12) · last updated 2025-12-02 · 109 rows
- Location: point (lat/lon + address) · checked: rows
- Use: Suggest attractions near a region for weekend plans, with overview text and an address.
- Example question: "What attractions are near Chinatown?"
- Sample: 109 attractions, e.g. National Gallery Singapore, Sultan Mosque, Chinatown Heritage Centre
- Caveats: Content last modified 2015 (opening hours and URLs to yoursingapore.com dated); misses newer attractions. Small (144 KB).

### Transport & travel: Vehicle ownership

#### COE bidding results / premiums

- ID: `d_69b3380ad7e51aff3a7dcc84eba52b8a`
- LTA · tier high · CSV via datastore · updates twice monthly · latest 2026-10 (1st bidding) · last updated 2026-10-07
- Location: none · checked: rows
- Fields: `month`, `bidding_no`, `vehicle_class`, `quota`, `bids_success`, `bids_received`, `premium`
- Use: Report each COE bidding result and trend by category; alert when Cat A/B premium crosses a threshold.
- Example question: "What did Cat A COE close at this round?"
- Caveats: Rows sampled in the first catalogue pass. reused, not re-sampled.

#### Car market by make (new registrations monthly; population & annual registrations by make/fuel)

- ID: `d_d3f4d708e1d0a37b4365414e2fad3a07` (plus 2 related: `d_20d3fc7f08caa581c5586df51a8993c5`, `d_2fcb043ef09016ae757bc396cd8f5027`)
- LTA · tier medium · CSV via datastore · updates monthly / annual · latest 2025-05 (monthly); 2024 (annual) · last updated 2025-07-09 · 51,669 rows
- Location: none · checked: rows
- Fields: `month`, `make`, `importer_type`, `fuel_type`, `vehicle_type`, `number`
- Use: Answer car-buying questions such as how popular a make or EV brand is and EV share trends.
- Example question: "How many BYDs were registered last year?"
- Sample: 2024 car population: XPENG Electric 336, ZEEKR Electric 99; 2024 new regs VOLVO 557
- Caveats: Monthly series stopped at 2025-05 (lastUpdated 2025-07); many null counts in recent rows. Annual files to 2024.

#### Motor vehicle population by type

- ID: `d_2873f3b1b2a836103f51f696350b98fa`
- LTA · tier low · CSV via datastore · updates annual · latest 2024 · last updated 2025-07-08 · 412 rows
- Location: none · checked: rows
- Fields: `year`, `category`, `type`, `number`
- Use: Context on car/motorcycle/bus/goods vehicle numbers.
- Example question: "How many cars are there in Singapore?"
- Sample: 2024 tax-exempted goods & other vehicles 23,848
- Caveats: Annual, ~1 year lag.

### Transport & travel: Vital statistics

#### Births, deaths & causes of death (headline vital statistics)

- ID: `d_16950a6230af2c42bc746a9fb85518dc` (plus 5 related: `d_b1516a82d21dc594ad5a93cc341a234c`, `d_796d4eacf201e5c745ed873e13fdc79d`, `d_f1d48318a55053833d9558cf215ffa39`, `d_e4ce2fa3be49ca007ef72fbcefb997ef`, `d_e2c79c60c046f9a2061328cc3f665688`)
- ICA · tier low · CSV via datastore · updates annual · latest 2024 · last updated 2025-09-05 · 216 rows
- Location: none · checked: rows
- Fields: `year`, `ethnic_group`, `live_births`, `deaths`, `natural_increase`
- Use: Answer general questions about birth/death trends and leading causes of death.
- Example question: "How many babies were born in Singapore last year?"
- Sample: 2024 Malays: 6,896 live births, 3,825 deaths
- Caveats: Annual, ~9 month lag; deaths-by-cause table is SingStat-wide (one row per series, years as columns).

### Transport & travel: set aside

| Group                                      | Datasets | Reason                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MPA port & shipping statistics             | 22       | Container/cargo throughput, bunker sales, vessel arrivals/calls, tanker arrivals, registered tonnage: macro shipping indicators with no personal use.                                                                                                                                                                |
| STB visitor statistics 2013-2015           | 22       | Visitor arrivals, visitor days, receipts, hotel occupancy and visitor survey cross-tabs all end 2013-2015; stale and macro.                                                                                                                                                                                          |
| Real-time LTA APIs                         | 2        | Taxi availability and traffic images are real-time APIs already covered elsewhere.                                                                                                                                                                                                                                   |
| LTA road asset inventory GeoJSON           | 12       | Lamp posts, traffic signs, word/arrow/lane markings, kerb lines, guardrails, retaining walls, signal aspects, bridges/flyovers, overhead gantries (unnamed, no ERP rates) and parking-standards zones: engineering layers, often 10-290 MB, no resident use.                                                         |
| Accident investigation reports             | 2        | Air and marine accident report indexes ending 2019; niche and stale.                                                                                                                                                                                                                                                 |
| ICA enforcement and cargo clearance counts | 10       | Annual counts of illegal immigrants, overstayers, harbourers, marriage-of-convenience cases, contraband, inward containers/consignments and parcels: national enforcement stats, nothing actionable for one person.                                                                                                  |
| ICA detailed birth and death cross-tabs    | 22       | Births/still-births/deaths broken down by ethnicity, mother's age/education/occupation, gestation, birth weight, attendant, place, marital status: demographic cross-tabs; headline series kept as one low candidate.                                                                                                |
| Stale LTA statistics (ending 2013-2020)    | 55       | Vehicle age/CC/VQS/fuel/transfer/de-registration/COE-revalidation/off-peak/taxi-fleet series, inspection pass rates, road and rail length, facility counts, traffic lights, street lighting, MRT station counts, journey stats, premium and wheelchair bus lists, car plate prefixes: last data 2013-2020 and macro. |

## Money, work & energy

Agencies: MOM, CPF, IRAS, MAS, EMA, ACRA, SkillsFuture.

Mostly MOM labour-market statistics (244), plus CPF, IRAS, ACRA, EMA, EDB, IPOS, PSD, MAS, MOF and SkillsFuture. The most valuable for job-search questions are fresh quarterly MOM series (vacancies, vacancy/unemployed ratio, retrenchments, turnover, re-employment, all to 2026-Q2), occupational wage percentiles by industry, bonus/leave/flexible-work norms, CPF rates/ceilings/FRS, and the MySkillsFuture course directory; ACRA lookup helps vet employers. Notably absent: SGS/T-bill/SSB yields, retail electricity (OEM) plans, income-tax rate tables and GST rates - none are in this bucket.

Coverage: 464 datasets, 264 in 36 entries, 200 set aside.

### Money, work & energy: CPF & retirement

#### CPF Full Retirement Sum by cohort year

- ID: `d_b212dff55c98a4c0b3d3d850bf744ad7`
- CPFB · tier high · CSV via datastore · updates annual · latest 2027 · last updated 2026-03-30 · 24 rows
- Location: none · checked: rows
- Fields: `effective_from`, `full_retirement_sum`
- Use: Answer retirement-planning questions and project the FRS for the owner's cohort.
- Example question: "What is the Full Retirement Sum for people turning 55 next year?"
- Sample: 2027: $228,200; 2026: $220,400; 2025: $213,000
- Caveats: Date format d/m/yyyy; BRS/ERS derivable (half / double FRS under current rules).

#### CPF contribution rates, allocation rates by account and age, and ordinary wage ceiling

- ID: `d_97ec9a2ce15cbf253128e48779a3fba0` (plus 2 related: `d_98ffa142ae0dec40391f78f81d26aca9`, `d_fcf9b47a2df0c9183875bbfb1c370077`)
- CPFB · tier high · CSV via datastore · updates ad-hoc (yearly changes) · latest 2026-01 · last updated 2026-03-26 · 183 rows
- Location: none · checked: rows
- Fields: `effective_from`, `age_grp`, `account_type`, `allocation_rate`
- Use: Compute take-home pay and employer/employee CPF split for a job offer, and how contributions split across OA/SA(RA)/MA by age.
- Example question: "If I'm offered $9,000 a month, how much goes to CPF and what's my take-home?"
- Sample: OW ceiling $8,000 from 2026-01 ($7,400 in 2025); allocation >70: Medisave 0.84, OA 0.08, RA 0.08
- Caveats: Contribution rates d_98ff... sampled in the first catalogue pass; allocation file covers 2014+, OW ceiling back to 1955.

#### Active CPF members by balance band and age group

- ID: `d_b73faed7a7024d18240eeb8b76e8709a` (plus 5 related: `d_bd4f3a1992ac4d7033f6d6db4692b2cf`, `d_d1ab7860f25218a0954cce4df0f7c2df`, `d_2e7d2eef487f6d0d5bfa1df2d41bcae0`, `d_7d81c300994c0a254cda04e4a9be8fa0`, `d_6d7b9a8c80526f08a49b585f0e2c92e8`)
- CPFB · tier medium · CSV via datastore · updates annual · latest 2025 · last updated 2026-03-26 · 1,854 rows
- Location: none · checked: rows
- Fields: `yr`, `regrossed_bal_grp`, `age_grp`, `no_of_active_mbrs`
- Use: Tell the owner roughly where their CPF balance ranks among members of the same age band.
- Example question: "How does my CPF balance compare with others my age?"
- Sample: 2025: 7,990 members aged >70-75 hold $500k+
- Caveats: Regrossed balances (incl. amounts withdrawn for housing); pre-2019 files (d_6d7b..., d_2e7d..., d_7d81...) are older series.

#### CPF Service Centres (locations)

- ID: `d_fa1eb7f19d247f7fe660ac446a6ce6ec`
- CPFB · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-07 · last updated 2026-07-12
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Point the owner to the nearest CPF service centre with address when an in-person visit is needed.
- Example question: "Where is the nearest CPF service centre to Tampines?"
- Caveats: Tiny GeoJSON (~2.6 KB, a handful of centres); download only.

#### CPF employer default indicator (monthly % of employers defaulting on contributions)

- ID: `d_7cb32d8cbfb5d7c459763933dd62d723`
- CPFB · tier low · CSV via datastore · updates monthly (published quarterly) · latest 2026-03 · last updated 2026-09-30 · 147 rows
- Location: none · checked: rows
- Fields: `month`, `default_rate`
- Use: Macro context only; reminds the owner to check that employer CPF is credited each month.
- Example question: "Are many employers late paying CPF?"
- Sample: 2026-03: 0.99%; 2026-02: 1.06%; 2026-01: 1.25%
- Caveats: Aggregate only; cannot check a specific employer.

### Money, work & energy: Calendar

#### Singapore public holidays (consolidated, plus per-year files 2020-2027) — **Selected**

- ID: `d_8ef23381f9417e4d4254ee8b4dcdb176` (plus 8 related: `d_0b0fe4a7101674be0a359e55d32cd126`, `d_0ba69fc6d56717ff0bf8083c6af3bb84`, `d_149b61ad0a22f61c09dc80f2df5bbec8`, `d_1840fb46caa92cb59e4f168e70a36bf1`, `d_3751791452397f1b1c80c451447e40b7`, `d_4e19214c3a5288eab7a27235f43da4fa`, `d_b773a1ad8dafa6ef27f4f2bf6a7c4a64`, `d_d4d621596397d8f2627cc06c3b6d020a`)
- MOM · tier high · CSV via datastore · updates annual · latest 2027 · last updated 2026-07-03
- Location: none · checked: rows (first catalogue pass)
- Fields: `date`, `day`, `holiday`
- Use: Calendar awareness for briefings, reminders and leave planning.
- Example question: "When is the next public holiday, and is there a long weekend?"
- Caveats: Rows sampled in the first catalogue pass. per-year files are redundant with the consolidated one.

### Money, work & energy: Employer lookup

#### ACRA registered entities: UEN, name, status, type, registration date and address

- ID: `d_3f960c10fed6145404ca7b821f263b87` (plus 28 related: `d_b1d2b840ab9e993570c037b706b39bb8`, `d_0cc5f52a1f298b916f317800251057f3`, `d_124a9bd407c7a25f8335b93b86e50fdd`, `d_181005ca270b45408b4cdfc954980ca2`, `d_1cd970d8351b42be4a308d628a6dd9d3`, `d_2b8c54b2a490d2fa36b925289e5d9572`, `d_300ddc8da4e8f7bdc1bfc62d0d99e2e7`, `d_31af23fdb79119ed185c256f03cb5773`, `d_3a3807c023c61ddfba947dc069eb53f2`, `d_4130f1d9d365d9f1633536e959f62bb7`, `d_4526d47d6714d3b052eed4a30b8b1ed6`, `d_478f45a9c541cbe679ca55d1cd2b970b`, `d_4e3db8955fdcda6f9944097bef3d2724`, `d_5573b0db0575db32190a2ad27919a7aa`, `d_5c4ef48b025fdfbc80056401f06e3df9`, `d_67e99e6eabc4aad9b5d48663b579746a`, `d_72f37e5c5d192951ddc5513c2b134482`, `d_85518d970b8178975850457f60f1e738`, `d_8575e84912df3c28995b8e6e0e05205a`, `d_9af9317c646a1c881bb5591c91817cc6`, `d_a2141adf93ec2a3c2ec2837b78d6d46e`, `d_acbc938ec77af18f94cecc4a7c9ec720`, `d_af2042c77ffaf0db5d75561ce9ef5688`, `d_b58303c68e9cf0d2ae93b73ffdbfbfa1`, `d_c0650f23e94c42e7a20921f4c5b75c24`, `d_df7d2d661c0c11a7c367c9ee4bf896c1`, `d_e97e8e7fc55b85a38babf66b0fa46b73`, `d_fa2ed456cf2b8597bb7e064b08fc3c7c`)
- ACRA · tier medium · CSV via datastore · updates monthly · latest snapshot 2026-10-14 · last updated 2026-10-14 · 2,127,089 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `uen`, `issuance_agency_desc`, `uen_status_desc`, `entity_name`, `entity_type_desc`, `uen_issue_date`, `reg_street_name`, `reg_postal_code`
- Use: Verify a recruiter's or prospective employer's company: is it live, when registered, what entity type and registered postal code (scam check).
- Example question: "Is "XYZ Pte Ltd" a real, live company and how old is it?"
- Sample: UEN 200503172K WSL PTE. LTD., Local Company, Deregistered, issued 2005-03-10
- Caveats: Very large (2.1M rows; ~234 MB) - query via datastore filters/q on entity_name only, never download. Per-letter "Information on Corporate Entities" files add SSIC/company type detail.

#### Government procurement awards via GeBIZ (tender, agency, supplier, amount)

- ID: `d_acde1106003906a75c3fa052592f2fcb`
- MOF · tier low · CSV via datastore · updates annual · latest FY2025 (to 2026-03) · last updated 2026-04-26 · 18,464 rows
- Location: none · checked: rows
- Fields: `tender_no`, `tender_description`, `agency`, `award_date`, `tender_detail_status`, `supplier_name`, `awarded_amt`
- Use: When vetting a prospective employer, check whether and how much it wins in government contracts.
- Example question: "Has this company won any government tenders recently?"
- Sample: 2025-06-16 Yellow Ribbon SG training tender awarded to SIM Group ($1,360) among others
- Caveats: ~4.4 MB; supplier_name free text; datastore q= search works.

### Money, work & energy: Energy use

#### Electricity grid emission factors

- ID: `d_3de362b580b2dd2fd50cc1006d4edd4f`
- EMA · tier low · CSV via datastore · updates annual · latest 2020 · last updated 2024-06-06
- Location: none · checked: metadata
- Fields: `year`, `avg_opt_margin_kgco2-per-kwh`, `build_margin_kgco2-per-kwh`, `upstream_fugitive_methane_emission_factor_kgch4-per-kwh`
- Use: Convert the owner's monthly kWh into an approximate carbon footprint.
- Example question: "What's the carbon footprint of my electricity use?"
- Caveats: Ends 2020; factor changes slowly.

#### Household electricity and town-gas consumption by dwelling type / planning area

- ID: `d_4e647ed2a40f33b8c968b19f405289cc` (plus 11 related: `d_e8fb7c462d24dac06375c552a776988c`, `d_634194a40f36e5bc11a942ab0164fa9d`, `d_37d0383e7b6df800e353b424214e531f`, `d_47db177174ba5899aa9cee08797d9171`, `d_59e8149ed5e250b85f0a2e8a0eb0a999`, `d_64530b45dd5c5dd6d7950e84874da8be`, `d_c9395d6106de082d220fb6a8ff6b423b`, `d_e9dd87933f70bf2e8e977773a9c33fd0`, `d_e9fa58fcb4b3df98dde245591b17e254`, `d_f68e309cf17d4b562ab6cefc1b9cf998`, `d_f7059fd0402a0af5963c4d11bbaf413d`)
- EMA · tier low · CSV via datastore · updates monthly / annual · latest 2021-06 (gas); 2009-2013 (electricity by planning area) · last updated 2024-06-06
- Location: town/planning-area · checked: metadata
- Fields: `year`, `mth`, `housing_type`, `dwelling_type`, `avg_mthly_hh_tg_consp_kwh`
- Use: Rough benchmark for whether the owner's utility usage is high for their dwelling type.
- Example question: "Is 400 kWh a month high for a 4-room flat?"
- Caveats: Stale: gas to Jun 2021, planning-area electricity GeoJSONs only 2009-2013. Newer EMA/SingStat data may exist elsewhere.

### Money, work & energy: Job market

#### Job vacancies by occupation / industry (quarterly, with annual series)

- ID: `d_86dffa3d28e4c3ee085c3f99abad6e9f` (plus 7 related: `d_59a34aef12e0ecf666de5746e50586e8`, `d_3f17bbf67d31d4d402caa8755eb74afc`, `d_d3f02543c4d0dd197c56637eefc32624`, `d_89c02a8fe06893fa97b47a6bdf3626be`, `d_01966fdb498fa7fa2863635e25539693`, `d_77a848ab5508fa38c5bbf72a956b3cf5`, `d_889d11a2b0a53b235abb64e3f4e0a47b`)
- MOM · tier high · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-09-22 · 450 rows
- Location: none · checked: rows
- Fields: `quarter`, `occupation`, `job_vacancy`
- Use: Track how many openings exist for the owner's occupation group and target industries each quarter and flag a rising or shrinking market in the job-search brief.
- Example question: "Are PMET job vacancies going up or down this quarter?"
- Sample: 2026-Q2: PMET vacancies 22,800; non-PMET 47,100; production/transport/cleaners 17,800
- Caveats: Broad occupation groups only (PMET / clerical-sales-service / production etc.); industry x occupation version (d_d3f0...) is ~1.7 MB. Values are text-typed. Published ~3 months after quarter end.

#### Job vacancy to unemployed person ratio

- ID: `d_80c0cf251ee9a26d240808297f52c820` (plus 1 related: `d_ab4c160672a92120c3bc801325fa55f2`)
- MOM · tier high · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-09-22 · 114 rows
- Location: none · checked: rows
- Fields: `quarter`, `jv_to_ue`
- Use: One-number labour-market tightness indicator for the weekly job-search brief (above 1 = more openings than jobseekers).
- Example question: "Is the job market tight or loose at the moment?"
- Sample: 2026-Q2: 1.48; 2026-Q1: 1.46; 2025-Q4: 1.58
- Caveats: Economy-wide only, seasonally adjusted.

#### Retrenchments by industry / occupation (quarterly counts; annual incidence rates)

- ID: `d_000d49cda016c13522d7d5be6a050f59` (plus 24 related: `d_61d92d31ca400be135190614277da825`, `d_a6246f522f3ea0cf265e3ef3ad59fe8e`, `d_cdde7c4701d917ae58aa63e4015490aa`, `d_493616c9e3c9bd5d1e273903aa693a16`, `d_5dd6b3b64be667ecb0077e624f21fa11`, `d_554647914a6f42266cd45c29250d8d85`, `d_7a7d656c3a358c429f2bd4c3e9a97809`, `d_21b59ce2a62b1638cffc98e2ec5f6b45`, `d_c693cf178591afd5b40701e0195e76dd`, `d_6338fec229179b809cb970b9af302393`, `d_661bf51b24d91dff23c053fc461c0923`, `d_49ab680655c6d48a221004630a37edd6`, `d_6d1fcbd205b908c27c174db08432346a`, `d_fef840cf56350e64d99b4838ea6000e7`, `d_4366ebbfe59535b007919264a1deb35e`, `d_2a12e772b35189cb2064590371f509d7`, `d_e0a113bbe9b2cff9414d3781bb8c8d9b`, `d_ae03ee7ce7397ce63481c6802bfe3431`, `d_9d1df046f28dd9899ba0ca13899c03db`, `d_5c9068e2c0331bb2aadea9eeac579ae8`, `d_8ee93a4e261908fafe878ea0bec29817`, `d_fdd935df6e82f5e327c3783032e84a24`, `d_4a089fa8530d79b33766f85e48a68af5`, `d_cc9216784a9de451166a236e9f575c45`)
- MOM · tier high · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-09-22 · 114 rows
- Location: none · checked: rows
- Fields: `quarter`, `retrench`
- Use: Alert when retrenchments in the owner's industry jump, and give layoff context for target employers' sectors.
- Example question: "How many people were retrenched last quarter, and is finance worse than before?"
- Sample: Total retrenched: 2026-Q2 4,620; 2026-Q1 3,830; 2025-Q4 3,690
- Caveats: Quarterly counts are broad industry/occupation; incidence-of-retrenchment rates (per 1,000 employees) are annual only (latest 2025).

#### Job vacancy rate by industry and occupation (quarterly, with annual series)

- ID: `d_74803e94c5299493f76d71c8994c50c1` (plus 7 related: `d_c57f5cd0558e429e2ac055d83030e75f`, `d_fe705c7af162331d36cc31193f8f50c9`, `d_1e10046c33418c507bb2483c26dca489`, `d_fb4853f65d48be0a6ee7fb762b1b5251`, `d_c53ea3b4afe234c08853b7fca12e804e`, `d_219448c6a9d45fa2537918335e614003`, `d_ddcb2546c798f94ba6b4a6508ab42632`)
- MOM · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-09-22
- Location: none · checked: metadata
- Fields: `quarter`, `industry`, `occupation`, `job_vacancy_rate`
- Use: Show the vacancy rate (vacancies per 100 jobs) for a target industry to judge how hard employers are hiring there.
- Example question: "Which industries have the highest job vacancy rate right now?"
- Caveats: Industry x occupation file is large (~1.7 MB); use the by-industry (d_fe70...) or by-occupation (d_1e10...) files for quick answers.

#### Labour turnover: monthly resignation and recruitment rates by industry / occupation

- ID: `d_167005620b4d1422d32660db9960191b` (plus 15 related: `d_30dfba375648a2d5a1c1099cb9cb8182`, `d_e58adb04ca812651cfecfa82acdf6c35`, `d_e7923b1ac9574659bdd50ad40f16526a`, `d_52274147829dc246d2256770b58a7334`, `d_7337e757c744956ac8b6aae6c5207830`, `d_83f04fc0e00cb029000aa3bf8c5d0478`, `d_ad3831aac52b302dd474fa92c7acc808`, `d_c60fe8fad219569c04428f35b07359f3`, `d_c5e8a6caedd74f7512a4d29c67da1f1c`, `d_785903005a276ca9efdeab97707cdbbf`, `d_80247eca3da78635ed9e89aa5831e883`, `d_62a65198292501453c50e06b764741bd`, `d_505835a6bca594ee8ba8a7e72a646f2f`, `d_aa6f816455e5d362066b5fd82969267e`, `d_df2976561f50447ff200a3230b2b0396`)
- MOM · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-09-22 · 4,700 rows
- Location: none · checked: rows
- Fields: `quarter`, `industry`, `resignation_rate`
- Use: Show whether people in a target industry are job-hopping (high resignation) and how actively firms recruit, to time a job move.
- Example question: "Are people in finance quitting more than usual this year?"
- Sample: 2026-Q2 resignation rate: arts/entertainment 0.9%, other community services 1.3%
- Caveats: Rates are average monthly % of employees; industry list is fine-grained (~40 industries).

#### Re-entry into employment after retrenchment (6 and 12 months; by age, education, occupation, sex)

- ID: `d_4d3ce3e889fdf1da6bd6e9d52667db91` (plus 19 related: `d_614b0fa2aa808afced2982c37e846d13`, `d_179a9eed04c5469fdc60a10ff31c93b4`, `d_64c370509ae938f31ebb2c7447bc10d6`, `d_01da358b8cc82e4efda2cfc1d18def01`, `d_06382194ad794a81e6d2591ce65a042a`, `d_0ccc3980b234e9d3033142e652337302`, `d_200d7acaa64088c60476de87274674cf`, `d_278500adbc490bc50b4204d9a9bb89c8`, `d_3f4006f4e0797e4cd255dfdde3125825`, `d_40ae5249bf902bf48c98c200112261f3`, `d_4fa5204237e205316b2be6888ebd5990`, `d_5b3e5df23ff572d2a545229cebc7b151`, `d_60e1cf17f90198d9d8ea312b8695ec31`, `d_60fd51fb26dacb810fc21b97d5a1ab6c`, `d_6fa43c0feeb832bf9ffd7257712da9e8`, `d_9548bb2124143f77b76c51ee8c895b69`, `d_9eb28868881672123e0c66acee258b66`, `d_b6e72fbf1049e8a8a1fbd5ab7446c51a`, `d_e91adc199c3c15b7388054ee9e2a52fb`)
- MOM · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-10-06 · 106 rows
- Location: none · checked: rows
- Fields: `quarter`, `reentry_rate_6mth`
- Use: Give realistic odds and timelines for finding work after a layoff, broken down by age band or occupation group.
- Example question: "What share of retrenched PMETs find a new job within six months?"
- Sample: 6-month re-entry rate: 2026-Q2 54.9%; 2026-Q1 60.7%
- Caveats: Quarterly figures refer to retrenchment cohort quarter; small subgroups can swing.

#### Unemployment rate and number unemployed (overall / resident / citizen; long-term; median duration)

- ID: `d_ca32584c91ee07d091a4ce75fa868414` (plus 14 related: `d_d1d755e060dd6b01a8024ba60b21b831`, `d_1353f9be1a020ba1469852c49ee62db3`, `d_80effd26c9ca5755a7ff0598fe2e0be6`, `d_b0fb18418204a0a11930ce44edc34775`, `d_dab839a10e83a6a8746e1836f3dd5629`, `d_3fb7b082cd455ec9493ef5e994ef0db7`, `d_50f76f080c7e80c3b6acd4dfc9f29174`, `d_8a02327def3434883960d1dce5567ab5`, `d_ec79cebfc6e2605327bd2a1e80cc17d4`, `d_d809f48f8a66a6e58f238bd82f585154`, `d_06892cb06e24815d193ff66edf4993ab`, `d_8872e15c61a2ee8dde0e5f7e6f48d718`, `d_edc7e225d4e7c8f3532e6c329ba2bf79`, `d_b62ae2e0fb4d8a0a01a2468bd0090f1b`)
- MOM · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-09-29
- Location: none · checked: rows (first catalogue pass)
- Fields: `period`, `residential_status`, `seasonally_adj_unemp_rate`, `non_seasonally_adj_unemp_rate`
- Use: Headline unemployment context for the job-search brief, plus how long unemployment typically lasts.
- Example question: "What is Singapore's unemployment rate now, and how long do people usually stay unemployed?"
- Caveats: Overall quarterly rate sampled in the first catalogue pass (d_ca32...); median duration and long-term unemployment are annual (latest 2025).

#### Employees on short work-week or temporary layoff

- ID: `d_31d4c1a2de1f880c005dad945ff44d5d` (plus 5 related: `d_2398b9988baf18a9e2108b246004f5ff`, `d_46b49c3bf00d87eaa24441f339387467`, `d_6e31884107e528965607fed92094384c`, `d_9caf05b082bee1705dda69dbc7266203`, `d_dcb22214ebbbd1f3dc82c78520541006`)
- MOM · tier low · CSV via datastore · updates quarterly · latest listing: updated 2026-03 · last updated 2026-03-23
- Location: none · checked: listing-only
- Use: Early-warning distress signal for an industry (firms cutting hours before retrenching).
- Example question: "Are companies putting staff on short work-weeks again?"
- Caveats: Quarterly files last updated 2026-03-23 (not refreshed with the Sep 2026 release), so may lag.

#### Foreign workforce stock by work pass type (EP, S Pass, WP)

- ID: `d_ca90ebca85472a1bf8fb01362b7233fa` (plus 4 related: `d_5105c8c24199312306d1dd38bbc560a8`, `d_4fb775d3cc311989261fae4ad22dde09`, `d_ce0511e418694cd265a3a6fc8c266782`, `d_f757d4b9db7c8977def084f0a51a46b5`)
- MOM · tier low · CSV via datastore · updates annual · latest 2022-12 · last updated 2024-06-06
- Location: none · checked: metadata
- Fields: `month`, `work_pass_type`, `count`
- Use: Background on work-pass numbers (Employment Pass vs S Pass) when discussing competition for roles.
- Example question: "How many Employment Pass holders are there?"
- Caveats: Stale: series ends Dec 2022 on data.gov.sg (MOM publishes newer figures on its website).

### Money, work & energy: Money services

#### Licensed money changers and remittance agents (locations)

- ID: `d_f2dc6f340fcf53007e18dad9df92d229` (plus 1 related: `d_b47c770f3ff44972bc73ea717e8fa87d`)
- MAS · tier medium · GeoJSON via download · updates quarterly · latest snapshot 2026-10 · last updated 2026-10-03
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find a licensed money changer or remittance shop near the owner's area before a trip or transfer, and check a shop is MAS-licensed.
- Example question: "Where is a licensed money changer near Jurong East?"
- Caveats: GeoJSON download (~130 KB each); licensee list, no rates.

### Money, work & energy: Public finance

#### Government expenditure by ministry/sector, operating revenue and fiscal position (Budget)

- ID: `d_00f95040967791729d51bd7cd6af2355` (plus 5 related: `d_6a804a6860b5c51af08df679a71bc190`, `d_0f0800a6b2b4b391daffcd88b2cc97fd`, `d_d6cd701a67607ac9d4f3d469d8c815e5`, `d_503841b8a2c76e8900f8d6395de43873`, `d_2ceefcf18f04feba153b9768652be854`)
- MOF · tier low · CSV via datastore · updates annual · latest FY2026 (estimated) · last updated 2026-04-26
- Location: none · checked: metadata
- Fields: `financial_year`, `actual_revised_estimated`, `sector`, `ministry`, `type`, `amount_in_millions`, `percent_of_gdp`
- Use: Answer Budget-season questions about how much the government spends on health, education, defence, etc.
- Example question: "How much is the government budgeting for healthcare this year?"
- Caveats: Actual / revised / estimated rows mixed; filter on actual_revised_estimated.

### Money, work & energy: Skills & training

#### MySkillsFuture course directory and course runs

- ID: `d_b5802b76f409764c16dde4bf2feb19cd` (plus 1 related: `d_60e4423c61d7bbe3c4cf07552197987b`)
- SSG/SWDA · tier high · XLSX via download · updates ad-hoc (refreshed) · latest snapshot 2026-09 · last updated 2026-09-29
- Location: none · checked: metadata
- Use: Suggest SkillsFuture-claimable courses (fees, provider, upcoming run dates) that close skill gaps for the owner's target roles.
- Example question: "Find a SkillsFuture-eligible data analytics course starting next month."
- Caveats: XLSX download only (directory ~13.6 MB, runs ~2.5 MB) - must be cached and indexed off-line, not queried live. Columns not exposed in metadata.

#### Continuing Education and Training (CET) centres and private education institutions (locations)

- ID: `d_890a14eaf2644db6956f41b2b1bfc494` (plus 1 related: `d_563451336616abdf5b2c36472c2afd8b`)
- SSG/SWDA · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2024-06 or older · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Locate training centres near the owner's region when choosing an in-person course.
- Example question: "Which training centres are near me in the East?"
- Caveats: Not updated since 2024-06; may be stale.

### Money, work & energy: Tax & property tax

#### Median annual value and property tax by HDB flat type / private property type

- ID: `d_48143be392f1ed22f0700835212e5a60` (plus 2 related: `d_774a81df45dca33112e59207e6dae1af`, `d_e96a2e27e7d3c35bb167068844ca0210`)
- IRAS · tier medium · CSV via datastore · updates annual · latest FY2025 · last updated 2026-09-04 · 80 rows
- Location: none · checked: rows
- Fields: `financial_year`, `type_of_hdb`, `no_of_cases`, `median_annual_value`, `property_tax_collection`
- Use: Sanity-check the owner's property-tax bill against the median annual value for their flat or condo type.
- Example question: "Is my property tax bill normal for a 4-room HDB?"
- Sample: FY2025 median annual value: 4-room $17,280; 5-room $18,240; Executive $18,900
- Caveats: National medians by type, not by town; property tax collection is in $ thousands.

#### Personal income tax reliefs and tax set-offs claimed, by type

- ID: `d_b08cff1811e8716643614c772f48ba7f` (plus 2 related: `d_dbd0c510ff4bb473d7f4a3843f391a65`, `d_1ff7566f5c1ffa0e27f799b16a5ad1d9`)
- IRAS · tier low · CSV via datastore · updates annual · latest YA2025 · last updated 2026-09-02 · 287 rows
- Location: none · checked: rows
- Fields: `year_of_assessment`, `type_of_relief`, `no_of_claimants`, `amount`
- Use: Remind the owner of reliefs others commonly claim (SRS, course fees, NSman, parent relief) before tax filing season.
- Example question: "Which tax reliefs do most people claim?"
- Sample: YA2025: SRS relief 184,423 claimants ($2.43bn); course fees 42,438; NSman 849,895
- Caveats: Aggregate claim counts and $ thousands; does NOT contain relief caps or tax rate tables.

#### Taxable individuals by income band (count, income and tax assessed)

- ID: `d_81675d7bbd87f3ffe8ad3b8db67399e5` (plus 5 related: `d_f394f202534237671d39b17bd3b506ec`, `d_0fb1c8d8f8e4f7733e0486837e54a0c7`, `d_855ec3e21bba9532ca390ad8c91d422b`, `d_96c222428732ed780a2d649c0d8105f9`, `d_9be6a977c945666271657d5699cfe149`)
- IRAS · tier low · CSV via datastore · updates annual · latest YA2025 · last updated 2026-09-02 · 480 rows
- Location: none · checked: rows
- Fields: `year_of_assessment`, `chargeable_income_group`, `resident_type`, `number_of_taxpayers`, `assessable_income`, `chargeable_income`, `net_tax_assessed`
- Use: Show which income band the owner is in and the average effective tax in that band.
- Example question: "What share of taxpayers earn more than me?"
- Sample: YA2025 non-residents with chargeable income $1m+: 47 taxpayers
- Caveats: Amounts in $ thousands; split by tax-resident status.

### Money, work & energy: Wages & benefits

#### Occupational wages by detailed occupation and industry (25th/50th/75th percentile, basic and gross)

- ID: `d_523d376ff1d501a338add925f3313fd1` (plus 2 related: `d_9917e751f7498502f70052a940a3f312`, `d_670c3c6cecbcd24e48034a3428bd306e`)
- MOM · tier high · CSV via datastore · updates annual · latest 2024-06 · last updated 2026-04-01 · 1,816 rows
- Location: none · checked: rows
- Fields: `year`, `occ_desc`, `ind`, `mthly_gross_wage_75_pctile`, `mthly_gross_wage_50_pctile`, `mthly_gross_wage_25_pctile`, `mthly_basic_wage_75_pctile`, `mthly_basic_wage_50_pctile`, `mthly_basic_wage_25_pctile`
- Use: Benchmark a job offer: look up percentile pay for a specific occupation within a specific industry during salary negotiation.
- Example question: "What does a wholesale trade manager earn in financial services vs retail?"
- Sample: 2024, wholesale trade manager: financial & insurance svcs median gross $16,071 (P25 $10,560, P75 $20,750); wholesale & retail $7,892
- Caveats: Reference month June 2024 despite 2026 update; overall occupational wages d_9917... sampled in the first catalogue pass. Occupation names are lower-case free text; fuzzy matching needed.

#### Annual leave entitlement distribution and non-statutory leave offered (by industry)

- ID: `d_0a67600d60f14236883b42c30ddc75e9` (plus 8 related: `d_6dd79ec2994f118e796c2acd15d3c90f`, `d_71ed718d27efb12056aa89b8f5733288`, `d_a143c95a601858374c0df6ac55462454`, `d_a736c8d230539bce067678bc9efa56e4`, `d_e7ee6593128c030a6e973fa48a41cfc1`, `d_59bcd9577080519375c4301f29bf06ef`, `d_b13441781ec6c04670e2bbe14b4ac739`, `d_bba55e58f9480f71de247f770bc48c60`)
- MOM · tier medium · CSV via datastore · updates annual · latest 2024 · last updated 2026-06-30 · 27 rows
- Location: none · checked: rows
- Fields: `year`, `annual_leave_entitlement`, `distribution`
- Use: Tell the owner whether an offer's leave days and leave types (study, marriage, family-care) are typical for the industry.
- Example question: "Is 18 days of annual leave normal for a full-time employee?"
- Sample: 2024: 55% of full-time employees get 14 days or fewer; 33.3% 15-21; 11.8% over 21
- Caveats: Conditions of Employment survey; latest 2024.

#### Bonus quantum paid and wage changes (total and basic) by industry

- ID: `d_f17b3b342f946d21cf3dc53caeaf9f7e` (plus 2 related: `d_e5848828d6a14d35a8b7eea7e15a149e`, `d_bd83b4534db1032ca7415f82bbaae003`)
- MOM · tier medium · CSV via datastore · updates annual · latest 2024 · last updated 2026-03-23 · 312 rows
- Location: none · checked: rows
- Fields: `year`, `ind1`, `ind2`, `avc`
- Use: Give typical bonus months and annual raise percentages by industry when evaluating an offer or appraisal.
- Example question: "How many months of bonus do professional services firms usually pay?"
- Sample: 2024 bonus (months of wage): professional services 1.65; admin & support 1.2; community/social/personal 2
- Caveats: Latest year 2024 (one year behind); industry level only.

#### Flexible work arrangements offered by establishments (telework, flexi-hours, part-time) by industry

- ID: `d_a55191aab3300a030b22866b6051410a` (plus 11 related: `d_b4bd13c259b1c5599a324e8dfaefae29`, `d_a59974c6f638e667bf66fd357068e286`, `d_43079cc099f6ac0315db856e570103ce`, `d_ed5664ea4e9d03c7d82810f45c555258`, `d_b07223bace786cbec31ab2f9dc3c9003`, `d_a3e4a9a986e2d5a3713aaec1bfa3648c`, `d_f63f7c88b854a6749493994daa3a484d`, `d_b33484e5a80c6053fa07fb767d5e8510`, `d_28b00faef00a758980fb9768c75df59b`, `d_b2886ac9033f5480337e5797667d95be`, `d_2bb9f23e0403158ce5b768dd4ef3c9ab`)
- MOM · tier medium · CSV via datastore · updates annual · latest 2025 · last updated 2026-06-30 · 72 rows
- Location: none · checked: rows
- Fields: `year`, `industry1`, `at_least_one`, `parttime_work`, `flexihours`, `staggered_time`, `teleworking`, `homeworking`, `job_sharing`, `compressed_work_schedule`
- Use: Show how common remote work and flexi-hours are in a target industry, to calibrate expectations in negotiations.
- Example question: "How many companies in services offer work from home?"
- Sample: 2025 services: 70.3% offer at least one scheduled FWA; teleworking 37.3%; flexi-hours 35.7%
- Caveats: Proportion of establishments, not employees.

#### Median gross monthly income from work of full-time employed residents (total, by sex, by age)

- ID: `d_bdf68cd8cc16da40c273f865d939fecb` (plus 2 related: `d_9cd9c40f22a4e45cac8f8b9d895fd5ce`, `d_aa75b9227b47cbc12ffe0e3be4979546`)
- MOM · tier medium · CSV via datastore · updates annual · latest 2025 · last updated 2026-03-27 · 320 rows
- Location: none · checked: rows
- Fields: `year`, `sex`, `age`, `median_income_incl_emp_cpf`, `median_income_excl_emp_cpf`
- Use: Compare the owner's income with peers of the same age and sex, with and without employer CPF.
- Example question: "What's the median salary for someone in their early 30s?"
- Sample: 2025 female 50-54: $6,084 incl. employer CPF ($5,280 excl.)
- Caveats: Labour Force Survey (June reference month); age bands of 5 years.

#### Occupational wages by age band, establishment size and sex

- ID: `d_aa407dcd74f04648058a1fa8a57286a8` (plus 3 related: `d_db0e6e9b54364552dd9d2fc6a28f14f0`, `d_7d528712f1fd454ac6ca32fe06fe8f12`, `d_d1e7ac04e9e121c9bbced9cb4a7e91d5`)
- MOM · tier medium · CSV via datastore · updates annual · latest 2024-06 · last updated 2026-04-01
- Location: none · checked: metadata
- Fields: `year`, `occ_desc`, `estab_size1`, `age_grp1`, `mthly_gross_wage_50_pctile`, `mthly_basic_wage_50_pctile`
- Use: Refine an offer benchmark by the owner's age band and whether the employer is a small or large firm.
- Example question: "Do large companies pay software engineers more than SMEs?"
- Caveats: Median only (no percentiles) in these cuts; June 2024 reference.

#### Employed residents by income band and occupation / industry / qualification / age

- ID: `d_16fdf439f84527f2ecfcee193a8ea567` (plus 4 related: `d_0a57588ed2315b714e66cbc786929343`, `d_156f700d7c7b3e8ca5d4c1771b15110a`, `d_2504fded6f927f7ceb4eb65548ec8068`, `d_c0e11e1f0e2cfc380209d2924dfb28c2`)
- MOM · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-03-27
- Location: none · checked: metadata
- Fields: `year`, `sex`, `gross_monthly_income_excl_emr_cpf`, `occupation`, `employed`
- Use: Estimate roughly what income percentile the owner sits at within their occupation or industry.
- Example question: "What percent of managers earn more than $10k a month?"
- Caveats: Wide cross-tabs (~300 KB each), counts in thousands; best used via computed percentiles.

#### Salary claims lodged by claim item

- ID: `d_f5d9209c996b9d9fc6c2a781aa23fcbf`
- MOM · tier low · CSV via datastore · updates annual · latest 2024 · last updated 2025-07-16
- Location: none · checked: listing-only
- Fields: `year`, `claim_items`, `number_of_claims`
- Use: Context on common employment disputes (unpaid salary, overtime, notice pay) if the owner has an employer dispute.
- Example question: "What are the most common salary claims people file?"
- Caveats: Annual; last updated 2025-07.

#### Sick leave taken and work-week patterns (5-day vs 5.5-day etc.) by industry

- ID: `d_4e785066861867d8add365d1b2473dbe` (plus 14 related: `d_0a10542a8c342d57b3b1cd824c436511`, `d_32e03b45c3dd57dafa837a1214077f69`, `d_735578adc09f2d33e8ede963b8d8feb9`, `d_aabbf079b16af63eccf483c18984ac5e`, `d_373a4c72b96c1bcf7030e8b82baffeb1`, `d_5051e06223b8c20dfd55697a126ebffe`, `d_6fc4532c1cf7d5a1a231c89f4c835530`, `d_b6ca499d5ec2f3c3bc8f735e271d9b11`, `d_f66ad192831ee7295a97f5117a08fdb7`, `d_149f6c39f9b6e343b88cba90863c66ba`, `d_2c4005a1c24ab6bde1d2b762b8f64bec`, `d_4ed36511f052d872df7107d07d793da7`, `d_60117eac5efb93aec9943c5c3ef2f51c`, `d_8787647de610dbaafb1e9cfb830a9363`)
- MOM · tier low · CSV via datastore · updates annual · latest 2023 (sick leave); 2024 (work-week) · last updated 2026-06-30
- Location: none · checked: metadata
- Fields: `year`, `sick_leave`, `avg_days_per_absentee`, `avg_days_per_employee`
- Use: Answer trivia-level workplace-norm questions (typical sick days, share on a 5-day week) for a target industry.
- Example question: "What share of employees in construction work a 5-day week?"
- Caveats: Sick-leave series ends 2023.

#### Weekly paid hours and overtime by industry

- ID: `d_357028a04b32f526d0ce43b162fa8e23` (plus 15 related: `d_8aad0e661f2ee23adb29c9c1b0571f3c`, `d_a781c59bc608d21f8bbfac1121768726`, `d_aebf156556c15c9c312ff23d24bf7278`, `d_0e43d62e0641ba98c339425cd5a2019a`, `d_16c09eef57385fc29402ee71ffefd375`, `d_25e50c4bba8cbe6754e537004050e219`, `d_5c6340cbe3eba3e4f3d2f20dd3245f51`, `d_6a23f1df63e4f0191de80d3859dd02d6`, `d_6b2f2536364c1125f7712cdd049900a6`, `d_8aea9a1bd2ae2c2160c6af4b63aca2c6`, `d_aafecdd28ed28d095f5d46887554e0d3`, `d_ab4bdf37338902a257748b1d90b487f9`, `d_c791286727ba26c82dec0d485898f938`, `d_ce1286635541b65ec31c7c9d43044737`, `d_f77122d6dae6b2a363d88fca166e53f4`)
- MOM · tier low · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-09-22
- Location: none · checked: metadata
- Fields: `quarter`, `industry`, `total_paid_hours`
- Use: Indicate typical weekly hours / overtime in a target industry (work-life balance check).
- Example question: "How many hours a week do people in finance typically work?"
- Caveats: Paid hours only (unpaid overtime of salaried staff not captured).

### Money, work & energy: set aside

| Group                                                                                                                                                                                                                                              | Datasets | Reason                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOM industrial relations (trade unions, collective agreements, Industrial Arbitration Court awards, trade disputes, industrial stoppages)                                                                                                          | 22       | Institutional statistics with no personal decision value; most series stale (2024-06 or older).                                                                                                            |
| MOM crane operator licences                                                                                                                                                                                                                        | 1        | Licensing counts for a niche trade.                                                                                                                                                                        |
| MOM residents with disabilities labour statistics                                                                                                                                                                                                  | 5        | Population-level cross-tabs not relevant to the owner.                                                                                                                                                     |
| MOM labour force / employed / unemployed demographic cross-tabs (by age, sex, marital status, qualification, previous industry)                                                                                                                    | 31       | Pure macro Labour Force Survey cross-tabs; the useful headline numbers are already covered by unemployment, vacancy and income candidates.                                                                 |
| CPF scheme aggregates (member counts, net balances, interest credited, withdrawals, housing schemes, Home Protection, MediShield Life/CareShield/ElderShield claims and premiums, CPFIS holdings, contributions received)                          | 44       | National aggregates; they cannot answer anything about the owner's own account (which the CPF portal does).                                                                                                |
| IRAS revenue administration and corporate tax statistics (collections, arrears, audits, investigations, GST businesses, taxable companies, MAP/APA, filing rates, service levels, stamp duty, cost of collection, enterprise disbursement schemes) | 27       | Agency-performance and corporate-tax aggregates; no personal tax rates, caps or deadlines.                                                                                                                 |
| MAS macro and stale series (SGD/USD daily to 2015, annual FX to 2014, credit card stats to 2015, foreign reserves, bank loans, housing loans outstanding)                                                                                          | 9        | Stale (data end 2014-2015 or 2024-06 snapshots) or pure macro; the verified FX-monthly and bank-rates datasets supersede them. No SGS/T-bill/SSB yield or auction data exists in this bucket.              |
| EDB manufacturing statistics (industrial production index, output, business expectations, export-order factors)                                                                                                                                    | 17       | Pure macro manufacturing series, all frozen at 2024-06 (IPI ends 2019).                                                                                                                                    |
| EMA energy-sector statistics and superseded tariffs (fuel mix, imports/exports, peak demand, natural gas / oil / final energy consumption, stock change, electricity accounts, solar PV, Energy Connects, 2005-2021 tariffs and tariff components) | 15       | Sector-level energy balances frozen at 2019-2021; the verified electricity and gas tariff datasets cover household price questions. No retail electricity / Open Electricity Market plan data exists here. |
| IPOS patent, trade mark and design filings                                                                                                                                                                                                         | 13       | IP filing registers/statistics with no use for a resident's assistant.                                                                                                                                     |
| Public Service Division workforce and PSC scholarship statistics                                                                                                                                                                                   | 12       | Internal civil-service HR statistics.                                                                                                                                                                      |
| CCCS complaint, competition and consumer protection case statistics                                                                                                                                                                                | 3        | Annual case counts to FY2021; no per-business complaint data.                                                                                                                                              |
| Enterprise Singapore domestic exports by area                                                                                                                                                                                                      | 1        | Macro trade statistics frozen at 2024-06.                                                                                                                                                                  |

## Education, community & government

Agencies: MOE, ECDA, NLB, PA, SportSG, MUIS, SPF, MFA and more.

770 datasets from education, community, culture, social, legal, security and civic agencies; about 85% are aggregate statistics or archival dumps (NLB digitised collections, poly/ITE yearly files, prison/CNB, IMDA telecom, MCCY/MSF/MinLaw stats). The useful core is location directories (community clubs, ActiveSG/sport facilities, libraries, police centres, FSCs/SSOs, monuments, IPPT centres, constituency offices), daily-refreshed ECDA preschool vacancies and fees, the Graduate Employment Survey salaries, MUIS prayer times, SEAB exam timetable, MFA embassy directories, film classifications, poly cut-off points and adult-learning course lists. Not present in this bucket: mosque locations, crime stats by police division, polling districts, legal-aid office locations, GST import relief, library opening hours/events (NLB API needs a key).

Coverage: 770 datasets, 134 in 48 entries, 636 set aside.

### Education, community & government: Childcare & preschool

#### ECDA preschool centre listing with vacancies, fees and incidental charges

- ID: `d_696c994c50745b079b3684f0e90ffc53` (plus 3 related: `d_44cfe12f2858ae503a093dfc075a28be`, `d_253a7e348279bf0a87666a71f7ea2e67`, `d_aea5df8dc9e1850857afd0e5e8e25795`)
- Early Childhood Development Agency · tier high · CSV via datastore · updates daily · latest snapshot 2026-10 · last updated 2026-10-19 · 1,874 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `tp_code`, `centre_code`, `centre_name`, `organisation_code`, `organisation_description`, `service_model`, `centre_contact_no`, `centre_email_address`, `centre_address`, `postal_code`, `centre_website`, `infant_vacancy_current_month`, `infant_vacancy_next_month`, `infant_vacancy_third_month`, `infant_vacancy_fourth_month`, `infant_vacancy_fifth_month`, `infant_vacancy_sixth_month`, `infant_vacancy_seventh_month`, `pg_vacancy_current_month`, `pg_vacancy_next_month`, `pg_vacancy_third_month`, `pg_vacancy_fourth_month`, `pg_vacancy_fifth_month`, `pg_vacancy_sixth_month`, `pg_vacancy_seventh_month`, `n1_vacancy_current_month`, `n1_vacancy_next_month`, `n1_vacancy_third_month`, `n1_vacancy_fourth_month`, `n1_vacancy_fifth_month` and 10 more
- Use: Find childcare/kindergarten centres near the owner with current and next-months vacancies, monthly fees by citizenship and service type, and extra charges.
- Example question: "Which childcare centres in Tampines have infant vacancies next month, and what do they charge citizens?"
- Sample: Centre services: MY WORLD PRESCHOOL, Class B (Child Care), Half Day PM Playgroup, fees 460 (SC) / 630 (SPR); last_updated 2026-10-09. 86,205 fee rows.
- Caveats: Centre listing has placeholder rows (centre_name "na", postal 000000) for transitional/pending centres; vacancy fields often "Not Applicable". Address/postal only, no lat/lon in CSV; fees file is large (12.8 MB) so query by centre_code. Only relevant if the owner has young children.

#### Child care centres and kindergartens (map points)

- ID: `d_5d668e3f544335f8028f546827b773b4` (plus 2 related: `d_7fe9a72b1afff18e48111772c8d0fd39`, `d_61eefab99958fd70e6aab17320a71f1c`)
- Early Childhood Development Agency · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-04 · last updated 2026-04-18
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Map/nearest lookup for child care centres and kindergartens around the owner's town.
- Example question: "What kindergartens are within walking distance of Bishan MRT?"
- Caveats: GeoJSON download only; Pre-Schools Location (61eefab9) is a stale 2024-06 snapshot. Pair with ECDA listing for fees/vacancies.

#### Student care centres

- ID: `d_77e6e0d58ce4743dab1f26dfcbbeb6f4`
- Ministry of Social and Family Development · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-09 · last updated 2026-09-25
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find after-school student care centres near home or a primary school.
- Example question: "Are there student care centres near Rivervale Primary?"
- Caveats: GeoJSON download only.

#### Baby Bonus Approved Institutions

- ID: `d_2509dfdb3d6b87606fe909dd72fbb9fb`
- Ministry of Social and Family Development · tier low · CSV via datastore · updates daily (stated) · latest 2021 · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Fields: `seq_no`, `instn_code`, `instn_name`, `instn_srvc_type_cde`, `instn_srvc_type`, `instn_blk_hse_no`, `instn_street_name`, `instn_flr_no`, `instn_unit_no`, `instn_bldg_name`, `instn_pc`, `instn_ofc_no`, `instn_email`, `ap_user_name`
- Use: Check whether a clinic/preschool/pharmacy accepts Baby Bonus CDA payments.
- Example question: "Can I use my Child Development Account at this clinic in Punggol?"
- Caveats: Coverage ends 2021 despite "daily" frequency label; likely stale. Contains staff user names column.

### Education, community & government: Civic & government

#### Election results, dates, electors and parties (general, by- and presidential elections)

- ID: `d_581a30bee57fa7d8383d6bc94739ad00` (plus 9 related: `d_00d89e5d100a612e36432d91493785bd`, `d_ef163fd9ebc3c2f21032c29da3bd3f77`, `d_fdfb854fcb7428b29734d2e0c0674220`, `d_f237c2349833df4247d2f93102e714d5`, `d_3ae9116b99b4bc1e64883f0d75aee967`, `d_ba8da764a37ca36b34e4e5ad866294f8`, `d_f6ac3c09e5eaf6a1d33fda03f397e619`, `d_417c05185b5b72b82f69373a088da1ce`, `d_c7f1fb58083c1c44bb8418eb4d909fd5`)
- Elections Department · tier medium · CSV via datastore · updates ad-hoc · latest GE2025 (2025-05) · last updated 2025-06-03
- Location: town/planning-area · checked: metadata
- Fields: `year`, `constituency`, `constituency_type`, `candidates`, `party`, `vote_count`, `vote_percentage`
- Use: Answer who won the owner's constituency and vote shares, and past election dates.
- Example question: "Who won Punggol GRC in GE2025 and by how much?"
- Caveats: Event-driven updates only.

#### Electoral boundaries 2025 (GE2025)

- ID: `d_7ddf956dfc1c59080bf95bba1c58a5d2`
- Elections Department · tier medium · GeoJSON via download · updates ad-hoc · latest GE2025 · last updated 2025-03-12
- Location: town/planning-area · checked: metadata
- Use: Tell the owner which GRC/SMC their address falls into.
- Example question: "Which GRC am I in?"
- Caveats: 1 MB polygons; needs a point to resolve; fixed until next boundary review.

#### MFA directory: Singapore overseas missions and foreign missions/international organisations in Singapore

- ID: `d_bd13a5a6d3a2e095b944f06b3cd73232` (plus 1 related: `d_cbd49cf16afc5af5a85e2e7488dde3f7`)
- Ministry of Foreign Affairs · tier medium · CSV via datastore · updates daily · latest snapshot 2026-10 · last updated 2026-10-19 · 155 rows
- Location: none · checked: rows
- Fields: `UniqueId`, `Letter`, `Group`, `IntraGroupOrdering`, `EntityName`, `Description`, `ContactMethodsStringified`, `OtherInformation`
- Use: Give contact details of the Singapore embassy abroad when travelling, or a foreign embassy in Singapore for visa matters.
- Example question: "What's the address and phone number of the Singapore embassy in Tokyo?"
- Sample: Singapore Trade Office - Taipei: 9th Floor, No. 85, Jen Ai Road Sec 4, Taipei, +886-2-2772-1940. FM: World Bank Group Office, MBFC Tower 2.
- Caveats: Contacts are a JSON string in ContactMethodsStringified; FM file has 228 rows.

#### Community Mediation Centres

- ID: `d_4c763d1fe1d80c30348ba4f427975f9c`
- Ministry of Law · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2025-12 · last updated 2025-12-02
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Point the owner to community mediation for neighbour disputes (noise, etc.).
- Example question: "Where can I get mediation for a dispute with my neighbour?"
- Caveats: Tiny layer (few centres).

#### Health Appointment System services and clinic offerings (vaccinations/screenings)

- ID: `d_ae458e073934907b5613b227e6cf5b37` (plus 1 related: `d_d3fc278691129cdc73a191cb2575a495`)
- OGP · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2024-09 · last updated 2024-09-23 · 29 rows
- Location: none · checked: rows
- Fields: `id`, `name`, `type`, `created_at`, `updated_at`, `category`
- Use: Tell which vaccinations/screenings can be booked via the HAS and their prices.
- Example question: "Which clinics offer the HPV vaccine through the appointment system and how much?"
- Sample: Services: Pneumococcal Vaccine (NAIS), HPV2 Vaccine (NAIS), Pfizer-BioNTech/Comirnaty (Adult) (NVP).
- Caveats: Stale (2024-09); the institutions (clinic names/addresses) table is not in this bucket so offerings map to bare institution IDs.

#### Sea water temperature and weather from MESN buoys (St John's, Raffles Lighthouse, Pulau Hantu)

- ID: `d_db2cd76f4349bfe4b40db22d8b295e54`
- NUS · tier low · XLSX via download · updates ad-hoc · latest monthly averages (unclear end) · last updated 2026-06-17
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Answer sea-temperature questions for swimming/diving trips around the southern islands.
- Example question: "How warm is the sea around St John's Island usually in December?"
- Caveats: XLSX monthly averages, not live.

#### data.gov.sg dataset usage metrics and top searches

- ID: `d_a3ccf37872e0c9a0a3b343ee4b285369` (plus 1 related: `d_78853d8f18e64df6836077d33d44375a`)
- OGP · tier low · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-22
- Location: none · checked: metadata
- Fields: `quarter`, `id`, `name`, `managed_by_agency`, `format`, `page_views`, `downloads`, `api_query`, `subscriptions`
- Use: Meta: help the owner/Chief see which datasets are popular or actively maintained when choosing integrations.
- Example question: "Which data.gov.sg datasets are most queried via API?"
- Caveats: Not end-user data; 3 MB.

### Education, community & government: Community & grassroots

#### Community Clubs and PAssion WaVe outlets

- ID: `d_9de02d3fb33d96da1855f4fbef549a0f` (plus 1 related: `d_f706de1427279e61fe41e89e24d440fa`)
- People's Association · tier high · GeoJSON via download · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-02
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find the owner's nearest community club (courses, facilities, CC events) and PAssion WaVe water-sports outlets.
- Example question: "Where is the nearest community club to me in Sengkang?"
- Caveats: GeoJSON download; f706de14 is an older 2024 snapshot. No course schedules (those live on onePA, not here).

#### Constituency offices and Community Development Councils

- ID: `d_487a56abf8c30b50dae3826d3973dfb3` (plus 1 related: `d_8e5abb957e8988af63b6bafcac6880c6`)
- People's Association · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-08
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Locate the owner's constituency office (Meet-the-People sessions) and CDC for local assistance schemes/vouchers.
- Example question: "Where is my constituency office for Meet-the-People sessions?"
- Caveats: GeoJSON download; post-GE2025 boundaries.

#### PA Water-Venture outlets and holiday chalets/facilities

- ID: `d_fd5f7f1e891d8c13f2eb06969a6e929b` (plus 1 related: `d_7d4e8bd0029578bdefcc7f7849cab1c4`)
- People's Association · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2024-06 · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Suggest kayaking/water-sport outlets and PA holiday chalets for weekend plans.
- Example question: "Where can I rent a kayak through PA?"
- Caveats: Stale 2024-06 snapshots; small layers.

#### Residents' Committees / Residents' Network centres and other PA network sites

- ID: `d_9ae25d6b3fefdd15983c4e46ecc7fcbd` (plus 3 related: `d_1b9841ba2d00462a1849c947f9ffb6c8`, `d_ddae2233aec5ca47e1d485b54b37fd34`, `d_8b88f80fa3cb9e15dc7f3071609a7202`)
- People's Association · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-02
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Locate the RC/RN centre near home for estate events or grassroots contacts.
- Example question: "Which residents' network centre covers my block?"
- Caveats: 1b9841ba is the older 2024 RC layer.

### Education, community & government: Libraries, heritage & arts

#### Public libraries (locations)

- ID: `d_27b8dae65d9ca1539e14d09578b17cbf`
- National Library Board · tier high · GeoJSON via download · updates ad-hoc · latest snapshot 2024-06 · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find the nearest public library to the owner.
- Example question: "What's the nearest library to Tampines?"
- Caveats: GeoJSON snapshot from 2024-06, so recent openings/renovation closures may be missing; no opening hours (the NLB Library API has them but needs a key).

#### IMDA film, arts-event and video-game classification databases

- ID: `d_ee0231c767e05c37f61e01923df2e461` (plus 2 related: `d_0357d70f583189708514ca1d35772cc0`, `d_fb51c5304f64d01f5839ee7208f853ea`)
- Info-communications Media Development Authority · tier medium · CSV via datastore · updates annual · latest 2025 · last updated 2026-07-31 · 4,643 rows
- Location: none · checked: rows
- Fields: `Year`, `Title`, `Romanised_Title`, `Also_Known_As`, `Actors`, `Producers`, `Directors`, `Language_Description`, `Format`, `Rating`, `Decision`, `Consumer_Advice`, `Total_Running_Time_Actual`, `General_Info`, `More_Info`, `Decision_Date`, `Episode_No`, `Episode_Title`, `Classified_By`
- Use: Look up a film's/game's rating and consumer advice before watching or buying, or check an arts event's rating.
- Example question: "What is "We Bury the Dead" rated in Singapore and why?"
- Sample: WE BURY THE DEAD (2025): NC16, Passed Clean, "Some Violence and Coarse Language". Arts: MAYDAY 25th anniv. tour, National Stadium.
- Caveats: Annual batch (2023-2025 published 2026-07), so current releases are missing; not an events calendar.

#### NLB Open Web APIs: catalogue search with item availability, library details, title recommendations, eResources

- ID: `d_6a8d81084dfcb26248545b8a91362ce6` (plus 3 related: `d_7e11775ef59f13278e1848cde57ce53a`, `d_bdc72edbd61f04946913f47d079240e7`, `d_39d77f60d11fbb9c85cb102e59ca0d08`)
- National Library Board · tier medium · API via download · updates realtime · latest live API · last updated 2025-02-27
- Location: none · checked: metadata
- Use: Check whether a book is available at a nearby library, get library opening details, and suggest reads.
- Example question: "Is "Atomic Habits" available at Bishan library right now?"
- Caveats: Hosted by NLB, not data.gov.sg; requires an NLB API key via application form (outside the no-key constraint).

#### National monuments and marked historic sites

- ID: `d_b29c230ec6b609e29ed42f71ca9a8767` (plus 1 related: `d_31e16b12809e66673e90d8b04fdee1b2`)
- National Heritage Board · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-04 · last updated 2026-04-16
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Suggest heritage walks and nearby monuments/historic sites for weekend outings.
- Example question: "Are there any national monuments near Chinatown I can visit?"
- Caveats: GeoJSON download; descriptive text, no opening hours.

#### IMDA Silver Infocomm hubs, infocomm accessibility centres and Wireless@SG hotspots

- ID: `d_3eed898889bf933cdd33d6548e220a06` (plus 2 related: `d_b11ee9a784f0f233565946398570f72a`, `d_d8644084f8b54f851a1acbb2f04d5089`)
- Info-communications Media Development Authority · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2024-06 · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Point an elderly relative to a nearby digital-skills hub, or find a public Wi-Fi hotspot.
- Example question: "Where can my mum get help learning to use her smartphone near Toa Payoh?"
- Caveats: All three are stale 2024-06 snapshots; Wireless@SG layer is 1.6 MB.

#### NLB Streets and Places (heritage notes on street/place names)

- ID: `d_9606da8c76387bf74627b3e7797f781d`
- National Library Board · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2024-06 · last updated 2024-06-06
- Location: point (lat/lon or SVY21 or address) · checked: listing-only
- Use: Answer trivia about the origin of a street or place name near the owner.
- Example question: "Why is it called Kampong Bahru Road?"
- Caveats: Static.

#### Theatre venues

- ID: `d_39620e0a12a31733842dcb6759b51a85`
- National Arts Council · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2023-12 · last updated 2025-11-13
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Locate theatres/performance venues near the owner.
- Example question: "What theatres are there around Bugis?"
- Caveats: No event listings.

### Education, community & government: Religion

#### MUIS Muslim prayer timetable

- ID: `d_a6a206cba471fe04b62dd886ef5eaf22` (plus 3 related: `d_d441e7242e78efc566024dd5b0d9829c`, `d_e81ea2337599b674c4f645c1af93e0dc`, `d_dddc19f6c90edd7cff6b57494630ad29`)
- Majlis Ugama Islam Singapura · tier medium · CSV via datastore · updates annual · latest 2024-01 to 2026-12 · last updated 2026-04-02 · 1,096 rows
- Location: none · checked: rows
- Fields: `Date`, `Day`, `Subuh`, `Syuruk`, `Zohor`, `Asar`, `Maghrib`, `Isyak`
- Use: Provide daily prayer times (Subuh to Isyak) in briefings or reminders if the owner observes them; also Maghrib for Ramadan iftar.
- Example question: "What time is Maghrib today?"
- Sample: 2026-12-31: Subuh 05:44, Syuruk 07:07, Zohor 13:10, Asar 16:34, Maghrib 19:10, Isyak 20:25.
- Caveats: 2027 timetable must be published (~yearly) before Jan 2027; high-tier only if the owner is Muslim.

#### MUIS ARS-certified asatizah and Muslim religious school (MRS) directories

- ID: `d_f87cdeb2e37b6469bfc115b59aae3ead` (plus 2 related: `d_8a104950bd41ae995f7a0a17b1eea27c`, `d_3a76af305c293f652bb287fa1729ce3b`)
- Majlis Ugama Islam Singapura · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-16
- Location: none · checked: metadata
- Fields: `Ustaz_Ustazah`, `ARS_Serial_Number`, `Name`, `Category`
- Use: Verify a Quran teacher is ARS-certified or that a religious school is registered.
- Example question: "Is Ustaz X ARS-certified?"
- Caveats: Names only; no addresses for MRS.

#### Zakat nisab rates and zakat collection centres

- ID: `d_cd3256f3713239aceedf395b9a1627a5` (plus 1 related: `d_010746d9bf4941311c50158e9c3761f4`)
- Majlis Ugama Islam Singapura · tier low · CSV via datastore · updates ad-hoc · latest 2024-04 · last updated 2024-06-06
- Location: none · checked: metadata
- Fields: `month`, `zakat_nisab_rates`, `Corrected`
- Use: Tell the owner the zakat nisab threshold and where to pay zakat.
- Example question: "What is the current zakat nisab?"
- Caveats: Stale: last nisab value 2024-04.

### Education, community & government: Safety & enforcement

#### Police establishments (NPCs/NPPs, divisions) with contacts, and NPC boundaries

- ID: `d_c69e6d27d72f765fabfbeea362299378` (plus 2 related: `d_83525629a0051cffb0d3979b1cbfea96`, `d_89b44df21fccc4f51390eaff16aa1fe8`)
- Singapore Police Force · tier high · GeoJSON via download · updates ad-hoc · latest snapshot 2026-07 · last updated 2026-07-30
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find the owner's nearest neighbourhood police centre/post and which NPC covers their area.
- Example question: "Where is the nearest neighbourhood police centre and what's its phone number?"
- Caveats: GeoJSON download; NPC boundary file is 6.7 MB (point-in-polygon needs coords). 83525629 is the 2018 layer.

#### Speed cameras (fixed, mobile, laser) and red-light cameras — **Selected**

- ID: `d_5fdeb9dccf757dbdf698240fed29f441` (plus 5 related: `d_e411f01a5ac504f88434d7a02388c9ce`, `d_763b60398a7749f793f1eae2fe97c775`, `d_5f140c79c9dbee0bbb07c753afd788d8`, `d_0b7ddc0979dfc183e8b0e056878b14af`, `d_983804de2bc016f53e44031d85d1ec8a`)
- Singapore Police Force · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2025-12 · last updated 2025-11-13
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Warn about speed/red-light camera locations on a driving route.
- Example question: "Are there speed cameras along the PIE near Toa Payoh?"
- Caveats: Portal dates are Nov/Dec 2025 but record update stamps are 2016-2017. The Digital Traffic Red Light Camera layer repeats the red-light camera coordinates. The SPF web pages are fresher (241 red-light cameras, 20 fixed speed cameras plus 10 LTA cameras on KPE/MCE as of 1 July 2026) but are HTML only. Mobile and laser sites are deployment locations, not always active.

#### Liquor Control Zones

- ID: `d_c73132af6cb61148014f652fe03b51ec` (plus 1 related: `d_b44b09cc3d80d65e34c2bde6e80b5b6b`)
- Singapore Police Force · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2025-11 · last updated 2025-11-13
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Tell the owner whether public drinking is restricted at a location (e.g. Geylang, Little India).
- Example question: "Can I drink in public at Little India on a weekend?"
- Caveats: b44b09cc is a 2014 temporary zone (historical).

#### Protected areas under the Air Navigation Act (drone restricted)

- ID: `d_3d05a22ad76368500bd6d5ef72367123`
- Ministry of Home Affairs · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2026-07 · last updated 2026-07-15
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Check whether flying a drone at a location is restricted.
- Example question: "Can I fly my drone at Marina Barrage?"
- Caveats: 2.3 MB polygons; only CAAS-protected areas, not all no-fly zones.

### Education, community & government: Schools & exams

#### MOE school CCAs, subjects offered, MOE programmes and distinctive programmes

- ID: `d_9aba12b5527843afb0b2e8e4ed6ac6bd` (plus 3 related: `d_f1d144e423570c9d84dbc5102c2e664d`, `d_b0697d22a7837a4eddf72efb66a36fc2`, `d_db1faeea02c646fa3abccfa5aba99214`)
- Ministry of Education · tier medium · CSV via datastore · updates annual · latest 2026 · last updated 2026-04-17
- Location: none · checked: metadata
- Fields: `School_name`, `school_section`, `cca_grouping_desc`, `cca_generic_name`, `cca_customized_name`
- Use: Compare schools by CCAs, subjects and ALP/LLP programmes (joins to verified General information of schools d_688b934f for location).
- Example question: "Which secondary schools near Clementi offer water polo as a CCA?"
- Caveats: Keyed by school name only; join to d_688b934f for address/zone. Only relevant with school-age children.

#### SEAB national exam timetable (PSLE/N/O/A-Level)

- ID: `d_e6809acbf96c701093bc673c475755e0`
- Singapore Examinations and Assessment Board · tier medium · CSV via datastore · updates annual · latest 2026 exam year (to 2027-03) · last updated 2026-04-29 · 655 rows
- Location: none · checked: rows
- Fields: `Day`, `Date`, `Start_Time`, `End_Time`, `Academic_Level`, `Subject_Code`, `Paper_No`, `Subject_Name`, `MOA`, `Duration`
- Use: Remind the owner of national exam dates/papers for a child or relative and avoid scheduling conflicts.
- Example question: "When is the A-Level Physics paper 1 this year?"
- Sample: A-Level PHYSICS 9749 Paper 1, Fri 2026-11-27 08:00-09:00, written.
- Caveats: Partial timetable per SEAB disclaimer; refreshed yearly around April.

#### School bus operators by school (with fare info)

- ID: `d_a9e4d1b0f2897b4480723bf7f074c5e5`
- Ministry of Education · tier low · CSV via datastore · updates quarterly · latest 2023-H2 · last updated 2026-07-31
- Location: none · checked: metadata
- Fields: `school_name`, `operator_name`, `contact_number`, `bus_operator_email`, `bus_fare_info`
- Use: Look up the school bus operator contact and fare for a given school.
- Example question: "Who runs the school bus for Nan Hua Primary and how much is it?"
- Caveats: Coverage 2023; "v0" dataset, may be incomplete.

#### Travelling time/distance from MRT/LRT stations to secondary schools and JCs

- ID: `d_f5d9f95e7691f70f87f9a2347454e069` (plus 1 related: `d_c432685074a6195411f03d5fa100eeb6`)
- Singapore Examinations and Assessment Board · tier low · CSV via datastore · updates annual · latest 2025-26 (sec), 2026-27 (JC) · last updated 2026-04-08
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Fields: `From_PostalCode`, `To_PostalCode`, `From`, `To`, `TimeTaken_Mins`, `DistanceTravelled_KM`
- Use: Estimate commute from the nearest MRT/LRT station to a candidate secondary school or JC.
- Example question: "How long is the walk from Bishan MRT to Raffles Institution?"
- Caveats: Station-to-school pairs keyed by postal code; generated routing data.

### Education, community & government: Social & family services

#### Family Service Centres (and Strengthening Families programme sites)

- ID: `d_add23c06f7267e799185c79ccaa2099b` (plus 1 related: `d_b3ce295807d1edc7442ff2d24355b0af`)
- Ministry of Social and Family Development · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-15
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find the FSC serving the owner's area for family/financial counselling.
- Example question: "Which family service centre covers Yishun?"
- Caveats: GeoJSON download.

#### Social Service Offices

- ID: `d_22cfe2aed0bf20a679ab59bcaf0f8248`
- Ministry of Social and Family Development · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2026-09 · last updated 2026-09-24
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Locate the nearest SSO for ComCare/financial assistance enquiries.
- Example question: "Where is the social service office for Bedok?"
- Caveats: GeoJSON download.

#### Institutions of a Public Character (IPC) list

- ID: `d_7249aa8080c2e3211fd1c5811e507bff`
- People's Association · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2025-12 · last updated 2025-12-31 · 422 rows
- Location: none · checked: rows
- Fields: `name_of_charity`, `sector_or_beneficiaries`
- Use: Check whether a charity is an IPC so donations get 250% tax deduction.
- Example question: "Is Zero Waste SG an IPC? Will my donation be tax-deductible?"
- Sample: ZERO WASTE SG LIMITED - Others; Zonta Singapore- Project Pari Fund - Social and Welfare.
- Caveats: Titled "UAT"; fields wrapped in HTML <a> links to FormSG; may not be the authoritative/complete IPC register.

#### Social Service Agencies directory (NCSS members) and disability services

- ID: `d_736e30b5a0111242dfde98d7b32cfda2` (plus 1 related: `d_9bde6cb42dce64ebaf2dc7ccc2db6201`)
- Ministry of Social and Family Development · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2026-10 · last updated 2026-10-16
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find social service agencies or disability services near the owner (e.g. for an elderly or disabled family member).
- Example question: "Are there any eldercare or disability services near Hougang?"
- Caveats: Disability Services layer (9bde6cb4) is a 2024-06 snapshot.

### Education, community & government: Sports & fitness

#### SportSG / ActiveSG sport facilities (and Dual-Use school facilities)

- ID: `d_9b87bab59d036a60fad2a91530e10773` (plus 1 related: `d_7ff555dfb7104533494b23a60188a044`)
- Sport Singapore · tier high · GeoJSON via download · updates ad-hoc · latest snapshot 2025-07 · last updated 2025-11-13
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Find the nearest ActiveSG swimming pool, gym, stadium or sports hall to the owner.
- Example question: "Where is the nearest ActiveSG gym or pool to Jurong East?"
- Caveats: GeoJSON download; no opening hours or crowd levels. DUS layer (7ff555df) is a 2024-06 snapshot.

#### IPPT training centres (IPPT-in-your-community, FCCs) and NAPFA test centres

- ID: `d_2d3e941d7be6c7ede34b9d13d5ef2544` (plus 2 related: `d_263beaeee450c77eb95c949df5bd274c`, `d_fb02554004cad17029a7e68819124973`)
- Ministry of Defence · tier medium · GeoJSON via download · updates ad-hoc · latest snapshot 2025-11 · last updated 2025-11-13
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: If the owner is an NSman, locate nearby IPPT/RT training centres and FCCs.
- Example question: "Where is the nearest IPPT training centre to Woodlands?"
- Caveats: No session schedules; NAPFA layer is tiny.

#### Sport facilities national census (all venues incl. HDB courts)

- ID: `d_2cfb0867cdeb2b7303068995699dc33b`
- Sport Singapore · tier medium · CSV via datastore · updates ad-hoc · latest 2024 census (published 2026-03) · last updated 2026-03-12 · 16,595 rows
- Location: point (lat/lon or SVY21 or address) · checked: rows
- Fields: `VenueName`, `PostalCode`, `Latitude`, `Longitude`, `SportsFacility`
- Use: Answer "where can I play X near me" for basketball courts, futsal, tennis, etc., across public and private venues.
- Example question: "Is there a basketball court near my block in Ang Mo Kio?"
- Sample: Postal 560564 (lat 1.37, lon 103.859): Futsal / Street Soccer Court, Basketball Court.
- Caveats: Many venues unnamed ("-"); coordinates rounded to 3 decimals. One row per facility type.

#### SAFRA clubhouses

- ID: `d_b0c7a065104744ecfbc21e93c226ee5c`
- Ministry of Defence · tier low · GeoJSON via download · updates ad-hoc · latest snapshot 2025-11 · last updated 2025-11-13
- Location: point (lat/lon or SVY21 or address) · checked: metadata
- Use: Locate SAFRA clubs (gyms, pools, F&B) for NSmen members.
- Example question: "Which SAFRA club is closest to me?"
- Caveats: Small static layer.

### Education, community & government: Tertiary, courses & careers

#### Graduate Employment Survey (NTU, NUS, SIT, SMU, SUSS, SUTD) by degree

- ID: `d_3c55210de27fcccda2ed0c63fdd2b352`
- Ministry of Education · tier high · CSV via datastore · updates annual · latest 2024 graduating cohort · last updated 2026-03-05 · 1,550 rows
- Location: none · checked: rows
- Fields: `year`, `university`, `school`, `degree`, `employment_rate_overall`, `employment_rate_ft_perm`, `basic_monthly_mean`, `basic_monthly_median`, `gross_monthly_mean`, `gross_monthly_median`, `gross_mthly_25_percentile`, `gross_mthly_75_percentile`
- Use: Benchmark salary expectations and employment rates by university degree for job search or career-switch decisions.
- Example question: "What is the median starting salary for NUS computer science graduates?"
- Sample: 2024 SIT-TUM BEng Electronics & Data Eng: employment 86.8%, gross median 4,600, P25-P75 4,200-5,000.
- Caveats: Fresh-graduate pay only (~6 months after graduation); one cohort per year, published ~Feb-Mar.

#### Polytechnic adult-learning courses (short, part-time diploma, post-diploma, WSQ)

- ID: `d_2f9d839c90e22a94cf1a399178ba9593` (plus 10 related: `d_57b5c1183e466a0b6df40a3fa4143cb2`, `d_d6cdbaaa983700515cd4b0267036ce9c`, `d_59f71eeaca8615f30610159eae1abdb0`, `d_1b28d101f36bc4737043917dff543f9a`, `d_2ca6b27474c3b380788796a036faf0f1`, `d_80ce709e5fa462626f2fec7d8dbfcf57`, `d_2596b6fb7867be65d9e525c9f9bc8ca0`, `d_06fbfbb5116edc2a8a9568a1b43e7acc`, `d_80d46ca0da1160027f786fe390473ae8`, `d_6f337a41a5cbe2cb110fe93c9f43bbe7`)
- Ngee Ann Polytechnic · tier medium · CSV via datastore · updates annual · latest 2025 (NP, RP); 2024 (SP) · last updated 2026-03-04
- Location: none · checked: metadata
- Fields: `Year`, `Course_Name`, `Course_Description`, `Reference`
- Use: Suggest upskilling courses (SkillsFuture-eligible short/WSQ/part-time) at NP, RP and SP for job-search questions.
- Example question: "Are there any part-time data analytics courses at the polytechnics?"
- Caveats: Per-poly, per-year files with different schemas (RP as XLSX); descriptions and links but no dates, fees or intakes. Temasek/NYP CET lists not present.

#### Polytechnic course cut-off points (ELR2B2) and planned intakes (NYP, NP)

- ID: `d_eb7bb85a49e021e63f9cb7b54497a400` (plus 9 related: `d_571e2ace874fe32b20393e50a4749faf`, `d_45518670214498e31330c6f79e3dbbeb`, `d_96768510413e84edf603bd4777766543`, `d_f3b95df32c930fee1c0f333a2c7ae92e`, `d_549d13ca5948a77b2648b48b37aab83d`, `d_41e3fa6cec02c46a2ffa2fc58073fb36`, `d_e0d9c03e6f4b530fac0bcd459e91cc8f`, `d_becb4f7b9e9e5ba95cf7382f1ec63feb`, `d_98b23f1a35559e6b7be1974dcf30d0bd`)
- Nanyang Polytechnic · tier medium · CSV via datastore · updates annual · latest AY2026 (NYP), 2025 (NP) · last updated 2026-03-10 · 563 rows
- Location: none · checked: rows
- Fields: `academic_year`, `jae_cluster`, `jae_course_code`, `course_name`, `gceo_cut_off_point`
- Use: Answer JAE cut-off and intake questions for a child or relative choosing a diploma.
- Example question: "What was the cut-off for NYP Animation, Games & Visual Effects this year?"
- Sample: NYP 2026 C29 Animation, Games & VFX COP 4-12; NP 2025 N73 Pharmaceutical Science ELR2B2-C 3 to 9, intake 65.
- Caveats: Only NYP and NP publish COPs here (SP/TP/RP absent). NP is one file per year.

#### ITE course catalogue and course fees (full-time and part-time)

- ID: `d_16d9275596a083bdcd1b3a3ce97f6ffa` (plus 4 related: `d_c0a089b996ff6bc6aaf500fde725464e`, `d_7d1568686442d85d69dc476e4926d5e1`, `d_e88ee7c099b6e70e399a3d846e41a611`, `d_1aad8101cfc40f6fd550cef8389969bc`)
- Institute of Technical Education · tier low · CSV via datastore · updates annual · latest 2026 · last updated 2026-06-15 · 2,581 rows
- Location: none · checked: rows
- Fields: `year`, `course_type`, `course_name`
- Use: List ITE courses and per-term/per-module fees by citizenship.
- Example question: "How much is an ITE Higher Nitec per term for a citizen?"
- Sample: 2026 Higher Nitec (4-year) fee per term: SC 283, PR 3,791, international 10,561.17. Catalog: 2026 Work-Study Diploma in Paramedicine.

#### Intake, enrolment and graduates by course (universities, polytechnics, ITE)

- ID: `d_6b264092cd066c55d8e2db9e68e7ffdb` (plus 2 related: `d_78a8224856234eafbbc44d3d3edacd19`, `d_24b8751abfc87a4f054f61186c2fe1ba`)
- Ministry of Education · tier low · CSV via datastore · updates annual · latest 2024 · last updated 2025-11-12
- Location: none · checked: metadata
- Fields: `year`, `sex`, `course`, `intake`, `enrolment`, `graduates`
- Use: Gauge how many graduates each field produces (competition context for job search).
- Example question: "How many IT graduates did the universities produce last year?"
- Caveats: Aggregated national stats, ~1-year lag.

#### Polytechnic full-time diploma course lists, fees, financial aid and scholarships

- ID: `d_913f2d358c89139a12b7c1c7133caa04` (plus 7 related: `d_93384114c34e72d1cb7908b95618267a`, `d_b81b0c14a78f68f0e0cdee56b88d28f0`, `d_eb1c0843cb3ef78a096a5639a4f9c1cb`, `d_aa3b89617725a58af2587ccea25e6950`, `d_7360b1a78d0bbde00461fa7d21326ec7`, `d_eb095cc63e3ea148ec3a19e75601e4d3`, `d_4772ca775d1e5924ed831fc2315a4472`)
- Ngee Ann Polytechnic · tier low · CSV via datastore · updates annual · latest 2026 (NP), 2025 (TP/RP/NYP), 2024 (SP) · last updated 2026-03-09
- Location: none · checked: metadata
- Fields: `Year`, `School`, `Course_Name`, `Course_Code`, `Course_Description`, `Reference`
- Use: Answer which diplomas each polytechnic offers and NP semester fees / bursaries.
- Example question: "Which polytechnics offer a cybersecurity diploma?"
- Caveats: Heterogeneous per-poly files (TP/RP are XLSX). Fees/aid only for NP.

#### SAF career schemes and vocations

- ID: `d_06e1cd4ae5bc3f398bf8bf905d8ad026`
- Ministry of Defence · tier low · CSV via datastore · updates ad-hoc · latest snapshot 2026-08 · last updated 2026-08-05
- Location: none · checked: metadata
- Fields: `SAF_Service`, `Career_scheme`, `Vocation`, `Link`, `Responsibilities`, `Eligibility_and_academic_qualifications`, `Benefits`
- Use: Describe SAF/DIS career schemes, eligibility and benefits if the owner explores defence careers.
- Example question: "What are the eligibility requirements for a DIS career scheme?"

### Education, community & government: set aside

| Group                                                                                                                                                                                              | Datasets | Reason                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| MOE General information of schools (d_688b934f82c1059ed0a6993d2a829089)                                                                                                                            | 1        | Low value for one resident (school contacts and nearest MRT station); rows sampled in the first catalogue pass. |
| NLB digitised collections and name authorities (newspapers 1800s-, books, maps, images, music, archived websites, digital-collection-by-subject lists)                                             | 103      | Bibliographic/archival metadata dumps; no daily-life value for an assistant (use NLB search APIs instead).      |
| Superseded yearly snapshots of polytechnic course/fee/scholarship lists (NP 2017-2024, TP 2016-2024, RP 2016-2019, SP older CET lists)                                                             | 97       | Older academic-year versions of files whose latest year is a candidate.                                         |
| Polytechnic and ITE institutional statistics (enrolment, intake, graduates, CET completion counts, number of courses)                                                                              | 40       | Institutional reporting stats; no personal use.                                                                 |
| MOE education statistics (enrolment by level/age, exam pass rates, cohort progression, teachers/principals, class sizes, school counts, private schools, LASALLE/NAFA, MOE kindergarten enrolment) | 71       | National aggregate education stats; not actionable for one resident.                                            |
| MOE SICS canteen-stall and school-bus advertisement tenders                                                                                                                                        | 2        | Vendor tender notices for operators, not residents.                                                             |
| IMDA infocomm industry and telecom statistics (subscriptions, call success, broadband usage, manpower, revenue, media-time surveys, postal volumes, stale 2013-2016 broadband plan prices)         | 62       | Macro/industry statistics, mostly last updated 2024-06 with old coverage.                                       |
| Singapore Prison Service, Yellow Ribbon and CNB statistics (penal/DRC/remand populations, recidivism, drug arrests and seizures, inmate programmes)                                                | 60       | Criminal-justice aggregates with no personal use.                                                               |
| SPF one-off event security zones (NDP 2015/2022-2025, ASEAN Summit 2017, SEA Games 2015, GE rally sites) and PCG offshore islands                                                                  | 18       | Past-event polygons; future NDP zones are announced via news. Not reusable.                                     |
| SPF road-accident causes (2012-2018) and driving-licence holder counts                                                                                                                             | 3        | Stale national aggregates.                                                                                      |
| MCCY arts/culture sector statistics, charity sector receipts/donations, Social Values Survey and MFT raw data                                                                                      | 58       | Sector-level statistics (2024-06 refresh, old coverage); no personal use.                                       |
| MSF statistics (domestic-violence trend reports, youth rehabilitation, foster care, OPG deputies/LPA counts, maintenance applications, paid-leave take-up)                                         | 36       | Aggregate social statistics; not actionable for one resident.                                                   |
| MinLaw moneylending, pawnbroking, bankruptcy, winding-up, Public Trustee, Legal Aid and CMC caseload statistics; registered precious-metal dealers list                                            | 28       | Aggregate legal-sector stats (mostly ending 2016-2020) and a business registry dump.                            |
| Judiciary caseload and PPO statistics                                                                                                                                                              | 3        | Court workload aggregates.                                                                                      |
| People's Association course/interest-group counts, PAssion card membership, CCC+ e-services lists                                                                                                  | 17       | Annual counts of classes/members and internal e-service listings; no schedules or bookable info.                |
| Singapore Customs licensed premises (zero-GST/duty warehouses, petroleum, liquor/tobacco, motor vehicles), revenue and TradeNet statistics                                                         | 10       | Trader/business licensing and revenue aggregates; no GST import-relief dataset exists here.                     |
| Sport Singapore participation survey statistics (participation levels, motivations, barriers, top sports)                                                                                          | 10       | National survey aggregates.                                                                                     |
| Research & innovation statistics (A*STAR R&D expenditure/manpower/patents, NRF grant calls)                                                                                                        | 8        | Macro R&D stats.                                                                                                |
| MUIS annual Haj pilgrim counts                                                                                                                                                                     | 1        | Historical aggregate.                                                                                           |
| Old electoral boundaries (2006, 2011, 2015, 2020)                                                                                                                                                  | 4        | Superseded by the 2025 boundaries.                                                                              |
| PDPC Do-Not-Call registry figures                                                                                                                                                                  | 2        | Registry volume stats; does not let the owner check numbers.                                                    |
| Misc: GovTech DNS records, Science Centre 2019 enrichment programmes                                                                                                                               | 2        | Infrastructure data / stale 2019 school programme list.                                                         |

## Statistics (SingStat) A

Agencies: Department of Statistics tables, first half.

First alphabetical half (1,156 tables) of SingStat Table Builder mirrors: mostly census/survey cross-tabs, input-output tables, national accounts, trade and financial-sector aggregates (dismissed). The resident-useful core is small but current: COE quota premiums incl. PQP (2026-09), month-end and average SGD exchange rates (2026-08), private property price and rental indices by CCR/RCR/OCR (2026-Q2), wage benchmarks by occupation and percentile, labour-market tightness, household income (2025) and HES 2023 spending benchmarks, monthly climate recap (2026-08) and hotel room rates. CPI, tariffs, bank rates, FX averages and job vacancies in this bucket were sampled in the first catalogue pass.

Coverage: 1156 datasets, 141 in 34 entries, 1015 set aside.

### Statistics (SingStat) A: Economy & society headlines

#### Births and fertility rates; key indicators on marriages and divorces, annual

- ID: `d_e39eeaeadb571c0d0725ef1eec48d166` (plus 2 related: `d_2b2630e253fc45523fd4ce58baa7b668`, `d_b9ed468278b4d0023e66e06c1c52253b`)
- SingStat · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-06-03
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2025`)
- Use: Family-planning trivia (TFR, median age at marriage).
- Example question: "What is the median age at first marriage now?"

#### Crime cases recorded; cases recorded for selected major offences, annual

- ID: `d_ca0b908cf06a267ca06acbd5feb4465c` (plus 1 related: `d_02d07531b84cd0cf2cf901fc1bf5d395`)
- SingStat · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-09-01
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2025`)
- Use: National safety context (e.g. scam/cheating trends).
- Example question: "Are scam cases still rising?"
- Caveats: National only, annual; no neighbourhood breakdown.

#### Food & beverage services index; online F&B and online retail sales proportions

- ID: `d_d7933d23e5fab92a086585cfb9224ba2` (plus 9 related: `d_42cb05dd61cddf473a8ba82cd10c7e34`, `d_794f0db02b3b009f7611860c05d1a495`, `d_cb3d44659cca6f48b5f7ce0d33d96a8f`, `d_ed77aee396f778d9166970cf826094fe`, `d_2a3204c2f3b4a783f66978f1dc99073a`, `d_f2a6e31b801445350bbeda1c895d455e`, `d_29d0626a2259ac6c3695e470451ab4d2`, `d_1ee399b195ab799a34588772ccc1ebfa`, `d_65e4d47c3616d251f9a84ec1ad28f43c`)
- SingStat · tier low · CSV via datastore · updates monthly · latest 2025-12 · last updated 2026-02-05
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2025Dec`)
- Use: Context on dining-out spending and e-commerce share trends.
- Example question: "What share of retail sales is online now?"
- Caveats: Last updated 2026-02-05 with data to 2025-12; appears not refreshed since (possible rebasing).

#### GDP year-on-year growth by industry; key GDP data, quarterly

- ID: `d_a5ff719648a0e6d4b4c623ee383ab686` (plus 2 related: `d_68a241ba626a888ac305a0b34769aec4`, `d_1506368f0e7928ac18e42f84d1c450a3`)
- SingStat · tier low · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-08-11 · 58 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: One-line economy update in the briefing after each quarterly GDP release.
- Example question: "How fast did the economy grow last quarter?"
- Sample: Real GDP (chained 2015$) +5.9% YoY; nominal +12.4% (2026Q2)

#### Indicators on population (total, residents, growth, density, ageing), annual

- ID: `d_3d227e5d9fdec73f3bcadce671c333a6`
- SingStat · tier low · CSV via datastore · updates annual · latest 2026 · last updated 2026-10-02
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2026`)
- Use: Answer population trivia.
- Example question: "What is Singapore's population this year?"

#### Life expectancy by sex; age-specific death rates, annual

- ID: `d_af61b90018b8fabecabe8e93950e0223` (plus 1 related: `d_0d64da52342e43d864bc84898ba6835f`)
- SingStat · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-06-03
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2025`)
- Use: Inputs for retirement/insurance planning conversations.
- Example question: "What is life expectancy at 65 for men?"

### Statistics (SingStat) A: Household benchmarks

#### Average monthly household expenditure by type of goods and services (HES, quinquennial) and its distribution; consumer-durables ownership

- ID: `d_7a24e1f85969c45ad68a89f7acf4e7a8` (plus 2 related: `d_b019b2a59996e9c7dd926898e16a7412`, `d_abef8a7f050670891ad530620bad67cb`)
- SingStat · tier medium · CSV via datastore · updates quinquennial · latest 2023 · last updated 2024-11-28 · 17 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2023`)
- Use: Benchmark the owner's monthly spending by category (food, housing, transport, health) against the average household.
- Example question: "Do I spend more on transport than the average household?"
- Sample: Total S$7,118.7/month; food & food serving S$1,421.7; transport S$951.2 (HES 2023)
- Caveats: Survey every 5 years; latest 2022/23. Older HES 2002/03-2017/18 tables dismissed as superseded.

#### Household employment income benchmarks 2000-2025: average/median, per member, deciles, percentiles, by dwelling type, transfers/taxes

- ID: `d_f4560da11b22b47050c75bdffb1d93e0` (plus 42 related: `d_178b6963fe272f50dfd9ceb9411952f9`, `d_1c5d8f9684c14ab840d451852fefb13f`, `d_1dc0ffa8e519eb9a069db01c8dab6bf0`, `d_1f57cbc6cc41d72fb1b96c7c266c2eaf`, `d_2e9f21f16c87aa94ed98556537f68c5b`, `d_34cea2e433a8cf475619eb4855477bfe`, `d_3783d61c6ff1857294b49240bf653167`, `d_42010db3d76ac3f5871533fff1d725d6`, `d_46c382ded9048e73ada7faf2b4ce47ba`, `d_472200f9806362db03be41b5068677e4`, `d_47a61cdd2eaeb76ad27761ef06608807`, `d_481193b8ad80eec0527d34a8c58b3891`, `d_650c42ad53d69ad3f6f47f04c21616fb`, `d_679ca7a5e70eac7441faffeb877f8230`, `d_78824270eced36ff2bd0d79999e79048`, `d_78c7c1ec34c9f7552a9cfa51ac24ba9b`, `d_7ec1e16178d7d13cfded6ced1a084759`, `d_87af902bf55b56c1b9675b296f8731d4`, `d_88430adbdecbccbad6d717ce81616a75`, `d_917a2a8bb57d96d48bafc3ab0baa2b6e`, `d_968496622a54acf5f67256434453b94c`, `d_981440e44e569b36524e2b1b51e13fd0`, `d_9834f6cdf1982e201c69c2bca45ad1c6`, `d_a0a94216a4bb495fcd8682934ce85003`, `d_a20ad8fbc8f77e06fedab855695d67a7`, `d_a71dd26716f6aaf2d848bb49289edfb7`, `d_b0d0ad4f0cc5f5084ad6d157e135f55a`, `d_b37bc6f05c76337ad51aefddf0b7c888`, `d_ba30a057b9b164d1400e8bd039dd1cd3`, `d_bb0bc88395e83f751d350fe4f9eccc1a`, `d_c040090e33c36244606071f21b532af9`, `d_c1a7394aeb3a4265f1730ac09cd051d6`, `d_c74ebe613db891d25e4836aaf98d7a47`, `d_ce5d8bb5c34f6b78b5b2f1fab09ccbce`, `d_d0a04cbd237d58557fe7178781275e7f`, `d_db18a290f392045e369a6036b9b949de`, `d_dff6b97b7c233917ac8294bd04051486`, `d_e19935af41b8ba83c0966b89ebed4ad5`, `d_e9d8d21437c90161601d9e84e93f8b63`, `d_e9e3d072d88817db1052876884168f01`, `d_ff1988785f3e36cfc4757cf604ae0acd`, `d_6d878eb9c5a47f54fee7ce496f681e8d`)
- SingStat · tier medium · CSV via datastore · updates annual · latest 2025 · last updated 2026-02-09 · 26 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `ResidentHouseholds_Average`)
- Use: Compare the owner's household income with national medians, deciles and dwelling-type averages.
- Example question: "What is the median household income in Singapore now?"
- Sample: Median monthly household employment income incl. employer CPF, resident households: S$10,088 (2025); resident employed households S$12,027
- Caveats: Long format (one row per year). Many near-duplicate tables (incl./excl. employer CPF, per member, change tables); pick 3-4 headline ones.

### Statistics (SingStat) A: Jobs & pay

#### Job vacancies by industry and occupational group (SSIC 2020), quarterly

- ID: `d_f3bbdfbf92b811fff364aeed23b5e0bb`
- SingStat · tier high · CSV via datastore · updates quarterly · latest · last updated 2026-10-12
- Location: none · checked: rows (first catalogue pass)
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Show where vacancies are concentrated for job-search questions.
- Example question: "How many PMET vacancies are there in ICT?"
- Caveats: Rows sampled in the first catalogue pass. not re-sampled here).

#### Median gross monthly income from employment (incl. employer CPF) of full-time employed residents by occupation and sex

- ID: `d_8f024ddf2553d81ee00ede55b1d9b0ff`
- SingStat · tier high · CSV via datastore · updates annual · latest 2024 · last updated 2026-05-19 · 16 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2024`)
- Use: Benchmark a salary or job offer against the national median for its occupation group.
- Example question: "What is the median pay for professionals in Singapore?"
- Sample: Professionals - Male S$9,156; Professionals - Female S$7,722 (2024)
- Caveats: Only broad SSOC major groups; latest year 2024 (one year behind). Pair with occupational wages d_9917e751 for finer detail.

#### Gross monthly income from employment (incl. employer CPF) of full-time employed residents: percentiles and median by sex

- ID: `d_0f1863aa8e0128a002f3befa2d69b2b6` (plus 1 related: `d_52760e82e8786bac11cca40eb29d1a93`)
- SingStat · tier medium · CSV via datastore · updates annual · latest 2025 · last updated 2026-01-30 · 4 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2025`)
- Use: Place the owner's income on the national distribution (20th/50th percentile etc.).
- Example question: "Is S$7,000 a month above the national median?"
- Sample: Median S$5,775 (male 6,000, female 5,460); 20th percentile S$3,164 (2025)
- Caveats: d_52760e82 has the same title (likely other percentile cuts / duplicate).

#### Labour market statistics (unemployed, vacancy ratio), recruitment/resignation rates by industry & occupation, re-entry rate, employment change

- ID: `d_7fa083fa9b837ef84c83caaba76601fd` (plus 9 related: `d_286aa474b0ec8a831d56105b8b063333`, `d_88a30f5d189a2102e4576bb35e1f94e9`, `d_c7cfe9596f35af4530c44b396c0c46dc`, `d_5fb31c11163a5ac1afd06272df71e644`, `d_da97bac6b8aa7f35dc0794e3cbeeb8e8`, `d_64c9443f13f603f552c5d2a4e65aac9a`, `d_31dec7667bc2c6b945a262cd60958eaf`, `d_a326c13e94827819f8f1057c15f00221`, `d_11a640f1e61c1a680efeac8c775cdcb5`)
- SingStat · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-10-09 · 5 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Summarise hiring climate for job-search questions: vacancy-to-unemployed ratio, resignation and recruitment rates in their industry.
- Example question: "Is the job market tightening this quarter?"
- Sample: Job vacancy to unemployed ratio 1.5; job vacancy rate 2.9%; resident unemployed (SA) 71.1k (2026Q2)
- Caveats: Complements verified job vacancies d_f3bbdfbf and unemployment d_ca32584c; recruitment/resignation tables are large (one row per industry x occupation).

#### Average monthly nominal earnings per employee (and YoY change); average weekly paid hours by industry

- ID: `d_5d2a513a20f58239f8c449ea6c9b6ecd` (plus 2 related: `d_64f98475cef1e94300362cb400a50012`, `d_d15f53a85afd9b2c6d23302f8577124d`)
- SingStat · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-03-04
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2025`)
- Use: Context on wage growth and working hours by industry.
- Example question: "How fast did average wages grow last year?"

### Statistics (SingStat) A: Money & rates

#### Current banks interest rates (end of period), monthly

- ID: `d_5fe5a4bb4a1ecc4d8a56a095832e2b24`
- SingStat · tier high · CSV via datastore · updates monthly · latest · last updated 2026-10-08
- Location: none · checked: rows (first catalogue pass)
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Quote prevailing bank savings/fixed-deposit/prime lending rates when the owner compares deposits or loans.
- Example question: "What are banks paying on 12-month fixed deposits now?"
- Caveats: Rows sampled in the first catalogue pass. not re-sampled here).

#### Exchange rates (average for period), monthly; annual averages folded in

- ID: `d_b2b7ffe00aaec3936ed379369fdf531b` (plus 3 related: `d_3c62d5eed03c40aeafbb6d0fa324e976`, `d_1ca9cbc55aa0e6added2c719d4bbedac`, `d_b09aeaf8eb591c4bfe347b66148c6b53`)
- SingStat · tier high · CSV via datastore · updates monthly · latest · last updated 2026-10-10
- Location: none · checked: rows (first catalogue pass)
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Give monthly-average SGD rates against major currencies for travel budgeting and expense conversion.
- Example question: "What was the average SGD/JPY rate last month?"
- Caveats: Rows sampled in the first catalogue pass. not re-sampled here). d_3c62d5ee is an older duplicate of the monthly-average table that stops at 2026-05; prefer b2b7ffe0.

#### Exchange rates (as at end of period), monthly

- ID: `d_cdd73fd4341b345fa4307e44d6f82175`
- SingStat · tier medium · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-13 · 15 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Month-end SGD rates for 15 currencies, e.g. to value foreign-currency holdings or IBKR cash at month end.
- Example question: "What was USD/SGD at the end of last month?"
- Sample: US Dollar 1.2729, Euro 1.4755, Japanese Yen 0.7965 (per 100 yen) SGD at 2026Aug
- Caveats: Wide table: one row per currency, newest column first (e.g. 2026Aug). JPY/KRW/IDR etc. quoted per 100 units.

#### Credit and charge cards (cardholders, billings, rollover, charge-off), quarterly

- ID: `d_5c8e5801c2a64e2e6b16608296ef3e02` (plus 1 related: `d_b40deadbdc470e97b9e16de99c5e6ee2`)
- SingStat · tier low · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-08-31 · 6 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Context for personal-finance chats, e.g. national card charge-off rate or total billings trend.
- Example question: "How much credit card debt is rolled over nationally?"
- Sample: Total card billings S$27,599.6m; rollover balance S$9,640.8m; charge-off rate 5.9% (2026Q2)
- Caveats: National aggregates only; no per-bank or personal data.

### Statistics (SingStat) A: Prices & utilities

#### Consumer Price Index (CPI), 2024 base, monthly

- ID: `d_bdaff844e3ef89d39fceb962ff8f0791`
- SingStat · tier high · CSV via datastore · updates monthly · latest 2026-08 (listing updated 2026-09-23) · last updated 2026-09-23
- Location: none · checked: rows (first catalogue pass)
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Report headline and item-level inflation (food, transport, housing, etc.) in briefings and answer cost-of-living questions.
- Example question: "How much have food prices gone up compared with a year ago?"
- Caveats: Rows sampled in the first catalogue pass. not re-sampled here).

#### Electricity tariff (monthly; annual companion folded in)

- ID: `d_61eac3cdb086814af485dcc682b75ae9` (plus 1 related: `d_d610f8ed1864daa6c7e790318bbc3323`)
- SingStat · tier high · CSV via datastore · updates monthly · latest · last updated 2026-04-06
- Location: none · checked: rows (first catalogue pass)
- Fields: one row per data series, one column per period (latest `2026Jun`)
- Use: Tell the owner the current household electricity tariff and estimate the monthly bill.
- Example question: "What is the electricity tariff this quarter?"
- Caveats: Rows sampled in the first catalogue pass. not re-sampled here). Monthly table last updated 2026-04-06.

#### Gas tariffs (monthly; annual companion folded in)

- ID: `d_c63822ef11e6a79b8281db36b1975bef` (plus 1 related: `d_9835e2085751e6b9c3efae9fdf2b9c5c`)
- SingStat · tier high · CSV via datastore · updates monthly · latest · last updated 2026-05-11
- Location: none · checked: rows (first catalogue pass)
- Fields: one row per data series, one column per period (latest `2026Jun`)
- Use: Report the current town-gas tariff for household bill checks.
- Example question: "Has the gas tariff changed this quarter?"
- Caveats: Rows sampled in the first catalogue pass. not re-sampled here). Monthly table last updated 2026-05-11.

### Statistics (SingStat) A: Property

#### Private residential property price index by type (1Q2009=100), quarterly; URA property price index by type (4Q1998=100) folded in

- ID: `d_da00b36ca8c831322fa0bb2a3378a476` (plus 1 related: `d_620ad30cf4aca7c1c25eb2eff9e4bedc`)
- SingStat · tier high · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-24 · 3 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Track private home price movements (landed vs non-landed) for the owner's housing decisions and briefing.
- Example question: "Did private property prices rise last quarter?"
- Sample: Residential 219.4, Landed 258.4, Non-landed 210.6 (2026Q2)
- Caveats: Quarterly with ~1 month lag; index, not prices.

#### Price index of non-landed private residential properties by locality (CCR/RCR/OCR), quarterly

- ID: `d_cac92aec5effc2d67f529615617c235a` (plus 1 related: `d_65f5bf43d377db3939d93eb6f744d950`)
- SingStat · tier medium · CSV via datastore · updates quarterly · latest 2026-Q1 · last updated 2026-04-24 · 3 rows
- Location: region · checked: rows
- Fields: one row per data series, one column per period (latest `20261Q`)
- Use: Compare condo price trends in Core Central / Rest of Central / Outside Central regions.
- Example question: "How have condo prices outside the central region moved this year?"
- Sample: CCR 158.6, RCR 228.9, OCR 271.4 (2026Q1)
- Caveats: Market segments (CCR/RCR/OCR), not the five planning regions. Latest column is 2026Q1 although metadata coverageEnd says 2026-06; d_65f5bf43 is an older duplicate ending 2025Q3.

#### Rental indices of non-landed private residential properties by locality; overall residential rental index folded in

- ID: `d_56b0c7f6538be69f24956634d88d82e8` (plus 1 related: `d_647dabde09e726b9eeb75e4d9cd96699`)
- SingStat · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-24 · 3 rows
- Location: region · checked: rows
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Show private rental trends by market segment for renters or landlords.
- Example question: "Are condo rents in the OCR going up or down?"
- Sample: CCR 152.9, RCR 172.3, OCR 169.0 (2026Q2)
- Caveats: Market segments (CCR/RCR/OCR). Index only; URA non-landed rental medians (d_149ac00a) give actual rents.

#### Available and vacant private residential properties; EC supply and pipeline, quarterly

- ID: `d_01e3556fb916ca19a7e29fc39520fa78` (plus 1 related: `d_361d4f4313d30951c76beaa343fd7ce1`)
- SingStat · tier low · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-24
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Add vacancy/supply context when discussing rents or buying a private home or EC.
- Example question: "How many private homes are vacant right now?"
- Caveats: Supply aggregates by type and region; mostly investor context.

#### HDB resale price index (1Q2009=100), quarterly (SingStat copy)

- ID: `d_f0c768860912d66940efdac9435dc046` (plus 1 related: `d_913fd3cff8b7f462cf70cf415001e02b`)
- SingStat · tier low · CSV via datastore · updates quarterly · latest 2026-Q2 (per metadata coverage) · last updated 2026-07-24
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Fallback mirror of the HDB RPI sampled in the first catalogue pass.
- Example question: "What is the latest HDB resale price index?"
- Caveats: Duplicate of verified HDB RPI d_14f63e59; d_913fd3cf is an older copy whose newest column is 2026Q1. Prefer the HDB-published dataset.

### Statistics (SingStat) A: Travel & tourism

#### Changi Airport aircraft movements, passengers, cargo and mail (monthly/annual); air passenger arrivals/departures by country

- ID: `d_98e2567a033e812081b78aabe250fc13` (plus 6 related: `d_26b26baae3317ffe90353882da4c47be`, `d_ed5a20574d59d59a3131ed3a3b19a4cb`, `d_9812eb4c2a31ee7151a534bf5db09ed3`, `d_b6f1ea41d3943fae7fcf564587e91af3`, `d_7108df0b6844857ae8ebe664652ab99c`, `d_ba460709b5b56388bf8a5bcba84e0bfb`)
- SingStat · tier low · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-08 · 13 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Context on how busy Changi is before travel.
- Example question: "How many passengers went through Changi last month?"
- Sample: Total passengers 5,997,977 (2026Aug)
- Caveats: By-country passenger tables are stale (last updated 2025).

#### Hotel statistics (average room rate, occupancy, room revenue), monthly

- ID: `d_8e62605f0c1c948702b6ea0fe45242d3` (plus 1 related: `d_a728577abbe4ff3f3409b9129be28a53`)
- SingStat · tier low · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-10 · 11 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Benchmark hotel prices when the owner plans a staycation or hosts visitors.
- Example question: "What is the average hotel room rate right now?"
- Sample: Average room rate S$284.4; occupancy 91.2% (2026Aug)

#### International visitor arrivals by place of residence (total/air/land/sea), by sex/age, length of stay; visitor days

- ID: `d_d1c33009b674dcf70b8e8c790b793f28` (plus 8 related: `d_7e7b2ee60c6ffc962f80fef129cf306e`, `d_d51bb6d1c330bf86d65de412a1daf86a`, `d_52c69f33b24be7c6da27652fd2e0d308`, `d_7c83bb4a265fdd6588be8a7036a62f19`, `d_87d4a928fbaf172af7cdd8d4254218aa`, `d_f8e030e3a0fabf9cf51ee944fe70b9d1`, `d_f1fa8e1ffdda0912360f820af84c2b9e`, `d_c6d3f73a65d1fa3a92f1f4e70e619a66`)
- SingStat · tier low · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-10 · 62 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Trivia/briefing context on tourism trends and crowding (e.g. holiday peaks from China).
- Example question: "How many tourists came to Singapore last month?"
- Sample: Total visitor arrivals 1,605,019; China 435,442 (2026Aug)
- Caveats: d_7e7b2ee6 is an older duplicate ending 2026-01.

#### Outbound departures of Singapore residents by mode of transport (air/land/sea), monthly

- ID: `d_a9109fbbdcc9e874fcce773060183cff` (plus 1 related: `d_90089b064caf754498b794466996c4c8`)
- SingStat · tier low · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-09
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Context on outbound travel peaks (e.g. school holidays) for trip planning.
- Example question: "Are a lot of residents travelling out by land this month?"

### Statistics (SingStat) A: Vehicles & transport

#### Motor vehicle quota, quota premium and prevailing quota premium (PQP), monthly

- ID: `d_22094bf608253d36c0c63b52d852dd6e`
- SingStat · tier high · CSV via datastore · updates monthly · latest 2026-09 · last updated 2026-10-11 · 50 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026Sep`)
- Use: Give COE premiums plus the PQP the owner would pay to renew an existing COE, with bid/quota counts per category.
- Example question: "What is the PQP for Cat A if I renew my COE this month?"
- Sample: Cat A QP 1st bidding S$133,009; Cat A PQP S$128,715; Cat B PQP S$131,616 (2026Sep)
- Caveats: Monthly roll-up; for per-exercise COE results use the verified COE dataset d_69b3380a. PQP is unique to this table.

#### Motor vehicle population, registrations and de-registrations (VQS), car age and CC distribution

- ID: `d_206838bdc92c07ab495af49475563da5` (plus 7 related: `d_aa457c0abaacccefd238c31cfed211d9`, `d_ede1a559013d10f234d209ac5e9fd9b4`, `d_d520d6034b5e0c4f883b4e480de28f97`, `d_d94cf5d839fc11a144f24ef971705d3e`, `d_529752a3d78beb78bd4f38e3be37f1b6`, `d_3fb55d02a8d6b7716bfa6bacaf6ef012`, `d_d9ab55b63f74e9f785a10a7b8f62ae12`)
- SingStat · tier low · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-09
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Context on car population/registration trends when the owner considers buying or scrapping a car.
- Example question: "How many new cars were registered last month?"
- Caveats: National aggregates. d_529752a3 is an older duplicate of new registrations (updated 2026-02). Car age/CC tables are annual.

#### Public transport operation and ridership, annual

- ID: `d_ba615ec4cc5d9f5b7800ad82057f36f1`
- SingStat · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-04-27
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2025`)
- Use: Answer trivia on MRT/LRT/bus ridership trends.
- Example question: "How many people ride the MRT each day on average?"
- Caveats: Annual; no line- or station-level detail.

### Statistics (SingStat) A: Weather & environment

#### Air temperature, sunshine, relative humidity and rainfall, monthly (annual folded in)

- ID: `d_1744ca68dc7ed37221b17c441042405e` (plus 1 related: `d_19c6ce4509e0bddde2062298aa8ce9ab`)
- SingStat · tier medium · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-09 · 10 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Monthly climate recap in briefings ("August was the driest in years") and seasonal comparisons for planning.
- Example question: "How much did it rain last month compared with usual?"
- Sample: Aug 2026: rainfall 41.8 mm over 5 rainy days; mean daily max 33.2 C; sunshine 8.1 h/day
- Caveats: Island-wide station (Changi), ~5-6 week lag; real-time weather comes from NEA APIs already covered.

#### Air pollution levels and air quality, annual

- ID: `d_8f5fa022cbda68494fa70e788600505b` (plus 1 related: `d_b733fb074ed97f4d322525467b0fa457`)
- SingStat · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-07-21
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2025`)
- Use: Background on annual PM2.5/ozone trends.
- Example question: "Has air quality improved over the years?"

### Statistics (SingStat) A: set aside

| Group                                                             | Datasets | Reason                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Census of Population 2000/2010/2020 cross-tabs                    | 141      | Point-in-time demographic cross-tabs (age/ethnicity/religion/language/dwelling); no recurring personal use.                                                                                                                                                                                                                                |
| Supply, Use and Input-Output Tables (2010-2021)                   | 159      | Economy-wide input-output accounting tables; no personal value.                                                                                                                                                                                                                                                                            |
| General Household Survey 2005/2015 cross-tabs                     | 68       | Old mid-decade survey cross-tabs; superseded and demographic only.                                                                                                                                                                                                                                                                         |
| Household Expenditure Survey 2002/03-2017/18 tables               | 21       | Superseded by the HES 2023 quinquennial tables kept as a candidate; also very granular cross-tabs.                                                                                                                                                                                                                                         |
| Household income tables, superseded editions (2024/2025 releases) | 34       | Older editions (series ending 2023/2024) and nominal/real change derivatives; the 2026-02 release folded into the household-income candidate covers 2000-2025.                                                                                                                                                                             |
| International trade data for Indonesia/Malaysia                   | 4        | Foreign merchandise trade statistics; no personal value.                                                                                                                                                                                                                                                                                   |
| National accounts, GDP components, productivity and capital stock | 84       | Macro accounts (deflators, capital formation, value added, compensation, surplus, GNI, demand); one GDP-growth table kept as candidate.                                                                                                                                                                                                    |
| Merchandise/services trade and trade price indices                | 87       | Exports, imports, re-exports by commodity/market, import/export/domestic-supply price indices, energy trade, air cargo, low-value goods; macro/business only.                                                                                                                                                                              |
| Monetary and financial-sector aggregates                          | 30       | Money supply, bank/finance-company balance sheets, reserves, FX turnover, insurance funds, CPF aggregates, SME loans, remittance costs; no personal decision value.                                                                                                                                                                        |
| Business, industry and investment statistics                      | 138      | Business expectations, entity formation/cessation, liquidations/bankruptcy, manufacturing, IIP, services/wholesale indices, corporate ratios, FDI, R&D, construction contracts/materials, industrial/commercial property, utilities and energy-sector output, duty-paid releases, livestock/food production, telecom/postal/media volumes. |
| Government finance and public-sector administration               | 33       | Fiscal accounts, debt, expenditure/revenue, civil-service headcounts, office holders, grassroots and charity registers.                                                                                                                                                                                                                    |
| Labour-force cross-tabs                                           | 20       | Employed/labour-force counts by age, sex, industry, occupation, qualification; candidates keep the wage and labour-market headline tables.                                                                                                                                                                                                 |
| Population, family and household demographics                     | 62       | Marriage/annulment/divorce/fertility/singlehood/death/household-structure breakdowns, citizenship grants, overseas citizens; headline indicators kept as candidates.                                                                                                                                                                       |
| Education system statistics                                       | 52       | Enrolment, intake, graduates, teachers, principals, school counts, progression rates, literacy and SDG education indicators.                                                                                                                                                                                                               |
| Health system and disease statistics                              | 34       | Disease incidence/notifications, immunisation, hospital admissions and beds, health personnel/facilities, mortality and risk-factor prevalence; annual or national aggregates without actionable personal use.                                                                                                                             |
| SDG, environment and land indicators                              | 25       | Access to electricity/water, forests and protected areas, GHG emissions, renewables share, land area/use, ICT access/skills; static national indicators.                                                                                                                                                                                   |
| Crime, justice and social-service statistics                      | 17       | Penal population, drug abusers, arrests, protection orders, ComCare, family service centres, fire and accident counts.                                                                                                                                                                                                                     |
| Leisure, culture and miscellaneous                                | 6        | Cinema attendance, library reach, sports participation, volunteering, cruise throughput, driving-licence holders, indicators of limited personal use.                                                                                                                                                                                      |

## Statistics (SingStat) B

Agencies: Department of Statistics tables, second half.

Second alphabetical half of SingStat tables (Resident Households... to Workload...). 1,032 of 1,156 are census/GHS cross-tabs, input-output matrices and macro/external-sector series with no personal value. The useful remainder is mid-value context: crime and loan-shark cases by Neighbourhood Police Centre, PUB water price per m3, quarterly retrenchments/unemployment, household-income benchmarks, Census 2020 planning-area profiles and leisure/travel trends. No CPI or average-retail-price tables fall in this half; Retail Sales and F&B indices here stop at 2025-12.

Coverage: 1156 datasets, 124 in 21 entries, 1032 set aside.

### Statistics (SingStat) B: Consumer economy

#### Retail Sales Index (2017=100) by industry, current prices / volume, monthly; Retail Sales Value

- ID: `d_8bd9b9872c7fcb456b7d2891a350be34` (plus 8 related: `d_0b5d936b4d4b3c7cd60bcc1ef5d0727a`, `d_0cd4e1d703f04efda7dcf64485c950cc`, `d_6b78d625911483860e162288a4000a0c`, `d_8111c3a9c68c26da21db7ba531a8f48f`, `d_8b5956aec84950c38ea24b265f8e182f`, `d_8c7032c995dd4c71bdc12429f2a32e92`, `d_96587181d80e9cb8a8b1984342c79a5f`, `d_e5f83bef6d21f3e9edd7f9308bf9eeba`)
- SingStat · tier low · CSV via datastore · updates monthly · latest 2025-12 · last updated 2026-02-05 · 16 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2025Dec`)
- Use: Consumer-spending trend for economic briefings (supermarkets, department stores, motor vehicles, etc.).
- Example question: "Are retail sales up year on year?"
- Sample: 2025-12 RSI total 120.627 (supermarkets 130.999)
- Caveats: Appears frozen: coverage ends 2025-12 and last updated 2026-02-05 (likely superseded by a rebased series on SingStat). 9 variants (SA, volume, quarterly, annual, value) folded in.

#### Value of Food & Beverage Sales - Estimated (monthly)

- ID: `d_73fe329d76ce493c14ee4cb70a7dbcdd`
- SingStat · tier low · CSV via datastore · updates monthly · latest 2025-12 · last updated 2026-02-05 · 1 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2025Dec`)
- Use: F&B spending trend for economic context.
- Example question: "How much do Singaporeans spend eating out each month?"
- Sample: 2025-12 F&B sales est. $1,036m
- Caveats: Same frozen status as RSI (ends 2025-12). Single series.

### Statistics (SingStat) B: Family

#### Childcare and Infant Care places and enrolment (annual)

- ID: `d_734ca14d3ac601a577189326af1b688a` (plus 1 related: `d_aca378d80d90390d6776e6de442c4ac6`)
- SingStat / ECDA · tier low · CSV via datastore · updates annual · latest 2024 · last updated 2025-07-09
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2024`)
- Use: National context on childcare capacity vs enrolment if the owner is planning for children.
- Example question: "Is there a shortage of infant care places?"
- Caveats: National totals only, latest 2024; ECDA centre listings would be far more useful.

#### Senior Activity Centres and Active Ageing Centres (count)

- ID: `d_0f70d7095a527be4ea443a7e30597896`
- SingStat / MSF · tier low · CSV via datastore · updates annual · latest 2024 · last updated 2025-06-10
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2024`)
- Use: Context only (number of active ageing centres) for eldercare conversations.
- Example question: "How many active ageing centres are there?"
- Caveats: Counts only, no locations; latest 2024.

### Statistics (SingStat) B: Housing

#### Supply of Private Residential Properties in the Pipeline; residential dwelling stock; HDB units built/sold

- ID: `d_055b6549444dedb341c50805d9682a41` (plus 3 related: `d_06d2fe53728d2d971f1a8beae3c882d9`, `d_5363b6c403ae9a7d91c387eae64c4fac`, `d_6c58a523a05b55836f383fa2a68d332d`)
- SingStat / URA / HDB · tier low · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-24 · 10 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Context on upcoming private housing supply (under construction / planned) and dwelling stock by HDB flat type when the owner discusses property.
- Example question: "How many private homes are under construction right now?"
- Sample: 2026-Q2 landed pipeline 1,109 (985 under construction); 2026 dwelling stock 1,646,994 incl. 469,251 HDB 4-room
- Caveats: National totals; no project-level detail.

### Statistics (SingStat) B: Income & spending benchmarks

#### Household Income from Work (Annual, 2000-2025) - distribution, per member, by dwelling

- ID: `d_21d29d0fe86b444496f88a10e303a1d3` (plus 12 related: `d_084c5a0d2db8310ff3e2800ea15f326a`, `d_1f131d397e8ad8511e860c83d978ac09`, `d_282f82aa112b0a1113c06f7a64b46cb9`, `d_3de9c42642510559d0d00fe19c82c954`, `d_49007d39c294b610fbd1a21ebf1415a0`, `d_4b78b2faa9266a0aac594d7924fea155`, `d_65613d416a08fe806357c698dbf4306c`, `d_91df44d6ec5075c9271d0fe7efdf65d0`, `d_936bc5a29091b3e41e5a1a962588a653`, `d_a4229f9345138b80bde13cb1ad17a4e8`, `d_c023ffef279eed760fdf4b4f823f942f`, `d_c481389264b6032459ae728cc51423ce`)
- SingStat · tier medium · CSV via datastore · updates annual · latest 2025 · last updated 2026-02-09 · 21 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2000`)
- Use: Let the owner benchmark household income (total or per member, incl/excl employer CPF) against the national distribution and dwelling-type averages.
- Example question: "Where does a household income of $12k a month sit in Singapore?"
- Sample: 2025: 14.2% of resident households have no employed person; 4.7% earn $3,000-3,999
- Caveats: Annual (Feb release). Several near-duplicate table pairs (two naming styles); 'Including employer CPF' older variants stop at 2024-02 update; deciles table d_c023ffef ends 2024.

#### Household Expenditure Survey 2017/18 and 2012/13 (spending by income quintile, dwelling, household size; durables ownership)

- ID: `d_855146b45dc2087867ee712699830f65` (plus 17 related: `d_16920b4dc841715d676d363d7b175f04`, `d_265dbb6dd49338853882076ca5678124`, `d_2c4e8a61d3e254ef0c672192b0731de0`, `d_2f133d6dbac7607ec1a95c996130b0c8`, `d_4e75c62689c9f6f95ed60c4ad680cb7a`, `d_53f4640059b47ae7a2b95d7b837b5dd9`, `d_5dee9e6d9e7e70ac199b158ba45f5abf`, `d_6a71278e57a2fc468452f550c800fde0`, `d_7a92f2b80605305f1866884e6e8f1286`, `d_832f3dbf5ffd55ed50cbd8fefa2c2e80`, `d_8bf039f9577f326089bee6fc8d83c68a`, `d_932549ba98a4b09b06474f33e49f8e39`, `d_9b4575f66f1143652e2b23519d6d6e7f`, `d_b62b0731b0283eb4d207651363ad38af`, `d_c1fb618152bf6a0d124d809660ba68e8`, `d_d40e2e889c0f84ac040dc108f2c20095`, `d_ec086b29a5c1eed4aad343faf433bae6`)
- SingStat · tier low · CSV via datastore · updates ad-hoc (5-yearly) · latest 2017/18 · last updated 2019-07-31 · 14 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `Total`)
- Use: Benchmark the owner's monthly household spending against similar households (by income quintile or dwelling type) in budgeting conversations.
- Example question: "Is spending $6k a month normal for a household like mine?"
- Sample: HES 2017/18 average monthly household expenditure: 1st quintile $2,570, 2nd $3,753, 3rd $4,812
- Caveats: Stale: latest survey here is 2017/18 (HES 2023 not in this bucket). Treat as rough benchmark only.

### Statistics (SingStat) B: Jobs & labour market

#### Retrenched Employees by Industry and Occupational Group (quarterly)

- ID: `d_3eaf52cdcc405a80b602d031d0bd092b` (plus 2 related: `d_535e05d48561a38b6e1778bb26647c7d`, `d_bd394a0fa6e75f328953fe8ffe7f08be`)
- SingStat / MOM · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-10-07 · 46 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Add layoff trend context by industry to job-search preparation and weekly briefings.
- Example question: "Are retrenchments rising in financial services this year?"
- Sample: 2026-Q2 total retrenched 4,620 (1Q26: 3,830); manufacturing 870
- Caveats: Rounded to tens; permanent and term-contract splits are separate tables (folded in).

#### Unemployment Rate (quarterly, seasonally adjusted)

- ID: `d_b816a930bca0eb19fdf20fcbfcdd4c39` (plus 3 related: `d_285a079d823a1cc22dffb9cac325f81a`, `d_750c4fcebb690a88d19884ad3e1417a9`, `d_b0da22a41f952764376a2b7b5b0f2533`)
- SingStat / MOM · tier medium · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-10-09
- Location: none · checked: rows (first catalogue pass)
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Quarterly labour-market headline for briefings and job-search context; complements the already-verified unemployment dataset d_ca32584c.
- Example question: "What's Singapore's unemployment rate right now?"
- Caveats: Overlaps d_ca32584c91ee07d091a4ce75fa868414 (sampled in the first catalogue pass) - pick one. Non-SA quarterly and annual variants folded in.

#### Labour-force annual benchmarks (usual hours worked, LFPR by age/sex, labour force by qualification)

- ID: `d_65fe27dc2fc93860ea0cc1f1b90de036` (plus 7 related: `d_34afb1e56eb4ce56a8a3a9abd371362a`, `d_390fcb2f8c1374d3fddfa7985159b530`, `d_465c5bd4a9adae523f9577371daf5e24`, `d_55f2ab3382d80b642c4533afaae581ea`, `d_df573e15bee404c564cae8f1d1af2f89`, `d_e9ab423c904f84e410d4f569ace00a7e`, `d_fb09aa61a7e0510c099656b4433ebbca`)
- SingStat / MOM · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-07-06
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2025`)
- Use: Career-conversation benchmarks such as typical weekly hours or participation rate by age.
- Example question: "How many hours a week does the average worker in Singapore put in?"
- Caveats: Annual; two tables (d_55f2ab, d_fb09aa) last updated 2021.

### Statistics (SingStat) B: Leisure

#### Community club sports/performing-arts courses and interest groups; arts activity and ticket sales (annual)

- ID: `d_e260cd8c50925d10e8f0ee8183cafc1d` (plus 3 related: `d_11a4dc07d0a49cb09e34354eb7b299ab`, `d_3b28797e228b857753145e19c06f7275`, `d_8f2696a92ff09ab6b3cf283748e592bc`)
- SingStat / PA / NAC · tier low · CSV via datastore · updates annual · latest 2024 · last updated 2025-11-27
- Location: none · checked: metadata
- Fields: one row per data series, one column per period (latest `2024`)
- Use: Trivia-level context on community and arts participation.
- Example question: "How many arts events were held last year?"
- Caveats: Aggregate counts only; not actionable for finding classes.

#### Usage of Sport Singapore Facilities (swimming, gym attendance, court bookings)

- ID: `d_d53601f10e5e53d5fb189a8478498384` (plus 1 related: `d_ed87f458933033c060cb5a548d1829d9`)
- SingStat / SportSG · tier low · CSV via datastore · updates quarterly · latest 2026-Q2 · last updated 2026-07-21 · 15 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `20262Q`)
- Use: Context for fitness habits (how busy ActiveSG pools/gyms/courts are nationally by quarter).
- Example question: "Are ActiveSG gyms getting busier?"
- Sample: 2026-Q2: swimming pool attendances 1,748,174; gym 1,452,931; badminton bookings 237,033
- Caveats: National totals only, no per-facility breakdown.

#### Visits to Selected Places of Interest (museums, zoo, Night Safari, Bird Paradise, Science Centre)

- ID: `d_2e935d60c3d7a73b9e7a83a6f97f56dc` (plus 4 related: `d_053869b976659494f28dd60280c3e401`, `d_37734c512776b3cf6eb15a21d089db63`, `d_a1f42d77cc195898b7d4ea7359106189`, `d_bea68c4536f907aa1915d237564bce37`)
- SingStat / NHB / Mandai · tier low · CSV via datastore · updates monthly · latest 2026-06 · last updated 2026-08-11 · 17 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `1990Nov`)
- Use: Suggest when attractions tend to be less crowded and give visitor-trend context for weekend planning.
- Example question: "Is the zoo usually packed in December?"
- Sample: 2026-06 visits ('000): Science Centre 120.4, Night Safari 85.2, Mandai Bird Paradise 77.7
- Caveats: Thousands of visits, ~2-month lag; column order is odd (starts at 1990Nov), so select columns by name. d_a1f42d77 is a duplicate monthly table.

### Statistics (SingStat) B: Markets

#### SGX Equities Turnover - Mainboard/Catalist value and volume by sector (monthly)

- ID: `d_ddc980f76042e1618cacf9c54f2e7695` (plus 7 related: `d_0a2bfbf582358299938899be4c5acc81`, `d_2d75cb67659b5a64ac6c1757f35aac76`, `d_6dd4e62cb6a4c648bb2f72f8d6672552`, `d_a198e7539ab40bac42c31d08c7d61d47`, `d_bf3645a65107756c46d06fa03cdd20f9`, `d_c29c62927fd4b00134b6febcf16a5f2c`, `d_f9c3d2b398bdf96d548c4cdca31753e6`)
- SingStat / SGX · tier low · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-13 · 11 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Monthly market-activity context next to the owner's watchlist/IBKR summary (e.g. SGX turnover up/down).
- Example question: "Was SGX trading volume higher last month?"
- Sample: 2026-08 Mainboard turnover value $41,662.4m (Jul $44,094.3m)
- Caveats: Monthly aggregate by sector, ~1-2 month lag; not useful for individual stocks.

### Statistics (SingStat) B: Neighbourhood profile

#### Census 2020 planning-area profiles (household income, dwelling, size, tenancy, age, ethnicity, school travel)

- ID: `d_2d6793de474551149c438ba349a108fd` (plus 20 related: `d_0145fb635a7112d530c4edb0e814b8a9`, `d_0df2274bb51639b2ebdfe89a302f8cdc`, `d_0ef47f84a0776b27010b242038ea2c6b`, `d_18f1b1597c10ef1c347d56e8f66f3d68`, `d_1ca435a3b62aafa6857d96368971765b`, `d_21d8b67788ed8ef5705aa4bd5ec66b4b`, `d_21f546492a87dec38391fc72eb4c7890`, `d_388f9c61f437a588b47b008a012d13fa`, `d_4e150bbd35c3145ea43019212c7b46c2`, `d_6fce8e61bf5c5ce7ad36f770cb0faf78`, `d_7f243956483d5901f237e6f87b096636`, `d_90215b2256c68fe94a058cb931d29591`, `d_9e035622439b5d25a63d7ea0699c9451`, `d_9eaccc6cc0f257cfd74d5c1ceb0fb663`, `d_a58564fbed922609a0f79af96069dd9b`, `d_b19c5bc4f6916b5481f6531918440fe6`, `d_ce1804c655566f5089fff370bec37c2d`, `d_d95ae740c0f8961a0b10435836660ce0`, `d_e7ae90176a68945837ad67892b898466`, `d_e9b1f437263fceebc0c1f0e60cd7b0f0`)
- SingStat · tier low · CSV via datastore · updates ad-hoc (decennial) · latest 2020 · last updated 2022-07-28 · 32 rows
- Location: town/planning-area · checked: rows
- Fields: `Number`, `Total`, `NoEmployedPerson`, `Below_1_000`, `1_000_1_999`, `2_000_2_999`, `3_000_3_999`, `4_000_4_999`, `5_000_5_999`, `6_000_6_999`, `7_000_7_999`, `8_000_8_999`, `9_000_9_999`, `10_000_10_999`, `11_000_11_999`, `12_000_12_999`, `13_000_13_999`, `14_000_14_999`, `15_000_17_499`, `17_500_19_999`, `20_000andOver`
- Use: Describe the owner's planning area (household income mix, dwelling types, age profile) for neighbourhood context or comparing areas when house-hunting.
- Example question: "What's the typical household income in Tampines compared with Bishan?"
- Sample: Census 2020 households: Ang Mo Kio 60,220, Bedok 97,551, Bishan 29,445
- Caveats: Snapshot 2020 only (next census 2030). d_4e150bbd is a re-issue of the same income table. 21 tables folded in.

#### Population estimates (residents by planning region/age/sex, total population, citizens, non-resident pass types)

- ID: `d_3c4dc32382bdc23189428af2126dd188` (plus 7 related: `d_3cf667d761b4bdc6d4d3d3aeec37dea5`, `d_4bd9ffc2595acd61fd1a7f642caf8f36`, `d_6c26f6181f2e5dd62bf3210fa1029074`, `d_94fd56bdb981f0f966cb487d8247bf1a`, `d_986539e65706d7d1c3ee4fc47c403db3`, `d_9888fedd5239a16d08b2cdd36adc09af`, `d_b4de9dea7770690a215481e932dda8b2`)
- SingStat · tier low · CSV via datastore · updates annual · latest 2026 (end-June) · last updated 2026-10-08 · 300 rows
- Location: region · checked: rows
- Fields: one row per data series, one column per period (latest `2026`)
- Use: Answer civic/population trivia and give region-level age profile context (e.g. number of young children in the owner's region).
- Example question: "How many residents live in the North-East region now?"
- Sample: End-June 2026 Central Region residents 991,270 (2025: 975,290)
- Caveats: Annual (Sept release).

### Statistics (SingStat) B: Safety

#### Selected Major Offences by Neighbourhood Police Centre (annual)

- ID: `d_f4a7f227f7fb0d5b362424ac896567ea` (plus 2 related: `d_43bc9a5106f4264642dc38e7cc39fcd3`, `d_5767147db6e5b4c4cfa874db132fef39`)
- SingStat / SPF · tier medium · CSV via datastore · updates annual · latest 2025 · last updated 2026-08-01 · 342 rows
- Location: town/planning-area · checked: rows
- Fields: one row per data series, one column per period (latest `2025`)
- Use: Give the owner a yearly safety snapshot for their own police division/NPC (robbery, housebreaking, snatch theft, motor-vehicle theft, outrage of modesty) versus the prior year.
- Example question: "Is housebreaking going up around my area?"
- Sample: 2025 Central Police Division total 308 (Housebreaking 17, Robbery 7); Bukit Merah East NPC 78
- Caveats: Annual only, ~2-month lag; NPC names need a mapping to town/region (division names give coarse region). d_5767147d is an older duplicate of the same table; victims-by-age table folded in.

#### Road Traffic Accident Casualties (monthly)

- ID: `d_5dec466b08a55497218daf8bafbfe96c` (plus 2 related: `d_0c4f0d2d9f99c20124cbb52ef83ad6df`, `d_78ba40f0eed52ff007bccb81ee6372ed`)
- SingStat / SPF · tier low · CSV via datastore · updates monthly · latest 2026-05 · last updated 2026-06-29 · 30 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026May`)
- Use: Road-safety trend for briefings (fatalities/injuries by road-user type incl. PMD users and cyclists).
- Example question: "How many road deaths were there last month?"
- Sample: 2026-05 fatalities 11 (pedestrians 1, motorcyclists 6)
- Caveats: ~4-5 month lag; national only.

#### Unlicensed Moneylending and Harassment cases by NPC (annual)

- ID: `d_b6dc6308d208f668232b4f9e171af3a4` (plus 1 related: `d_2e8c7fffdfb3f4a85b06a7647072b731`)
- SingStat / SPF · tier low · CSV via datastore · updates annual · latest 2025 · last updated 2026-09-01 · 150 rows
- Location: town/planning-area · checked: rows
- Fields: one row per data series, one column per period (latest `2025`)
- Use: Add loan-shark/harassment counts for the owner's police division to a neighbourhood safety summary.
- Example question: "Are there many loan-shark harassment cases in my area?"
- Sample: 2025 Central Police Division 146 (UML 25, harassment 121); Bukit Merah East NPC 66
- Caveats: Annual; NPC-to-town mapping needed. National total table folded in.

### Statistics (SingStat) B: Travel

#### Scheduled Aircraft Movements and Transit Passengers at Changi (monthly); sea passengers (quarterly)

- ID: `d_a430153d90c8c0ad964fa822bd1d6b2b` (plus 2 related: `d_18f279334e39d96468fedf422bdaeb96`, `d_2dd0f4a7349da2886662a6a8e2c42cd5`)
- SingStat / CAAS · tier low · CSV via datastore · updates monthly · latest 2026-08 · last updated 2026-10-07 · 6 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026Aug`)
- Use: Travel-season context (aircraft arrivals/departures trend) when the owner plans trips.
- Example question: "Is Changi busier this month than last year?"
- Sample: 2026-08 foreign airline aircraft arrivals 6,773; transit passengers 56,424
- Caveats: Only transit passengers and aircraft movements, not total passenger arrivals. Sea Passenger Handled (quarterly) folded in.

### Statistics (SingStat) B: Utilities & household costs

#### Water Prices (domestic potable tariff incl. taxes)

- ID: `d_f979ebe9adca8ac412a60d3f59b40f98` (plus 1 related: `d_9db4902c7a47357441dac7d2806032a5`)
- SingStat / PUB · tier medium · CSV via datastore · updates annual · latest 2026 · last updated 2026-05-18 · 26 rows
- Location: none · checked: rows
- Fields: one row per data series, one column per period (latest `2026`)
- Use: Explain or sanity-check the water component of the SP utilities bill (tariff, water conservation tax, waterborne tax per m3, 0-40 vs >40 m3 tiers).
- Example question: "How much am I paying per cubic metre of water now?"
- Sample: 2026 domestic 0-40 m3: $3.24/m3 (tariff 1.43 + WCT 0.72 + waterborne 1.09); >40 m3: $4.39/m3
- Caveats: Annual; changes only on tariff revisions. Water Sales (d_9db4902c) folded in but is low value.

### Statistics (SingStat) B: set aside

| Group                                                                                                                                                                                                                                                              | Datasets | Reason                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------ |
| Census of Population 2000 cross-tabs                                                                                                                                                                                                                               | 206      | Twenty-six-year-old demographic cross-tabs; no current personal use.                                   |
| Census of Population 2010 cross-tabs                                                                                                                                                                                                                               | 171      | Superseded by Census 2020; demographic cross-tabs.                                                     |
| Census of Population 2020 national cross-tabs (non-planning-area)                                                                                                                                                                                                  | 151      | National demographic/education/religion/language cross-tabs; planning-area tables kept as a candidate. |
| General Household Survey 2005 cross-tabs                                                                                                                                                                                                                           | 147      | Stale demographic cross-tabs.                                                                          |
| General Household Survey 2015 cross-tabs (incl. planning-area)                                                                                                                                                                                                     | 167      | Superseded by Census 2020 planning-area tables.                                                        |
| Household Expenditure Survey 2002/03 and 2007/08                                                                                                                                                                                                                   | 8        | Superseded by HES 2012/13 and 2017/18 (candidate).                                                     |
| Supply, Use and Input-Output tables (2010-2021)                                                                                                                                                                                                                    | 66       | Inter-industry coefficient matrices; macro-economic modelling only.                                    |
| Balance of payments, FDI, international investment, external debt, merchandise/services trade                                                                                                                                                                      | 28       | Macro external-sector statistics with no personal use.                                                 |
| National accounts, productivity, unit costs, producer/manufactured-product price indices, corporate finances, manufacturing census, insurance funds, donations                                                                                                     | 48       | Macro/industry aggregates; no resident-level decision value.                                           |
| Energy balances, fossil-fuel taxes, waste/recycling, sea cargo and vessel arrivals                                                                                                                                                                                 | 9        | Aggregate national energy/environment/shipping statistics.                                             |
| Telecommunications subscriptions and broadband penetration                                                                                                                                                                                                         | 8        | Industry subscription counts; no personal value.                                                       |
| Tourism receipts                                                                                                                                                                                                                                                   | 1        | Macro tourism revenue.                                                                                 |
| Misc annual social/admin stats (courts workload, trade disputes, trade unions, WSQ/training, education enrolment, student medical/dental, marital status, HQA, homes for the aged, volunteers, CPF withdrawals, commercial/industrial space supply, body donation) | 22       | Aggregate administrative counts with no clear personal-assistant use.                                  |
