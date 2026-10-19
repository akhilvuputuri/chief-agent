/** Coarse Singapore geography: the five NEA regions and SVY21 conversion. */
export const REGIONS = ["north", "south", "east", "west", "central"] as const;
export type Region = (typeof REGIONS)[number];

/**
 * NEA's own label points for its five air-quality regions (from the PSI feed's
 * regionMetadata). A place belongs to the region whose label point is nearest:
 * coarse, but it matches how NEA reports PSI and the 24-hour forecast.
 */
export const REGION_LABELS: Record<Region, { lat: number; lon: number }> = {
  north: { lat: 1.41803, lon: 103.82 },
  south: { lat: 1.29587, lon: 103.82 },
  east: { lat: 1.35735, lon: 103.94 },
  west: { lat: 1.35735, lon: 103.7 },
  central: { lat: 1.35735, lon: 103.82 },
};

export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function regionOf(point: { lat: number; lon: number }): Region {
  let best: Region = "central";
  let bestKm = Infinity;
  for (const region of REGIONS) {
    const km = distanceKm(point, REGION_LABELS[region]);
    if (km < bestKm) [best, bestKm] = [region, km];
  }
  return best;
}

/** Roughly mainland Singapore; lightning feeds include strikes in Johor and Riau. */
export function inSingapore(p: { lat: number; lon: number }) {
  return p.lat >= 1.15 && p.lat <= 1.48 && p.lon >= 103.59 && p.lon <= 104.1;
}

// SVY21 (EPSG:3414): Transverse Mercator on WGS84, used by HDB and URA coordinates.
const A = 6378137;
const F = 1 / 298.257223563;
const ORIGIN_LAT = 1.366666;
const ORIGIN_LON = 103.833333;
const NORTHING0 = 38744.572;
const EASTING0 = 28001.642;
const K = 1;
const B = A * (1 - F);
const E2 = 2 * F - F * F;
const N = (A - B) / (A + B);
const N2 = N * N;
const N3 = N2 * N;
const N4 = N2 * N2;
const G =
  A *
  (1 - N) *
  (1 - N2) *
  (1 + (9 * N2) / 4 + (225 * N4) / 64) *
  (Math.PI / 180);
const A0 = 1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256;
const A2 = (3 / 8) * (E2 + (E2 * E2) / 4 + (15 * E2 * E2 * E2) / 128);
const A4 = (15 / 256) * (E2 * E2 + (3 * E2 * E2 * E2) / 4);
const A6 = (35 * E2 * E2 * E2) / 3072;
function meridian(latDeg: number) {
  const lat = (latDeg * Math.PI) / 180;
  return (
    A *
    (A0 * lat -
      A2 * Math.sin(2 * lat) +
      A4 * Math.sin(4 * lat) -
      A6 * Math.sin(6 * lat))
  );
}
const M0 = meridian(ORIGIN_LAT);

/** Converts SVY21 northing/easting in metres to WGS84 latitude/longitude. */
export function svy21ToWgs84(northing: number, easting: number) {
  const nPrime = northing - NORTHING0;
  const mPrime = M0 + nPrime / K;
  const sigma = ((mPrime / G) * Math.PI) / 180;
  const latPrime =
    sigma +
    ((3 * N) / 2 - (27 * N3) / 32) * Math.sin(2 * sigma) +
    ((21 * N2) / 16 - (55 * N4) / 32) * Math.sin(4 * sigma) +
    ((151 * N3) / 96) * Math.sin(6 * sigma) +
    ((1097 * N4) / 512) * Math.sin(8 * sigma);
  const sinLat = Math.sin(latPrime);
  const rho = (A * (1 - E2)) / Math.pow(1 - E2 * sinLat * sinLat, 1.5);
  const v = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const psi = v / rho;
  const t = Math.tan(latPrime);
  const ePrime = easting - EASTING0;
  const x = ePrime / (K * v);
  const latTerm1 = (t / (K * rho)) * ((x * ePrime) / 2);
  const latTerm2 =
    (t / (K * rho)) *
    ((x ** 3 * ePrime) / 24) *
    (-4 * psi * psi + 9 * psi * (1 - t * t) + 12 * t * t);
  const latTerm3 =
    (t / (K * rho)) *
    ((x ** 5 * ePrime) / 720) *
    (8 * psi ** 4 * (11 - 24 * t * t) -
      12 * psi ** 3 * (21 - 71 * t * t) +
      15 * psi * psi * (15 - 98 * t * t + 15 * t ** 4) +
      180 * psi * (5 * t * t - 3 * t ** 4) +
      360 * t ** 4);
  const latTerm4 =
    (t / (K * rho)) *
    ((x ** 7 * ePrime) / 40320) *
    (1385 - 3633 * t * t + 4095 * t ** 4 + 1575 * t ** 6);
  const lat = latPrime - latTerm1 + latTerm2 - latTerm3 + latTerm4;
  const secLat = 1 / Math.cos(lat);
  const lonTerm1 = x * secLat;
  const lonTerm2 = ((x ** 3 * secLat) / 6) * (psi + 2 * t * t);
  const lonTerm3 =
    ((x ** 5 * secLat) / 120) *
    (-4 * psi ** 3 * (1 - 6 * t * t) +
      psi * psi * (9 - 68 * t * t) +
      72 * psi * t * t +
      24 * t ** 4);
  const lonTerm4 =
    ((x ** 7 * secLat) / 5040) *
    (61 + 662 * t * t + 1320 * t ** 4 + 720 * t ** 6);
  const lon =
    (ORIGIN_LON * Math.PI) / 180 + lonTerm1 - lonTerm2 + lonTerm3 - lonTerm4;
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}
