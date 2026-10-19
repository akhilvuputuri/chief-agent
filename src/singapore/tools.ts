import { ToolValidationError } from "../tool-errors.js";
import { Carparks } from "./carparks.js";
import { DataGov } from "./datagov.js";
import { DataMall } from "./datamall.js";
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
  constructor(options: SgHttpOptions = {}) {
    const now = options.now ?? Date.now;
    const http = new SgHttp(options);
    this.dataGov = new DataGov(http, now);
    this.dataMall = new DataMall(http, now);
    this.carparks = new Carparks(this.dataGov, this.dataMall, now);
  }
  get dataMallConfigured() {
    return this.dataMall.configured;
  }
  async call(a: SingaporeAction) {
    try {
      return await this.dispatch(a);
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
  private dispatch(a: SingaporeAction) {
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
