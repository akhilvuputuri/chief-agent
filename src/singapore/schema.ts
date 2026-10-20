import { z } from "zod";
import { REGIONS } from "./geo.js";

const region = z.enum(REGIONS);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

/** data.gov.sg reads (keyless; a key only raises rate limits). */
export const sgWeather = z
  .object({
    operation: z.literal("sg_weather"),
    region: region.optional(),
    outlook: z.boolean().optional(),
  })
  .strict();
export const sgAir = z
  .object({ operation: z.literal("sg_air"), region: region.optional() })
  .strict();
export const sgAlerts = z
  .object({ operation: z.literal("sg_alerts"), region: region.optional() })
  .strict();
export const sgCarparks = z
  .object({
    operation: z.literal("sg_carparks"),
    query: text(80).optional(),
    codes: z
      .array(z.string().regex(/^[A-Za-z0-9]{1,10}$/))
      .min(1)
      .max(10)
      .optional(),
    region: region.optional(),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();
export const sgHolidays = z
  .object({
    operation: z.literal("sg_holidays"),
    from: date.optional(),
    to: date.optional(),
  })
  .strict();
export const sgHawkerClosures = z
  .object({
    operation: z.literal("sg_hawker_closures"),
    query: text(80).optional(),
    region: region.optional(),
    from: date.optional(),
    to: date.optional(),
  })
  .strict();
export const sgCameras = z
  .object({
    operation: z.literal("sg_cameras"),
    query: text(80).optional(),
    region: region.optional(),
    kind: z.enum(["red_light", "speed", "laser", "mobile"]).optional(),
  })
  .strict();
export const sgDataset = z
  .object({
    operation: z.literal("sg_dataset"),
    dataset: z.string().regex(/^d_[0-9a-f]{32}$/),
    // Exact-match filters; one value per element, several values match any of them.
    filters: z
      .record(
        z.string().regex(/^[A-Za-z0-9_]{1,60}$/),
        z.array(text(200)).min(1).max(30),
      )
      .optional(),
    fields: z
      .array(z.string().regex(/^[A-Za-z0-9_]{1,60}$/))
      .min(1)
      .max(20)
      .optional(),
    sort: z
      .string()
      .regex(/^[A-Za-z0-9_]{1,60}( (asc|desc))?$/)
      .optional(),
    q: text(100).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    offset: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

/** NEA rain radar over a recent window, analysed for one location. */
export const sgRain = z
  .object({
    operation: z.literal("sg_rain"),
    lat: z.number().min(1).max(2).optional(),
    lon: z.number().min(103).max(105).optional(),
    place: text(100).optional(),
    region: region.optional(),
    hours: z.number().min(0.25).max(6).optional(),
    stepMinutes: z.number().int().min(5).max(60).optional(),
    range: z.enum(["70km", "240km"]).optional(),
  })
  .strict();

/** LTA DataMall reads (need the account key). */
export const ltaBusArrival = z
  .object({
    operation: z.literal("lta_bus_arrival"),
    stop: z.string().regex(/^\d{5}$/),
    service: z
      .string()
      .regex(/^[0-9A-Za-z]{1,5}$/)
      .optional(),
  })
  .strict();
export const ltaBusStops = z
  .object({ operation: z.literal("lta_bus_stops"), query: text(60) })
  .strict();
export const ltaTrainAlerts = z
  .object({ operation: z.literal("lta_train_alerts") })
  .strict();
export const ltaTraffic = z
  .object({ operation: z.literal("lta_traffic"), query: text(60).optional() })
  .strict();

export const singaporeSchemas = [
  sgWeather,
  sgAir,
  sgAlerts,
  sgCarparks,
  sgHolidays,
  sgHawkerClosures,
  sgCameras,
  sgDataset,
  sgRain,
  ltaBusArrival,
  ltaBusStops,
  ltaTrainAlerts,
  ltaTraffic,
] as const;
export type SingaporeAction = z.infer<(typeof singaporeSchemas)[number]>;
export const singaporeOperations = new Set(
  singaporeSchemas.map((s) => s.shape.operation.value as string),
);
export function isSingaporeAction<T extends { operation: string }>(
  a: T,
): a is Extract<T, SingaporeAction> {
  return singaporeOperations.has(a.operation);
}
