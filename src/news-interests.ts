/** Interest profile for the news bulletin, learned from the articles the owner
 * saved to Reader (from the bulletin's Save buttons or anywhere else, such as
 * Safari). Phase 1 is deliberately simple and inspectable: per-site affinity
 * plus TF-IDF word overlap with recent saves. No model call, no hidden state;
 * the profile is rebuilt from Reader's current library for every edition, so
 * deleting an article in Reader also removes its influence.
 *
 * `interestProfile` and `affinity` are the only seam the ranker uses. A later
 * scorer (embeddings, a learned ranker over saved-versus-suggested items) can
 * replace them without touching feed gathering, delivery or the Save flow. */
import { canonicalUrl, domainOf } from "./news-feed.js";

/** Reader's saved-article metadata: title, link, site and save time only. */
export interface SavedArticle {
  url: string;
  title: string;
  domain: string;
  savedAt: Date;
}
interface SavedDoc {
  title: string;
  weight: number;
  vector: Map<string, number>;
}
export interface InterestProfile {
  size: number;
  /** Decayed save counts per site domain (without `www.`). */
  sites: Map<string, number>;
  idf: Map<string, number>;
  docs: SavedDoc[];
  /** Canonical links already in Reader; never suggested again. */
  saved: Set<string>;
}

/** A save counts half as much after this many days. Saves are rarer than
 * votes were, so they fade slower than the old 30-day vote half-life. */
export const SAVE_HALF_LIFE_DAYS = 60;
const SITE_CAP = 3;
const NEIGHBOURS = 3;
/** Saved articles older than this do not shape the profile. */
const PROFILE_DAYS = 365;

const STOP = new Set(
  (
    "the a an and or of to in on for with at by from as is are was were be been this that these those it its into over after before about how why what who new says said will can could " +
    "you your our we they their his her not but just more most than then there here when where which while also out off now get got has have had does did do one two first year years week day today"
  ).split(" "),
);

/** Lowercased content words with light plural folding ("chips" → "chip"). */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t))
    .map((t) =>
      t.length > 4 && t.endsWith("ies")
        ? t.slice(0, -3) + "y"
        : t.length > 3 && t.endsWith("s") && !t.endsWith("ss")
          ? t.slice(0, -1)
          : t,
    );
}

function normalize(v: Map<string, number>) {
  let sum = 0;
  for (const x of v.values()) sum += x * x;
  const n = Math.sqrt(sum);
  if (n) for (const [k, x] of v) v.set(k, x / n);
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of small) dot += x * (large.get(k) ?? 0);
  return dot;
}

export const bareDomain = (host: string) => host.replace(/^www\./, "");

export function interestProfile(
  saves: SavedArticle[],
  now: Date,
): InterestProfile {
  const sites = new Map<string, number>();
  const saved = new Set<string>();
  const recent: { a: SavedArticle; words: string[]; weight: number }[] = [];
  for (const a of saves) {
    try {
      saved.add(canonicalUrl(a.url));
    } catch {
      // A link Chief cannot canonicalize still shapes the profile below.
    }
    const ageDays = Math.max(
      0,
      (now.getTime() - a.savedAt.getTime()) / 86400000,
    );
    if (ageDays > PROFILE_DAYS) continue;
    const weight = Math.pow(0.5, ageDays / SAVE_HALF_LIFE_DAYS);
    const site = bareDomain(a.domain);
    sites.set(site, (sites.get(site) ?? 0) + weight);
    recent.push({ a, words: contentWords(a.title), weight });
  }
  const df = new Map<string, number>();
  for (const r of recent)
    for (const t of new Set(r.words)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [t, n] of df)
    idf.set(t, Math.log((recent.length + 1) / (n + 1)) + 1);
  const docs = recent
    .filter((r) => r.words.length)
    .map((r) => {
      const vector = new Map<string, number>();
      for (const t of r.words)
        vector.set(t, (vector.get(t) ?? 0) + (idf.get(t) ?? 1));
      return { title: r.a.title, weight: r.weight, vector: normalize(vector) };
    });
  return { size: saves.length, sites, idf, docs, saved };
}

/** How much a candidate resembles what the owner saves.
 * `similar` is in [0, 1]: the mean over the three closest saved titles of
 * cosine × that save's recency weight, so separate interests each count
 * instead of being averaged into one blurred centroid.
 * `site` is the decayed number of saves from the item's site, capped at 3. */
export function affinity(
  profile: InterestProfile,
  item: {
    title: string;
    summary?: string | null;
    url: string;
    sourceDomain?: string;
  },
) {
  let host = "";
  try {
    host = bareDomain(domainOf(item.url));
  } catch {
    // Unparseable links simply get no site affinity.
  }
  const site = Math.min(
    SITE_CAP,
    Math.max(
      profile.sites.get(host) ?? 0,
      item.sourceDomain
        ? (profile.sites.get(bareDomain(item.sourceDomain)) ?? 0)
        : 0,
    ),
  );
  if (!profile.docs.length) return { similar: 0, site, like: null };
  const vector = new Map<string, number>();
  const add = (words: string[], scale: number) => {
    for (const t of words) {
      const w = profile.idf.get(t);
      // Words the owner has never saved cannot match; skip them.
      if (w) vector.set(t, (vector.get(t) ?? 0) + w * scale);
    }
  };
  add(contentWords(item.title), 1);
  add(contentWords((item.summary ?? "").slice(0, 400)), 0.5);
  if (!vector.size) return { similar: 0, site, like: null };
  normalize(vector);
  const near = profile.docs
    .map((d) => ({ d, s: cosine(vector, d.vector) * d.weight }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, NEIGHBOURS);
  const similar = near.reduce((sum, x) => sum + x.s, 0) / NEIGHBOURS;
  return { similar, site, like: near[0]?.d.title ?? null };
}

/** A readable summary for news_status: what the profile currently favours. */
export function describeProfile(
  profile: InterestProfile,
  followed: Set<string>,
) {
  const sites = [...profile.sites]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([site, w]) => ({ site, weight: +w.toFixed(2) }));
  const terms = new Map<string, number>();
  for (const d of profile.docs)
    for (const [t, x] of d.vector)
      terms.set(t, (terms.get(t) ?? 0) + x * d.weight);
  return {
    savedArticles: profile.size,
    topSites: sites,
    topTerms: [...terms]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([t]) => t),
    // Sites the owner saves from but does not follow: candidates to suggest.
    unfollowedSites: [...profile.sites]
      .filter(([s, w]) => w >= 2 && !followed.has(s))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s]) => s),
  };
}
