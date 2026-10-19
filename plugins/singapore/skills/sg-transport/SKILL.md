---
name: sg-transport
description: How to present LTA bus arrivals, bus stop lookups, MRT service status and traffic incidents for Singapore.
---

# Bus, MRT and traffic

## Bus arrivals (lta_bus_arrival)

Each service returns up to three next buses:

- `arrives` is whole minutes rounded down, or "Arr" when the bus is less than a minute away;
- `live` false means the time is a schedule, not a tracked bus;
- `load` is seats available, standing available or limited standing;
- `wheelchair` is true for wheelchair-accessible buses;
- `type` is single deck, double deck or bendy.

Lead with what the owner asked: "65: 3 min (seats), 11 min, 19 min". Mention load only when it is limited standing or the owner asked.

`scheduleAtStop` gives first and last bus times by day type (weekday, Saturday, or Sunday and public holidays) for services without an arrival estimate. `noEstimates` true means nothing is arriving at the stop, or for the service asked about. When it is false, report the live arrivals normally and add a line only for the services listed in `servicesWithoutEstimates`. Use the current Singapore time and day.

- Outside those times, say the service is not running and give the next first bus.
- Inside them, say there is no estimate right now.
- After midnight, a last bus such as "00:30" belongs to the previous day's service.

Loop services such as 225G and 225W are separate services.

## Bus stops (lta_bus_stops)

Search by stop description or road words. Every stop has a 5-digit code. Opposite sides of a road are different stops with different codes, so when two match, ask which direction the owner is going.

## MRT and LRT (lta_train_alerts)

- `normal` means no disruption is reported.
- When `disrupted`, give the affected line and stations, the direction, and any free bus or free shuttle arrangements.
- LTA messages are the official advisory text. Quote them briefly with their time.

## Traffic (lta_traffic)

Incidents include accidents, vehicle breakdowns, roadworks and obstacles, each with a message that starts with its date and time. Filter by expressway (PIE, CTE, AYE and so on) or road words. Mention lane closures and exits that are closed.

## Source

End with the returned source line.
