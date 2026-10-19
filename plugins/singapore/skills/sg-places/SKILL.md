---
name: sg-places
description: How to answer Singapore carpark, free and night parking, traffic camera, public holiday and hawker centre closure questions with the Singapore tools.
---

# Carparks, cameras, holidays and hawker centres

## Carparks (sg_carparks)

**Searching:**

- Search with words from an address, development or block ("Bishan Street 22", "Suntec"), with exact carpark codes (HDB codes look like HE12 or ACB), or with a region.
- Use codes from the brief when the owner has saved ones.
- Results are capped by `limit`. When `truncated` is true, ask the owner to narrow the search instead of listing everything.

**Reading a result:**

- HDB and JTC entries have:
  - `type`;
  - `system` (electronic or coupon);
  - `shortTermParking` hours;
  - `freeParking` (for example "SUN & PH FR 7AM-10.30PM", meaning free on Sundays and public holidays from 7 am to 10.30 pm, or "NO");
  - `nightParking`;
  - `gantryHeightM`, where 0 means there is no gantry.
- `lots` are live available lots by vehicle type. null means no live count for that carpark. Mall carparks (agency LTA) come from LTA DataMall and appear only when it is configured.
- There are no parking rates. Say so if asked, and point the owner to the carpark operator, the Parking.sg app or the OneMotoring rate pages.

**Free parking on a given day:** combine `freeParking` with sg_holidays for that date.

## Cameras (sg_cameras)

- Without `kind`, the tool lists red-light and fixed speed cameras. Pass kind laser or mobile only when the owner asks about those. Laser and mobile entries are deployment sites, not always active.
- The records are old. The Traffic Police website may list newer cameras, so say this when it matters.
- The first call can take about half a minute while the layers download.

## Public holidays (sg_holidays)

- Pass a date range, or omit it for the next 12 months.
- An "(Observed)" row is the extra day off when a holiday falls on a Sunday.
- Treat a Friday or Monday holiday as part of a long weekend.
- `publishedThrough` is the last date MOM has published. Do not guess holidays beyond it.

## Hawker centres (sg_hawker_closures)

- **Arguments:** pass the centre's name or address words as `query`, and a date range. The default is the next 14 days.
- **Closed or open:** `closures` lists cleaning and repair periods that overlap the range. A matched centre with no overlapping closure is open in that range as far as NEA's schedule shows, and `openInRangeNextClosure` gives its next closure.
- **Ambiguous names:** several centres can match one name, for example two on Old Airport Road. Name the one you mean, or ask the owner.
- **Missing dates:** dates marked TBC are not listed.

## Source

End with the returned source line.
