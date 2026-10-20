import { crc32, deflateSync } from "node:zlib";
import { ISLAND, LEGEND, type Frame, type Point } from "./radar.js";
import { REGION_OUTLINES } from "./region-outlines.js";

/**
 * Draws NEA radar frames over a plain map of Singapore's five regions, as a
 * palette PNG (one frame) or a looping GIF (several). Everything is drawn from
 * a fixed palette, so no colour quantisation is needed, and no map service is
 * called: the outlines are bundled.
 */

type Rgb = [number, number, number];
const SEA: Rgb = [214, 228, 238];
const LAND: Rgb = [246, 245, 240];
const COAST: Rgb = [112, 128, 140];
const BORDER: Rgb = [200, 198, 190];
const MARKER: Rgb = [214, 39, 40];
const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [33, 37, 41];
const TRACK: Rgb = [206, 212, 218];
/** How strongly rain colours cover the map beneath. */
const RAIN_ALPHA = 0.75;

const P = {
  sea: 0,
  land: 1,
  coast: 2,
  border: 3,
  marker: 4,
  white: 5,
  ink: 6,
  track: 7,
};
/** Rain over sea, then rain over land: one entry per legend colour. */
const RAIN_OVER_SEA = 8;
const RAIN_OVER_LAND = RAIN_OVER_SEA + LEGEND.length;
const blend = (top: Rgb, under: Rgb): Rgb =>
  top.map((c, i) =>
    Math.round(c * RAIN_ALPHA + under[i]! * (1 - RAIN_ALPHA)),
  ) as Rgb;
export const PALETTE: Rgb[] = [
  SEA,
  LAND,
  COAST,
  BORDER,
  MARKER,
  WHITE,
  INK,
  TRACK,
  ...LEGEND.map((c) => blend(c, SEA)),
  ...LEGEND.map((c) => blend(c, LAND)),
];

// ---- base map ---------------------------------------------------------------

interface Canvas {
  width: number;
  height: number;
  /** Degrees per pixel, the same both ways (Singapore is near the equator). */
  deg: number;
}
function canvas(width: number): Canvas {
  const deg = (ISLAND.east - ISLAND.west) / width;
  return {
    width,
    height: Math.round((ISLAND.north - ISLAND.south) / deg),
    deg,
  };
}
const lonAt = (c: Canvas, x: number) => ISLAND.west + (x + 0.5) * c.deg;
const latAt = (c: Canvas, y: number) => ISLAND.north - (y + 0.5) * c.deg;

/** Decodes a Google polyline into [lon, lat] pairs. */
export function decodePolyline(text: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let shift = 0;
    let value = 0;
    let byte: number;
    do {
      byte = text.charCodeAt(i++) - 63;
      value |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return value & 1 ? ~(value >> 1) : value >> 1;
  };
  while (i < text.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}

const bases = new Map<number, Uint8Array>();
/** Sea, land, region borders and coastline at this width; computed once. */
function baseMap(c: Canvas) {
  const cached = bases.get(c.width);
  if (cached) return cached;
  // Region number per pixel (0 is sea), by even-odd scanline fill of each region's rings.
  const region = new Uint8Array(c.width * c.height);
  Object.values(REGION_OUTLINES).forEach((rings, r) => {
    const edges = rings.flatMap((ring) => {
      const pts = decodePolyline(ring.replace(/^-/, "")).map(([lon, lat]) => ({
        x: (lon - ISLAND.west) / c.deg - 0.5,
        y: (ISLAND.north - lat) / c.deg - 0.5,
      }));
      return pts.map((a, i) => [a, pts[(i + 1) % pts.length]!] as const);
    });
    for (let y = 0; y < c.height; y++) {
      const xs: number[] = [];
      for (const [a, b] of edges)
        if (a.y <= y !== b.y <= y)
          xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (
          let x = Math.max(0, Math.ceil(xs[k]!));
          x <= Math.min(c.width - 1, xs[k + 1]!);
          x++
        )
          region[y * c.width + x] = r + 1;
    }
  });
  const base = new Uint8Array(c.width * c.height);
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      const i = y * c.width + x;
      const here = region[i]!;
      if (!here) continue;
      const near = [
        x > 0 ? region[i - 1]! : 0,
        x + 1 < c.width ? region[i + 1]! : 0,
        y > 0 ? region[i - c.width]! : 0,
        y + 1 < c.height ? region[i + c.width]! : 0,
      ];
      base[i] = near.includes(0)
        ? P.coast
        : near.some((n) => n !== here)
          ? P.border
          : P.land;
    }
  bases.set(c.width, base);
  return base;
}

// ---- drawing ----------------------------------------------------------------

/** 5 × 7 glyphs for the time label. */
const GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};

function label(pixels: Uint8Array, c: Canvas, text: string) {
  const scale = Math.max(2, Math.round(c.width / 320));
  const pad = 2 * scale;
  const w = text.length * 6 * scale - scale + 2 * pad;
  const h = 7 * scale + 2 * pad;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) pixels[(pad + y) * c.width + pad + x] = P.white;
  [...text].forEach((ch, n) =>
    (GLYPHS[ch] ?? GLYPHS[" "]!).forEach((row, gy) =>
      [...row].forEach((bit, gx) => {
        if (bit !== "1") return;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++)
            pixels[
              (2 * pad + gy * scale + dy) * c.width +
                2 * pad +
                (n * 6 + gx) * scale +
                dx
            ] = P.ink;
      }),
    ),
  );
}

function marker(pixels: Uint8Array, c: Canvas, p: Point) {
  const cx = (p.lon - ISLAND.west) / c.deg;
  const cy = (ISLAND.north - p.lat) / c.deg;
  const r = Math.max(5, c.width / 120);
  for (let y = Math.floor(cy - r - 3); y <= cy + r + 3; y++)
    for (let x = Math.floor(cx - r - 3); x <= cx + r + 3; x++) {
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r) pixels[y * c.width + x] = P.marker;
      else if (d <= r + 2.5) pixels[y * c.width + x] = P.white;
    }
}

/** "HH:MM SGT" for a frame time. */
export function clock(ms: number) {
  return new Date(ms + 8 * 3600_000).toISOString().slice(11, 16) + " SGT";
}

/** One frame as palette indices: map, rain, coastline, marker, time and progress. */
function draw(c: Canvas, f: Frame, p: Point, progress?: number) {
  const base = baseMap(c);
  const pixels = Uint8Array.from(base);
  const d = f.detail;
  if (d) {
    // Separable lookup: each canvas column and row maps to one radar pixel.
    const cols = Int32Array.from(
      { length: c.width },
      (_, x) =>
        Math.floor(
          ((lonAt(c, x) - f.west) / (f.east - f.west)) * d.imageWidth,
        ) - d.x0,
    );
    const rows = Int32Array.from(
      { length: c.height },
      (_, y) =>
        Math.floor(
          ((f.north - latAt(c, y)) / (f.north - f.south)) * d.imageHeight,
        ) - d.y0,
    );
    for (let y = 0; y < c.height; y++) {
      const ry = rows[y]!;
      if (ry < 0 || ry >= d.height) continue;
      for (let x = 0; x < c.width; x++) {
        const rx = cols[x]!;
        if (rx < 0 || rx >= d.width) continue;
        const colour = d.colours[ry * d.width + rx]!;
        if (!colour) continue;
        const i = y * c.width + x;
        // The coastline stays visible through rain.
        if (base[i] === P.coast) continue;
        pixels[i] =
          (base[i] === P.sea ? RAIN_OVER_SEA : RAIN_OVER_LAND) + colour - 1;
      }
    }
  }
  marker(pixels, c, p);
  label(pixels, c, clock(f.time));
  if (progress !== undefined) {
    const h = Math.max(4, Math.round(c.width / 160));
    const filled = Math.round(progress * c.width);
    for (let y = c.height - h; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        pixels[y * c.width + x] = x < filled ? P.ink : P.track;
  }
  return pixels;
}

// ---- encoders ---------------------------------------------------------------

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0);
  return Buffer.concat([head, body, crc]);
}

/** An 8-bit palette PNG. */
export function encodePalettePng(
  width: number,
  height: number,
  pixels: Uint8Array,
  palette: Rgb[],
) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Buffer.from(palette.flat())),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** GIF variable-width LZW, as in the GIF89a specification. */
export function lzw(
  indices: Uint8Array,
  minCodeSize: number,
  /** Tests read the end code's width here; it must match the decoder's. */
  trace?: { endWidth?: number },
) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out: number[] = [];
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let table = new Map<number, number>();
  let acc = 0;
  let bits = 0;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  if (!indices.length) {
    if (trace) trace.endWidth = codeSize;
    emit(end);
    if (bits) out.push(acc & 0xff);
    return Buffer.from(out);
  }
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      // Table full: start again so codes stay within 12 bits.
      emit(clear);
      table = new Map();
      codeSize = minCodeSize + 1;
      next = end + 1;
    } else {
      // The decoder grows its code size one entry behind the encoder.
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  // The decoder adds one more entry after that last code, so it may expect
  // the end code one bit wider.
  if (next < 4096 && next >= 1 << codeSize) codeSize++;
  if (trace) trace.endWidth = codeSize;
  emit(end);
  if (bits) out.push(acc & 0xff);
  return Buffer.from(out);
}

/** A looping GIF89a from palette-indexed frames; delays are in hundredths of a second. */
export function encodeGif(
  width: number,
  height: number,
  frames: { pixels: Uint8Array; delay: number }[],
  palette: Rgb[],
) {
  const bitsNeeded = Math.max(1, Math.ceil(Math.log2(palette.length)));
  const table = Buffer.alloc(3 << bitsNeeded);
  table.set(palette.flat());
  const minCodeSize = Math.max(2, bitsNeeded);
  const parts: Buffer[] = [Buffer.from("GIF89a", "latin1")];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0x80 | ((bitsNeeded - 1) << 4) | (bitsNeeded - 1);
  parts.push(screen, table);
  // Loop forever.
  parts.push(
    Buffer.from([
      0x21,
      0xff,
      0x0b,
      ...Buffer.from("NETSCAPE2.0", "latin1"),
      3,
      1,
      0,
      0,
      0,
    ]),
  );
  for (const frame of frames) {
    const control = Buffer.from([0x21, 0xf9, 4, 0x04, 0, 0, 0, 0]);
    control.writeUInt16LE(frame.delay, 4);
    const image = Buffer.alloc(10);
    image[0] = 0x2c;
    image.writeUInt16LE(width, 5);
    image.writeUInt16LE(height, 7);
    const data = lzw(frame.pixels, minCodeSize);
    const blocks: Buffer[] = [Buffer.from([minCodeSize])];
    for (let i = 0; i < data.length; i += 255) {
      const block = data.subarray(i, i + 255);
      blocks.push(Buffer.from([block.length]), block);
    }
    blocks.push(Buffer.from([0]));
    parts.push(control, image, ...blocks);
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// ---- public -----------------------------------------------------------------

export interface RadarPicture {
  kind: "photo" | "animation";
  bytes: Buffer;
  filename: string;
  width: number;
  height: number;
  frames: number;
}

/** The newest frame as a PNG map with the location marked. */
export function radarMap(frame: Frame, p: Point, width = 960): RadarPicture {
  const c = canvas(width);
  return {
    kind: "photo",
    bytes: encodePalettePng(c.width, c.height, draw(c, frame, p), PALETTE),
    filename: "rain-radar.png",
    width: c.width,
    height: c.height,
    frames: 1,
  };
}

/** Frames (newest first, as RadarFrames returns them) as a looping GIF, oldest first. */
export function radarAnimation(
  frames: Frame[],
  p: Point,
  width = 720,
): RadarPicture {
  const c = canvas(width);
  const ordered = [...frames].reverse();
  const last = ordered.length - 1;
  return {
    kind: "animation",
    bytes: encodeGif(
      c.width,
      c.height,
      ordered.map((f, i) => ({
        pixels: draw(c, f, p, last ? i / last : 1),
        // Hold the newest frame so the current picture is easy to read.
        delay: i === last ? 200 : 45,
      })),
      PALETTE,
    ),
    filename: "rain-radar.gif",
    width: c.width,
    height: c.height,
    frames: ordered.length,
  };
}
