---
name: sg-weather
description: How to read and present NEA weather, rain, air quality, UV, heat stress and alert results for one Singapore region.
---

# Weather, air and alerts

## Regions

Results use NEA's five regions: north, south, east, west and central. A place is assigned to the region whose NEA label point is nearest, so places near a border can land in the neighbouring region. Name the region you used. Some examples: Tampines, Bedok and Changi are east. Jurong, Clementi and Bukit Batok are west or south-west. Woodlands and Yishun are north. Bishan, Toa Payoh and Ang Mo Kio are central. The city and Sentosa are south.

## Forecasts (sg_weather)

- `nextTwoHours.byRegion` groups forecast areas by condition. Say the condition and the areas it covers, with the validity window, for example "9.30 pm to 11.30 pm".
- `next24Hours` has an overall forecast, the temperature and humidity range, wind, and three or four periods with a condition per region.
- `rainNow` counts rain gauges reporting rain in the last 5 minutes. An empty `raining` object means no gauge in that region reported rain.
- `nextFourDays` appears only when outlook is true. Use it for questions about later in the week or the weekend.

## Air quality and sun (sg_air)

- **24-hour PSI bands:** 0–50 good, 51–100 moderate, 101–200 unhealthy, 201–300 very unhealthy, above 300 hazardous.
- **When PSI is unhealthy or worse:** say that NEA advises reducing prolonged or strenuous outdoor activity. Vulnerable people (elderly, children, people with heart or lung conditions) should avoid it.
- **1-hour PM2.5 bands:** normal (0–55), elevated (56–150), high (151–250), very high (above 250). Use it for "right now" questions; PSI is the 24-hour picture.
- **US AQI (`usAqi`, `usBand`):** this hour's PM2.5 on the US EPA scale, the number aqicn.org shows for Singapore. For haze or air quality questions, give it next to PSI in one line, for example "West: PSI 131; about 165 on the US hourly scale aqicn uses." It reads higher than PSI because the US scale is stricter between about 12 and 150 µg/m³ and is not a 24-hour average. Explain that only if the owner asks or seems surprised. Do not call aqicn itself: this is computed from NEA's readings.
- **UV:** low 0–2, moderate 3–5, high 6–7, very high 8–10, extreme 11 and above. There are no readings at night.
- **Heat stress (WBGT):** Low, Moderate or High. At Moderate or High, suggest shade, water and rest for outdoor exercise.

## Alerts (sg_alerts)

- **Floods:** list active PUB flood alerts as published. When there are none, say so.
- **Lightning:** strikes in the last 30 minutes are counted per region. Recent lightning in the owner's region means outdoor activity should wait.

## Freshness

- Always give the reading time in Singapore time.
- `stale: true` means the feed has not updated as often as it should, which happens. Say the reading is old, and do not present it as current.

## Source

End with the returned source line. It is the attribution the Singapore Open Data Licence requires.
