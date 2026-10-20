import { ToolValidationError } from "../tool-errors.js";
import { Carparks } from "./carparks.js";
import { DataGov } from "./datagov.js";
import { DataMall } from "./datamall.js";
import { Places } from "./places.js";
import { ISLAND, RadarFrames, analyse, inFrame, type Frame } from "./radar.js";
import { radarAnimation, radarMap } from "./radar-image.js";

/** "11:05 pm" in Singapore time. */
function twelveHour(ms: number) {
  const d = new Date(ms + 8 * 3600_000);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`;
}
import type { MediaOutbox } from "../media-outbox.js";
import { SgBusyError, SgHttp, type SgHttpOptions } from "./http.js";
import type { SingaporeAction } from "./schema.js";

/**
 * Read-only Singapore open-data tools (data.gov.sg and LTA DataMall), dispatched by
 * JobTools. No owner data is stored; results are cached in memory per feed.
 */
export class SingaporeTools {
  readonly dataGov: DataGov;
  readonly dataMall: DataMall;
  readonly carparks: Carparks;
  readonly radar: RadarFrames;
  readonly places: Places;
  private readonly keyedDataGov: boolean;
  private readonly now: () => number;
  /** Where radar pictures wait for the reply; without it, pictures are unavailable. */
  readonly media?: MediaOutbox;
  constructor(options: SgHttpOptions & { media?: MediaOutbox } = {}) {
    const now = options.now ?? Date.now;
    const http = new SgHttp(options);
    this.dataGov = new DataGov(http, now);
    this.dataMall = new DataMall(http, now);
    this.carparks = new Carparks(this.dataGov, this.dataMall, now);
    this.radar = new RadarFrames(http, now);
    this.places = new Places(http, this.dataGov);
    this.keyedDataGov = !!options.dataGovKey;
    this.now = now;
    this.media = options.media;
  }
  get dataMallConfigured() {
    return this.dataMall.configured;
  }
  /** `run` is the calling run, so a picture reaches the reply for that run. */
  async call(a: SingaporeAction, context: { run?: string } = {}) {
    try {
      return await this.dispatch(a, context);
    } catch (error) {
      // A throttled or failing provider is an answer, not a crash: tell the owner to retry shortly.
      if (error instanceof SgBusyError)
        return {
          status: "busy",
          provider:
            error.provider === "dataMall" ? "LTA DataMall" : "data.gov.sg",
          limit: error.provider,
          retryAfterSeconds: error.retryAfterSeconds,
        };
      throw error;
    }
  }
  private async rain(
    a: Extract<SingaporeAction, { operation: "sg_rain" }>,
    context: { run?: string },
  ) {
    const place = await this.places.resolve(a);
    const hours = a.hours ?? 1;
    const step = a.stepMinutes ?? (hours <= 1 ? 5 : hours <= 3 ? 10 : 15);
    // Each frame is one API call; without a key the anonymous limit allows few.
    const maxFrames = this.keyedDataGov ? 37 : 9;
    const stepMinutes = Math.max(
      5,
      Math.ceil(Math.max(step, (hours * 60) / (maxFrames - 1)) / 5) * 5,
    );
    const range = a.range ?? "70km";
    const frames = await this.radar.window(range, hours * 60, stepMinutes);
    if (!frames.length)
      return { status: "unavailable", note: "No radar frame was returned." };
    if (!inFrame(frames[0]!, place))
      throw new ToolValidationError(
        "That location is outside the radar picture; try range 240km",
      );
    return {
      location: place,
      stepMinutes,
      ...analyse(
        frames,
        place,
        range === "70km" ? 50 : 150,
        this.now(),
        stepMinutes,
      ),
      ...this.picture(a.picture, frames, place, context.run),
      // Frames the provider did not return; history between samples is unknown.
      ...(frames.length < Math.floor((hours * 60) / stepMinutes) + 1
        ? {
            framesMissing:
              Math.floor((hours * 60) / stepMinutes) + 1 - frames.length,
          }
        : {}),
      intensityScale:
        "NEA radar colours mapped to light, moderate, heavy, very heavy and intense; not exact mm/h",
      source:
        "Contains information from data.gov.sg (NEA rain radar) under the Singapore Open Data Licence v1.0 (https://data.gov.sg/open-data-licence).",
    };
  }
  /** Renders and queues a radar picture; the result tells the agent what will be sent. */
  private picture(
    kind: "none" | "map" | "animation" | undefined,
    frames: Frame[],
    place: { lat: number; lon: number; label: string; source: string },
    run: string | undefined,
  ) {
    if (!kind || kind === "none") return {};
    if (!this.media || !run)
      return {
        picture: {
          status: "unavailable",
          note: "Pictures cannot be sent here.",
        },
      };
    // Mark only a location the owner gave; the all-Singapore default has no dot.
    const given = place.source !== "default";
    const shown =
      given &&
      place.lat > ISLAND.south &&
      place.lat < ISLAND.north &&
      place.lon > ISLAND.west &&
      place.lon < ISLAND.east;
    const mark = shown ? place : undefined;
    const picture =
      kind === "animation" && frames.length > 1
        ? radarAnimation(frames, mark)
        : radarMap(frames[0]!, mark);
    // A short caption in the same 12-hour time the reply uses.
    const span =
      picture.kind === "animation"
        ? `${twelveHour(frames[frames.length - 1]!.time)} – ${twelveHour(frames[0]!.time)}`
        : twelveHour(frames[0]!.time);
    const where = shown
      ? ` Red dot: ${place.source === "coordinates" ? "your location" : place.label}.`
      : "";
    this.media.put(run, {
      kind: picture.kind,
      bytes: picture.bytes,
      filename: picture.filename,
      caption: `Rain radar, ${span}.${where}\nNEA radar, URA map, via data.gov.sg (Singapore Open Data Licence)`,
    });
    return {
      picture: {
        status: "queued",
        kind: picture.kind,
        note: 'Sent right after your reply. Say only that it follows, for example "The radar loop follows." Do not describe how it is sent.',
      },
    };
  }
  private dispatch(a: SingaporeAction, context: { run?: string }) {
    switch (a.operation) {
      case "sg_weather":
        return this.dataGov.weather(a.region, a.outlook ?? false);
      case "sg_air":
        return this.dataGov.air(a.region);
      case "sg_alerts":
        return this.dataGov.alerts(a.region);
      case "sg_carparks":
        if (!a.query && !a.codes && !a.region)
          throw new ToolValidationError(
            "sg_carparks needs a query, carpark codes or a region",
          );
        return this.carparks.search(a);
      case "sg_holidays":
        return this.dataGov.holidays(a.from, a.to);
      case "sg_hawker_closures":
        return this.dataGov.hawkerClosures(a.query, a.from, a.to, a.region);
      case "sg_cameras":
        return this.dataGov.cameras(a.query, a.region, a.kind);
      case "sg_dataset":
        return this.dataGov.dataset(a);
      case "sg_rain":
        return this.rain(a, context);
      case "lta_bus_arrival":
      case "lta_bus_stops":
      case "lta_train_alerts":
      case "lta_traffic":
        if (!this.dataMall.configured)
          throw new ToolValidationError("LTA DataMall is not configured");
        if (a.operation === "lta_bus_arrival")
          return this.dataMall.busArrival(a.stop, a.service);
        if (a.operation === "lta_bus_stops")
          return this.dataMall.busStops(a.query);
        if (a.operation === "lta_train_alerts")
          return this.dataMall.trainAlerts();
        return this.dataMall.traffic(a.query);
    }
  }
}
