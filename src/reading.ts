import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
import { ToolValidationError } from "./tool-errors.js";
import { SerialQueue } from "./security.js";
import {
  SAME_STORY,
  canonicalUrl,
  domainOf,
  parseFeed,
  similarity,
  storyTokens,
  type FeedFetcher,
} from "./reading-feed.js";

/** Daily reading bulletin (issue 50). Candidate gathering, ranking and delivery are
 * deterministic: no model call builds or sends an edition, so every selection can be
 * replayed from its saved trace. The conversational agent only manages settings. */

export interface Interest {
  topic: string;
  keywords: string[];
}
export type Vote = "like" | "more" | "dislike";
export type Reason =
  | "off_topic"
  | "too_shallow"
  | "already_knew"
  | "poor_source"
  | "too_repetitive";

/** How one current vote moves the learned weights of the item's topic and source keys.
 * A plain dislike is deliberately weak; a stated reason targets what it names. */
export const SIGNALS: Record<string, { topic: number; source: number }> = {
  like: { topic: 1, source: 0.5 },
  more: { topic: 2, source: 1 },
  dislike: { topic: -0.3, source: -0.15 },
  off_topic: { topic: -1, source: 0 },
  too_shallow: { topic: 0, source: -0.75 },
  already_knew: { topic: -0.2, source: 0 },
  poor_source: { topic: 0, source: -1 },
  too_repetitive: { topic: -0.5, source: 0 },
};
export const HALF_LIFE_DAYS = 30;
export const WEIGHT_CAP = 3;
export const FEEDBACK_CAP = 1.5;
/** Discovery skips only items clearly rejected: reaching this needs reasoned votes or
 * many recent plain dislikes, so a couple of plain dislikes never hide a topic. */
export const DISCOVERY_FLOOR = -1;
const OLDER_THAN_DAYS = 3;
const SOURCE_REFRESH_MINUTES = 30;
const MAX_SOURCES = 30;
const ON_DEMAND_PER_DAY = 3;
/** Edition builds for one owner run one at a time across the scheduler and tools (the
 * gateway is a single process), so concurrent builds cannot both select items that the
 * other is about to deliver, and quota checks see every earlier edition. */
const builds = new SerialQueue();

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1000) / 1000;
export const normTopic = (t: string) =>
  t.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 60);
const normDomain = (d: string) =>
  d
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
const domainIn = (domain: string, list: string[]) =>
  list.some((d) => domain === d || domain.endsWith("." + d));
function phrase(term: string) {
  const escaped = normTopic(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu");
}

// ---------- time zone helpers ----------
const formats = new Map<string, Intl.DateTimeFormat>();
export function validTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
export function zonedParts(date: Date, tz: string) {
  let fmt = formats.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formats.set(tz, fmt);
  }
  const p = Object.fromEntries(
    fmt
      .formatToParts(date)
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    utcGuess: Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    ),
  };
}
/** The instant a local wall-clock time occurs in `tz`. A repeated time (DST fall-back)
 * resolves to its earlier occurrence; a time skipped by a spring-forward jump moves
 * forward by the gap (02:30 becomes 03:30), never back into the previous hour. */
export function zonedInstant(date: string, hhmm: string, tz: string) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, h!, mi!);
  const offset = (t: number) => zonedParts(new Date(t), tz).utcGuess - t;
  // Offsets a day either side bracket any transition on this date.
  const before = wall - offset(wall - 86400000);
  const after = wall - offset(wall + 86400000);
  const exact = [before, after]
    .sort((a, b) => a - b)
    .find((t) => zonedParts(new Date(t), tz).utcGuess === wall);
  return new Date(exact ?? before);
}
export function nextDelivery(
  settings: { delivery_time: string | null; timezone: string | null },
  now: Date,
) {
  if (!settings.delivery_time || !settings.timezone) return null;
  const today = zonedParts(now, settings.timezone).date;
  const slot = zonedInstant(today, settings.delivery_time, settings.timezone);
  if (slot > now) return slot;
  const next = new Date(Date.parse(today + "T12:00:00Z") + 86400000)
    .toISOString()
    .slice(0, 10);
  return zonedInstant(next, settings.delivery_time, settings.timezone);
}
function localLabel(date: Date, tz: string, withYear = false) {
  return date.toLocaleDateString("en-GB", {
    timeZone: tz,
    weekday: withYear ? undefined : "short",
    day: "numeric",
    month: "short",
    year: withYear ? "numeric" : undefined,
  });
}

// ---------- learning ----------
export interface VoteRow {
  item_id: string;
  vote: Vote;
  reason: Reason | null;
  updated_at: Date | string;
  topics: string[];
  domain: string;
}
/** Derived preferences are a pure function of the current votes, their age and owner
 * overrides: re-voting replaces a row instead of adding to it, so nothing counts twice. */
export function learnWeights(
  votes: VoteRow[],
  overrides: Record<string, number>,
  now: Date,
) {
  const weights: Record<string, number> = {};
  for (const v of votes) {
    const signal = SIGNALS[v.reason ?? v.vote]!;
    const ageDays = Math.max(
      0,
      (now.getTime() - new Date(v.updated_at).getTime()) / 86400000,
    );
    const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    for (const t of v.topics.slice(0, 3))
      if (signal.topic)
        weights[`topic:${t}`] =
          (weights[`topic:${t}`] ?? 0) + signal.topic * decay;
    if (signal.source)
      weights[`source:${v.domain}`] =
        (weights[`source:${v.domain}`] ?? 0) + signal.source * decay;
  }
  for (const k of Object.keys(weights))
    weights[k] = round(clamp(weights[k]!, -WEIGHT_CAP, WEIGHT_CAP));
  for (const [k, w] of Object.entries(overrides)) weights[k] = w;
  for (const k of Object.keys(weights)) if (weights[k] === 0) delete weights[k];
  return weights;
}

// ---------- ranking ----------
export interface Candidate {
  id: string;
  canonical_url: string;
  url: string;
  domain: string;
  title: string;
  summary: string | null;
  content_basis: "feed_summary" | "title_only";
  categories: string[];
  language: string | null;
  published_at: Date | null;
  first_seen_at: Date;
  source_name: string;
  source_topics: string[];
}
export interface Settings {
  interests: Interest[];
  languages: string[];
  preferred_domains: string[];
  excluded_domains: string[];
  muted_topics: string[];
  items_per_edition: number;
  discovery_slots: number;
  history_days: number;
  max_age_days: number;
}
export interface Scored {
  c: Candidate;
  topics: string[];
  matched: string[];
  titleHit: boolean;
  components: {
    interest: number;
    source: number;
    feedback: number;
    recency: number;
  };
  score: number;
  baselineScore: number;
  label: string[];
  reason: string;
}
export interface Delivered {
  canonical_url: string;
  title: string;
}

function topicsFor(c: Candidate, interests: Interest[]) {
  const matched: string[] = [];
  let titleHit = false;
  const body = [c.summary ?? "", ...c.categories, ...c.source_topics].join(
    " \n ",
  );
  for (const i of interests) {
    const terms = [i.topic, ...i.keywords].map(phrase);
    const inTitle = terms.some((r) => r.test(c.title));
    if (inTitle || terms.some((r) => r.test(body))) {
      matched.push(normTopic(i.topic));
      titleHit ||= inTitle;
    }
  }
  const fallback = [...c.source_topics, ...c.categories]
    .map(normTopic)
    .filter(Boolean);
  const all = [...new Set([...matched, ...fallback])];
  return { matched, titleHit, topics: all.slice(0, 3), all };
}

export function rank(
  candidates: Candidate[],
  s: Settings,
  weights: Record<string, number>,
  delivered: Delivered[],
  now: Date,
) {
  const excluded: Record<string, number> = {};
  const skip = (reason: string) =>
    (excluded[reason] = (excluded[reason] ?? 0) + 1);
  const deliveredUrls = new Set(delivered.map((d) => d.canonical_url));
  const deliveredStories = delivered.map((d) => storyTokens(d.title));
  const muted = s.muted_topics.map(normTopic);
  const mutedPatterns = muted.map(phrase);
  const primary = (l: string) => l.toLowerCase().split(/[-_]/)[0]!;
  const languages = s.languages.map(primary);
  const scored: Scored[] = [];
  for (const c of candidates) {
    if (domainIn(c.domain, s.excluded_domains)) {
      skip("excluded_source");
      continue;
    }
    if (
      languages.length &&
      c.language &&
      !languages.includes(primary(c.language))
    ) {
      skip("language");
      continue;
    }
    const { matched, titleHit, topics, all } = topicsFor(c, s.interests);
    // A mute is explicit, so it checks every label and the excerpt, not only the
    // three topics kept for learning.
    if (
      all.some((t) => muted.includes(t)) ||
      mutedPatterns.some((r) => r.test(c.title) || r.test(c.summary ?? ""))
    ) {
      skip("muted_topic");
      continue;
    }
    if (deliveredUrls.has(c.canonical_url)) {
      skip("already_delivered");
      continue;
    }
    const tokens = storyTokens(c.title);
    if (deliveredStories.some((d) => similarity(d, tokens) >= SAME_STORY)) {
      skip("already_delivered_story");
      continue;
    }
    const topicWeights = topics.map((t) => weights[`topic:${t}`] ?? 0);
    const topicPart = topicWeights.length
      ? topicWeights.reduce((a, b) => a + b, 0) / topicWeights.length
      : 0;
    const sourcePart = weights[`source:${c.domain}`] ?? 0;
    const ageHours = c.published_at
      ? Math.max(0, (now.getTime() - c.published_at.getTime()) / 3600000)
      : null;
    const components = {
      interest: titleHit ? 2 : matched.length ? 1.2 : 0,
      source: domainIn(c.domain, s.preferred_domains) ? 0.5 : 0,
      feedback: round(
        clamp(0.5 * topicPart + 0.4 * sourcePart, -FEEDBACK_CAP, FEEDBACK_CAP),
      ),
      recency: round(ageHours === null ? 0.3 : Math.exp(-ageHours / 48)),
    };
    const baselineScore = round(
      components.interest + components.source + components.recency,
    );
    const label: string[] = [];
    if (ageHours === null) label.push("undated");
    else if (ageHours > OLDER_THAN_DAYS * 24) label.push("older");
    scored.push({
      c,
      topics,
      matched,
      titleHit,
      components,
      score: round(baselineScore + components.feedback),
      baselineScore,
      label,
      reason: "",
    });
  }
  return { scored, excluded };
}

function order(a: Scored, b: Scored, key: "score" | "baselineScore") {
  return (
    b[key] - a[key] ||
    (b.c.published_at?.getTime() ?? 0) - (a.c.published_at?.getTime() ?? 0) ||
    (a.c.canonical_url < b.c.canonical_url ? -1 : 1)
  );
}
/** Greedy selection: collapse near-identical stories, prefer interest matches with at
 * most two per source domain and primary topic (relaxed in stages to fill slots),
 * then reserve a small discovery allowance so early votes cannot permanently narrow
 * the feed. Never pads with items outside interests beyond that allowance. */
export function select(
  scored: Scored[],
  s: Pick<Settings, "items_per_edition" | "discovery_slots">,
  key: "score" | "baselineScore" = "score",
) {
  const sorted = [...scored].sort((a, b) => order(a, b, key));
  const clusters: Scored[] = [];
  const tokens: Set<string>[] = [];
  let duplicates = 0;
  for (const x of sorted) {
    const t = storyTokens(x.c.title);
    if (tokens.some((o) => similarity(o, t) >= SAME_STORY)) {
      duplicates++;
      continue;
    }
    tokens.push(t);
    clusters.push(x);
  }
  const matches = clusters.filter((x) => x.components.interest > 0);
  const others = clusters.filter(
    (x) =>
      x.components.interest === 0 && x.components.feedback > DISCOVERY_FLOOR,
  );
  const discovery = Math.min(s.discovery_slots, others.length);
  const mainTarget = s.items_per_edition - discovery;
  const chosen: Scored[] = [];
  const perDomain = new Map<string, number>();
  const perTopic = new Map<string, number>();
  const take = (x: Scored) => {
    chosen.push(x);
    perDomain.set(x.c.domain, (perDomain.get(x.c.domain) ?? 0) + 1);
    const t = x.topics[0] ?? "";
    perTopic.set(t, (perTopic.get(t) ?? 0) + 1);
  };
  // Pass 1 caps sources and primary topics at two each; pass 2 keeps only the source
  // cap; pass 3 fills any remaining slot so diversity never causes a shortfall.
  const passes: ((x: Scored) => boolean)[] = [
    (x) =>
      (perDomain.get(x.c.domain) ?? 0) < 2 &&
      (perTopic.get(x.topics[0] ?? "") ?? 0) < 2,
    (x) => (perDomain.get(x.c.domain) ?? 0) < 2,
    () => true,
  ];
  for (const allowed of passes)
    for (const x of matches) {
      if (chosen.length >= mainTarget) break;
      if (!chosen.includes(x) && allowed(x)) take(x);
    }
  const main = chosen.length;
  const discoveryOrder = others.sort(
    (a, b) =>
      b.components.recency +
      b.components.source +
      (key === "score" ? b.components.feedback : 0) -
      (a.components.recency +
        a.components.source +
        (key === "score" ? a.components.feedback : 0)),
  );
  // Discovery honours the same source cap, relaxing it only to fill its reserved slots.
  const picks: Scored[] = [];
  for (const capped of [true, false])
    for (const x of discoveryOrder) {
      if (picks.length >= discovery) break;
      if (picks.includes(x)) continue;
      if (capped && (perDomain.get(x.c.domain) ?? 0) >= 2) continue;
      picks.push(x);
      perDomain.set(x.c.domain, (perDomain.get(x.c.domain) ?? 0) + 1);
    }
  return {
    selected: [
      ...chosen,
      ...picks.map((x) => ({ ...x, label: ["discovery", ...x.label] })),
    ],
    duplicates,
    main,
  };
}

export function reasonFor(x: Scored, tz: string, now: Date) {
  const parts: string[] = [];
  if (x.label.includes("discovery"))
    parts.push("Discovery pick outside your listed interests");
  else if (x.titleHit)
    parts.push(`Headline matches your interest “${x.matched[0]}”`);
  else if (x.matched.length)
    parts.push(`Related to your interest “${x.matched[0]}”`);
  if (x.components.source > 0) parts.push("from a preferred source");
  if (x.components.feedback >= 0.2)
    parts.push("you rated similar readings well");
  else if (x.components.feedback <= -0.2)
    parts.push(
      "earlier feedback ranked this lower, but it was still a strong match",
    );
  if (x.c.published_at) {
    const hours = Math.round(
      (now.getTime() - x.c.published_at.getTime()) / 3600000,
    );
    parts.push(
      hours < 48
        ? `published ${Math.max(hours, 1)}h ago`
        : `published ${localLabel(x.c.published_at, tz, true)}`,
    );
  } else parts.push("publication date not given by the feed");
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

// ---------- persistence and building ----------
function settingsRow(row: any): Settings & Record<string, any> {
  return {
    ...row,
    interests: row?.interests ?? [],
    languages: row?.languages ?? [],
    preferred_domains: row?.preferred_domains ?? [],
    excluded_domains: row?.excluded_domains ?? [],
    muted_topics: row?.muted_topics ?? [],
    items_per_edition: row?.items_per_edition ?? 5,
    discovery_slots: row?.discovery_slots ?? 1,
    history_days: row?.history_days ?? 14,
    max_age_days: row?.max_age_days ?? 7,
    overrides: row?.overrides ?? {},
  };
}

export class ReadingEditions {
  constructor(
    private db: Database,
    private fetcher: FeedFetcher,
    private clock = () => new Date(),
  ) {}
  async settings(user: string) {
    return settingsRow(
      (
        await this.db.query("SELECT * FROM reading_settings WHERE user_id=$1", [
          user,
        ])
      ).rows[0],
    );
  }
  /** Fetch one approved feed and upsert its entries. Discovery time is recorded once;
   * publication time comes only from the feed. */
  async ingest(user: string, source: { id: string; url: string }) {
    const started = Date.now();
    const { body, finalUrl } = await this.fetcher.get(source.url);
    const feed = parseFeed(body, finalUrl, this.clock());
    const entries = feed.entries.slice(0, 50);
    const rows = entries.map((e) => ({
      id: randomUUID(),
      canonical_url: canonicalUrl(e.url),
      url: e.url,
      domain: domainOf(e.url),
      title: e.title,
      summary: e.summary,
      content_basis: e.summary ? "feed_summary" : "title_only",
      categories: e.categories,
      language: feed.language,
      published_at: e.publishedAt?.toISOString() ?? null,
    }));
    const unique = [...new Map(rows.map((r) => [r.canonical_url, r])).values()];
    if (unique.length)
      await this.db.query(
        `INSERT INTO reading_candidates(id,user_id,source_id,canonical_url,url,domain,title,summary,content_basis,categories,language,published_at,first_seen_at,last_seen_at)
         SELECT r.id,$1,$2,r.canonical_url,r.url,r.domain,r.title,r.summary,r.content_basis,r.categories,r.language,r.published_at,$4,$4
         FROM jsonb_to_recordset($3::jsonb) AS r(id uuid,canonical_url text,url text,domain text,title text,summary text,content_basis text,categories jsonb,language text,published_at timestamptz)
         ON CONFLICT(user_id,canonical_url) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,
           source_id=EXCLUDED.source_id,title=EXCLUDED.title,
           summary=COALESCE(EXCLUDED.summary,reading_candidates.summary),
           content_basis=CASE WHEN EXCLUDED.summary IS NULL THEN reading_candidates.content_basis ELSE EXCLUDED.content_basis END,
           categories=EXCLUDED.categories,language=EXCLUDED.language,
           published_at=COALESCE(reading_candidates.published_at,EXCLUDED.published_at)`,
        [user, source.id, JSON.stringify(unique), this.clock()],
      );
    return {
      title: feed.title,
      items: unique.length,
      ms: Date.now() - started,
    };
  }
  private async refresh(user: string) {
    const now = this.clock();
    const sources = (
      await this.db.query(
        "SELECT * FROM reading_sources WHERE user_id=$1 AND status='active' ORDER BY created_at LIMIT $2",
        [user, MAX_SOURCES],
      )
    ).rows;
    const report: any[] = [];
    let requests = 0;
    const due = sources.filter((s) => {
      if (s.next_retry_at && new Date(s.next_retry_at) > now) {
        report.push({
          id: s.id,
          name: s.name,
          status: "backoff",
          error: s.last_error,
        });
        return false;
      }
      if (
        s.last_fetched_at &&
        s.last_status === "ok" &&
        now.getTime() - new Date(s.last_fetched_at).getTime() <
          SOURCE_REFRESH_MINUTES * 60000
      ) {
        report.push({
          id: s.id,
          name: s.name,
          status: "cached",
          items: s.last_item_count,
        });
        return false;
      }
      return true;
    });
    const queue = [...due];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        requests++;
        try {
          const r = await this.ingest(user, s);
          await this.db.query(
            "UPDATE reading_sources SET last_fetched_at=$3,last_status='ok',last_error=NULL,last_item_count=$4,error_count=0,next_retry_at=NULL WHERE id=$1 AND user_id=$2",
            [s.id, user, now, r.items],
          );
          report.push({
            id: s.id,
            name: s.name,
            status: "ok",
            items: r.items,
            ms: r.ms,
          });
        } catch (error) {
          const message = (
            error instanceof Error ? error.message : "feed error"
          ).slice(0, 200);
          const delay = Math.min(30 * Math.pow(2, s.error_count), 720);
          await this.db.query(
            "UPDATE reading_sources SET last_fetched_at=$3,last_status='error',last_error=$4,error_count=error_count+1,next_retry_at=$5 WHERE id=$1 AND user_id=$2",
            [s.id, user, now, message, new Date(now.getTime() + delay * 60000)],
          );
          report.push({
            id: s.id,
            name: s.name,
            status: "failed",
            error: message,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, worker),
    );
    await this.db.query(
      "DELETE FROM reading_candidates WHERE user_id=$1 AND last_seen_at<$2",
      [user, new Date(now.getTime() - 45 * 86400000)],
    );
    return { sources: report, requests, configured: sources.length };
  }
  /** Current derived weights. `persist` records a new version when they changed; read-only
   * status calls pass false so looking never creates history. */
  async preferences(user: string, reason: string, persist = true) {
    const s = await this.settings(user);
    const now = this.clock();
    const votes = (
      await this.db.query(
        `SELECT v.item_id,v.vote,v.reason,v.updated_at,i.topics,i.domain
         FROM reading_votes v JOIN reading_items i ON i.id=v.item_id
         WHERE v.user_id=$1 AND ($2::timestamptz IS NULL OR v.updated_at>$2)
         ORDER BY v.updated_at`,
        [user, s.learning_reset_at ?? null],
      )
    ).rows as VoteRow[];
    const weights = learnWeights(votes, s.overrides, now);
    const latest = (
      await this.db.query(
        "SELECT id,weights FROM reading_preference_versions WHERE user_id=$1 ORDER BY id DESC LIMIT 1",
        [user],
      )
    ).rows[0];
    const same =
      !persist ||
      (latest &&
        JSON.stringify(sortKeys(latest.weights)) ===
          JSON.stringify(sortKeys(weights)));
    const version = same
      ? (latest?.id ?? null)
      : (
          await this.db.query(
            "INSERT INTO reading_preference_versions(user_id,weights,contributing,reason) VALUES($1,$2::jsonb,$3::jsonb,$4) RETURNING id",
            [
              user,
              JSON.stringify(weights),
              JSON.stringify(
                votes.map((v) => ({
                  itemId: v.item_id,
                  vote: v.vote,
                  reason: v.reason,
                  at: v.updated_at,
                })),
              ),
              reason,
            ],
          )
        ).rows[0].id;
    return {
      version: version == null ? null : Number(version),
      weights,
      votes: votes.length,
    };
  }
  /** Build and save one edition. A scheduled edition is unique per owner-local date, so
   * a retried tick cannot create a second, different edition for the same day. */
  async create(
    user: string,
    kind: "scheduled" | "on_demand",
    opts: { allowRetry?: boolean; dailyLimit?: number; at?: Date } = {},
  ) {
    return builds.run(user, () => this.build(user, kind, opts));
  }
  private async build(
    user: string,
    kind: "scheduled" | "on_demand",
    opts: { allowRetry?: boolean; dailyLimit?: number; at?: Date },
  ) {
    // The scheduler passes its tick time so a build that straddles local midnight still
    // files the edition under the date whose slot triggered it.
    const now = opts.at ?? this.clock();
    const s = await this.settings(user);
    const tz = s.timezone ?? "UTC";
    const date = zonedParts(now, tz).date;
    if (kind === "scheduled") {
      const exists = await this.db.query(
        "SELECT 1 FROM reading_editions WHERE user_id=$1 AND kind='scheduled' AND edition_date=$2",
        [user, date],
      );
      if (exists.rows.length)
        return {
          retry: false as const,
          editionId: null,
          duplicate: true,
          date,
          items: 0,
          target: s.items_per_edition,
          shortfall: null,
        };
    }
    if (opts.dailyLimit !== undefined) {
      const today = (
        await this.db.query(
          "SELECT count(*)::int AS n FROM reading_editions WHERE user_id=$1 AND kind=$2 AND created_at>=$3",
          [user, kind, zonedInstant(date, "00:00", tz)],
        )
      ).rows[0].n;
      if (today >= opts.dailyLimit)
        throw new ToolValidationError(
          `At most ${opts.dailyLimit} on-demand editions per day`,
        );
    }
    const fetched = await this.refresh(user);
    const failed = fetched.sources.filter(
      (x) => x.status !== "ok" && x.status !== "cached",
    );
    if (
      opts.allowRetry &&
      fetched.configured &&
      failed.length === fetched.configured
    )
      return { retry: true as const };
    const candidates = (
      await this.db.query(
        `SELECT c.*,COALESCE(s.name,c.domain) AS source_name,COALESCE(s.topics,'[]'::jsonb) AS source_topics
         FROM reading_candidates c LEFT JOIN reading_sources s ON s.id=c.source_id
         WHERE c.user_id=$1 AND (s.id IS NULL OR s.status='active')
           AND COALESCE(c.published_at,c.first_seen_at)>=$2
         ORDER BY COALESCE(c.published_at,c.first_seen_at) DESC LIMIT 500`,
        [user, new Date(now.getTime() - s.max_age_days * 86400000)],
      )
    ).rows.map((r): Candidate => ({
      ...r,
      published_at: r.published_at ? new Date(r.published_at) : null,
      first_seen_at: new Date(r.first_seen_at),
    }));
    const delivered = (
      await this.db.query(
        `SELECT i.canonical_url,i.title FROM reading_items i JOIN reading_editions e ON e.id=i.edition_id
         WHERE i.user_id=$1 AND e.created_at>=$2 AND e.state<>'muted'`,
        [user, new Date(now.getTime() - s.history_days * 86400000)],
      )
    ).rows as Delivered[];
    const prefs = await this.preferences(user, `edition:${kind}`);
    const { scored, excluded } = rank(
      candidates,
      s,
      prefs.weights,
      delivered,
      now,
    );
    const picked = select(scored, s, "score");
    const baseline = select(scored, s, "baselineScore");
    const baselineUrls = new Set(
      baseline.selected.map((x) => x.c.canonical_url),
    );
    const items = picked.selected.map((x, position) => ({
      id: randomUUID(),
      position,
      canonical_url: x.c.canonical_url,
      url: x.c.url,
      domain: x.c.domain,
      source_name: x.c.source_name,
      title: x.c.title,
      summary: x.c.summary,
      content_basis: x.c.content_basis,
      published_at: x.c.published_at?.toISOString() ?? null,
      first_seen_at: x.c.first_seen_at.toISOString(),
      topics: x.topics,
      label: x.label.join(",") || null,
      reason: reasonFor(x, tz, now),
      score: x.score,
      components: {
        ...x.components,
        matched: x.matched,
        baselineScore: x.baselineScore,
        inBaseline: baselineUrls.has(x.c.canonical_url),
      },
    }));
    const target = s.items_per_edition;
    const trace = {
      target,
      selected: items.length,
      shortfall:
        items.length < target
          ? failed.length
            ? `${failed.length} of ${fetched.configured} sources failed and fewer credible new candidates were available`
            : "fewer credible new candidates matched your interests"
          : null,
      sources: fetched.sources,
      networkRequests: fetched.requests,
      modelCalls: 0,
      pool: candidates.length,
      excluded: { ...excluded, duplicate_story: picked.duplicates },
      preferenceVersion: prefs.version,
      baseline: baseline.selected.map((x) => x.c.canonical_url),
      // Greedy selection only reaches a prefix of each ordering, so the top 60 by score
      // plus the top 20 discovery candidates are enough to replay both selections.
      snapshot: [
        ...new Set([
          ...[...scored].sort((a, b) => order(a, b, "score")).slice(0, 60),
          ...scored
            .filter((x) => x.components.interest === 0)
            .sort((a, b) => b.components.recency - a.components.recency)
            .slice(0, 20),
        ]),
      ].map((x) => ({
        url: x.c.canonical_url,
        title: x.c.title.slice(0, 160),
        domain: x.c.domain,
        topics: x.topics,
        publishedAt: x.c.published_at?.toISOString() ?? null,
        label: x.label,
        score: x.score,
        baselineScore: x.baselineScore,
        components: x.components,
      })),
      builtAt: now.toISOString(),
    };
    const editionId = randomUUID();
    const inserted = (
      await this.db.query(
        `WITH e AS (
           INSERT INTO reading_editions(id,user_id,kind,edition_date,preference_version,trace,created_at)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$8)
           ON CONFLICT (user_id,edition_date) WHERE kind='scheduled' DO NOTHING RETURNING id
         ), i AS (
           INSERT INTO reading_items(id,edition_id,user_id,position,canonical_url,url,domain,source_name,title,summary,content_basis,published_at,first_seen_at,topics,label,reason,score,components)
           SELECT r.id,e.id,$2,r.position,r.canonical_url,r.url,r.domain,r.source_name,r.title,r.summary,r.content_basis,r.published_at,r.first_seen_at,r.topics,r.label,r.reason,r.score,r.components
           FROM e, jsonb_to_recordset($7::jsonb) AS r(id uuid,position int,canonical_url text,url text,domain text,source_name text,title text,summary text,content_basis text,published_at timestamptz,first_seen_at timestamptz,topics jsonb,label text,reason text,score numeric,components jsonb)
           RETURNING 1
         ) SELECT (SELECT id FROM e) AS id`,
        [
          editionId,
          user,
          kind,
          date,
          prefs.version,
          JSON.stringify(trace),
          JSON.stringify(items),
          now,
        ],
      )
    ).rows[0]?.id;
    return {
      retry: false as const,
      editionId: inserted ?? null,
      duplicate: !inserted,
      date,
      items: items.length,
      target,
      shortfall: trace.shortfall,
    };
  }
}
function sortKeys(o: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

// ---------- scheduling ----------
/** Deterministic daily trigger in the owner's timezone. Latest-only: a missed day is not
 * backfilled, and a slot earlier than `schedule_from` (enable/resume/time change) is skipped. */
export class ReadingScheduler {
  private busy = false;
  private retries = new Map<
    string,
    { date: string; attempts: number; next: number }
  >();
  constructor(
    private db: Database,
    private editions: ReadingEditions,
    private allowed: (user: string) => boolean,
    private clock = () => new Date(),
  ) {}
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.clock();
      const due = (
        await this.db.query(
          `SELECT user_id,delivery_time,timezone,schedule_from FROM reading_settings
           WHERE enabled AND NOT paused AND delivery_time IS NOT NULL AND timezone IS NOT NULL
             AND EXISTS(SELECT 1 FROM reading_sources r WHERE r.user_id=reading_settings.user_id AND r.status='active')`,
        )
      ).rows;
      for (const s of due) {
        if (!this.allowed(s.user_id) || !validTimeZone(s.timezone)) continue;
        const date = zonedParts(now, s.timezone).date;
        const slot = zonedInstant(date, s.delivery_time, s.timezone);
        if (now < slot) continue;
        if (s.schedule_from && slot < new Date(s.schedule_from)) continue;
        const exists = (
          await this.db.query(
            "SELECT 1 FROM reading_editions WHERE user_id=$1 AND kind='scheduled' AND edition_date=$2",
            [s.user_id, date],
          )
        ).rows.length;
        if (exists) continue;
        const retry = this.retries.get(s.user_id);
        if (retry?.date === date && retry.next > now.getTime()) continue;
        const attempts = retry?.date === date ? retry.attempts : 0;
        // When every source fails, retry for up to three hours before saying so.
        const allowRetry =
          attempts < 12 && now.getTime() - slot.getTime() < 3 * 3600000;
        try {
          const r = await this.editions.create(s.user_id, "scheduled", {
            allowRetry,
            at: now,
          });
          if (r.retry)
            this.retries.set(s.user_id, {
              date,
              attempts: attempts + 1,
              next: now.getTime() + 15 * 60000,
            });
          else this.retries.delete(s.user_id);
        } catch (error) {
          this.retries.set(s.user_id, {
            date,
            attempts: attempts + 1,
            next: now.getTime() + 15 * 60000,
          });
          console.error(
            JSON.stringify({
              event: "reading.build_failed",
              error:
                error instanceof Error
                  ? error.message.slice(0, 200)
                  : "unknown",
            }),
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

// ---------- delivery ----------
export type Button = { text: string; callback_data: string };
export function itemKeyboard(
  item: { id: string; topics: string[] },
  vote: { vote: Vote; reason: Reason | null } | null,
): Button[][] {
  const mark = (on: boolean, text: string) => (on ? `✓ ${text}` : text);
  const rows: Button[][] = [
    [
      {
        text: mark(vote?.vote === "like", "👍 Like"),
        callback_data: `rd:l:${item.id}`,
      },
      {
        text: mark(vote?.vote === "dislike", "👎 Dislike"),
        callback_data: `rd:d:${item.id}`,
      },
      {
        text: mark(vote?.vote === "more", "More like this"),
        callback_data: `rd:m:${item.id}`,
      },
    ],
  ];
  if (vote?.vote === "dislike") {
    const r = (code: string, reason: Reason, text: string) => ({
      text: mark(vote.reason === reason, text),
      callback_data: `rd:r:${code}:${item.id}`,
    });
    rows.push(
      [
        r("ot", "off_topic", "Off-topic"),
        r("sh", "too_shallow", "Too shallow"),
        r("ak", "already_knew", "Knew it"),
      ],
      [
        r("ps", "poor_source", "Poor source"),
        r("rp", "too_repetitive", "Repetitive"),
      ],
    );
  }
  const last: Button[] = [];
  if (vote) last.push({ text: "↩ Undo", callback_data: `rd:u:${item.id}` });
  last.push({ text: "Why this?", callback_data: `rd:w:${item.id}` });
  last.push({ text: "Mute source", callback_data: `rd:ms:${item.id}` });
  if (item.topics[0])
    last.push({
      text: `Mute “${item.topics[0].slice(0, 20)}”`,
      callback_data: `rd:mt:${item.id}`,
    });
  rows.push(last);
  return rows;
}
export function itemText(item: any, index: number, total: number, tz: string) {
  const labels = String(item.label ?? "")
    .split(",")
    .filter(Boolean);
  const date = item.published_at
    ? localLabel(new Date(item.published_at), tz, true)
    : "date not given";
  const tags = [
    labels.includes("older") ? "Older piece" : null,
    labels.includes("discovery") ? "Discovery pick" : null,
  ].filter(Boolean);
  const excerpt =
    item.content_basis === "feed_summary" && item.summary
      ? `Feed excerpt: ${item.summary}`
      : "Only the headline was available from the feed; open the link to read it.";
  return [
    `${index + 1}/${total} · ${item.title}`,
    [item.source_name, date, ...tags].join(" · "),
    excerpt,
    `Why: ${item.reason}`,
    item.url,
  ].join("\n");
}
export function headerText(edition: any, count: number, tz: string) {
  const trace = edition.trace ?? {};
  const target = trace.target ?? 5;
  const when = localLabel(new Date(edition.created_at), tz);
  const lines = [
    `${edition.kind === "on_demand" ? "Readings on request" : "Your daily readings"} — ${when} (${count} of ${target})`,
  ];
  if (!count)
    lines.push(
      `No credible new readings this time${trace.shortfall ? `: ${trace.shortfall}` : ""}. Nothing was padded or invented.`,
    );
  else if (trace.shortfall)
    lines.push(`Fewer than ${target}: ${trace.shortfall}.`);
  if (count)
    lines.push(
      "Excerpts come from each source's feed, not a full reading of the article. Rate items to tune future editions; silence counts as no opinion.",
    );
  return lines.join("\n");
}

/** Persisted edition outbox mirroring RoutineDelivery: pending → sending → sent, with
 * 'uncertain' on interruption. Never retried automatically. */
export class ReadingDelivery {
  private busy = false;
  constructor(
    private db: Database,
    private send: (
      user: string,
      text: string,
      keyboard?: Button[][],
    ) => Promise<unknown>,
    private allowed: (user: string) => boolean = () => true,
  ) {}
  async recover() {
    await this.db.query(
      "UPDATE reading_editions SET state='uncertain' WHERE state='sending'",
    );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Scheduled editions of a paused or disabled bulletin must not deliver late.
      await this.db.query(
        `UPDATE reading_editions e SET state='muted' FROM reading_settings s
         WHERE s.user_id=e.user_id AND e.state='pending' AND e.kind='scheduled' AND (s.paused OR NOT s.enabled)`,
      );
      const edition = (
        await this.db
          .query(`UPDATE reading_editions SET state='sending' WHERE id=(
           SELECT id FROM reading_editions WHERE state='pending'
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)
      ).rows[0];
      if (!edition) return;
      try {
        if (!this.allowed(edition.user_id))
          throw new Error("Unauthorized delivery");
        const tz =
          (
            await this.db.query(
              "SELECT timezone FROM reading_settings WHERE user_id=$1",
              [edition.user_id],
            )
          ).rows[0]?.timezone ?? "UTC";
        const items = (
          await this.db.query(
            "SELECT * FROM reading_items WHERE edition_id=$1 ORDER BY position",
            [edition.id],
          )
        ).rows;
        await this.send(
          edition.user_id,
          headerText(edition, items.length, tz),
          [
            [
              {
                text: "Pause daily readings",
                callback_data: `rd:p:${edition.id}`,
              },
            ],
          ],
        );
        for (const [index, item] of items.entries()) {
          await this.send(
            edition.user_id,
            itemText(item, index, items.length, tz),
            itemKeyboard(item, null),
          );
          await this.db.query(
            "UPDATE reading_items SET sent_at=now() WHERE id=$1",
            [item.id],
          );
        }
        await this.db.query(
          "UPDATE reading_editions SET state='sent',sent_at=now() WHERE id=$1",
          [edition.id],
        );
      } catch {
        await this.db.query(
          "UPDATE reading_editions SET state='uncertain' WHERE id=$1",
          [edition.id],
        );
      }
    } finally {
      this.busy = false;
    }
  }
}

// ---------- button feedback ----------
const REASONS: Record<string, Reason> = {
  ot: "off_topic",
  sh: "too_shallow",
  ak: "already_knew",
  ps: "poor_source",
  rp: "too_repetitive",
};
export const readingCallback =
  /^rd:(?:(l|m|d|u|w|ms|mt|p)|r:(ot|sh|ak|ps|rp)):([0-9a-f-]{36})$/;
export function explainItem(item: any, version: number | null) {
  const c = item.components ?? {};
  return [
    `Why “${String(item.title).slice(0, 120)}”:`,
    item.reason,
    `Score ${Number(item.score).toFixed(2)} = interest ${c.interest} + preferred source ${c.source} + feedback ${c.feedback} + recency ${c.recency}.`,
    c.inBaseline === false
      ? "Your earlier feedback moved this into the edition; the no-feedback baseline would have chosen something else."
      : "The no-feedback baseline ranking would also have chosen it.",
    `Preference version ${version ?? "none"}. Feedback can change a score by at most ±${FEEDBACK_CAP}; it never removes a topic or source by itself.`,
  ].join("\n");
}
/** Owner-bound, replay-safe feedback. Each press sets the current state rather than
 * toggling or accumulating, so a replayed or double-tapped button changes nothing. */
export class ReadingFeedback {
  constructor(
    private db: Database,
    private clock = () => new Date(),
  ) {}
  private async log(
    user: string,
    item: string | null,
    action: string,
    detail = {},
  ) {
    await this.db.query(
      "INSERT INTO reading_feedback_events(user_id,item_id,action,detail,created_at) VALUES($1,$2,$3,$4::jsonb,$5)",
      [user, item, action, JSON.stringify(detail), this.clock()],
    );
  }
  async setVote(
    user: string,
    itemId: string,
    vote: Vote | null,
    reason: Reason | null = null,
  ) {
    const item = (
      await this.db.query(
        "SELECT id,topics,domain FROM reading_items WHERE id=$1 AND user_id=$2",
        [itemId, user],
      )
    ).rows[0];
    if (!item) return null;
    if (vote === null)
      await this.db.query(
        "DELETE FROM reading_votes WHERE item_id=$1 AND user_id=$2",
        [itemId, user],
      );
    else
      await this.db.query(
        `INSERT INTO reading_votes(item_id,user_id,vote,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)
         ON CONFLICT(item_id) DO UPDATE SET vote=EXCLUDED.vote,reason=EXCLUDED.reason,
           updated_at=CASE WHEN reading_votes.vote=EXCLUDED.vote AND reading_votes.reason IS NOT DISTINCT FROM EXCLUDED.reason
             THEN reading_votes.updated_at ELSE EXCLUDED.updated_at END
         WHERE reading_votes.user_id=EXCLUDED.user_id`,
        [itemId, user, vote, reason, this.clock()],
      );
    await this.log(user, itemId, vote ?? "undo", reason ? { reason } : {});
    return { item, vote: vote ? { vote, reason } : null };
  }
  async press(user: string, data: string) {
    const m = readingCallback.exec(data);
    if (!m) return { notice: "That button is not recognised." };
    const [, action, code] = m;
    const id = m[3]!;
    if (action === "p") {
      const r = await this.db.query(
        `UPDATE reading_settings SET paused=true,updated_at=now() WHERE user_id=$1
         AND EXISTS(SELECT 1 FROM reading_editions WHERE id=$2 AND user_id=$1) RETURNING user_id`,
        [user, id],
      );
      if (!r.rows.length) return { notice: "That bulletin is unavailable." };
      await this.db.query(
        "UPDATE reading_editions SET state='muted' WHERE user_id=$1 AND state='pending' AND kind='scheduled'",
        [user],
      );
      await this.log(user, null, "pause");
      return {
        notice: "Daily readings paused. Ask me to resume anytime.",
        clear: true,
      };
    }
    const item = (
      await this.db.query(
        "SELECT i.*,e.preference_version FROM reading_items i JOIN reading_editions e ON e.id=i.edition_id WHERE i.id=$1 AND i.user_id=$2",
        [id, user],
      )
    ).rows[0];
    if (!item) return { notice: "That reading is unavailable." };
    const current = async () =>
      (
        await this.db.query(
          "SELECT vote,reason FROM reading_votes WHERE item_id=$1 AND user_id=$2",
          [id, user],
        )
      ).rows[0] ?? null;
    if (action === "w")
      return {
        notice: "Explained below.",
        reply: explainItem(item, item.preference_version),
      };
    if (action === "ms" || action === "mt") {
      const column = action === "ms" ? "excluded_domains" : "muted_topics";
      const value = action === "ms" ? item.domain : item.topics?.[0];
      if (!value) return { notice: "No topic to mute for this reading." };
      await this.db.query(
        `INSERT INTO reading_settings(user_id,${column}) VALUES($1,jsonb_build_array($2::text))
         ON CONFLICT(user_id) DO UPDATE SET ${column}=CASE WHEN reading_settings.${column} ? $2::text
           THEN reading_settings.${column} ELSE reading_settings.${column}||jsonb_build_array($2::text) END,updated_at=now()`,
        [user, value],
      );
      await this.log(user, id, action === "ms" ? "mute_source" : "mute_topic", {
        value,
      });
      return {
        notice:
          action === "ms"
            ? `Muted ${value}. Ask me to unmute it anytime.`
            : `Muted topic “${value}”. Ask me to unmute it anytime.`,
        keyboard: itemKeyboard(item, await current()),
      };
    }
    const vote: Vote | null =
      action === "u"
        ? null
        : action === "l"
          ? "like"
          : action === "m"
            ? "more"
            : "dislike";
    // A reason always means dislike; plain Dislike keeps any reason already chosen.
    const prior = await current();
    const reason = code
      ? REASONS[code]!
      : vote === "dislike" && prior?.vote === "dislike"
        ? prior.reason
        : null;
    const r = await this.setVote(user, id, vote, reason);
    if (!r) return { notice: "That reading is unavailable." };
    return {
      notice:
        vote === null
          ? "Feedback removed."
          : vote === "dislike"
            ? reason
              ? "Saved: disliked, with your reason."
              : "Saved: disliked. Optionally tell me why."
            : vote === "more"
              ? "Saved: more like this."
              : "Saved: liked.",
      keyboard: itemKeyboard(item, r.vote),
    };
  }
}

// ---------- conversational tools ----------
type ReadingAction = Extract<Action, { operation: `reading_${string}` }>;

export class ReadingTools {
  private editions: ReadingEditions;
  constructor(
    private db: Database,
    private fetcher: FeedFetcher,
    private clock = () => new Date(),
  ) {
    this.editions = new ReadingEditions(db, fetcher, clock);
  }
  private async requireForeground(user: string, run: string) {
    const turn = (
      await this.db.query(
        "SELECT background FROM work_turns WHERE run_id=$1 AND user_id=$2",
        [run, user],
      )
    ).rows[0];
    if (!turn || turn.background)
      throw new ToolValidationError(
        "Only a foreground user request may change the reading bulletin",
      );
  }
  async call(user: string, run: string, a: ReadingAction): Promise<any> {
    if (a.operation === "reading_status") return this.status(user);
    if (a.operation === "reading_explain") return this.explain(user, a.itemId);
    await this.requireForeground(user, run);
    if (a.operation === "reading_settings") return this.configure(user, a);
    if (a.operation === "reading_source_add") return this.addSource(user, a);
    if (a.operation === "reading_source_remove")
      return this.removeSource(user, a.id);
    if (a.operation === "reading_preferences") return this.preferences(user, a);
    return this.editionNow(user);
  }
  private async status(user: string) {
    const s = await this.editions.settings(user);
    const now = this.clock();
    const sources = (
      await this.db.query(
        "SELECT id,name,url,topics,status,last_status,last_error,last_item_count,last_fetched_at,next_retry_at FROM reading_sources WHERE user_id=$1 ORDER BY created_at",
        [user],
      )
    ).rows;
    const editions = (
      await this.db.query(
        `SELECT e.id,e.kind,e.edition_date,e.state,e.created_at,e.sent_at,e.trace->>'shortfall' AS shortfall,
           (SELECT count(*)::int FROM reading_items i WHERE i.edition_id=e.id) AS items,
           (SELECT count(*)::int FROM reading_items i WHERE i.edition_id=e.id AND i.sent_at IS NOT NULL) AS sent
         FROM reading_editions e WHERE e.user_id=$1 ORDER BY e.created_at DESC LIMIT 5`,
        [user],
      )
    ).rows;
    const prefs = await this.editions.preferences(user, "status", false);
    const top = Object.entries(prefs.weights)
      .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
      .slice(0, 20);
    return {
      settings: {
        enabled: s.enabled ?? false,
        paused: s.paused ?? false,
        interests: s.interests,
        languages: s.languages,
        preferredDomains: s.preferred_domains,
        excludedDomains: s.excluded_domains,
        mutedTopics: s.muted_topics,
        deliveryTime: s.delivery_time ?? null,
        timezone: s.timezone ?? null,
        itemsPerEdition: s.items_per_edition,
        discoverySlots: s.discovery_slots,
        nextDelivery:
          s.enabled && !s.paused
            ? (nextDelivery(s as any, now)?.toISOString() ?? null)
            : null,
      },
      sources,
      learned: {
        version: prefs.version,
        activeVotes: prefs.votes,
        weights: Object.fromEntries(top),
        overrides: s.overrides,
        resetAt: s.learning_reset_at ?? null,
        rule: `like +1 topic/+0.5 source; more-like-this double; plain dislike -0.3/-0.15; reasons target topic or source; ${HALF_LIFE_DAYS}-day half-life; per-key cap ±${WEIGHT_CAP}; feedback shifts a score by at most ±${FEEDBACK_CAP}`,
      },
      recentEditions: editions,
      metrics: await this.metrics(user, now),
    };
  }
  /** Report-only quality signals. Silence is unknown, not failure; a handful of votes is
   * not evidence of improvement. */
  async metrics(user: string, now: Date) {
    const since = new Date(now.getTime() - 30 * 86400000);
    const items = (
      await this.db.query(
        `SELECT i.id,i.edition_id,i.title,i.domain,i.sent_at,i.content_basis,i.components,v.vote
         FROM reading_items i LEFT JOIN reading_votes v ON v.item_id=i.id
         WHERE i.user_id=$1 AND i.sent_at>=$2 ORDER BY i.sent_at`,
        [user, since],
      )
    ).rows;
    const editions = (
      await this.db.query(
        "SELECT trace FROM reading_editions WHERE user_id=$1 AND created_at>=$2",
        [user, since],
      )
    ).rows;
    const rated = items.filter((i) => i.vote);
    const liked = rated.filter((i) => i.vote !== "dislike");
    const byEdition = new Map<string, Set<string>>();
    for (const i of items)
      byEdition.set(
        i.edition_id,
        (byEdition.get(i.edition_id) ?? new Set()).add(i.domain),
      );
    let repeated = 0;
    const seen: { tokens: Set<string>; at: number }[] = [];
    for (const i of items) {
      const tokens = storyTokens(i.title);
      const at = new Date(i.sent_at).getTime();
      if (
        seen.some(
          (s) =>
            at - s.at <= 14 * 86400000 &&
            similarity(s.tokens, tokens) >= SAME_STORY,
        )
      )
        repeated++;
      seen.push({ tokens, at });
    }
    const feedbackOnly = rated.filter(
      (i) => i.components?.inBaseline === false,
    );
    const ratio = (a: number, b: number) => (b ? round(a / b) : null);
    return {
      windowDays: 30,
      delivered: items.length,
      rated: rated.length,
      likeRate: ratio(liked.length, rated.length),
      ratingCoverage: ratio(rated.length, items.length),
      repeatedStoryRate: ratio(repeated, items.length),
      avgSourceDomainsPerEdition: byEdition.size
        ? round(
            [...byEdition.values()].reduce((a, s) => a + s.size, 0) /
              byEdition.size,
          )
        : null,
      sourceFailures: editions.reduce(
        (a, e) =>
          a +
          (e.trace?.sources ?? []).filter((s: any) => s.status === "failed")
            .length,
        0,
      ),
      titleOnlyItems: items.filter((i) => i.content_basis === "title_only")
        .length,
      feedbackOnlyPicks: {
        rated: feedbackOnly.length,
        liked: feedbackOnly.filter((i) => i.vote !== "dislike").length,
      },
      modelCallsPerEdition: 0,
      note: "likeRate uses rated items only; unrated items are unknown. Small samples do not show improvement. Summary accuracy errors are owner-reported, not measured here.",
    };
  }
  private async configure(
    user: string,
    a: Extract<ReadingAction, { operation: "reading_settings" }>,
  ) {
    if (a.timezone !== undefined && !validTimeZone(a.timezone))
      throw new ToolValidationError(
        `Unknown IANA timezone "${a.timezone}"; use a name like Asia/Singapore`,
      );
    const old = await this.editions.settings(user);
    const merged = {
      interests:
        a.interests?.map((i) => ({
          topic: i.topic.trim(),
          keywords: [
            ...new Set((i.keywords ?? []).map((k) => k.trim()).filter(Boolean)),
          ],
        })) ?? old.interests,
      languages: a.languages?.map((l) => l.toLowerCase()) ?? old.languages,
      preferred_domains:
        a.preferredDomains?.map(normDomain).filter(Boolean) ??
        old.preferred_domains,
      excluded_domains:
        a.excludedDomains?.map(normDomain).filter(Boolean) ??
        old.excluded_domains,
      muted_topics:
        a.mutedTopics?.map(normTopic).filter(Boolean) ?? old.muted_topics,
      delivery_time: a.deliveryTime ?? old.delivery_time ?? null,
      timezone: a.timezone ?? old.timezone ?? null,
      items_per_edition: a.itemsPerEdition ?? old.items_per_edition,
      discovery_slots: a.discoverySlots ?? old.discovery_slots,
      enabled: a.enabled ?? old.enabled ?? false,
      paused: a.paused ?? old.paused ?? false,
    };
    if (merged.discovery_slots >= merged.items_per_edition)
      throw new ToolValidationError(
        "discoverySlots must leave at least one slot for your interests",
      );
    // Checked on every change while enabled, so the bulletin cannot be left running
    // without interests, a delivery time or a feed.
    if (merged.enabled) {
      const sources = (
        await this.db.query(
          "SELECT count(*)::int AS n FROM reading_sources WHERE user_id=$1 AND status='active'",
          [user],
        )
      ).rows[0].n;
      const missing = [
        !merged.interests.length && "interests",
        !merged.delivery_time && "deliveryTime",
        !merged.timezone && "timezone",
        !sources && "at least one feed (reading_source_add)",
      ].filter(Boolean);
      if (missing.length)
        throw new ToolValidationError(
          `Ask the owner for ${missing.join(", ")} before enabling the daily bulletin`,
        );
    }
    const now = this.clock();
    // Restart the schedule clock whenever delivery becomes active or its time changes, so
    // enabling after today's slot waits for tomorrow instead of sending immediately.
    const restart =
      (merged.enabled && !old.enabled) ||
      (!merged.paused && old.paused) ||
      merged.delivery_time !== (old.delivery_time ?? null) ||
      merged.timezone !== (old.timezone ?? null);
    const row = (
      await this.db.query(
        `INSERT INTO reading_settings(user_id,enabled,paused,interests,languages,preferred_domains,excluded_domains,muted_topics,delivery_time,timezone,items_per_edition,discovery_slots,schedule_from)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)
         ON CONFLICT(user_id) DO UPDATE SET enabled=$2,paused=$3,interests=$4::jsonb,languages=$5::jsonb,
           preferred_domains=$6::jsonb,excluded_domains=$7::jsonb,muted_topics=$8::jsonb,delivery_time=$9,timezone=$10,
           items_per_edition=$11,discovery_slots=$12,schedule_from=CASE WHEN $14 THEN $13 ELSE reading_settings.schedule_from END,updated_at=now()
         RETURNING *`,
        [
          user,
          merged.enabled,
          merged.paused,
          JSON.stringify(merged.interests),
          JSON.stringify(merged.languages),
          JSON.stringify([...new Set(merged.preferred_domains)]),
          JSON.stringify([...new Set(merged.excluded_domains)]),
          JSON.stringify([...new Set(merged.muted_topics)]),
          merged.delivery_time,
          merged.timezone,
          merged.items_per_edition,
          merged.discovery_slots,
          now,
          restart,
        ],
      )
    ).rows[0];
    if (row.paused || !row.enabled)
      await this.db.query(
        "UPDATE reading_editions SET state='muted' WHERE user_id=$1 AND state='pending' AND kind='scheduled'",
        [user],
      );
    return {
      settings: row,
      nextDelivery:
        row.enabled && !row.paused
          ? nextDelivery(row, now)?.toISOString()
          : null,
      note: row.enabled
        ? "Delivery is deterministic: approved feeds only, feed excerpts, no model call per edition."
        : "Not enabled; nothing is scheduled until the owner confirms interests, feeds, time and timezone.",
    };
  }
  private async addSource(
    user: string,
    a: Extract<ReadingAction, { operation: "reading_source_add" }>,
  ) {
    const count = (
      await this.db.query(
        "SELECT count(*)::int AS n FROM reading_sources WHERE user_id=$1",
        [user],
      )
    ).rows[0].n;
    if (count >= MAX_SOURCES)
      throw new ToolValidationError(
        `Maximum ${MAX_SOURCES} feeds; remove one first`,
      );
    let url: string;
    try {
      url = new URL(a.url).href;
    } catch {
      throw new ToolValidationError("Use the feed's full https:// URL");
    }
    const id = randomUUID();
    const inserted = (
      await this.db.query(
        `INSERT INTO reading_sources(id,user_id,url,name,topics) VALUES($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT(user_id,url) DO NOTHING RETURNING id`,
        [
          id,
          user,
          url,
          a.name ?? new URL(url).hostname,
          JSON.stringify((a.topics ?? []).map(normTopic)),
        ],
      )
    ).rows[0];
    if (!inserted)
      throw new ToolValidationError("That feed is already configured");
    try {
      const r = await this.editions.ingest(user, { id, url });
      if (!r.items)
        throw new Error("no readable entries with a title and link");
      const name = a.name ?? r.title ?? new URL(url).hostname;
      const row = (
        await this.db.query(
          "UPDATE reading_sources SET name=$3,last_fetched_at=$5,last_status='ok',last_item_count=$4 WHERE id=$1 AND user_id=$2 RETURNING id,name,url,topics",
          [id, user, name, r.items, this.clock()],
        )
      ).rows[0];
      return {
        added: row,
        entries: r.items,
        note: "Feed text is untrusted; only titles, links, dates and excerpts are used.",
      };
    } catch (error) {
      await this.db.query(
        "DELETE FROM reading_candidates WHERE source_id=$1 AND user_id=$2",
        [id, user],
      );
      await this.db.query(
        "DELETE FROM reading_sources WHERE id=$1 AND user_id=$2",
        [id, user],
      );
      throw new ToolValidationError(
        `Could not read that feed: ${error instanceof Error ? error.message.slice(0, 160) : "feed error"}. Use a public HTTPS RSS or Atom URL.`,
      );
    }
  }
  private async removeSource(user: string, id: string) {
    await this.db.query(
      "DELETE FROM reading_candidates WHERE source_id=$1 AND user_id=$2",
      [id, user],
    );
    const row = (
      await this.db.query(
        "DELETE FROM reading_sources WHERE id=$1 AND user_id=$2 RETURNING name,url",
        [id, user],
      )
    ).rows[0];
    if (!row) throw new ToolValidationError("Reading source unavailable");
    // Without a feed the daily bulletin would only send empty editions: switch it off.
    const disabled = (
      await this.db.query(
        `UPDATE reading_settings SET enabled=false,updated_at=now() WHERE user_id=$1 AND enabled
         AND NOT EXISTS(SELECT 1 FROM reading_sources WHERE user_id=$1 AND status='active') RETURNING user_id`,
        [user],
      )
    ).rows.length;
    if (disabled)
      await this.db.query(
        "UPDATE reading_editions SET state='muted' WHERE user_id=$1 AND state='pending' AND kind='scheduled'",
        [user],
      );
    return {
      removed: row,
      ...(disabled
        ? {
            disabled: true,
            note: "That was the last feed, so the daily bulletin is now off. Add a feed and re-enable it to resume.",
          }
        : {}),
    };
  }
  private async preferences(
    user: string,
    a: Extract<ReadingAction, { operation: "reading_preferences" }>,
  ) {
    await this.db.query(
      "INSERT INTO reading_settings(user_id) VALUES($1) ON CONFLICT DO NOTHING",
      [user],
    );
    if (a.action === "reset") {
      await this.db.query(
        "UPDATE reading_settings SET learning_reset_at=$2,overrides='{}'::jsonb,updated_at=now() WHERE user_id=$1",
        [user, this.clock()],
      );
      await this.db.query(
        "INSERT INTO reading_feedback_events(user_id,action) VALUES($1,'reset')",
        [user],
      );
    } else {
      if (!a.key)
        throw new ToolValidationError(
          "key is required, e.g. topic:climate or source:example.com",
        );
      const key = a.key.startsWith("topic:")
        ? `topic:${normTopic(a.key.slice(6))}`
        : `source:${normDomain(a.key.slice(7))}`;
      if (a.action === "set" && a.weight === undefined)
        throw new ToolValidationError("weight is required to set a preference");
      await this.db.query(
        a.action === "set"
          ? "UPDATE reading_settings SET overrides=overrides||jsonb_build_object($2::text,$3::numeric),updated_at=now() WHERE user_id=$1"
          : "UPDATE reading_settings SET overrides=overrides-$2::text,updated_at=now() WHERE user_id=$1",
        a.action === "set" ? [user, key, a.weight] : [user, key],
      );
      await this.db.query(
        "INSERT INTO reading_feedback_events(user_id,action,detail) VALUES($1,$2,$3::jsonb)",
        [
          user,
          `override_${a.action}`,
          JSON.stringify({ key, weight: a.weight ?? null }),
        ],
      );
    }
    const prefs = await this.editions.preferences(user, `owner:${a.action}`);
    return {
      version: prefs.version,
      weights: prefs.weights,
      note:
        a.action === "reset"
          ? "Earlier votes are kept for history but no longer influence ranking."
          : "Owner overrides replace the learned weight for that key until cleared.",
    };
  }
  private async editionNow(user: string) {
    const s = await this.editions.settings(user);
    const sources = (
      await this.db.query(
        "SELECT count(*)::int AS n FROM reading_sources WHERE user_id=$1 AND status='active'",
        [user],
      )
    ).rows[0].n;
    if (!s.interests.length || !sources)
      throw new ToolValidationError(
        "Set interests and add at least one feed before requesting an edition",
      );
    const r = await this.editions.create(user, "on_demand", {
      dailyLimit: ON_DEMAND_PER_DAY,
    });
    if (r.retry)
      throw new ToolValidationError("Every feed failed; try again later");
    return {
      editionId: r.editionId,
      items: r.items,
      target: r.target,
      shortfall: r.shortfall,
      instruction:
        "The edition is being delivered as separate Telegram messages with rating buttons. Confirm briefly; do not repeat the items.",
    };
  }
  private async explain(user: string, itemId: string) {
    const item = (
      await this.db.query(
        `SELECT i.*,e.preference_version,e.kind,e.edition_date,e.trace->'excluded' AS excluded,
           e.trace->'baseline' AS baseline,e.trace->'shortfall' AS shortfall,v.vote,v.reason AS vote_reason
         FROM reading_items i JOIN reading_editions e ON e.id=i.edition_id
         LEFT JOIN reading_votes v ON v.item_id=i.id WHERE i.id=$1 AND i.user_id=$2`,
        [itemId, user],
      )
    ).rows[0];
    if (!item) throw new ToolValidationError("Reading item unavailable");
    return {
      untrusted: true,
      explanation: explainItem(item, item.preference_version),
      item: {
        title: item.title,
        url: item.url,
        source: item.source_name,
        publishedAt: item.published_at,
        discoveredAt: item.first_seen_at,
        contentBasis: item.content_basis,
        topics: item.topics,
        labels: item.label,
        components: item.components,
        vote: item.vote ?? null,
        voteReason: item.vote_reason ?? null,
      },
      edition: {
        kind: item.kind,
        date: item.edition_date,
        exclusions: item.excluded,
        shortfall: item.shortfall,
      },
    };
  }
}
