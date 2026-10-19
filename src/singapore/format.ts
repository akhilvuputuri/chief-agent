/** Small helpers shared by the Singapore reducers. */
const SGT = "Asia/Singapore";

/** Minutes since an ISO timestamp, or null when it cannot be read. */
export function ageMinutes(iso: unknown, now: number) {
  if (typeof iso !== "string") return null;
  // Some feeds omit the zone; their times are Singapore time.
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}+08:00`;
  const at = Date.parse(withZone);
  return Number.isFinite(at)
    ? Math.max(0, Math.round((now - at) / 60000))
    : null;
}

/** YYYY-MM-DD in Singapore time. */
export function sgDate(at: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SGT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** The hour (0-23) in Singapore time. */
export function sgHour(at: number) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: SGT,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(at),
  );
}

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** NEA's D/M/YYYY (sometimes DD/MM/YYYY) dates; "NA", "TBC" and blanks are null. */
export function dmy(raw: unknown) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
}

/** Bounded plain text for model-facing output; source text is data, not instructions. */
export function clip(raw: unknown, max = 300) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const num = (raw: unknown) => {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
};

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/**
 * Every query word must match a whole word of the fields: numbers exactly ("22" is not
 * "227"), other words as a prefix ("bish" matches "Bishan").
 */
export function matchesQuery(query: string | undefined, ...fields: unknown[]) {
  if (!query) return true;
  const hay = words(
    fields.filter((f) => f !== null && f !== undefined).join(" "),
  );
  return words(query).every((w) =>
    hay.some((h) => (/^\d+$/.test(w) ? h === w : h.startsWith(w))),
  );
}

export function psiBand(psi: number | null) {
  if (psi === null) return null;
  if (psi <= 50) return "good";
  if (psi <= 100) return "moderate";
  if (psi <= 200) return "unhealthy";
  if (psi <= 300) return "very unhealthy";
  return "hazardous";
}

/** NEA's 1-hour PM2.5 concentration bands. */
export function pm25Band(value: number | null) {
  if (value === null) return null;
  if (value <= 55) return "normal";
  if (value <= 150) return "elevated";
  if (value <= 250) return "high";
  return "very high";
}

export function uvBand(value: number | null) {
  if (value === null) return null;
  if (value <= 2) return "low";
  if (value <= 5) return "moderate";
  if (value <= 7) return "high";
  if (value <= 10) return "very high";
  return "extreme";
}
