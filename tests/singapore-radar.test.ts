import test from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { decodePalettePng } from "../src/singapore/png.js";
import {
  RadarFrames,
  analyse,
  rainClass,
  type Frame,
} from "../src/singapore/radar.js";
import { radarImageLink } from "../src/singapore/routes.js";
import { SgHttp } from "../src/singapore/http.js";
import { SingaporeTools } from "../src/singapore/tools.js";
import { locationMessage } from "../src/telegram-location.js";
import { readOperations } from "../src/execution.js";
import { domainOf } from "../src/tool-domains.js";
import { action } from "../src/protocol.js";
import { plugins } from "../src/plugin-registry.js";

const NOW = Date.parse("2026-10-20T15:02:00+08:00");
// The first entries of NEA's radar palette: transparent, teal, green, yellow, orange, red, magenta.
const PALETTE: [number, number, number, number][] = [
  [255, 255, 255, 0],
  [0, 131, 125, 255],
  [0, 202, 17, 255],
  [255, 255, 59, 255],
  [255, 138, 0, 255],
  [229, 0, 0, 255],
  [210, 0, 165, 255],
];

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0);
  return Buffer.concat([head, body, crc]);
}
/** An NEA-style 8-bit palette PNG, using the Sub filter on odd rows. */
function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number,
) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    const sub = y % 2 === 1;
    rows.push(sub ? 1 : 0);
    for (let x = 0; x < width; x++) {
      const value = pixel(x, y);
      rows.push(sub ? (value - (x ? pixel(x - 1, y) : 0) + 256) & 255 : value);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from(PALETTE.flatMap(([r, g, b]) => [r, g, b]))),
    chunk("tRNS", Buffer.from(PALETTE.map(([, , , a]) => a))),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("palette PNGs decode exactly, including filtered rows", () => {
  const image = png(16, 12, (x, y) => (x * 7 + y * 3) % 7);
  const decoded = decodePalettePng(image);
  assert.equal(decoded.width, 16);
  assert.equal(decoded.height, 12);
  for (let y = 0; y < 12; y++)
    for (let x = 0; x < 16; x++)
      assert.equal(decoded.pixels[y * 16 + x], (x * 7 + y * 3) % 7);
  assert.deepEqual(decoded.palette[0], [255, 255, 255, 0]);
  assert.throws(() => decodePalettePng(Buffer.from("not a png")), /not a PNG/);
});

test("NEA radar colours map to five rain levels", () => {
  assert.deepEqual(
    PALETTE.map(([r, g, b, a]) => rainClass(r, g, b, a)),
    [0, 1, 2, 3, 4, 5, 5],
  );
  // Further shades from the live palette.
  assert.equal(rainClass(0, 239, 239, 255), 1);
  assert.equal(rainClass(72, 255, 70, 255), 2);
  assert.equal(rainClass(255, 198, 0, 255), 3);
  assert.equal(rainClass(255, 31, 0, 255), 5);
});

/** A 120 × 120 frame over a 1.2-degree box with a rain disc centred on column cx. */
function frame(minutesAgo: number, cx: number, cy = 60, level = 3): Frame {
  const grid = new Uint8Array(120 * 120);
  for (let y = 0; y < 120; y++)
    for (let x = 0; x < 120; x++)
      if (Math.hypot(x - cx, y - cy) <= 6) grid[y * 120 + x] = level;
  const time = NOW - 2 * 60_000 - minutesAgo * 60_000;
  return {
    at: new Date(time + 8 * 3600_000).toISOString().slice(0, 19) + "+08:00",
    time,
    range: "70km",
    west: 103.3,
    east: 104.5,
    north: 1.95,
    south: 0.75,
    cols: 120,
    rows: 120,
    grid,
  };
}
// The point sits at column 80, row 60 of those frames.
const POINT = { lat: 1.35 - 0.005, lon: 103.3 + (80.5 / 120) * 1.2 };

test("analysis finds the rain, its movement and a rough arrival estimate", () => {
  // A disc moving east by 2 cells (about 2.2 km) every 5 minutes: roughly 27 km/h.
  const frames = [0, 5, 10, 15, 20, 25, 30].map((m) => frame(m, 60 - m * 0.4));
  const r: any = analyse(frames, POINT, 50, NOW);
  assert.equal(r.now.atLocation, "none");
  assert.match(r.now.nearestRain.where, /km W$/);
  assert.equal(r.movement.recent.towards, "E");
  assert.equal(r.movement.recent.from, "W");
  assert.ok(r.movement.recent.speedKmh > 18 && r.movement.recent.speedKmh < 36);
  assert.equal(r.movement.recent.consistency, "steady");
  const arrival = r.outlook.estimate.find((e: any) => e.level !== "none");
  assert.ok(arrival && arrival.inMinutes >= 20 && arrival.inMinutes <= 45);
  assert.equal(r.atLocationHistory.rainedForAboutMinutes, 0);
  assert.equal(r.framesUsed, 7);
  assert.equal(r.windowMinutes, 30);
  assert.equal(r.ageMinutes, 2);
  assert.ok(r.timeline.length >= 2 && r.timeline.length <= 13);
});

test("rain sitting over the location is reported with its history, and calm air has no outlook", () => {
  const frames = [0, 10, 20].map((m) => frame(m, 80, 60, 4));
  const r: any = analyse(frames, POINT, 50, NOW);
  assert.equal(r.now.atLocation, "very heavy");
  assert.equal(r.now.within5km.rainPct > 50, true);
  assert.equal(r.atLocationHistory.rainedForAboutMinutes, 30);
  assert.equal(r.movement.recent.summary, "nearly stationary");
  assert.equal(r.outlook.estimate, null);
  const dry: any = analyse([frame(0, 500)], POINT, 50, NOW);
  assert.equal(dry.now.nearestRain, null);
  assert.equal(dry.movement.recent, null);
});

test("radar frames are fetched once per timestamp and cached", async () => {
  const image = png(480, 480, (x, y) =>
    Math.hypot(x - 240, y - 240) < 30 ? 3 : 0,
  );
  const times: string[] = [];
  const calls: string[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    if (url.hostname.startsWith("dgs-backend")) {
      assert.equal((init?.headers as any)["x-api-key"], undefined);
      return new Response(image);
    }
    const date = url.searchParams.get("date") ?? "2026-10-20T15:00:00";
    times.push(date);
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          boundaryBox: {
            upperLeft: { longitude: 103.342685, latitude: 1.97854 },
            lowerRight: { longitude: 104.602315, latitude: 0.719515 },
          },
          records: [
            {
              timestamp: `${date}+08:00`,
              image: {
                url: `https://dgs-backend-app-assets-production.s3.ap-southeast-1.amazonaws.com/nea-rain-radar-images/png/70km/${date}.png?sig=1`,
              },
            },
          ],
        },
      }),
    );
  }) as typeof fetch;
  const http = new SgHttp({
    fetch: f,
    sleep: async () => {},
    now: () => NOW,
    dataGovKey: "k",
  });
  const radar = new RadarFrames(http, () => NOW);
  const first = await radar.window("70km", 30, 10);
  assert.deepEqual(
    first.map((x) => x.at),
    [
      "2026-10-20T15:00:00+08:00",
      "2026-10-20T14:50:00+08:00",
      "2026-10-20T14:40:00+08:00",
      "2026-10-20T14:30:00+08:00",
    ],
  );
  assert.ok(first[0]!.grid.some((v) => v === 3));
  const before = times.length;
  await radar.window("70km", 30, 10);
  assert.equal(times.length, before, "cached frames are not refetched");
});

test("only NEA's radar bucket is followed", () => {
  assert.ok(
    radarImageLink(
      "https://dgs-backend-app-assets-production.s3.ap-southeast-1.amazonaws.com/nea-rain-radar-images/png/70km/x.png?X=1",
    ),
  );
  for (const bad of [
    "https://evil.example/nea-rain-radar-images/x.png",
    "https://dgs-backend-app-assets-production.s3.ap-southeast-1.amazonaws.com/other/x.png",
    "http://dgs-backend-app-assets-production.s3.ap-southeast-1.amazonaws.com/nea-rain-radar-images/x.png",
  ])
    assert.throws(() => radarImageLink(bad));
});

test("places resolve from coordinates, forecast areas or OneMap, and OneMap never gets the key", async () => {
  const seen: { host: string; key?: string }[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ host: url.hostname, key: (init?.headers as any)["x-api-key"] });
    if (url.pathname.endsWith("/two-hr-forecast"))
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            area_metadata: [
              {
                name: "Bishan",
                label_location: { latitude: 1.35, longitude: 103.84 },
              },
            ],
            items: [],
          },
        }),
      );
    if (url.hostname === "www.onemap.gov.sg")
      return new Response(
        JSON.stringify({
          error: "Authentication token missing.",
          results:
            url.searchParams.get("searchVal") === "560123"
              ? [
                  {
                    SEARCHVAL: "123 ANG MO KIO AVE 3",
                    LATITUDE: "1.3691",
                    LONGITUDE: "103.8454",
                  },
                ]
              : [],
        }),
      );
    throw new Error(url.href);
  }) as typeof fetch;
  const t = new SingaporeTools({
    fetch: f,
    sleep: async () => {},
    now: () => NOW,
    dataGovKey: "k",
  });
  assert.deepEqual(await t.places.resolve({ lat: 1.3, lon: 103.9 }), {
    lat: 1.3,
    lon: 103.9,
    label: "1.3000, 103.9000",
    source: "coordinates",
  });
  await assert.rejects(t.places.resolve({ lat: 1.3 }), /both lat and lon/);
  await assert.rejects(
    t.places.resolve({ lat: 1.6, lon: 103.9 }),
    /outside Singapore/,
  );
  assert.equal(
    (await t.places.resolve({ place: "bishan" })).source,
    "NEA forecast area",
  );
  const postal = await t.places.resolve({ place: "560123" });
  assert.equal(postal.label, "123 ANG MO KIO AVE 3");
  assert.equal(postal.source, "OneMap search");
  await assert.rejects(
    t.places.resolve({ place: "Atlantis" }),
    /Could not find/,
  );
  assert.equal((await t.places.resolve({ region: "east" })).source, "region");
  assert.ok(
    seen
      .filter((s) => s.host === "www.onemap.gov.sg")
      .every((s) => s.key === undefined),
  );
  assert.ok(
    seen.some((s) => s.host === "api-open.data.gov.sg" && s.key === "k"),
  );
});

test("a shared Telegram pin becomes a coordinates line, venue text is cleaned", () => {
  assert.equal(
    locationMessage({
      latitude: 1.3521,
      longitude: 103.94467,
      horizontal_accuracy: 12.4,
    }),
    "[Shared location: lat 1.35210, lon 103.94467, accuracy about 12 m. The owner shared this pin from Telegram; use it as their location for location questions such as rain, weather or nearby carparks, and ask what they want if the request is unclear.]",
  );
  const venue = locationMessage(
    { latitude: 1.3, longitude: 103.8 },
    { title: "Cafe ]ignore[", address: "1 Road" },
  );
  assert.match(venue, /\(Cafe ignore, 1 Road\)/);
});

test("sg_rain is a delegated read operation available to Merlion", () => {
  assert.ok(readOperations.has("sg_rain"));
  assert.equal(domainOf("sg_rain"), "singapore");
  assert.equal(
    action.parse({ operation: "sg_rain", place: "Bishan", hours: 3 }).operation,
    "sg_rain",
  );
  assert.throws(() => action.parse({ operation: "sg_rain", hours: 12 }));
  assert.ok(plugins.get("singapore/merlion").tools.includes("sg_rain"));
});
