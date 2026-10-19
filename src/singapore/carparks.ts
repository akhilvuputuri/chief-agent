import type { DataGov } from "./datagov.js";
import { SOURCE_NOTE } from "./datagov.js";
import type { DataMall } from "./datamall.js";
import { DATAMALL_NOTE } from "./datamall.js";
import { ageMinutes, clip, matchesQuery, num } from "./format.js";
import { regionOf, svy21ToWgs84, type Region } from "./geo.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- parsed provider JSON */
type J = any;

const LOT: Record<string, string> = {
  C: "car",
  Y: "motorcycle",
  M: "motorcycle",
  H: "heavy vehicle",
  S: "motorcycle with sidecar",
};

interface Carpark {
  id: string;
  agency: "HDB" | "JTC" | "URA" | "LTA";
  name: string;
  lat: number | null;
  lon: number | null;
  details: Record<string, unknown>;
}

/** Carpark search: HDB, JTC and URA reference data joined with live lots. */
export class Carparks {
  constructor(
    private readonly dataGov: DataGov,
    private readonly dataMall: DataMall,
    private readonly now: () => number = Date.now,
  ) {}
  private async reference(): Promise<Carpark[]> {
    const [hdb, jtc, ura] = await Promise.all([
      this.dataGov.hdbCarparks(),
      this.dataGov.jtcCarparks(),
      this.dataGov.uraCarparks(),
    ]);
    const fromSvy = (x: unknown, y: unknown) => {
      const e = num(x);
      const n = num(y);
      return e === null || n === null
        ? { lat: null, lon: null }
        : svy21ToWgs84(n, e);
    };
    const flat =
      (agency: "HDB" | "JTC") =>
      (r: J): Carpark => ({
        id: String(r.car_park_no),
        agency,
        name: clip(r.address, 160) ?? String(r.car_park_no),
        ...fromSvy(r.x_coord, r.y_coord),
        details: {
          type: clip(r.car_park_type, 60),
          system: clip(r.type_of_parking_system, 60),
          shortTermParking: clip(r.short_term_parking, 60),
          freeParking: clip(r.free_parking, 60),
          nightParking: clip(r.night_parking, 10),
          gantryHeightM: num(r.gantry_height),
          decks: num(r.car_park_decks),
        },
      });
    return [
      ...hdb.map(flat("HDB")),
      ...jtc.map(flat("JTC")),
      ...ura.map((f: J) => {
        const p = f.properties ?? {};
        return {
          id: String(p.PP_CODE),
          agency: "URA" as const,
          name: clip(p.PARKING_PL, 160) ?? String(p.PP_CODE),
          lat: num(f.geometry?.coordinates?.[1]),
          lon: num(f.geometry?.coordinates?.[0]),
          details: {
            lotCounts: {
              car: num(p.NO_CAR),
              motorcycle: num(p.NO_MCYCLE),
              heavyVehicle: num(p.NO_H_VEHIC),
            },
          },
        };
      }),
    ];
  }
  /** Live lots keyed by agency:id. DataMall covers HDB, URA and malls; otherwise HDB only. */
  private async lots() {
    const out = new Map<
      string,
      { lots: J[]; updated: string | null; place?: J }
    >();
    if (this.dataMall.configured) {
      for (const r of await this.dataMall.carparkLots()) {
        const key = `${r.Agency}:${r.CarParkID}`;
        const entry = out.get(key) ?? { lots: [], updated: null, place: r };
        entry.lots.push({
          type: LOT[r.LotType] ?? r.LotType,
          available: num(r.AvailableLots),
        });
        out.set(key, entry);
      }
      return { lots: out, source: "LTA DataMall (HDB, URA and mall carparks)" };
    }
    const item = await this.dataGov.hdbLots();
    for (const c of item.carpark_data ?? []) {
      const key = `HDB:${c.carpark_number}`;
      // A carpark number can repeat; keep the most recently updated record.
      const prev = out.get(key);
      if (prev && String(prev.updated) >= String(c.update_datetime)) continue;
      out.set(key, {
        updated: c.update_datetime ?? null,
        lots: (c.carpark_info ?? []).map((i: J) => ({
          type: LOT[i.lot_type] ?? i.lot_type,
          available: num(i.lots_available),
          total: num(i.total_lots),
        })),
      });
    }
    return { lots: out, source: "data.gov.sg HDB carpark availability" };
  }

  async search(input: {
    query?: string;
    codes?: string[];
    region?: Region;
    limit?: number;
  }) {
    const limit = input.limit ?? 5;
    const [reference, live] = await Promise.all([
      this.reference(),
      this.lots(),
    ]);
    const codes = new Set((input.codes ?? []).map((c) => c.toUpperCase()));
    const regionOk = (lat: number | null, lon: number | null) =>
      !input.region ||
      (lat !== null && lon !== null && regionOf({ lat, lon }) === input.region);
    const results: J[] = [];
    for (const c of reference) {
      if (codes.size && !codes.has(c.id.toUpperCase())) continue;
      if (
        !codes.size &&
        input.query?.toUpperCase() !== c.id.toUpperCase() &&
        !matchesQuery(input.query, c.name)
      )
        continue;
      if (!regionOk(c.lat, c.lon)) continue;
      const lot = live.lots.get(`${c.agency}:${c.id}`);
      results.push({
        id: c.id,
        agency: c.agency,
        name: c.name,
        region:
          c.lat !== null && c.lon !== null
            ? regionOf({ lat: c.lat, lon: c.lon })
            : null,
        ...c.details,
        lots: lot?.lots ?? null,
        lotsAgeMinutes: lot?.updated
          ? ageMinutes(lot.updated, this.now())
          : lot
            ? 0
            : null,
      });
    }
    // Mall carparks exist only in the live DataMall feed.
    for (const [key, entry] of live.lots) {
      if (!key.startsWith("LTA:") || !entry.place) continue;
      const p = entry.place;
      if (codes.size && !codes.has(String(p.CarParkID).toUpperCase())) continue;
      if (!codes.size && !matchesQuery(input.query, p.Development, p.Area))
        continue;
      const [a, b] = String(p.Location ?? "")
        .split(/\s+/)
        .map(Number);
      // The feed is documented as "lat lon"; tolerate the reverse order.
      const [lat, lon] =
        a !== undefined && a > 90 ? [b ?? null, a] : [a ?? null, b ?? null];
      if (!regionOk(lat ?? null, lon ?? null)) continue;
      results.push({
        id: String(p.CarParkID),
        agency: "LTA",
        name: clip(p.Development, 160),
        area: clip(p.Area, 40),
        region: lat && lon ? regionOf({ lat, lon }) : null,
        lots: entry.lots,
        lotsAgeMinutes: 0,
      });
    }
    return {
      query: input.query ?? null,
      total: results.length,
      carparks: results.slice(0, limit),
      truncated: results.length > limit,
      liveLots: live.source,
      note: "lots null means no live count for that carpark. Rates are not included; HDB, URA and mall rates differ.",
      source: this.dataMall.configured
        ? `${SOURCE_NOTE} ${DATAMALL_NOTE}`
        : SOURCE_NOTE,
    };
  }
}
