/**
 * The only module that names the Singapore open-data hosts. Every outbound request
 * is built from one of these GET routes, so this inventory is the complete surface:
 * data.gov.sg real-time feeds, datastore search and dataset download links, plus the
 * LTA DataMall reads Chief uses. There are no write routes.
 */
export const hosts = {
  dataGovOpen: "https://api-open.data.gov.sg",
  dataGovLegacy: "https://api.data.gov.sg",
  dataGovStore: "https://data.gov.sg",
  dataMall: "https://datamall2.mytransport.sg",
} as const;
export type Host = keyof typeof hosts;
/**
 * Requests are paced per rate-limit group. data.gov.sg limits real-time APIs,
 * datastore search and downloads separately; each group has its own queue and breaker.
 */
export type Provider =
  | "dataGovRealtime"
  | "dataGovStore"
  | "dataGovFiles"
  | "dataGovLegacy"
  | "dataMall";
const groupOf = (r: Route): Provider =>
  r.host === "dataMall"
    ? "dataMall"
    : r.host === "dataGovStore"
      ? "dataGovStore"
      : r.host === "dataGovLegacy"
        ? "dataGovLegacy"
        : r.path.includes("/datasets/")
          ? "dataGovFiles"
          : "dataGovRealtime";

export interface Route {
  host: Host;
  path: string;
  /** Query parameters fixed by the route, such as the weather sub-API. */
  fixed?: Readonly<Record<string, string>>;
  /** Query parameters a caller may add. */
  query?: readonly string[];
}
const route = (
  host: Host,
  path: string,
  query: readonly string[] = [],
  fixed?: Record<string, string>,
): Route => ({ host, path, query, ...(fixed ? { fixed } : {}) });

const realtime = (name: string, fixed?: Record<string, string>) =>
  route("dataGovOpen", `/v2/real-time/api/${name}`, [], fixed);

export const routes = {
  twoHour: realtime("two-hr-forecast"),
  day: realtime("twenty-four-hr-forecast"),
  outlook: realtime("four-day-outlook"),
  psi: realtime("psi"),
  pm25: realtime("pm25"),
  uv: realtime("uv"),
  rainfall: realtime("rainfall"),
  airTemperature: realtime("air-temperature"),
  humidity: realtime("relative-humidity"),
  lightning: realtime("weather", { api: "lightning" }),
  wbgt: realtime("weather", { api: "wbgt" }),
  flood: realtime("weather/flood-alerts"),
  hdbCarparkLots: route("dataGovLegacy", "/v1/transport/carpark-availability"),
  datastore: route("dataGovStore", "/api/action/datastore_search", [
    "resource_id",
    "limit",
    "offset",
    "filters",
    "fields",
    "sort",
    "q",
  ]),
  download: route(
    "dataGovOpen",
    "/v1/public/api/datasets/{dataset}/poll-download",
  ),
  busArrival: route("dataMall", "/ltaodataservice/v3/BusArrival", [
    "BusStopCode",
    "ServiceNo",
  ]),
  busStops: route("dataMall", "/ltaodataservice/BusStops", ["$skip"]),
  busRoutes: route("dataMall", "/ltaodataservice/BusRoutes", ["$skip"]),
  trainAlerts: route("dataMall", "/ltaodataservice/TrainServiceAlerts"),
  trafficIncidents: route("dataMall", "/ltaodataservice/TrafficIncidents"),
  carparkLots: route("dataMall", "/ltaodataservice/CarParkAvailabilityv2", [
    "$skip",
  ]),
} as const satisfies Record<string, Route>;
export type RouteName = keyof typeof routes;

const DATASET = /^d_[0-9a-f]{32}$/;
/** Builds a request URL from a route; path and query values are validated, never raw. */
export function routeUrl(
  name: RouteName,
  params: Record<string, string> = {},
  query: Record<string, string | number | undefined> = {},
) {
  const r: Route = routes[name];
  const path = r.path.replace(/\{([a-z]+)\}/g, (_, key: string) => {
    const value = params[key];
    if (key !== "dataset" || !value || !DATASET.test(value))
      throw new Error(`Singapore route ${name}: invalid ${key}`);
    return value;
  });
  const url = new URL(path, hosts[r.host]);
  for (const [k, v] of Object.entries(r.fixed ?? {}))
    url.searchParams.set(k, v);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (!r.query?.includes(k))
      throw new Error(`Singapore route ${name}: unexpected parameter ${k}`);
    url.searchParams.set(k, String(v));
  }
  return { url, provider: groupOf(r) };
}

/**
 * data.gov.sg answers a download request with a short-lived link to its own S3
 * bucket. Only that bucket is followed; any other link is refused.
 */
export function downloadLink(raw: unknown) {
  if (typeof raw !== "string") throw new Error("Download link missing");
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "s3.ap-southeast-1.amazonaws.com" ||
    !url.pathname.startsWith("/blobs.data.gov.sg/")
  )
    throw new Error("Download link is not a data.gov.sg file");
  return url;
}
