import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  downloadLink,
  hosts,
  routeUrl,
  routes,
} from "../src/singapore/routes.js";
import { SgBusyError, SgHttp } from "../src/singapore/http.js";
import { regionOf, svy21ToWgs84, inSingapore } from "../src/singapore/geo.js";
import {
  dmy,
  matchesQuery,
  psiBand,
  usAqi,
  usAqiBand,
} from "../src/singapore/format.js";
import { SingaporeTools } from "../src/singapore/tools.js";
import { readOperations } from "../src/execution.js";
import { runtimeContext } from "../src/runtime.js";
import { action } from "../src/protocol.js";
import { domainOf, selectDomains } from "../src/tool-domains.js";
import { singaporeOperations } from "../src/singapore/schema.js";

// 2026-10-20 08:00 Singapore time.
const NOW = Date.parse("2026-10-20T08:00:00+08:00");

type Reply = { status?: number; body: unknown };
/** A fake fetch that answers by URL path and records every request. */
function fakeFetch(handler: (url: URL) => Reply) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const r = handler(url);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

const twoHour = {
  code: 0,
  data: {
    area_metadata: [
      {
        name: "Bedok",
        label_location: { latitude: 1.321, longitude: 103.924 },
      },
      {
        name: "Jurong West",
        label_location: { latitude: 1.34, longitude: 103.705 },
      },
    ],
    items: [
      {
        update_timestamp: "2026-10-20T07:36:00+08:00",
        timestamp: "2026-10-20T07:30:00+08:00",
        valid_period: {
          start: "2026-10-20T07:30:00+08:00",
          end: "2026-10-20T09:30:00+08:00",
          text: "7.30 am to 9.30 am",
        },
        forecasts: [
          { area: "Bedok", forecast: "Thundery Showers" },
          { area: "Jurong West", forecast: "Cloudy" },
        ],
      },
    ],
  },
  errorMsg: "",
};
const day = {
  code: 0,
  data: {
    records: [
      {
        updatedTimestamp: "2026-10-20T05:40:00+08:00",
        general: {
          forecast: { text: "Thundery Showers" },
          temperature: { low: 25, high: 34 },
          relativeHumidity: { low: 60, high: 95 },
          wind: { direction: "SE", speed: { low: 10, high: 20 } },
        },
        periods: [
          {
            timePeriod: { text: "6 am to Midday 20 Oct" },
            regions: {
              east: { text: "Showers" },
              west: { text: "Cloudy" },
              north: { text: "Cloudy" },
              south: { text: "Cloudy" },
              central: { text: "Cloudy" },
            },
          },
        ],
      },
    ],
  },
};
const rainfall = {
  code: 0,
  data: {
    stations: [
      {
        id: "S1",
        name: "Bedok North",
        location: { latitude: 1.33, longitude: 103.93 },
      },
      {
        id: "S2",
        name: "Jurong",
        location: { latitude: 1.34, longitude: 103.7 },
      },
    ],
    // Twenty minutes stale on purpose.
    readings: [
      {
        timestamp: "2026-10-20T07:35:00+08:00",
        data: [
          { stationId: "S1", value: 1.4 },
          { stationId: "S2", value: 0 },
        ],
      },
    ],
  },
};
const regionsOf = (v: (r: string) => number) =>
  Object.fromEntries(
    ["north", "south", "east", "west", "central"].map((r) => [r, v(r)]),
  );
const psi = {
  code: 0,
  data: {
    items: [
      {
        timestamp: "2026-10-20T07:00:00+08:00",
        readings: {
          psi_twenty_four_hourly: regionsOf((r) => (r === "west" ? 114 : 52)),
        },
      },
    ],
  },
};
const pm25 = {
  code: 0,
  data: {
    items: [
      {
        timestamp: "2026-10-20T07:00:00+08:00",
        readings: { pm25_one_hourly: regionsOf(() => 60) },
      },
    ],
  },
};
const uv = {
  code: 0,
  data: {
    records: [{ index: [{ hour: "2026-10-20T07:00:00+08:00", value: 1 }] }],
  },
};
const wbgt = {
  code: 0,
  data: {
    records: [
      {
        datetime: "2026-10-20T07:45:00+08:00",
        item: {
          readings: [
            {
              station: { name: "Changi" },
              location: { latitude: "1.36", longitude: "103.98" },
              wbgt: "31.2",
              heatStress: "Moderate",
            },
            {
              station: { name: "Clementi" },
              location: { latitude: "1.33", longitude: "103.70" },
              wbgt: "27",
              heatStress: "Low",
            },
          ],
        },
      },
    ],
  },
};
const lightning = {
  code: 0,
  data: {
    records: [
      {
        datetime: "2026-10-20T07:58:00+08:00",
        item: {
          readings: [
            {
              location: { latitude: "1.35", longitude: "103.94" },
              datetime: "2026-10-20T07:55:00+08:00",
              type: "G",
            },
            // Johor, outside Singapore.
            {
              location: { latitude: "1.5551", longitude: "103.2661" },
              datetime: "2026-10-20T07:56:00+08:00",
              type: "G",
            },
          ],
        },
      },
    ],
  },
};
const flood = {
  code: 0,
  data: {
    records: [
      { datetime: "2026-10-20T07:58:00+08:00", item: { readings: [] } },
    ],
  },
};
const datastore = (records: unknown[]) => ({
  success: true,
  result: { fields: [], records, total: records.length },
});
const holidays = datastore([
  { date: "2026-11-08", day: "Sunday", holiday: "Deepavali" },
  { date: "2026-11-09", day: "Monday", holiday: "Deepavali (Observed)" },
  { date: "2027-01-01", day: "Friday", holiday: "New Year's Day" },
  { date: "2026-08-09", day: "Sunday", holiday: "National Day" },
]);
const hawkers = datastore([
  {
    name: "Old Airport Road Food Centre",
    address_myenv: "51 Old Airport Road",
    q4_cleaningstartdate: "26/10/2026",
    q4_cleaningenddate: "29/10/2026",
    remarks_q4: "nil",
    other_works_startdate: "NA",
    latitude_hc: "1.308",
    longitude_hc: "103.885",
  },
  {
    name: "Bedok Interchange Hawker Centre",
    address_myenv: "208B New Upper Changi Road",
    q4_cleaningstartdate: "7/12/2026",
    q4_cleaningenddate: "8/12/2026",
    other_works_startdate: "TBC",
    latitude_hc: "1.325",
    longitude_hc: "103.932",
    status: "Existing",
  },
  {
    // Works started but NEA has published no end date: closed until further notice.
    name: "Reno Centre",
    address_myenv: "1 Reno Road",
    other_works_startdate: "1/3/2026",
    other_works_enddate: "TBC",
    remarks_other_works: "Repairs and Redecoration",
    status: "Existing",
  },
  {
    name: "Future Hawker Centre",
    address_myenv: "9 New Town Way",
    status: "Under construction",
  },
]);
const hdbCarparks = datastore([
  {
    car_park_no: "HE12",
    address: "BLK 78/81 REDHILL LANE",
    x_coord: "26967.6",
    y_coord: "29657.7",
    car_park_type: "SURFACE CAR PARK",
    type_of_parking_system: "ELECTRONIC PARKING",
    short_term_parking: "WHOLE DAY",
    free_parking: "SUN & PH FR 7AM-10.30PM",
    night_parking: "YES",
    gantry_height: "4.5",
    car_park_decks: "0",
  },
  {
    car_park_no: "BE31",
    address: "BLK 232-237 BISHAN STREET 22",
    x_coord: "29560",
    y_coord: "37180",
    car_park_type: "SURFACE CAR PARK",
    free_parking: "SUN & PH FR 7AM-10.30PM",
    night_parking: "NO",
    gantry_height: "0",
  },
]);
const hdbLots = {
  items: [
    {
      timestamp: "2026-10-20T07:59:00+08:00",
      carpark_data: [
        {
          carpark_number: "HE12",
          update_datetime: "2026-10-20T07:58:00",
          carpark_info: [
            { lot_type: "C", lots_available: "102", total_lots: "105" },
          ],
        },
      ],
    },
  ],
};
const empty = { type: "FeatureCollection", features: [] };

function dataGovHandler(extra: Record<string, unknown> = {}) {
  return (url: URL): Reply => {
    const p = url.pathname;
    if (p.endsWith("/two-hr-forecast")) return { body: twoHour };
    if (p.endsWith("/twenty-four-hr-forecast")) return { body: day };
    if (p.endsWith("/rainfall")) return { body: rainfall };
    if (p.endsWith("/psi")) return { body: psi };
    if (p.endsWith("/pm25")) return { body: pm25 };
    if (p.endsWith("/uv")) return { body: uv };
    if (p.endsWith("/weather/flood-alerts")) return { body: flood };
    if (p.endsWith("/weather"))
      return {
        body: url.searchParams.get("api") === "wbgt" ? wbgt : lightning,
      };
    if (p.endsWith("/datastore_search")) {
      const id = url.searchParams.get("resource_id");
      if (id === "d_8ef23381f9417e4d4254ee8b4dcdb176")
        return { body: holidays };
      if (id === "d_bda4baa634dd1cc7a6c7cad5f19e2d68") return { body: hawkers };
      if (id === "d_23f946fa557947f93a8043bbef41dd09")
        return { body: hdbCarparks };
      if (id === "d_3b0c377cde41041c93f893d0a92e9fe7")
        return { body: datastore([]) };
    }
    if (p.endsWith("/poll-download"))
      return {
        body: {
          code: 0,
          data: {
            url: `https://s3.ap-southeast-1.amazonaws.com/blobs.data.gov.sg/${p.split("/")[5]}.geojson`,
          },
        },
      };
    if (url.hostname === "s3.ap-southeast-1.amazonaws.com")
      return { body: extra[url.pathname] ?? empty };
    if (p.endsWith("/carpark-availability")) return { body: hdbLots };
    throw new Error(`unexpected ${url.href}`);
  };
}
const tools = (handler: (u: URL) => Reply, dataMallKey?: string) => {
  const f = fakeFetch(handler);
  return {
    t: new SingaporeTools({
      fetch: f.fn,
      now: () => NOW,
      sleep: noSleep,
      dataMallKey,
    }),
    calls: f.calls,
  };
};

test("Singapore routes are a fixed GET inventory with validated parameters", () => {
  assert.equal(
    routeUrl("wbgt").url.href,
    "https://api-open.data.gov.sg/v2/real-time/api/weather?api=wbgt",
  );
  assert.equal(
    routeUrl("busArrival", {}, { BusStopCode: "83139" }).url.href,
    "https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=83139",
  );
  assert.throws(
    () => routeUrl("busArrival", {}, { Other: "x" }),
    /unexpected parameter/,
  );
  assert.throws(
    () => routeUrl("download", { dataset: "../x" }),
    /invalid dataset/,
  );
  assert.equal(routeUrl("datastore").provider, "dataGovStore");
  assert.equal(
    routeUrl("download", { dataset: "d_" + "a".repeat(32) }).provider,
    "dataGovFiles",
  );
  assert.equal(routeUrl("psi").provider, "dataGovRealtime");
  assert.equal(routeUrl("trainAlerts").provider, "dataMall");
  assert.ok(Object.values(routes).every((r) => r.host in hosts));
  assert.equal(
    downloadLink(
      "https://s3.ap-southeast-1.amazonaws.com/blobs.data.gov.sg/d_1.geojson?X-Amz=1",
    ).hostname,
    "s3.ap-southeast-1.amazonaws.com",
  );
  assert.throws(() => downloadLink("https://evil.example/blobs.data.gov.sg/x"));
  assert.throws(() =>
    downloadLink("https://s3.ap-southeast-1.amazonaws.com/other-bucket/x"),
  );
  assert.throws(() =>
    downloadLink("http://s3.ap-southeast-1.amazonaws.com/blobs.data.gov.sg/x"),
  );
});

test("Singapore API origins appear only in the routes module", async () => {
  // Attribution links name the licence page, never an API route.
  const allowed = "https://data.gov.sg/open-data-licence";
  const walk = async (dir: URL): Promise<[string, string][]> => {
    const out: [string, string][] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? "/" : ""), dir);
      if (e.isDirectory()) out.push(...(await walk(u)));
      else if (e.name.endsWith(".ts"))
        out.push([u.pathname, await readFile(u, "utf8")]);
    }
    return out;
  };
  for (const [file, text] of await walk(new URL("../src/", import.meta.url))) {
    if (file.endsWith("/singapore/routes.ts")) continue;
    const scrubbed = text.split(allowed).join("");
    for (const origin of Object.values(hosts))
      assert.ok(!scrubbed.includes(origin), `${file} names ${origin}`);
  }
});

test("SVY21 converts to WGS84 and places map to NEA regions", () => {
  // HDB carpark ACB, Albert Centre.
  const acb = svy21ToWgs84(31490.4942, 30314.7936);
  assert.ok(
    Math.abs(acb.lat - 1.30106) < 0.0005 &&
      Math.abs(acb.lon - 103.85412) < 0.0005,
  );
  assert.equal(regionOf({ lat: 1.353, lon: 103.945 }), "east"); // Tampines
  assert.equal(regionOf({ lat: 1.436, lon: 103.786 }), "north"); // Woodlands
  assert.equal(regionOf({ lat: 1.34, lon: 103.705 }), "west"); // Jurong West
  assert.equal(regionOf({ lat: 1.351, lon: 103.848 }), "central"); // Bishan
  assert.equal(inSingapore({ lat: 1.5551, lon: 103.2661 }), false);
  assert.equal(dmy("7/12/2026"), "2026-12-07");
  assert.equal(dmy("TBC"), null);
  assert.equal(psiBand(114), "unhealthy");
  assert.ok(matchesQuery("bishan st 22", "BLK 232 BISHAN ST 22"));
  assert.ok(!matchesQuery("bishan street 22", "BLK 218-227 BISHAN STREET 23"));
  assert.ok(!matchesQuery("!!!", "anything"));
  assert.ok(!matchesQuery("宏茂桥", "BLK 1 ANG MO KIO"));
});

test("requests are paced per rate-limit group and a 429 opens that group's breaker only", async () => {
  const waits: number[] = [];
  let clock = NOW;
  let throttle = true;
  const f = fakeFetch((url) => {
    if (url.pathname.endsWith("/datastore_search") && throttle) {
      throttle = false;
      return { status: 429, body: { code: 24, name: "TOO_MANY_REQUESTS" } };
    }
    return {
      body: url.pathname.endsWith("/datastore_search")
        ? datastore([])
        : { code: 0, data: {} },
    };
  });
  const http = new SgHttp({
    fetch: f.fn,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  await http.json("psi");
  await http.json("pm25");
  assert.deepEqual(waits, [2500], "anonymous real-time calls are 2.5 s apart");
  await assert.rejects(
    http.json("datastore", { resource_id: "d_x" }),
    SgBusyError,
  );
  // The datastore breaker does not block the real-time feeds.
  await http.json("uv");
  await assert.rejects(
    http.json("datastore", { resource_id: "d_x" }),
    SgBusyError,
  );
  clock += 61_000;
  await http.json("datastore", { resource_id: "d_x" });
  assert.equal(
    f.calls.at(-1)!.headers["user-agent"]?.startsWith("ChiefAssistant/"),
    true,
  );
  assert.equal(f.calls.at(-1)!.headers["x-api-key"], undefined);
});

test("keys are sent only to their own provider and DataMall is refused without one", async () => {
  const f = fakeFetch(() => ({ body: { code: 0, data: {}, value: [] } }));
  const keyed = new SgHttp({
    fetch: f.fn,
    sleep: noSleep,
    dataGovKey: "dg",
    dataMallKey: "lta",
  });
  await keyed.json("psi");
  await keyed.json("trainAlerts");
  assert.equal(f.calls[0]!.headers["x-api-key"], "dg");
  assert.equal(f.calls[0]!.headers.AccountKey, undefined);
  assert.equal(f.calls[1]!.headers.AccountKey, "lta");
  assert.equal(f.calls[1]!.headers["x-api-key"], undefined);
  assert.equal(keyed.gap("dataGovRealtime"), 400);
  const bare = new SgHttp({ fetch: f.fn, sleep: noSleep });
  await assert.rejects(bare.json("trainAlerts"), /not configured/);
  assert.equal(f.calls.length, 2);
  const unauthorised = new SgHttp({
    fetch: fakeFetch(() => ({ status: 401, body: "" })).fn,
    sleep: noSleep,
    dataMallKey: "wrong",
  });
  await assert.rejects(
    unauthorised.json("trainAlerts"),
    /rejected the account key/,
  );
});

test("weather groups forecast areas by region and flags stale rain readings", async () => {
  const { t } = tools(dataGovHandler());
  const w: any = await t.call({ operation: "sg_weather", region: "east" });
  assert.deepEqual(w.nextTwoHours.byRegion, {
    east: { "Thundery Showers": ["Bedok"] },
  });
  assert.equal(w.nextTwoHours.validPeriod, "7.30 am to 9.30 am");
  assert.equal(w.nextTwoHours.stale, false);
  assert.deepEqual(w.next24Hours.periods, [
    { period: "6 am to Midday 20 Oct", east: "Showers" },
  ]);
  assert.deepEqual(w.next24Hours.temperatureC, [25, 34]);
  assert.equal(w.rainNow.ageMinutes, 25);
  assert.equal(w.rainNow.stale, true);
  assert.deepEqual(w.rainNow.raining.east, {
    stations: 1,
    maxMm: 1.4,
    places: ["Bedok North"],
  });
  assert.match(w.source, /Singapore Open Data Licence/);
});

test("air quality reports PSI bands, PM2.5, UV and the worst heat stress per region", async () => {
  const { t } = tools(dataGovHandler());
  const a: any = await t.call({ operation: "sg_air" });
  assert.deepEqual(a.psi24h.byRegion.west, { psi: 114, band: "unhealthy" });
  assert.deepEqual(a.psi24h.byRegion.east, { psi: 52, band: "moderate" });
  assert.equal(a.pm25OneHour.byRegion.north.band, "elevated");
  // 60 µg/m³ on the US EPA scale aqicn shows.
  assert.equal(a.pm25OneHour.byRegion.north.usAqi, 153);
  assert.equal(a.pm25OneHour.byRegion.north.usBand, "unhealthy");
  assert.match(a.pm25OneHour.usAqiNote, /aqicn/);
  assert.equal(a.uv.index, 1);
  assert.equal(a.heatStress.worstByRegion.east.level, "Moderate");
  const alerts: any = await t.call({ operation: "sg_alerts" });
  assert.deepEqual(alerts.floods.active, []);
  assert.deepEqual(Object.keys(alerts.lightningLast30Minutes.byRegion), [
    "east",
  ]);
  assert.equal(alerts.lightningLast30Minutes.byRegion.east.count, 1);
  assert.deepEqual(Object.keys(alerts.heatStressAboveLow.worstByRegion), [
    "east",
  ]);
});

test("holidays and hawker closures come from cached datasets", async () => {
  const { t, calls } = tools(dataGovHandler());
  const h: any = await t.call({ operation: "sg_holidays" });
  assert.deepEqual(
    h.holidays.map((x: any) => x.date),
    ["2026-11-08", "2026-11-09", "2027-01-01"],
  );
  assert.equal(h.publishedThrough, "2027-01-01");
  await t.call({
    operation: "sg_holidays",
    from: "2027-01-01",
    to: "2027-01-31",
  });
  assert.equal(
    calls.filter((c) => c.url.pathname.endsWith("/datastore_search")).length,
    1,
  );
  const c: any = await t.call({ operation: "sg_hawker_closures" });
  assert.deepEqual(
    c.closures.map((x: any) => [
      x.centre,
      x.from,
      x.to,
      x.endPublished,
      x.reason,
    ]),
    [
      ["Reno Centre", "2026-03-01", null, false, "other works"],
      [
        "Old Airport Road Food Centre",
        "2026-10-26",
        "2026-10-29",
        true,
        "cleaning",
      ],
    ],
  );
  // An open-ended closure is never reported as open.
  const reno: any = await t.call({
    operation: "sg_hawker_closures",
    query: "reno",
  });
  assert.equal(reno.closures.length, 1);
  assert.deepEqual(reno.openInRange, []);
  const future: any = await t.call({
    operation: "sg_hawker_closures",
    query: "future hawker",
  });
  assert.deepEqual(future.openInRange, []);
  assert.deepEqual(future.notTrading, [
    { centre: "Future Hawker Centre", status: "Under construction" },
  ]);
  const unicode: any = await t.call({
    operation: "sg_hawker_closures",
    query: "宏茂桥",
  });
  assert.equal(unicode.matchedCentres, 0);
  const bedok: any = await t.call({
    operation: "sg_hawker_closures",
    query: "bedok interchange",
  });
  assert.deepEqual(bedok.closures, []);
  assert.equal(bedok.openInRange[0].nextClosure.from, "2026-12-07");
  assert.deepEqual(bedok.openInRange[0].closureDatesTbc, ["other works"]);
  const east: any = await t.call({
    operation: "sg_hawker_closures",
    region: "east",
    to: "2026-12-31",
  });
  assert.deepEqual(
    east.closures.map((x: any) => x.centre),
    ["Bedok Interchange Hawker Centre"],
  );
});

test("carpark search joins HDB details with live lots and needs a query, codes or region", async () => {
  const { t } = tools(dataGovHandler());
  const r: any = await t.call({ operation: "sg_carparks", codes: ["he12"] });
  assert.equal(r.total, 1);
  assert.equal(r.carparks[0].freeParking, "SUN & PH FR 7AM-10.30PM");
  assert.deepEqual(r.carparks[0].lots, [
    { type: "car", available: 102, total: 105 },
  ]);
  assert.equal(r.carparks[0].lotsAgeMinutes, 2);
  assert.equal(r.liveLots, "data.gov.sg HDB carpark availability");
  const bishan: any = await t.call({
    operation: "sg_carparks",
    query: "bishan street 22",
  });
  assert.deepEqual(
    bishan.carparks.map((c: any) => [c.id, c.lots]),
    [["BE31", null]],
  );
  await assert.rejects(t.call({ operation: "sg_carparks" }), /needs a query/);
});

test("DataMall carpark lots include mall carparks when the key is configured", async () => {
  const { t } = tools((url) => {
    if (url.pathname.endsWith("/CarParkAvailabilityv2"))
      return {
        body: {
          value: [
            {
              CarParkID: "HE12",
              Area: "",
              Development: "BLK 78/81 REDHILL LANE",
              Location: "1.28 103.81",
              AvailableLots: 99,
              LotType: "C",
              Agency: "HDB",
            },
            {
              CarParkID: "1",
              Area: "Marina",
              Development: "Suntec City",
              Location: "1.29375 103.85718",
              AvailableLots: 2902,
              LotType: "C",
              Agency: "LTA",
            },
          ],
        },
      };
    return dataGovHandler()(url);
  }, "key");
  const suntec: any = await t.call({
    operation: "sg_carparks",
    query: "suntec",
  });
  assert.deepEqual(
    suntec.carparks.map((c: any) => [c.agency, c.name, c.lots[0].available]),
    [["LTA", "Suntec City", 2902]],
  );
  const he12: any = await t.call({ operation: "sg_carparks", codes: ["HE12"] });
  assert.equal(he12.carparks[0].lots[0].available, 99);
});

test("bus arrivals give minutes and fall back to first and last bus times", async () => {
  let services: unknown[] = [];
  const routesRows = [
    {
      ServiceNo: "65",
      BusStopCode: "83139",
      WD_FirstBus: "0530",
      WD_LastBus: "0015",
      SAT_FirstBus: "0530",
      SAT_LastBus: "0015",
      SUN_FirstBus: "0600",
      SUN_LastBus: "0015",
    },
  ];
  const { t } = tools((url) => {
    const p = url.pathname;
    if (p.endsWith("/v3/BusArrival"))
      return { body: { BusStopCode: "83139", Services: services } };
    if (p.endsWith("/BusStops"))
      return {
        body: {
          value: [
            {
              BusStopCode: "83139",
              RoadName: "Upp Changi Rd",
              Description: "Blk 1",
              Latitude: 1.3,
              Longitude: 103.9,
            },
          ],
        },
      };
    if (p.endsWith("/BusRoutes")) return { body: { value: routesRows } };
    if (p.endsWith("/TrainServiceAlerts"))
      return {
        body: {
          value: {
            Status: 2,
            AffectedSegments: [
              {
                Line: "EWL",
                Direction: "Pasir Ris",
                Stations: "EW1,EW2",
                FreePublicBus: "EW1,EW2",
              },
            ],
            Message: [
              { Content: "EWL delay", CreatedDate: "2026-10-20 07:50:00" },
            ],
          },
        },
      };
    if (p.endsWith("/TrafficIncidents"))
      return {
        body: {
          value: [
            {
              Type: "Accident",
              Latitude: 1.3,
              Longitude: 103.8,
              Message: "(20/10)07:40 Accident on PIE (towards Tuas)",
            },
            { Type: "Roadwork", Message: "Road Works on CTE" },
          ],
        },
      };
    throw new Error(url.href);
  }, "key");
  const none: any = await t.call({
    operation: "lta_bus_arrival",
    stop: "83139",
  });
  assert.equal(none.noEstimates, true);
  assert.deepEqual(none.scheduleAtStop, [
    {
      service: "65",
      firstBus: { weekday: "05:30", saturday: "05:30", sunday: "06:00" },
      lastBus: { weekday: "00:15", saturday: "00:15", sunday: "00:15" },
    },
  ]);
  services = [
    {
      ServiceNo: "65",
      Operator: "SBST",
      NextBus: {
        EstimatedArrival: "2026-10-20T08:00:40+08:00",
        Monitored: 1,
        Load: "SEA",
        Feature: "WAB",
        Type: "DD",
      },
      NextBus2: {
        EstimatedArrival: "2026-10-20T08:11:59+08:00",
        Monitored: 0,
        Load: "LSD",
        Feature: "",
        Type: "SD",
      },
      NextBus3: { EstimatedArrival: "", Monitored: 0 },
    },
  ];
  const live: any = await t.call({
    operation: "lta_bus_arrival",
    stop: "83139",
    service: "65",
  });
  assert.equal(live.description, "Blk 1");
  assert.deepEqual(
    live.services[0].next.map((b: any) => [
      b.arrives,
      b.live,
      b.load,
      b.wheelchair,
      b.type,
    ]),
    [
      ["Arr", true, "seats available", true, "double deck"],
      ["11 min", false, "limited standing", false, "single deck"],
    ],
  );
  assert.equal(live.noEstimates, undefined);
  const stops: any = await t.call({
    operation: "lta_bus_stops",
    query: "83139",
  });
  assert.equal(stops.stops[0].code, "83139");
  const train: any = await t.call({ operation: "lta_train_alerts" });
  assert.equal(train.status, "disrupted");
  assert.equal(train.affected[0].line, "EWL");
  assert.equal(train.messages[0].ageMinutes, 10);
  const traffic: any = await t.call({ operation: "lta_traffic", query: "PIE" });
  assert.equal(traffic.total, 1);
});

test("a throttled provider becomes a busy result and DataMall tools refuse without a key", async () => {
  const { t } = tools(() => ({ status: 429, body: { code: 24 } }));
  const busy: any = await t.call({ operation: "sg_air" });
  assert.deepEqual(
    { status: busy.status, provider: busy.provider, limit: busy.limit },
    { status: "busy", provider: "data.gov.sg", limit: "dataGovRealtime" },
  );
  assert.ok(busy.retryAfterSeconds > 0);
  await assert.rejects(
    t.call({ operation: "lta_train_alerts" }),
    /LTA DataMall is not configured/,
  );
});

test("Singapore tools are read-only, in their own domain and offered only when configured", () => {
  for (const op of singaporeOperations) {
    assert.ok(readOperations.has(op), op);
    assert.equal(domainOf(op), "singapore", op);
  }
  assert.equal(
    action.parse({ operation: "lta_bus_arrival", stop: "83139" }).operation,
    "lta_bus_arrival",
  );
  assert.throws(() =>
    action.parse({ operation: "lta_bus_arrival", stop: "8313" }),
  );
  assert.throws(() => action.parse({ operation: "sg_dataset", dataset: "x" }));
  const names = (flags: Record<string, boolean>) =>
    runtimeContext(flags, null).tools.map((t) => t.name);
  assert.ok(
    !names({}).some((n) => n.startsWith("sg_") || n.startsWith("lta_")),
  );
  // Without the DataMall key the bus tools are still offered (they answer "not configured").
  const keyless = names({ singapore: true });
  assert.ok(
    keyless.includes("sg_weather") && keyless.includes("lta_bus_arrival"),
  );
  assert.ok(
    names({ singapore: true, ltaDataMall: true }).includes("lta_bus_arrival"),
  );
  // The coordinator delegates: it gets the agents, never the tools.
  const chief = runtimeContext(
    { singapore: true, ltaDataMall: true },
    null,
    undefined,
    undefined,
    true,
  );
  assert.ok(
    !chief.tools.some(
      (t) => t.name.startsWith("sg_") || t.name.startsWith("lta_"),
    ),
  );
  const types = (ctx: { context: string }) =>
    JSON.parse(ctx.context).agentCatalogue.map((a: { type: string }) => a.type);
  assert.deepEqual(
    types(chief).filter((t: string) =>
      ["merlion", "singapore", "transport"].includes(t),
    ),
    ["merlion"],
  );
  const noKey = runtimeContext(
    { singapore: true },
    null,
    undefined,
    undefined,
    true,
  );
  assert.ok(types(noKey).includes("merlion"));
  assert.ok(
    selectDomains({ message: "will it rain in the east later?" }).has(
      "singapore",
    ),
  );
  assert.ok(
    selectDomains({ message: "when is the next bus at my stop" }).has(
      "singapore",
    ),
  );
  assert.ok(
    !selectDomains({ message: "summarise my unread email" }).has("singapore"),
  );
});

test("carpark search survives a failed reference download and live-lot outage", async () => {
  const { t } = tools((url) => {
    // URA's download link points outside the data.gov.sg bucket and is refused.
    if (url.pathname.endsWith("/poll-download"))
      return {
        body: { code: 0, data: { url: "https://evil.example/x.geojson" } },
      };
    if (url.pathname.endsWith("/carpark-availability"))
      return { status: 503, body: "" };
    return dataGovHandler()(url);
  });
  const r: any = await t.call({ operation: "sg_carparks", codes: ["HE12"] });
  assert.deepEqual(r.referenceUnavailable, ["URA"]);
  assert.equal(r.carparks[0].id, "HE12");
  assert.equal(r.carparks[0].lots, null);
  assert.match(r.liveLots, /unavailable/);
});

test("dataset file downloads never carry an API key and only http.ts calls fetch", async () => {
  const f = fakeFetch(dataGovHandler());
  const withKeys = new SingaporeTools({
    fetch: f.fn,
    now: () => NOW,
    sleep: noSleep,
    dataGovKey: "dg",
    dataMallKey: "lta",
  });
  await withKeys.call({ operation: "sg_cameras" });
  const s3 = f.calls.filter(
    (c) => c.url.hostname === "s3.ap-southeast-1.amazonaws.com",
  );
  assert.equal(s3.length, 2);
  for (const c of s3) {
    assert.equal(c.headers["x-api-key"], undefined);
    assert.equal(c.headers.AccountKey, undefined);
  }
  assert.ok(
    f.calls.some(
      (c) =>
        c.url.pathname.endsWith("/poll-download") &&
        c.headers["x-api-key"] === "dg",
    ),
  );
  const dir = new URL("../src/singapore/", import.meta.url);
  for (const file of await readdir(dir)) {
    const text = await readFile(new URL(file, dir), "utf8");
    if (file !== "http.ts")
      assert.ok(!/\bfetch\s*\(/.test(text), `${file} calls fetch`);
  }
});

test("flood alerts follow the region filter, keeping alerts whose location cannot be read", async () => {
  const floods = {
    code: 0,
    data: {
      records: [
        {
          datetime: "2026-10-20T07:58:00+08:00",
          item: {
            readings: [
              {
                location: { latitude: 1.34, longitude: 103.7 },
                description: "Flash flood at Jurong",
              },
              {
                circle: "1.35 103.94 0.5",
                description: "Flash flood at Tampines",
              },
              { description: "Flash flood, location text only" },
            ],
          },
        },
      ],
    },
  };
  const { t } = tools((url) =>
    url.pathname.endsWith("/weather/flood-alerts")
      ? { body: floods }
      : dataGovHandler()(url),
  );
  const east: any = await t.call({ operation: "sg_alerts", region: "east" });
  assert.deepEqual(
    east.floods.active.map((f: any) => f.description),
    ["Flash flood at Tampines", "Flash flood, location text only"],
  );
  assert.equal(east.floods.unlocatedAlerts, 1);
  const all: any = await t.call({ operation: "sg_alerts" });
  assert.equal(all.floods.active.length, 3);
});

test("bus services listed without estimates still get their schedule, and bad pages fail loudly", async () => {
  let stopsBody: unknown = {
    value: [{ BusStopCode: "83139", Description: "Blk 1", RoadName: "Rd" }],
  };
  const { t } = tools((url) => {
    const p = url.pathname;
    if (p.endsWith("/v3/BusArrival"))
      return {
        body: {
          Services: [
            {
              ServiceNo: "65",
              NextBus: {
                EstimatedArrival: "2026-10-20T08:05:00+08:00",
                Monitored: 1,
              },
            },
            {
              ServiceNo: "66",
              NextBus: { EstimatedArrival: "" },
              NextBus2: { EstimatedArrival: "" },
            },
          ],
        },
      };
    if (p.endsWith("/BusStops")) return { body: stopsBody };
    if (p.endsWith("/BusRoutes"))
      return {
        body: {
          value: [
            {
              ServiceNo: "65",
              BusStopCode: "83139",
              WD_FirstBus: "0530",
              WD_LastBus: "0015",
            },
            {
              ServiceNo: "66",
              BusStopCode: "83139",
              WD_FirstBus: "0900",
              WD_LastBus: "2100",
            },
          ],
        },
      };
    throw new Error(url.href);
  }, "key");
  const r: any = await t.call({ operation: "lta_bus_arrival", stop: "83139" });
  assert.equal(r.services[0].next[0].arrives, "5 min");
  assert.deepEqual(
    r.scheduleAtStop.map((s: any) => s.service),
    ["66"],
  );
  // Service 65 is arriving, so the stop as a whole is not "no estimates".
  assert.equal(r.noEstimates, false);
  assert.deepEqual(r.servicesWithoutEstimates, ["66"]);
  assert.match(r.scheduleNote, /only services without an arrival estimate/);
  stopsBody = { error: "unexpected" };
  const fresh = tools((url) => {
    if (url.pathname.endsWith("/BusStops")) return { body: stopsBody };
    throw new Error(url.href);
  }, "key");
  await assert.rejects(
    fresh.t.call({ operation: "lta_bus_stops", query: "blk" }),
    /unexpected page/,
  );
});

test("a dataset file without a ready link is initiated and polled again", async () => {
  let polls = 0;
  const f = fakeFetch((url) => {
    const p = url.pathname;
    if (p.endsWith("/poll-download"))
      return {
        body:
          ++polls < 2
            ? { code: 0, data: { status: "PENDING" } }
            : {
                code: 0,
                data: {
                  url: "https://s3.ap-southeast-1.amazonaws.com/blobs.data.gov.sg/x.geojson",
                },
              },
      };
    if (p.endsWith("/initiate-download"))
      return { body: { code: 0, data: { message: "started" } } };
    return { body: { type: "FeatureCollection", features: [] } };
  });
  const http = new SgHttp({ fetch: f.fn, sleep: noSleep });
  assert.deepEqual(await http.file("d_" + "b".repeat(32)), {
    type: "FeatureCollection",
    features: [],
  });
  assert.deepEqual(
    f.calls.map((c) => c.url.pathname.split("/").pop()),
    ["poll-download", "initiate-download", "poll-download", "x.geojson"],
  );
});

test("US AQI from NEA's hourly PM2.5 matches aqicn.org's Singapore readings", () => {
  // NEA 1-hour PM2.5 and aqicn's map at 11:00 SGT on 21 October 2026.
  assert.deepEqual(
    [33, 46, 53, 67, 82].map((v) => usAqi(v)),
    [95, 127, 144, 157, 165],
  );
  // Band edges, the top of the scale, and missing readings.
  assert.deepEqual(
    [0, 12, 12.1, 35.4, 35.5, 55.4, 55.5, 150.4, 500.4, 900].map((v) =>
      usAqi(v),
    ),
    [0, 50, 51, 100, 101, 150, 151, 200, 500, 500],
  );
  assert.equal(usAqi(null), null);
  assert.deepEqual(
    [50, 51, 101, 151, 201, 301].map((v) => usAqiBand(v)),
    [
      "good",
      "moderate",
      "unhealthy for sensitive groups",
      "unhealthy",
      "very unhealthy",
      "hazardous",
    ],
  );
});
