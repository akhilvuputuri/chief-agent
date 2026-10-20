import { inflateSync } from "node:zlib";

/** A decoded 8-bit palette PNG: one palette index per pixel, row by row. */
export interface PalettePng {
  width: number;
  height: number;
  pixels: Uint8Array;
  /** [r, g, b, alpha] for each palette index. */
  palette: [number, number, number, number][];
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SIDE = 2048;

/**
 * Decodes the 8-bit indexed PNGs NEA publishes for rain radar. Only what those
 * images use is supported: colour type 3, bit depth 8, no interlacing.
 */
export function decodePalettePng(data: Buffer): PalettePng {
  if (data.length < 33 || !data.subarray(0, 8).equals(SIGNATURE))
    throw new Error("Radar image is not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let plte: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  while (pos + 8 <= data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.toString("latin1", pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + length);
    if (body.length !== length) throw new Error("Radar image is truncated");
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || colour !== 3 || interlace !== 0)
        throw new Error("Unsupported radar image format");
      if (!width || !height || width > MAX_SIDE || height > MAX_SIDE)
        throw new Error("Unsupported radar image size");
    } else if (type === "PLTE") plte = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!width || !plte) throw new Error("Radar image has no palette");
  const raw = inflateSync(Buffer.concat(idat), {
    maxOutputLength: (width + 1) * height,
  });
  if (raw.length < (width + 1) * height)
    throw new Error("Radar image data is short");
  const pixels = new Uint8Array(width * height);
  const prev = new Uint8Array(width);
  const line = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const start = y * (width + 1);
    const filter = raw[start]!;
    for (let x = 0; x < width; x++) {
      const value = raw[start + 1 + x]!;
      const left = x > 0 ? line[x - 1]! : 0;
      const up = prev[x]!;
      const corner = x > 0 ? prev[x - 1]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) throw new Error("Radar image filter is invalid");
      line[x] = (value + predicted) & 255;
    }
    pixels.set(line, y * width);
    prev.set(line);
  }
  const palette: PalettePng["palette"] = [];
  for (let i = 0; i * 3 + 2 < plte.length; i++)
    palette.push([
      plte[i * 3]!,
      plte[i * 3 + 1]!,
      plte[i * 3 + 2]!,
      trns && i < trns.length ? trns[i]! : 255,
    ]);
  return { width, height, pixels, palette };
}
