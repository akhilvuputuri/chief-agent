import test from "node:test";
import assert from "node:assert/strict";
import { decodePalettePng } from "../src/singapore/png.js";
import {
  ISLAND,
  LEGEND,
  legendIndex,
  type Frame,
} from "../src/singapore/radar.js";
import {
  PALETTE,
  decodePolyline,
  encodeGif,
  encodePalettePng,
  lzw,
  radarAnimation,
  radarMap,
  twelveHour,
} from "../src/singapore/radar-image.js";

/** An independent GIF LZW decoder, written from the specification. */
function unlzw(
  data: Buffer,
  minCodeSize: number,
  seen: { endWidth?: number } = {},
) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out: number[] = [];
  let size = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = Array.from({ length: clear }, (_, i) => [i]);
    dict.push([], []);
    size = minCodeSize + 1;
  };
  reset();
  let prev: number[] | null = null;
  let pos = 0;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i++, pos++) {
      // Strict: a code that runs past the data means the widths disagree.
      if (pos >> 3 >= data.length) throw new Error("read past the data");
      code |= ((data[pos >> 3]! >> (pos & 7)) & 1) << i;
    }
    return code;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === end) {
      seen.endWidth = size;
      break;
    }
    let entry: number[];
    if (code < dict.length) entry = dict[code]!;
    else if (code === dict.length && prev) entry = [...prev, prev[0]!];
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (prev && dict.length < 4096) dict.push([...prev, entry[0]!]);
    if (dict.length === 1 << size && size < 12) size++;
    prev = entry;
  }
  return Uint8Array.from(out);
}

/** Frames of a GIF made by encodeGif: palette indices and delays. */
function readGif(gif: Buffer) {
  assert.equal(gif.subarray(0, 6).toString("latin1"), "GIF89a");
  const width = gif.readUInt16LE(6);
  const height = gif.readUInt16LE(8);
  const tableSize = 3 << ((gif[10]! & 7) + 1);
  let i = 13 + tableSize;
  const frames: { pixels: Uint8Array; delay: number }[] = [];
  let delay = 0;
  let loops = false;
  while (gif[i] !== 0x3b) {
    if (gif[i] === 0x21) {
      const label = gif[i + 1];
      if (label === 0xf9) delay = gif.readUInt16LE(i + 4);
      if (label === 0xff)
        loops =
          gif.subarray(i + 3, i + 14).toString("latin1") === "NETSCAPE2.0";
      i += 2;
      while (gif[i]) i += gif[i]! + 1;
      i++;
      continue;
    }
    assert.equal(gif[i], 0x2c);
    i += 10;
    const min = gif[i++]!;
    const blocks: Buffer[] = [];
    while (gif[i]) {
      blocks.push(gif.subarray(i + 1, i + 1 + gif[i]!));
      i += gif[i]! + 1;
    }
    i++;
    frames.push({ pixels: unlzw(Buffer.concat(blocks), min), delay });
  }
  return { width, height, frames, loops };
}

test("LZW round-trips runs, noise and table resets at every code size", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (const min of [2, 4, 7, 8]) {
    const n = 1 << min;
    const runs = Uint8Array.from(
      { length: 50_000 },
      (_, i) => Math.floor(i / 97) % n,
    );
    const noise = Uint8Array.from({ length: 50_000 }, () => random() % n);
    for (const data of [runs, noise, Uint8Array.of(1), new Uint8Array(0)]) {
      const trace: { endWidth?: number } = {};
      const seen: { endWidth?: number } = {};
      assert.deepEqual(unlzw(lzw(data, min, trace), min, seen), data);
      // The end code must be as wide as the decoder expects, even where the
      // extra bit would fall in zero padding.
      assert.equal(trace.endWidth, seen.endWidth);
    }
    // Lengths that end right as the table grows, at every small size.
    for (let length = 1; length < 600; length++) {
      const data = Uint8Array.from({ length }, () => random() % n);
      const trace: { endWidth?: number } = {};
      const seen: { endWidth?: number } = {};
      assert.deepEqual(unlzw(lzw(data, min, trace), min, seen), data);
      assert.equal(
        trace.endWidth,
        seen.endWidth,
        `min ${min}, length ${length}`,
      );
    }
  }
});

test("polylines decode as in Google's reference example", () => {
  assert.deepEqual(
    decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@").map(([lon, lat]) => [
      Math.round(lon * 1e3) / 1e3,
      Math.round(lat * 1e3) / 1e3,
    ]),
    [
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ],
  );
});

test("palette PNGs and looping GIFs encode exactly", () => {
  const pixels = Uint8Array.from(
    { length: 40 * 30 },
    (_, i) => (i * 7) % PALETTE.length,
  );
  const png = decodePalettePng(encodePalettePng(40, 30, pixels, PALETTE));
  assert.deepEqual([png.width, png.height], [40, 30]);
  assert.deepEqual(Uint8Array.from(png.pixels), pixels);
  assert.deepEqual(png.palette[9]!.slice(0, 3), PALETTE[9]);
  const other = pixels.map((v) => (v + 1) % PALETTE.length);
  const gif = readGif(
    encodeGif(
      40,
      30,
      [
        { pixels, delay: 45 },
        { pixels: other, delay: 200 },
      ],
      PALETTE,
    ),
  );
  assert.ok(gif.loops);
  assert.deepEqual([gif.width, gif.height], [40, 30]);
  assert.deepEqual(
    gif.frames.map((f) => f.delay),
    [45, 200],
  );
  assert.deepEqual(gif.frames[0]!.pixels, pixels);
  assert.deepEqual(gif.frames[1]!.pixels, other);
});

/** A 70 km-style frame with heavy rain (a yellow legend colour) in a box around Bishan. */
function frame(minutesAgo: number, shiftLon = 0): Frame {
  const box = {
    west: 103.342685,
    east: 104.602315,
    north: 1.97854,
    south: 0.719515,
  };
  const size = 480;
  const col = (lon: number) =>
    Math.floor(((lon - box.west) / (box.east - box.west)) * size);
  const row = (lat: number) =>
    Math.floor(((box.north - lat) / (box.north - box.south)) * size);
  const x0 = col(ISLAND.west);
  const y0 = row(ISLAND.north);
  const width = col(ISLAND.east) + 1 - x0;
  const height = row(ISLAND.south) + 1 - y0;
  const colours = new Uint8Array(width * height);
  const heavy = legendIndex(255, 240, 0, 255) + 1;
  for (let y = row(1.37); y <= row(1.33); y++)
    for (let x = col(103.83 + shiftLon); x <= col(103.87 + shiftLon); x++)
      colours[(y - y0) * width + (x - x0)] = heavy;
  return {
    at: "",
    time: Date.parse("2026-10-20T15:00:00+08:00") - minutesAgo * 60_000,
    range: "70km",
    ...box,
    cols: 120,
    rows: 120,
    grid: new Uint8Array(120 * 120),
    detail: {
      imageWidth: size,
      imageHeight: size,
      x0,
      y0,
      width,
      height,
      colours,
    },
  };
}

test("the radar map shows sea, land, rain over the island, the marker and the time", () => {
  const map = radarMap(frame(0), { lat: 1.3, lon: 103.95 });
  assert.equal(map.kind, "photo");
  const png = decodePalettePng(map.bytes);
  const at = (lat: number, lon: number) =>
    png.pixels[
      Math.floor(
        (ISLAND.north - lat) / ((ISLAND.east - ISLAND.west) / png.width),
      ) *
        png.width +
        Math.floor(
          (lon - ISLAND.west) / ((ISLAND.east - ISLAND.west) / png.width),
        )
    ]!;
  const colour = (lat: number, lon: number) =>
    png.palette[at(lat, lon)]!.slice(0, 3);
  // Open sea south-east of the island, and inland Tampines.
  assert.deepEqual(colour(1.2, 104.05), PALETTE[0]);
  assert.deepEqual(colour(1.353, 103.945), PALETTE[1]);
  // Heavy rain over Bishan is drawn in its legend colour blended over land.
  const yellow = LEGEND.findIndex(
    ([r, g, b]) => r === 255 && g === 240 && b === 0,
  );
  assert.equal(at(1.35, 103.85), 8 + LEGEND.length + yellow);
  // The marker sits on the location.
  assert.deepEqual(colour(1.3, 103.95), [214, 39, 40]);
  // The time label is in the top-left corner: white background, dark text.
  const corner = new Set(
    Array.from(png.pixels.subarray(15 * png.width, 15 * png.width + 120)),
  );
  assert.ok(corner.has(5) && corner.has(6));
});

test("the radar animation plays oldest to newest and holds the newest frame", () => {
  // Rain moving east: newest first, as RadarFrames returns frames.
  const frames = [0, 10, 20].map((m) => frame(m, -m * 0.002));
  const anim = radarAnimation(frames, { lat: 1.3, lon: 103.95 }, 360);
  assert.equal(anim.kind, "animation");
  assert.equal(anim.frames, 3);
  const gif = readGif(anim.bytes);
  assert.deepEqual(
    gif.frames.map((f) => f.delay),
    [45, 45, 200],
  );
  // Each frame differs as the rain moves; all use palette entries only.
  assert.notDeepEqual(gif.frames[0]!.pixels, gif.frames[2]!.pixels);
  for (const f of gif.frames) {
    assert.equal(f.pixels.length, gif.width * gif.height);
    assert.ok(f.pixels.every((v) => v < PALETTE.length));
  }
});

test("each radar pixel lands exactly on the map pixels whose centres it covers", () => {
  const box = {
    west: 103.342685,
    east: 104.602315,
    north: 1.97854,
    south: 0.719515,
  };
  const size = 480;
  const base = frame(0);
  const d = base.detail!;
  // Light up one radar pixel inland (near Bishan); clear the test block.
  d.colours.fill(0);
  const col = Math.floor(((103.85 - box.west) / (box.east - box.west)) * size);
  const row = Math.floor(
    ((box.north - 1.355) / (box.north - box.south)) * size,
  );
  d.colours[(row - d.y0) * d.width + (col - d.x0)] = 1;
  const west = box.west + (col / size) * (box.east - box.west);
  const east = box.west + ((col + 1) / size) * (box.east - box.west);
  const north = box.north - (row / size) * (box.north - box.south);
  const south = box.north - ((row + 1) / size) * (box.north - box.south);
  const map = decodePalettePng(radarMap(base, { lat: 1.2, lon: 104.05 }).bytes);
  const deg = (ISLAND.east - ISLAND.west) / map.width;
  let inside = 0;
  for (let y = 0; y < map.height; y++)
    for (let x = 0; x < map.width; x++) {
      const lon = ISLAND.west + (x + 0.5) * deg;
      const lat = ISLAND.north - (y + 0.5) * deg;
      const covered = lon >= west && lon < east && lat <= north && lat > south;
      const rain = map.pixels[y * map.width + x]! >= 8;
      if (covered) inside++;
      assert.equal(rain, covered, `pixel ${x},${y}`);
    }
  // A radar pixel is about 4.5 map pixels across.
  assert.ok(inside >= 16 && inside <= 25, String(inside));
});

test("times read as 12-hour Singapore time, including midnight and noon", () => {
  const at = (sgt: string) =>
    twelveHour(Date.parse(`2026-10-21T${sgt}:00+08:00`));
  assert.equal(at("00:00"), "12:00 am");
  assert.equal(at("00:05"), "12:05 am");
  assert.equal(at("11:59"), "11:59 am");
  assert.equal(at("12:00"), "12:00 pm");
  assert.equal(at("23:05"), "11:05 pm");
  // A UTC instant is shown in Singapore time.
  assert.equal(twelveHour(Date.parse("2026-10-20T16:05:00Z")), "12:05 am");
});
