import { decodePalettePng } from "./png.js";
import type { SgHttp } from "./http.js";
import { TtlCache } from "./cache.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- parsed provider JSON */
type J = any;

export type RadarRange = "70km" | "240km";
export const INTENSITY = [
  "none",
  "light",
  "moderate",
  "heavy",
  "very heavy",
  "intense",
] as const;
const MIN = 60_000;
/** Pixels per analysis cell: 480-pixel frames become a 120 × 120 grid. */
const CELL = 4;

/**
 * NEA's rain-rate legend, lightest to most intense, as observed in live frames
 * (2026-10-13 to 2026-10-20): six teals, ten greens, five yellows, four oranges,
 * then reds and magentas. Exact mm/h values are not published with the image.
 */
export const LEGEND: [number, number, number][] = [
  [0, 255, 255],
  [0, 239, 239],
  [0, 209, 213],
  [0, 186, 191],
  [0, 151, 154],
  [0, 131, 125],
  [0, 128, 69],
  [0, 137, 56],
  [0, 162, 53],
  [0, 183, 41],
  [0, 202, 17],
  [0, 218, 13],
  [0, 245, 7],
  [0, 255, 0],
  [67, 255, 65],
  [72, 255, 70],
  [255, 255, 59],
  [255, 255, 0],
  [255, 240, 0],
  [255, 220, 0],
  [255, 198, 0],
  [255, 178, 0],
  [255, 165, 0],
  [255, 138, 0],
  [255, 114, 0],
  [255, 73, 0],
  [255, 31, 0],
  [229, 0, 0],
  [193, 0, 0],
  [182, 0, 106],
  [210, 0, 165],
  [212, 0, 170],
  [255, 0, 255],
];
/** Legend positions where each level after "light" begins. */
const LEVEL_STARTS = [6, 16, 21, 25];
const LEGEND_LEVEL = new Map(
  LEGEND.map(([r, g, b], i) => [
    `${r},${g},${b}`,
    1 + LEVEL_STARTS.filter((start) => i >= start).length,
  ]),
);

/**
 * Maps a palette colour to one of five coarse levels: exact legend colours by
 * table, anything else by hue. Opaque white appears in some palettes unused and
 * is not on the legend, so it counts as no rain.
 */
export function rainClass(r: number, g: number, b: number, alpha: number) {
  if (alpha < 32) return 0;
  const known = LEGEND_LEVEL.get(`${r},${g},${b}`);
  if (known) return known;
  if (r > 230 && g > 230 && b > 230) return 0;
  if (r < 100 && g > 100 && b > 100 && Math.abs(g - b) < 40) return 1;
  if (r < 120 && g > b + 30) return 2;
  if (r > 200 && g >= 190 && b < 100) return 3;
  if (r > 200 && g >= 100) return 4;
  if (r > 150 && g < 100) return 5;
  return 1;
}

export interface Frame {
  at: string;
  time: number;
  range: RadarRange;
  west: number;
  east: number;
  north: number;
  south: number;
  cols: number;
  rows: number;
  /** Highest rain level in each cell, 0-5. */
  grid: Uint8Array;
}

/** "YYYY-MM-DDTHH:mm:ss" in Singapore time, the radar API's date format. */
function sgtStamp(ms: number) {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 19);
}

/** Fetches and caches radar frames. A published frame never changes. */
export class RadarFrames {
  private readonly frames = new Map<string, Frame | null>();
  private readonly pending = new Map<string, Promise<Frame | null>>();
  private readonly latest: TtlCache;
  constructor(
    private readonly http: SgHttp,
    private readonly now: () => number = Date.now,
  ) {
    this.latest = new TtlCache(now);
  }
  private remember(key: string, frame: Frame | null) {
    this.frames.set(key, frame);
    // Six hours of five-minute frames at both ranges, with room to spare.
    if (this.frames.size > 400)
      this.frames.delete(this.frames.keys().next().value!);
  }
  private async load(range: RadarRange, date?: string): Promise<Frame | null> {
    const body = (await this.http.json(
      range === "70km" ? "radar70" : "radar240",
      { date },
    )) as J;
    const data = body?.data;
    const record = (data?.records ?? [])[0];
    const box = data?.boundaryBox;
    if (body?.code !== 0 || !record?.image?.url || !box) return null;
    const stamp = String(record.timestamp ?? "");
    // The feed gives +08:00 offsets; a bare local time is read as Singapore time, not UTC.
    const time = Date.parse(
      /(?:Z|[+-]\d\d:?\d\d)$/.test(stamp) ? stamp : `${stamp}+08:00`,
    );
    if (!Number.isFinite(time)) return null;
    const png = decodePalettePng(await this.http.radarImage(record.image.url));
    const classes = png.palette.map(([r, g, b, a]) => rainClass(r, g, b, a));
    const cols = Math.floor(png.width / CELL);
    const rows = Math.floor(png.height / CELL);
    const grid = new Uint8Array(cols * rows);
    for (let y = 0; y < rows * CELL; y++)
      for (let x = 0; x < cols * CELL; x++) {
        const level = classes[png.pixels[y * png.width + x]!] ?? 0;
        const cell = Math.floor(y / CELL) * cols + Math.floor(x / CELL);
        if (level > grid[cell]!) grid[cell] = level;
      }
    return {
      at: stamp,
      time,
      range,
      west: Number(box.upperLeft.longitude),
      east: Number(box.lowerRight.longitude),
      north: Number(box.upperLeft.latitude),
      south: Number(box.lowerRight.latitude),
      cols,
      rows,
      grid,
    };
  }
  /** Frames newest first, spaced stepMinutes apart, covering the last `minutes`. */
  async window(range: RadarRange, minutes: number, stepMinutes: number) {
    const newest = await this.latest.get(`latest:${range}`, 2 * MIN, () =>
      this.load(range),
    );
    if (!newest) return [];
    this.remember(`${range}:${newest.time}`, newest);
    const out: Frame[] = [newest];
    for (let back = stepMinutes; back <= minutes; back += stepMinutes) {
      const time = newest.time - back * MIN;
      const key = `${range}:${time}`;
      if (!this.frames.has(key)) {
        // Concurrent calls share one fetch per frame.
        let loading = this.pending.get(key);
        if (!loading) {
          loading = this.load(range, sgtStamp(time)).finally(() =>
            this.pending.delete(key),
          );
          this.pending.set(key, loading);
        }
        this.remember(key, await loading);
      }
      const frame = this.frames.get(key);
      if (frame) out.push(frame);
    }
    return out;
  }
}

// ---- geometry --------------------------------------------------------------

export interface Point {
  lat: number;
  lon: number;
}
const KM_PER_LAT = 110.57;
const kmPerLon = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (degrees: number) =>
  COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]!;

function cellCentre(f: Frame, cx: number, cy: number): Point {
  return {
    lon: f.west + ((cx + 0.5) / f.cols) * (f.east - f.west),
    lat: f.north - ((cy + 0.5) / f.rows) * (f.north - f.south),
  };
}
/** Offset of `to` from `from` in km (east, north). */
function offsetKm(from: Point, to: Point) {
  return {
    east: (to.lon - from.lon) * kmPerLon(from.lat),
    north: (to.lat - from.lat) * KM_PER_LAT,
  };
}
function bearing(east: number, north: number) {
  return (Math.atan2(east, north) * 180) / Math.PI;
}
function cellKm(f: Frame) {
  return ((f.east - f.west) / f.cols) * kmPerLon((f.north + f.south) / 2);
}
export function inFrame(f: Frame, p: Point) {
  return p.lon > f.west && p.lon < f.east && p.lat > f.south && p.lat < f.north;
}

interface Cell {
  level: number;
  east: number;
  north: number;
  km: number;
}
/** Cells within `radiusKm` of the point, with their offset from it. */
function around(f: Frame, p: Point, radiusKm: number): Cell[] {
  const out: Cell[] = [];
  const pad = Math.ceil(radiusKm / cellKm(f)) + 1;
  const px = Math.floor(((p.lon - f.west) / (f.east - f.west)) * f.cols);
  const py = Math.floor(((f.north - p.lat) / (f.north - f.south)) * f.rows);
  for (let cy = Math.max(0, py - pad); cy < Math.min(f.rows, py + pad); cy++)
    for (
      let cx = Math.max(0, px - pad);
      cx < Math.min(f.cols, px + pad);
      cx++
    ) {
      const o = offsetKm(p, cellCentre(f, cx, cy));
      const km = Math.hypot(o.east, o.north);
      if (km <= radiusKm)
        out.push({ level: f.grid[cy * f.cols + cx]!, ...o, km });
    }
  return out;
}

const round = (n: number, digits = 0) => {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
};
const share = (cells: Cell[], min: number) =>
  cells.length
    ? round((cells.filter((c) => c.level >= min).length / cells.length) * 100)
    : 0;
function relative(east: number, north: number) {
  const km = Math.hypot(east, north);
  return km < 1.5
    ? "over the location"
    : `${round(km)} km ${compass(bearing(east, north))}`;
}

function snapshot(f: Frame, p: Point, radiusKm: number) {
  const cells = around(f, p, radiusKm);
  const wet = cells.filter((c) => c.level > 0);
  const here = cells.filter((c) => c.km <= 1.5);
  const weight = wet.reduce((s, c) => s + c.level, 0);
  const centre = weight
    ? {
        east: wet.reduce((s, c) => s + c.east * c.level, 0) / weight,
        north: wet.reduce((s, c) => s + c.north * c.level, 0) / weight,
      }
    : null;
  return {
    cells,
    wet,
    atPoint: here.reduce((m, c) => Math.max(m, c.level), 0),
    peak: wet.reduce((m, c) => Math.max(m, c.level), 0),
    cover: share(cells, 1),
    centre,
  };
}

/** Best whole-cell shift between two frames near the point, as km/h east and north. */
function motionBetween(older: Frame, newer: Frame, p: Point, radiusKm: number) {
  const hours = (newer.time - older.time) / 3600_000;
  if (hours <= 0) return null;
  const size = cellKm(newer);
  const a = around(older, p, radiusKm);
  const b = new Map<string, number>();
  for (const c of around(newer, p, radiusKm + 30))
    if (c.level)
      b.set(
        `${Math.round(c.east / size)},${Math.round(c.north / size)}`,
        c.level,
      );
  const wetA = a.filter((c) => c.level);
  if (wetA.length < 12 || b.size < 12) return null;
  // Rain cells rarely move faster than 90 km/h.
  const reach = Math.min(25, Math.ceil((90 * hours) / size));
  const width = 2 * reach + 1;
  const scores = new Float64Array(width * width);
  let best = { score: 0, dx: 0, dy: 0 };
  for (let dy = -reach; dy <= reach; dy++)
    for (let dx = -reach; dx <= reach; dx++) {
      let score = 0;
      for (const c of wetA) {
        const key = `${Math.round(c.east / size) + dx},${Math.round(c.north / size) + dy}`;
        const level = b.get(key);
        if (level) score += Math.min(level, c.level);
      }
      scores[(dy + reach) * width + dx + reach] = score;
      if (score > best.score) best = { score, dx, dy };
    }
  const total = wetA.reduce((s, c) => s + c.level, 0);
  if (best.score / total < 0.25) return null;
  // Refine to a fraction of a cell with a parabola through the best score and
  // its neighbours on each axis, so slow rain is not rounded to 0 or 1 cell.
  const at = (dx: number, dy: number) =>
    Math.abs(dx) > reach || Math.abs(dy) > reach
      ? 0
      : scores[(dy + reach) * width + dx + reach]!;
  const refine = (minus: number, plus: number) => {
    const curve = minus - 2 * best.score + plus;
    return curve < 0
      ? Math.max(-0.5, Math.min(0.5, (minus - plus) / (2 * curve)))
      : 0;
  };
  const dx =
    best.dx + refine(at(best.dx - 1, best.dy), at(best.dx + 1, best.dy));
  const dy =
    best.dy + refine(at(best.dx, best.dy - 1), at(best.dx, best.dy + 1));
  return {
    east: (dx * size) / hours,
    north: (dy * size) / hours,
    weight: best.score,
    /** Speed that one whole-cell shift represents for this pair. */
    quantum: size / hours,
  };
}

function averageMotion(
  moves: { east: number; north: number; weight: number; quantum: number }[],
) {
  const weight = moves.reduce((s, m) => s + m.weight, 0);
  if (!weight) return null;
  const east = moves.reduce((s, m) => s + m.east * m.weight, 0) / weight;
  const north = moves.reduce((s, m) => s + m.north * m.weight, 0) / weight;
  const speed = Math.hypot(east, north);
  // Consistency: how far individual moves stray from the average, relative to
  // its speed plus the step one cell shift represents. Slow rain alternates
  // between zero and one-cell shifts, which is quantisation, not erratic motion.
  const scatter =
    moves.reduce(
      (s, m) => s + m.weight * Math.hypot(m.east - east, m.north - north),
      0,
    ) / weight;
  const quantum = moves.reduce((s, m) => s + m.quantum * m.weight, 0) / weight;
  const agree = Math.max(0, 1 - scatter / (speed + quantum));
  return { east, north, speed, agree };
}

function describeMotion(m: ReturnType<typeof averageMotion>, pairs: number) {
  if (!m) return null;
  if (m.speed < 4)
    return { summary: "nearly stationary", speedKmh: round(m.speed), pairs };
  const toward = compass(bearing(m.east, m.north));
  const from = compass(bearing(m.east, m.north) + 180);
  return {
    summary: `moving from the ${from} toward the ${toward} at about ${round(m.speed)} km/h`,
    towards: toward,
    from,
    speedKmh: round(m.speed),
    consistency:
      m.agree > 0.85 ? "steady" : m.agree > 0.6 ? "fairly steady" : "erratic",
    pairs,
  };
}

/**
 * Simple advection nowcast: shift the newest frame along the recent motion and
 * read the rain level that would sit over the point in 10-60 minutes.
 */
function nowcast(
  f: Frame,
  p: Point,
  motion: NonNullable<ReturnType<typeof averageMotion>>,
) {
  const out: { inMinutes: number; level: string }[] = [];
  for (const minutes of [10, 20, 30, 45, 60]) {
    const h = minutes / 60;
    // Rain that will be over the point came from upwind of it.
    const source = {
      lat: p.lat - (motion.north * h) / KM_PER_LAT,
      lon: p.lon - (motion.east * h) / kmPerLon(p.lat),
    };
    const level = inFrame(f, source)
      ? around(f, source, 1.5).reduce((m, c) => Math.max(m, c.level), 0)
      : 0;
    out.push({ inMinutes: minutes, level: INTENSITY[level]! });
  }
  return out;
}

export interface RainAnalysis {
  [key: string]: unknown;
}

/** Summarises the radar window for one point: now, history, movement and outlook. */
export function analyse(
  frames: Frame[],
  p: Point,
  radiusKm = 50,
  nowMs = Date.now(),
) {
  const [latest] = frames;
  if (!latest) return null;
  const now = snapshot(latest, p, radiusKm);
  const rings = Object.fromEntries(
    // The wide view's cells are about 4 km across, so its rings are wider too.
    (latest.range === "240km" ? [25, 50, 100] : [5, 10, 25]).map((r) => {
      const ring = now.cells.filter((c) => c.km <= r);
      return [
        `within${r}km`,
        { rainPct: share(ring, 1), heavyPct: share(ring, 3) },
      ];
    }),
  );
  const nearest = (min: number) => {
    const c = now.wet
      .filter((x) => x.level >= min)
      .sort((x, y) => x.km - y.km)[0];
    return c
      ? {
          where: relative(c.east, c.north),
          level: INTENSITY[c.level],
          km: round(c.km, 1),
        }
      : null;
  };
  const chronological = [...frames].reverse();
  const moves = [];
  for (let i = 1; i < chronological.length; i++) {
    const m = motionBetween(
      chronological[i - 1]!,
      chronological[i]!,
      p,
      radiusKm,
    );
    if (m) moves.push({ ...m, at: chronological[i]!.time });
  }
  const recentCut = latest.time - 45 * MIN;
  const recent = averageMotion(moves.filter((m) => m.at >= recentCut));
  const overall = averageMotion(moves);
  const snaps = chronological.map((f) => ({ f, s: snapshot(f, p, radiusKm) }));
  // A timeline of at most 13 points, so a 6-hour window stays readable.
  const every = Math.max(1, Math.ceil(snaps.length / 13));
  const timeline = snaps
    .filter((_, i) => i % every === 0 || i === snaps.length - 1)
    .map(({ f, s }) => ({
      at: f.at,
      atLocation: INTENSITY[s.atPoint],
      rainWithinRadiusPct: s.cover,
      mainRain: s.centre ? relative(s.centre.east, s.centre.north) : "none",
      peak: INTENSITY[s.peak],
    }));
  const wetFrames = snaps.filter(({ s }) => s.atPoint > 0);
  const stepMinutes =
    chronological.length > 1
      ? (latest.time - chronological[0]!.time) /
        MIN /
        (chronological.length - 1)
      : 0;
  const peakAt = snaps.reduce(
    (best, x) => (x.s.atPoint > best.s.atPoint ? x : best),
    snaps[0]!,
  );
  return {
    radarRange: latest.range,
    latestFrame: latest.at,
    ageMinutes: Math.max(0, round((nowMs - latest.time) / MIN)),
    framesUsed: frames.length,
    windowMinutes: round((latest.time - chronological[0]!.time) / MIN),
    radiusKm,
    now: {
      atLocation: INTENSITY[now.atPoint],
      ...rings,
      nearestRain: nearest(1),
      nearestHeavyRain: nearest(3),
      mainRain: now.centre
        ? relative(now.centre.east, now.centre.north)
        : "none",
    },
    atLocationHistory: {
      rainedForAboutMinutes: round(wetFrames.length * stepMinutes),
      lastRainAt: wetFrames.length
        ? wetFrames[wetFrames.length - 1]!.f.at
        : null,
      heaviest: INTENSITY[peakAt.s.atPoint],
      heaviestAt: peakAt.s.atPoint ? peakAt.f.at : null,
    },
    movement: {
      recent: describeMotion(
        recent,
        moves.filter((m) => m.at >= recentCut).length,
      ),
      overWindow: describeMotion(overall, moves.length),
    },
    outlook:
      recent && recent.speed >= 4 && recent.agree > 0.6
        ? {
            estimate: nowcast(latest, p, recent),
            note: "Extrapolated from recent movement; storms grow and decay, so treat as a rough guide.",
          }
        : {
            estimate: null,
            note: "Movement too weak or inconsistent to project.",
          },
    timeline,
  };
}
