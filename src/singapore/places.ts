import { ToolValidationError } from "../tool-errors.js";
import type { DataGov } from "./datagov.js";
import type { SgHttp } from "./http.js";
import { clip, matchesQuery, num } from "./format.js";
import { REGION_LABELS, type Region } from "./geo.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- parsed provider JSON */
type J = any;

export interface Place {
  lat: number;
  lon: number;
  label: string;
  source: string;
}

/** Loose bounds around Singapore; points outside are refused. */
export function inSingaporeArea(lat: number, lon: number) {
  return lat > 1.1 && lat < 1.5 && lon > 103.55 && lon < 104.15;
}

/**
 * Resolves where the owner means: exact coordinates (for example a shared
 * Telegram pin), a typed place, or a region. Typed places try NEA forecast
 * areas first, then OneMap address search (postal codes, buildings, MRT stations).
 */
export class Places {
  constructor(
    private readonly http: SgHttp,
    private readonly dataGov: DataGov,
  ) {}
  async resolve(input: {
    lat?: number;
    lon?: number;
    place?: string;
    region?: Region;
  }): Promise<Place> {
    if (input.lat !== undefined || input.lon !== undefined) {
      if (input.lat === undefined || input.lon === undefined)
        throw new ToolValidationError("Give both lat and lon");
      if (!inSingaporeArea(input.lat, input.lon))
        throw new ToolValidationError("That location is outside Singapore");
      return {
        lat: input.lat,
        lon: input.lon,
        label: `${input.lat.toFixed(4)}, ${input.lon.toFixed(4)}`,
        source: "coordinates",
      };
    }
    if (input.place) return this.lookup(input.place);
    if (input.region)
      return {
        ...REGION_LABELS[input.region],
        label: `${input.region} region`,
        source: "region",
      };
    return {
      lat: 1.3521,
      lon: 103.8198,
      label: "Singapore",
      source: "default",
    };
  }
  private async lookup(query: string): Promise<Place> {
    // Forecast areas are a shortcut; when that feed is down, OneMap still answers.
    const two = (await this.dataGov.cache
      .get("feed:twoHour", 10 * 60_000, async () => {
        const body = (await this.http.json("twoHour")) as J;
        if (body?.code !== 0)
          throw new Error("data.gov.sg twoHour returned no data");
        return body.data;
      })
      .catch(() => null)) as J;
    const area = (two?.area_metadata ?? []).find(
      (a: J) => String(a.name).toLowerCase() === query.trim().toLowerCase(),
    );
    if (area)
      return {
        lat: Number(area.label_location.latitude),
        lon: Number(area.label_location.longitude),
        label: String(area.name),
        source: "NEA forecast area",
      };
    const body = (await this.http.json("oneMapSearch", {
      searchVal: query,
      returnGeom: "Y",
      getAddrDetails: "N",
      pageNum: 1,
    })) as J;
    const hit = (body?.results ?? []).find((r: J) => {
      const lat = num(r.LATITUDE);
      const lon = num(r.LONGITUDE);
      return lat !== null && lon !== null && inSingaporeArea(lat, lon);
    });
    if (hit)
      return {
        lat: Number(hit.LATITUDE),
        lon: Number(hit.LONGITUDE),
        label: clip(hit.SEARCHVAL, 100) ?? query,
        source: "OneMap search",
      };
    const partial = (two?.area_metadata ?? []).find((a: J) =>
      matchesQuery(query, a.name),
    );
    if (partial)
      return {
        lat: Number(partial.label_location.latitude),
        lon: Number(partial.label_location.longitude),
        label: String(partial.name),
        source: "NEA forecast area",
      };
    throw new ToolValidationError(
      "Could not find that place; ask the owner for a postal code, a nearby MRT station or to share a location",
    );
  }
}
