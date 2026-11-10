// Study links: the owner-scoped collection for study material (db/036_study_links.sql),
// the durable record for a save that needed the owner's choice, and the Reader hand-off
// for links that are offline reading instead. The routing itself is model judgment in
// src/jev.ts; this module never decides by keyword.
//
// One URL per link: the normalised URL is what the pending-Reader lookup compares, what
// the save_link payload carries and what de-duplicates entries. A Reader request key is
// reused only for a genuine retry of the identical request (nothing is in flight and
// nothing was refused under it); after a stored rejection the next attempt gets a new key.
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import {
  canonicalUrl,
  PublicFeedFetcher,
  type FeedFetcher,
} from "./news-feed.js";
import {
  dedupeKey,
  judgeLink,
  linkUrl,
  pageInfo,
  topicLabel,
  type PageInfo,
} from "./link-classifier.js";
import {
  readLinkClassifierConfig,
  type LinkClassifierConfig,
  type LinkJudge,
  type LinkRoute,
} from "./jev.js";
import { MemoryStore } from "./memory.js";
import { errorFields, opsLog, projectEvent } from "./ops-log.js";
import { ToolValidationError } from "./tool-errors.js";
import type { ReaderLink } from "./news.js";
import {
  STUDY_WRITE_OPERATIONS,
  type LinkChoice,
  type StudyStatus,
} from "./study-links-schema.js";

export type { LinkChoice, StudyStatus };
export {
  LINK_CHOICES,
  STUDY_STATUSES,
  STUDY_WRITE_OPERATIONS,
} from "./study-links-schema.js";

const STATUS_LABEL: Record<StudyStatus, string> = {
  to_study: "to study",
  in_progress: "in progress",
  done: "done",
};

export interface StudyEntry {
  id: string;
  user: string;
  url: string;
  canonicalUrl: string;
  title: string;
  source: string | null;
  topic: string | null;
  tags: string[];
  notes: string | null;
  status: StudyStatus;
  route: string;
  reason: string;
  confidence: number;
  model: string | null;
  readerSaved: boolean;
  addedAt: string;
  updatedAt: string;
}

const COLUMNS = `id,user_id,url,canonical_url,title,source,topic,tags,notes,status,
 classification_route,classification_reason,classification_confidence,classification_model,
 reader_saved,added_at,updated_at`;

function entryOf(row: any): StudyEntry {
  return {
    id: row.id,
    user: row.user_id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    source: row.source ?? null,
    topic: row.topic ?? null,
    tags: row.tags ?? [],
    notes: row.notes ?? null,
    status: row.status,
    route: row.classification_route,
    reason: row.classification_reason,
    confidence: Number(row.classification_confidence),
    model: row.classification_model ?? null,
    readerSaved: !!row.reader_saved,
    addedAt: new Date(row.added_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface StudyWrite {
  url: string;
  canonicalUrl: string;
  title: string;
  source: string | null;
  topic: string | null;
  tags?: string[];
  notes?: string | null;
  route: string;
  reason: string;
  confidence: number;
  model: string | null;
}

export interface StudyFilter {
  /** A partial topic query, matched case-insensitively with `%` and `_` escaped. */
  topic?: string;
  /** Exact stored topic labels, used for a broad learning-interest query. */
  topics?: string[];
  tag?: string;
  status?: StudyStatus;
  limit?: number;
}

/** `%`, `_` and `\` are literal characters in a topic the owner typed, not wildcards. */
const likePattern = (value: string) =>
  `%${value.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Question filler that names no topic at all ("what's on my AI study list"). */
const TOPIC_FILLER =
  /\b(?:what'?s|what|which|is|are|was|on|in|of|from|my|the|all|any|show|me|list|lists|do|i|have|saved|new)\b/g;
/** Words that describe the whole learning-interest collection rather than one area. */
const BROAD_WORD =
  /^(?:ai|a\.i\.|ml|ai\/ml|learning|study|studies|tech|technical|stuff|items|links|resources|material|reading)$/;
/** Words that name no topic on their own, so "machine learning" is still a broad query. */
const NOISE_WORD = /^(?:machine)$/;

/**
 * How a topic query becomes a filter. A query naming the whole learning-interest
 * collection ("AI", "my AI study list") covers every configured interest area, because
 * the stored topics are the area labels and "agent platforms" and "developer tools"
 * contain no "AI" to match. Any other query also matches a partial topic label.
 */
export function topicFilter(query: string, interests: string[]) {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return { labels: [] as string[], like: undefined };
  const words = wanted
    .replace(TOPIC_FILLER, " ")
    .split(/[^a-z0-9./]+/)
    .filter(Boolean)
    .filter((word) => !NOISE_WORD.test(word));
  if (words.length && words.every((word) => BROAD_WORD.test(word)))
    return {
      labels: interests.map((area) => area.toLowerCase()),
      like: undefined,
    };
  return {
    labels: interests
      .filter((area) => {
        const label = area.toLowerCase();
        return label.includes(wanted) || wanted.includes(label);
      })
      .map((area) => area.toLowerCase()),
    like: wanted,
  };
}

/** The collection and the durable decision records, owner-scoped in every statement. */
export class StudyStore {
  constructor(private db: Database) {}

  /** A duplicate canonical URL returns the existing entry instead of inserting. */
  async add(
    user: string,
    entry: StudyWrite,
  ): Promise<{ existing: boolean; entry: StudyEntry }> {
    const inserted = await this.db.query(
      `INSERT INTO study_resources(id,user_id,url,canonical_url,title,source,topic,tags,notes,
         classification_route,classification_reason,classification_confidence,classification_model)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(user_id,canonical_url) DO NOTHING RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        user,
        entry.url,
        entry.canonicalUrl,
        entry.title,
        entry.source,
        entry.topic,
        entry.tags ?? [],
        entry.notes ?? null,
        entry.route,
        entry.reason,
        entry.confidence,
        entry.model,
      ],
    );
    if (inserted.rows.length)
      return { existing: false, entry: entryOf(inserted.rows[0]) };
    const existing = await this.findByCanonical(user, entry.canonicalUrl);
    if (!existing)
      throw new Error("Study entry unavailable after a duplicate insert");
    return { existing: true, entry: existing };
  }

  async findByCanonical(user: string, canonical: string) {
    const row = (
      await this.db.query(
        `SELECT ${COLUMNS} FROM study_resources WHERE user_id=$1 AND canonical_url=$2`,
        [user, canonical],
      )
    ).rows[0];
    return row ? entryOf(row) : undefined;
  }

  async find(user: string, id: string) {
    const row = (
      await this.db.query(
        `SELECT ${COLUMNS} FROM study_resources WHERE user_id=$1 AND id=$2`,
        [user, id],
      )
    ).rows[0];
    return row ? entryOf(row) : undefined;
  }

  async list(user: string, filter: StudyFilter = {}) {
    const values: unknown[] = [user];
    const where = ["user_id=$1"];
    if (filter.status) {
      values.push(filter.status);
      where.push(`status=$${values.length}`);
    }
    if (filter.topic || filter.topics?.length) {
      const parts: string[] = [];
      if (filter.topics?.length) {
        // A broad query resolves to the configured interest areas (see topicFilter()).
        values.push(filter.topics.map((label) => label.toLowerCase()));
        parts.push(`lower(topic) = ANY($${values.length}::text[])`);
      }
      if (filter.topic) {
        values.push(likePattern(filter.topic));
        parts.push(`lower(topic) LIKE $${values.length} ESCAPE '\\'`);
      }
      where.push(`(${parts.join(" OR ")})`);
    }
    if (filter.tag) {
      values.push(filter.tag.toLowerCase());
      where.push(
        `EXISTS (SELECT 1 FROM unnest(tags) t WHERE lower(t)=$${values.length})`,
      );
    }
    values.push(Math.min(Math.max(filter.limit ?? 20, 1), 50));
    const rows = (
      await this.db.query(
        `SELECT ${COLUMNS} FROM study_resources WHERE ${where.join(" AND ")}
         ORDER BY CASE status WHEN 'to_study' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
           added_at DESC
         LIMIT $${values.length}`,
        values,
      )
    ).rows;
    return rows.map(entryOf);
  }

  /** The topics actually in use, so a filter can be corrected instead of failing blind. */
  async topics(user: string) {
    const rows = (
      await this.db.query(
        `SELECT DISTINCT topic FROM study_resources
         WHERE user_id=$1 AND topic IS NOT NULL ORDER BY topic LIMIT 20`,
        [user],
      )
    ).rows;
    return rows.map((row) => row.topic as string);
  }

  async counts(user: string) {
    const rows = (
      await this.db.query(
        "SELECT status,count(*)::int AS n FROM study_resources WHERE user_id=$1 GROUP BY status",
        [user],
      )
    ).rows;
    const counts: Record<StudyStatus, number> = {
      to_study: 0,
      in_progress: 0,
      done: 0,
    };
    for (const row of rows ?? [])
      counts[row.status as StudyStatus] = Number(row.n);
    return counts;
  }

  async update(
    user: string,
    id: string,
    patch: {
      status?: StudyStatus;
      notes?: string | null;
      tags?: string[];
      title?: string;
    },
  ) {
    const values: unknown[] = [user, id];
    const sets: string[] = [];
    for (const [column, value] of [
      ["status", patch.status],
      ["notes", patch.notes],
      ["tags", patch.tags],
      ["title", patch.title],
    ] as const) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column}=$${values.length}`);
    }
    if (!sets.length) return this.find(user, id);
    const row = (
      await this.db.query(
        `UPDATE study_resources SET ${sets.join(",")},updated_at=now()
         WHERE user_id=$1 AND id=$2 RETURNING ${COLUMNS}`,
        values,
      )
    ).rows[0];
    return row ? entryOf(row) : undefined;
  }

  async remove(user: string, id: string) {
    const row = (
      await this.db.query(
        "DELETE FROM study_resources WHERE user_id=$1 AND id=$2 RETURNING title",
        [user, id],
      )
    ).rows[0];
    return row ? { title: row.title as string } : undefined;
  }

  /** Marks the Reader copy of the same link, when the owner asked for both. */
  async markReaderSaved(user: string, canonical: string) {
    await this.db.query(
      "UPDATE study_resources SET reader_saved=true,updated_at=now() WHERE user_id=$1 AND canonical_url=$2",
      [user, canonical],
    );
  }

  /**
   * Every Reader save still in flight for this owner. `source_payload` is what Chief
   * sent; `payload` may already hold the publisher address Reader resolution produced,
   * so comparing only `payload` would miss the owner's own link.
   */
  async pendingReaderSaves(user: string) {
    const rows = (
      await this.db.query(
        `SELECT request_key,payload,source_payload FROM mcp_operations
         WHERE user_id=$1 AND connection='reader' AND tool='save_link' AND state='pending'
         ORDER BY updated_at DESC LIMIT 20`,
        [user],
      )
    ).rows;
    const sentUrl = (row: any) => {
      for (const value of [row.source_payload, row.payload]) {
        const candidate = (value as { url?: unknown } | null)?.url;
        if (typeof candidate !== "string") continue;
        try {
          // The exact payload, and its dedupe key for the same-link comparison.
          return { url: candidate, canonical: canonicalUrl(candidate) };
        } catch {
          continue;
        }
      }
      return undefined;
    };
    return rows.flatMap((row) => {
      const sent = sentUrl(row);
      return sent
        ? [
            {
              requestKey: row.request_key as string,
              url: sent.url,
              canonical: sent.canonical,
            },
          ]
        : [];
    });
  }

  /** A Reader save still in flight for this exact link, if any. */
  async pendingReaderSave(user: string, url: string) {
    const wanted = canonicalUrl(url);
    const match = (await this.pendingReaderSaves(user)).find(
      (row) => row.canonical === wanted,
    );
    return match ? { requestKey: match.requestKey, url: match.url } : undefined;
  }

  /** The persisted Reader write for one request key, for reconciling before a retry. */
  async readerOperation(user: string, requestKey: string) {
    const row = (
      await this.db.query(
        `SELECT state,result FROM mcp_operations
         WHERE user_id=$1 AND connection='reader' AND request_key=$2`,
        [user, requestKey],
      )
    ).rows[0];
    return row ? { state: row.state as string, result: row.result } : undefined;
  }
}

export interface DecisionRecord {
  id: string;
  user: string;
  sharedUrl: string;
  canonicalUrl: string;
  title: string | null;
  source: string | null;
  topic: string | null;
  route: LinkRoute;
  reason: string;
  confidence: number;
  model: string | null;
  telegramChatId: string | null;
  telegramMessageId: number | null;
  /** The thread the buttons were really sent to, when the host recorded one. */
  telegramThreadId: number | null;
  state: "pending" | "confirmed";
  choice: LinkChoice | null;
  studyState: "none" | "done";
  studyId: string | null;
  readerState: "none" | "pending" | "accepted" | "rejected" | "uncertain";
  readerRequestKey: string | null;
  readerAttempts: number;
  readerDetail: string | null;
  lastError: string | null;
  /** A choice card the owner never answered stops acting after this instant. */
  expiresAt: string | null;
}

function decision(row: any): DecisionRecord {
  return {
    id: row.id,
    user: row.user_id,
    sharedUrl: row.shared_url,
    canonicalUrl: row.canonical_url,
    title: row.title ?? null,
    source: row.source ?? null,
    topic: row.topic ?? null,
    route: row.route,
    reason: row.reason,
    confidence: Number(row.confidence),
    model: row.model ?? null,
    telegramChatId: row.telegram_chat_id ?? null,
    telegramMessageId:
      row.telegram_message_id === null || row.telegram_message_id === undefined
        ? null
        : Number(row.telegram_message_id),
    telegramThreadId:
      row.telegram_thread_id === null || row.telegram_thread_id === undefined
        ? null
        : Number(row.telegram_thread_id),
    state: row.state,
    choice: row.choice ?? null,
    studyState: row.study_state,
    studyId: row.study_id ?? null,
    readerState: row.reader_state,
    readerRequestKey: row.reader_request_key ?? null,
    readerAttempts: Number(row.reader_attempts ?? 0),
    readerDetail: row.reader_status_detail ?? null,
    lastError: row.last_error ?? null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

/** link_decisions is the resume record: it is never deleted on a tap. */
export class LinkDecisions {
  constructor(private db: Database) {}

  async create(row: {
    user: string;
    sharedUrl: string;
    canonicalUrl: string;
    title: string | null;
    source: string | null;
    topic: string | null;
    route: LinkRoute;
    reason: string;
    confidence: number;
    model: string | null;
  }) {
    const id = randomUUID();
    const created = await this.db.query(
      `INSERT INTO link_decisions(id,user_id,shared_url,canonical_url,title,source,topic,route,reason,confidence,model)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        id,
        row.user,
        row.sharedUrl,
        row.canonicalUrl,
        row.title,
        row.source,
        row.topic,
        row.route,
        row.reason,
        row.confidence,
        row.model,
      ],
    );
    return decision(created.rows[0]);
  }

  async get(user: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM link_decisions WHERE user_id=$1 AND id=$2",
        [user, id],
      )
    ).rows[0];
    return row ? decision(row) : undefined;
  }

  /** The message the buttons sit on, so a stale tap on another card cannot act. */
  async attach(
    user: string,
    id: string,
    chat: string,
    messageId: number | null,
    threadId?: number | null,
  ) {
    await this.db.query(
      "UPDATE link_decisions SET telegram_chat_id=$3,telegram_message_id=$4,telegram_thread_id=$5 WHERE user_id=$1 AND id=$2",
      [user, id, chat, messageId, threadId ?? null],
    );
  }

  /**
   * Claim the decision, not the row's state: a leftover claim expires, so a failed tap
   * cannot permanently disable the buttons. No row means another tap is in flight.
   */
  async claim(user: string, id: string, leaseSeconds = 120) {
    const row = (
      await this.db.query(
        `UPDATE link_decisions SET claim_token=$3,claimed_at=now()
         WHERE user_id=$1 AND id=$2 AND state='pending'
           AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $4))
         RETURNING *`,
        [user, id, randomUUID(), leaseSeconds],
      )
    ).rows[0];
    return row ? decision(row) : undefined;
  }

  async release(user: string, id: string) {
    await this.db.query(
      "UPDATE link_decisions SET claim_token=NULL,claimed_at=NULL WHERE user_id=$1 AND id=$2",
      [user, id],
    );
  }

  async setChoice(user: string, id: string, choice: LinkChoice) {
    const row = (
      await this.db.query(
        "UPDATE link_decisions SET choice=$3 WHERE user_id=$1 AND id=$2 RETURNING choice",
        [user, id, choice],
      )
    ).rows[0];
    return row?.choice as LinkChoice | undefined;
  }

  async setStudy(user: string, id: string, studyId: string) {
    await this.db.query(
      "UPDATE link_decisions SET study_state='done',study_id=$3 WHERE user_id=$1 AND id=$2",
      [user, id, studyId],
    );
  }

  /**
   * The key is persisted before the call, so a crash leaves a resumable retry. The attempt
   * counter moves only when the key changes: one request, however many times it is
   * recorded, is one attempt.
   */
  async setReaderAttempt(
    user: string,
    id: string,
    requestKey: string,
    state: "pending" | "accepted" | "rejected" | "uncertain",
    detail: string | null,
  ) {
    await this.db.query(
      `UPDATE link_decisions SET reader_request_key=$3,
         reader_attempts=reader_attempts+CASE WHEN reader_request_key IS DISTINCT FROM $3::uuid THEN 1 ELSE 0 END,
         reader_state=$4,reader_status_detail=$5 WHERE user_id=$1 AND id=$2`,
      [user, id, requestKey, state, detail],
    );
  }

  async setReaderState(
    user: string,
    id: string,
    state: DecisionRecord["readerState"],
    detail: string | null,
  ) {
    await this.db.query(
      "UPDATE link_decisions SET reader_state=$3,reader_status_detail=$4 WHERE user_id=$1 AND id=$2",
      [user, id, state, detail],
    );
  }

  async fail(user: string, id: string, message: string) {
    await this.db.query(
      "UPDATE link_decisions SET last_error=$3 WHERE user_id=$1 AND id=$2",
      [user, id, message],
    );
  }

  async confirm(user: string, id: string) {
    await this.db.query(
      "UPDATE link_decisions SET state='confirmed',claim_token=NULL,claimed_at=NULL WHERE user_id=$1 AND id=$2 AND state='pending'",
      [user, id],
    );
  }
}

export interface LinkChoiceMessage {
  id: string;
  text: string;
  buttons: { text: string; data: string }[];
}

/** Telegram inline buttons for a genuinely unsure link: three taps, never an open question. */
export function linkChoiceButtons(id: string) {
  return [
    { text: "Study list", data: `lnk:study:${id}` },
    { text: "Reader", data: `lnk:reader:${id}` },
    { text: "Both", data: `lnk:both:${id}` },
  ];
}

export type ReaderOutcome = {
  /** `blocked` is a definite non-send: another Reader save is in flight, so this one
   * never left Chief and nothing was written to Reader. */
  state: "accepted" | "rejected" | "pending" | "blocked" | "unavailable";
  detail: string;
  /**
   * What the owner should know beside the outcome: an earlier save of this exact link was
   * already in flight, so this request settled that one instead of starting a second
   * (requirement 8). It travels with every outcome, so no path can hide it.
   */
  note?: string;
  /** The key this call used, so the decision row can resume the same request. */
  requestKey?: string;
};

/** What the caller knows about an earlier Reader attempt for the same link. */
export interface ReaderRetry {
  /** The key on the decision row: reused only for a retry of this exact request. */
  requestKey?: string | null;
  /** A stored rejection under that key: the next attempt needs a new key. */
  rejected?: boolean;
  /**
   * Called with a newly created key before Reader is contacted. The caller persists it,
   * so a crash mid-call leaves a resumable key instead of a duplicate save.
   */
  persist?: (requestKey: string) => Promise<void>;
}

export interface StudyLinksDeps {
  db: Database;
  judge: LinkJudge;
  config?: LinkClassifierConfig;
  fetcher?: FeedFetcher;
  /** Resolved per call: the MCP runtime is created after the tools. */
  reader?: () => ReaderLink | undefined;
  memory?: MemoryStore;
  /** Replaced only by tests that need a failing collection write. */
  store?: StudyStore;
  /** Deliver the quick tap options; returns the Telegram message id and thread. */
  ask?: (
    user: string,
    message: LinkChoiceMessage,
  ) => Promise<{ messageId: number | null; threadId?: number | null }>;
}

const clip = (value: string, n: number) => {
  const points = [...value];
  return points.length > n ? points.slice(0, n).join("") : value;
};

/**
 * The one link URL for a save, with predictable input failures kept as validation.
 * `publicLink()` rejects http, private hostnames and oversized links with a plain Error,
 * which the host would record as an uncertain write and then block every later write
 * with. A ToolValidationError says exactly that nothing was written.
 */
function validatedLink(raw: string) {
  try {
    return linkUrl(raw);
  } catch (error) {
    throw new ToolValidationError(
      `That isn't a public https link Chief can save (${failureMessage(error)}), so nothing was written.`,
    );
  }
}

/** The dedupe key of a link the owner shared, refused as input rather than as a failure. */
function validatedKey(raw: string) {
  try {
    return dedupeKey(raw);
  } catch (error) {
    throw new ToolValidationError(
      `That isn't a public https link Chief can save (${failureMessage(error)}), so nothing was written.`,
    );
  }
}

export class StudyLinks {
  readonly store: StudyStore;
  readonly decisions: LinkDecisions;
  readonly config: LinkClassifierConfig;
  private fetcher: FeedFetcher;
  private memory: MemoryStore;

  constructor(private deps: StudyLinksDeps) {
    this.store = deps.store ?? new StudyStore(deps.db);
    this.decisions = new LinkDecisions(deps.db);
    this.config = deps.config ?? readLinkClassifierConfig();
    this.fetcher = deps.fetcher ?? new PublicFeedFetcher();
    this.memory = deps.memory ?? new MemoryStore(deps.db);
  }

  /**
   * The owner's saved learning interests, with the configured areas as the floor. Only
   * whole words count, so an "email" or "detail" memory is not mistaken for AI work.
   */
  async interests(user: string) {
    const saved: string[] = [];
    const learning =
      /\b(ai|llms?|agents?|agentic|models?|developers?|dev(eloper)? tools?|code|coding|engineering|voice|speech|conversational|assistants?)\b/i;
    try {
      for (const item of await this.memory.active(user))
        if (item.value && learning.test(`${item.key} ${item.value}`))
          saved.push(`${item.key}: ${item.value}`);
    } catch (error) {
      // Memory is context, not authority: a read failure only widens the interests.
      opsLog("link.interests_failed", "warn", errorFields(error));
    }
    return [...this.config.interests, ...saved];
  }

  private async classify(
    user: string,
    shared: string,
    message: string,
    signal?: AbortSignal,
  ) {
    const page = await pageInfo(this.fetcher, shared, signal);
    const verdict = await this.deps.judge.judge({
      url: page.url,
      title: page.title,
      site: page.site,
      excerpt: page.excerpt,
      message,
      interests: await this.interests(user),
    });
    return {
      page,
      verdict,
      judgment: judgeLink(verdict, page, this.config.apply.minConfidence),
    };
  }

  /**
   * The single entry point for "save this". Classifies first, then saves straight
   * away when confident; only a genuinely unsure link becomes a question.
   */
  async save(
    user: string,
    input: { url: string; ownerMessage?: string },
    signal?: AbortSignal,
  ) {
    const shared = validatedLink(input.url);
    const message = input.ownerMessage?.trim() || "Save this link.";
    const { page, judgment } = await this.classify(
      user,
      shared,
      message,
      signal,
    );
    const heading = page.title ?? page.url;
    if (judgment.route === "unsure") {
      const asked = await this.askChoice(user, {
        page,
        title: page.title,
        source: page.site,
        topic: judgment.topic,
        route: judgment.route,
        reason: judgment.reason,
        confidence: judgment.confidence,
        model: judgment.model,
      });
      return { outcome: "needs_choice" as const, ...asked };
    }
    if (judgment.route === "study" || judgment.route === "both") {
      const saved = await this.store.add(user, {
        url: page.url,
        canonicalUrl: page.canonicalUrl,
        title: page.title!,
        source: page.site,
        topic: judgment.topic,
        route: judgment.route,
        reason: judgment.reason,
        confidence: judgment.confidence,
        model: judgment.model,
      });
      if (judgment.route === "study")
        return {
          outcome: saved.existing ? ("duplicate" as const) : ("study" as const),
          entry: summarize(saved.entry),
          message: saved.existing
            ? `Already on your study list: ${saved.entry.title}.`
            : `Saved to your study list: ${saved.entry.title} (${saved.entry.topic ?? "no topic yet"}).`,
        };
      const reader = await this.readerSave(user, page.url, {}, signal);
      if (reader.state === "accepted")
        await this.store.markReaderSaved(user, page.canonicalUrl);
      const both = saved.existing
        ? `Already on your study list: ${saved.entry.title}.`
        : `Saved to your study list: ${saved.entry.title}.`;
      const savedLine = saved.existing
        ? `Already on your study list and saved to Reader: ${saved.entry.title}.`
        : `Saved to your study list and to Reader: ${saved.entry.title}.`;
      return {
        outcome: "both" as const,
        entry: summarize(saved.entry),
        reader,
        message:
          reader.state === "accepted"
            ? // An earlier save of this same link that was in flight is named, so the owner
              // knows no second save was started (requirement 8).
              [savedLine, reader.note].filter(Boolean).join(" ")
            : `${both} ${readerMessage(reader)}`,
      };
    }
    const reader = await this.readerSave(user, page.url, {}, signal);
    if (reader.state === "accepted")
      return {
        outcome: "reader" as const,
        reader,
        message: `Saved to Reader for offline reading: ${heading}.${reader.note ? ` ${reader.note}` : ""}`,
      };
    return {
      // A refusal is a definite no; a save already in flight that this one never joined is
      // a definite non-send; a pending or timed-out save is uncertain.
      outcome:
        reader.state === "pending"
          ? ("uncertain" as const)
          : reader.state === "blocked"
            ? ("blocked" as const)
            : ("failed" as const),
      reader,
      message: `${heading}: ${readerMessage(reader)}`,
    };
  }

  private async askChoice(
    user: string,
    row: {
      page: PageInfo;
      title: string | null;
      source: string;
      topic: string | null;
      route: LinkRoute;
      reason: string;
      confidence: number;
      model: string | null;
    },
  ) {
    const record = await this.decisions.create({
      user,
      sharedUrl: row.page.url,
      canonicalUrl: row.page.canonicalUrl,
      title: row.title,
      source: row.source,
      topic: row.topic,
      route: row.route,
      reason: row.reason,
      confidence: row.confidence,
      model: row.model,
    });
    const message: LinkChoiceMessage = {
      id: record.id,
      text: `${row.title ?? row.page.url}\n\n${row.reason}\nWhere should it go?`,
      buttons: linkChoiceButtons(record.id),
    };
    let sent:
      { messageId: number | null; threadId?: number | null } | undefined;
    let delivered = false;
    try {
      sent = await this.deps.ask?.(user, message);
      delivered = !!sent;
    } catch (error) {
      // No buttons reached the owner, so say so instead of claiming a question is waiting.
      opsLog("link.ask_failed", "warn", errorFields(error));
    }
    if (sent)
      await this.decisions.attach(
        user,
        record.id,
        user,
        sent.messageId,
        sent.threadId ?? null,
      );
    return {
      decisionId: record.id,
      question: message.text,
      buttons: message.buttons,
      title: row.title,
      delivered,
      message: delivered
        ? "This one is genuinely unclear, so I asked where it should go with three tap options and saved nothing yet."
        : "This one is genuinely unclear and nothing was saved, but the tap buttons didn't reach the owner. Ask again and I'll retry the question.",
    };
  }

  /**
   * Reader hand-off for the one link URL. A key is reused only while that exact
   * request is in flight; a stored rejection, or a previous definite failure, gets a
   * new key so one refusal cannot block every later attempt.
   */
  async readerSave(
    user: string,
    url: string,
    previous: ReaderRetry,
    signal?: AbortSignal,
  ): Promise<ReaderOutcome> {
    const reader = this.deps.reader?.();
    if (!reader)
      return {
        state: "unavailable",
        detail:
          "Reader isn't connected to Chief, so nothing was sent to Reader.",
      };
    // Only a retry of this exact request keeps its key. A rejection under it, a definite
    // failure or a different payload means a new key, so one refusal never blocks later.
    let key = previous.requestKey ?? undefined;
    if (key) {
      const operation = await this.store.readerOperation(user, key);
      if (operation?.state === "complete")
        return {
          state: "accepted",
          detail: "Already saved to Reader.",
          requestKey: key,
        };
      if (operation?.state === "rejected" || previous.rejected) key = undefined;
    }
    const pending = await this.store.pendingReaderSaves(user);
    const wanted = canonicalUrl(url);
    const same = pending.find((row) => row.canonical === wanted);
    // An earlier save of this exact link that Reader has not answered yet: this is the same
    // request, so its key is reused, and the owner is told so instead of being left to wonder
    // whether a second save was started (requirement 8).
    let note: string | undefined;
    const done = (outcome: ReaderOutcome): ReaderOutcome =>
      note ? { ...outcome, note } : outcome;
    if (same && same.requestKey !== key) {
      // Only the identical request may take over a key that is already in flight; a
      // different payload under that key would be refused by mcp.ts's replay check.
      if (key || same.url !== url)
        return {
          state: "blocked",
          detail: `A Reader save for this link is already in progress (request key ${same.requestKey}), so I didn't start a second one. Ask me to check that save, then retry.`,
        };
      key = same.requestKey;
      await previous.persist?.(key);
      note = `An earlier Reader save for this link was still in progress, so this settled that same request instead of starting a second.`;
    }
    // A save for another link that Reader has not answered yet: nothing is sent for this
    // one, so it is a definite non-send rather than an uncertain result.
    const other = pending.find((row) => row.canonical !== wanted);
    if (!key && other)
      return {
        state: "blocked",
        detail: `Another Reader save is still unconfirmed (request key ${other.requestKey}), so this one wasn't sent. Ask me to check that save, then retry.`,
      };
    if (!key) {
      key = randomUUID();
      // Persisted before the call: a crash here leaves a resumable key, not a duplicate.
      await previous.persist?.(key);
    }
    let result: any;
    try {
      result = await reader.save(user, key, url, signal);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Reader couldn't be reached";
      if (/pending MCP write/.test(message))
        return {
          state: "blocked",
          detail:
            "Another Reader save is still unconfirmed, so this one wasn't sent. Ask me to check Reader's pending save, then retry.",
        };
      if (error instanceof ToolValidationError)
        return done({
          state: "rejected",
          detail: `Reader refused it: ${clip(message, 160)}`,
          requestKey: key,
        });
      return done({
        state: "pending",
        detail: `The Reader copy couldn't be confirmed, so its result is uncertain (${clip(message, 160)}).`,
        requestKey: key,
      });
    }
    if (result?.state === "complete") {
      const status = result.result?.status;
      return done({
        state: "accepted",
        requestKey: key,
        detail:
          status === "bookmark"
            ? "Reader saved the link but couldn't prepare the article, so it's in Reader's Imports."
            : status === "already_saved"
              ? "Reader already had it."
              : "Saved to Reader.",
      });
    }
    if (result?.state === "rejected")
      return done({
        state: "rejected",
        detail: "Reader refused that link.",
        requestKey: key,
      });
    return done({
      state: "pending",
      requestKey: key,
      detail:
        result?.category === "auth"
          ? "Reader rejected Chief's connection, so the save isn't confirmed. Reconnect Reader, then retry."
          : result?.category === "capacity"
            ? `Reader is rate-limiting Chief; retry in about ${result.retryAfterSeconds ?? 60} seconds.`
            : "The Reader copy couldn't be confirmed, so its result is uncertain.",
    });
  }

  /** Owner-scoped list with filters; `text` is written for a phone screen. */
  async list(user: string, input: StudyFilter = {}) {
    // "What's on my AI study list" is a broad query over the owner's learning interests,
    // not a substring hunt for "AI" in labels such as "agent platforms".
    const filter: StudyFilter = { ...input };
    if (input.topic) {
      const match = topicFilter(input.topic, this.config.interests);
      filter.topic = match.like;
      filter.topics = match.labels;
    }
    const entries = await this.store.list(user, filter);
    const counts = await this.store.counts(user);
    const topics = await this.store.topics(user);
    // The heading names what the owner asked for, not the resolved label set.
    const filterText = [
      input.status ? STATUS_LABEL[input.status] : undefined,
      input.topic ? `topic ${input.topic}` : undefined,
      input.tag ? `tag ${input.tag}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    const heading =
      entries.length === 0
        ? filterText
          ? `No study entries match ${filterText}.${topics.length ? ` Topics on your list: ${topics.join(", ")}.` : ""}`
          : "Your study list is empty."
        : `Study list${filterText ? ` (${filterText})` : ""} — ${entries.length} shown, ${counts.to_study} to study, ${counts.in_progress} in progress, ${counts.done} done.`;
    const lines = entries.map((e) => {
      const detail = [
        e.source,
        e.topic,
        STATUS_LABEL[e.status],
        e.tags.length ? `#${e.tags.join(" #")}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      // The link itself, so the owner can tap through from the phone.
      return `• ${e.title}\n  ${e.url}\n  ${detail}`;
    });
    return {
      count: entries.length,
      counts,
      topics,
      entries: entries.map(summarize),
      text: [heading, ...lines].join("\n"),
    };
  }

  async update(
    user: string,
    input: {
      id: string;
      status?: StudyStatus;
      notes?: string | null;
      tags?: string[];
    },
  ) {
    const before = await this.store.find(user, input.id);
    if (!before) throw new ToolValidationError("No study entry with that id");
    const updated = await this.store.update(user, input.id, {
      ...(input.status ? { status: input.status } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.tags ? { tags: input.tags } : {}),
    });
    if (!updated) throw new ToolValidationError("No study entry with that id");
    const changed = [
      input.status ? `status ${STATUS_LABEL[input.status]}` : undefined,
      input.notes !== undefined ? "notes" : undefined,
      input.tags ? `tags ${input.tags.join(", ") || "(cleared)"}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      entry: summarize(updated),
      message: `Updated ${updated.title}: ${changed}.`,
      text: `• ${updated.title} — ${STATUS_LABEL[updated.status]}${updated.topic ? ` · ${updated.topic}` : ""}`,
    };
  }

  async remove(user: string, id: string) {
    const removed = await this.store.remove(user, id);
    if (!removed) throw new ToolValidationError("No study entry with that id");
    return {
      removed: true,
      title: removed.title,
      message: `Removed from your study list: ${removed.title}.`,
    };
  }

  /**
   * Corrections. Study → Reader saves the link to Reader and then removes the study
   * entry, once Reader accepted. Reader → study adds an entry from the Reader record
   * (or the page) and says plainly that Reader keeps its own copy, because Chief has
   * no Reader removal grant.
   */
  async move(
    user: string,
    input: { id?: string; url?: string; to: "reader" | "study" },
    signal?: AbortSignal,
  ) {
    if (input.to === "reader") {
      const current = input.id
        ? await this.store.find(user, input.id)
        : input.url
          ? await this.store.findByCanonical(user, validatedKey(input.url))
          : undefined;
      if (!current)
        throw new ToolValidationError(
          "No study entry with that id or link; list the study list first",
        );
      const outcome = await this.readerSave(user, current.url, {}, signal);
      if (outcome.state === "accepted") {
        try {
          await this.store.remove(user, current.id);
        } catch (error) {
          // The Reader copy exists; only the local removal failed, so say exactly that.
          return {
            moved: false,
            to: "reader" as const,
            reader: outcome,
            title: current.title,
            message: `Saved to Reader, but I couldn't remove it from your study list (${failureMessage(error)}), so it may still be listed. Remove it there if you want only Reader.`,
          };
        }
        return {
          moved: true,
          to: "reader" as const,
          title: current.title,
          message: [
            `Moved to Reader for offline reading and removed from your study list: ${current.title}.`,
            outcome.note,
          ]
            .filter(Boolean)
            .join(" "),
        };
      }
      return {
        moved: false,
        to: "reader" as const,
        reader: outcome,
        title: current.title,
        message: `Still on your study list: ${current.title}. ${readerMessage(outcome)}`,
      };
    }
    const raw =
      input.url ??
      (input.id ? (await this.store.find(user, input.id))?.url : undefined);
    if (!raw)
      throw new ToolValidationError(
        "A study id or the Reader link is required to move it",
      );
    const shared = validatedLink(raw);
    const page = await pageInfo(this.fetcher, shared, signal);
    const inReader = await this.readerHas(user, page.url, signal);
    // The route is the owner's explicit instruction, but the topic is Jev's read of the
    // page, the same as a classified save: an entry moved here gets a real subject or
    // none, never a guess (requirement 4).
    const judged = await this.topicOf(
      user,
      page,
      "Save this to my study list.",
      signal,
    );
    const saved = await this.store.add(user, {
      url: page.url,
      canonicalUrl: page.canonicalUrl,
      title: page.title ?? page.url,
      source: page.site,
      topic: judged.topic,
      route: "study",
      reason: inReader
        ? "Moved to the study list from Reader at the owner's request; Reader keeps its own copy."
        : "Moved to the study list at the owner's request.",
      // The owner chose the route, so the confidence is theirs, not the model's.
      confidence: 1,
      model: judged.model,
    });
    return {
      moved: !saved.existing,
      to: "study" as const,
      entry: summarize(saved.entry),
      message: saved.existing
        ? `Already on your study list: ${saved.entry.title}.`
        : `Added to your study list: ${saved.entry.title}.${inReader ? " Reader still has its own copy; remove it there if you want only the study list." : ""}`,
    };
  }

  /** Reader's own saved list, when its read-only connection allows it. */
  private async readerHas(
    user: string,
    canonical: string,
    signal?: AbortSignal,
  ) {
    const reader = this.deps.reader?.();
    if (!reader) return false;
    try {
      const saved = await reader.savedArticles(user, signal);
      const wanted = canonicalUrl(canonical);
      return saved.articles.some((article) => {
        try {
          return canonicalUrl(article.url) === wanted;
        } catch {
          return false;
        }
      });
    } catch (error) {
      // Reader's library is a hint, not the record: a read failure only leaves the move's
      // wording plainer, and it must not fail the move.
      opsLog("link.reader_library_failed", "warn", errorFields(error));
      return false;
    }
  }

  /**
   * Jev's learning interest for a page whose route is already decided (a move the owner
   * asked for, or a tap on a card). The route is not re-judged: only the topic is taken,
   * and a Jev failure leaves it empty rather than invented.
   */
  private async topicOf(
    user: string,
    page: PageInfo,
    message: string,
    signal?: AbortSignal,
  ) {
    try {
      const verdict = await this.deps.judge.judge({
        url: page.url,
        title: page.title,
        site: page.site,
        excerpt: page.excerpt,
        message,
        interests: await this.interests(user),
      });
      return verdict.ok && verdict.topic
        ? { topic: topicLabel(verdict.topic), model: verdict.model }
        : { topic: null, model: null };
    } catch (error) {
      // A topic is a detail, not the write: a judge failure leaves it empty.
      opsLog("link.topic_failed", "warn", errorFields(error));
      return { topic: null, model: null };
    }
  }

  /**
   * The title and topic a card did not carry. A card created while the page could not be
   * read has no title, so the page is read again now: its own title and Jev's topic fill
   * the entry, and a page that is still unreadable leaves the link as the title rather
   * than an invented name (requirement 4).
   */
  private async pageDetail(
    user: string,
    row: {
      sharedUrl: string;
      title: string | null;
      topic: string | null;
      model: string | null;
    },
    signal?: AbortSignal,
  ) {
    if (row.title && row.topic)
      return { title: row.title, topic: row.topic, model: row.model };
    let page: PageInfo | undefined;
    try {
      page = await pageInfo(this.fetcher, row.sharedUrl, signal);
    } catch (error) {
      opsLog("link.page_reread_failed", "warn", errorFields(error));
    }
    let topic = row.topic;
    let model = row.model;
    if (!topic && page) {
      const judged = await this.topicOf(
        user,
        page,
        "Save this to my study list.",
        signal,
      );
      topic = judged.topic;
      model = model ?? judged.model;
    }
    return { title: row.title ?? page?.title ?? null, topic, model };
  }

  /**
   * The tap. Resumable: only the unfinished step runs, nothing the owner already has
   * is lost, and a failure after a partial write says what may be saved instead of
   * claiming nothing was written.
   */
  async confirm(
    user: string,
    id: string,
    choice: LinkChoice,
    tappedMessageId?: number | null,
    signal?: AbortSignal,
  ): Promise<{ text: string; settled: boolean; choice: LinkChoice | null }> {
    const current = await this.decisions.get(user, id);
    if (!current)
      return {
        text: "That saved link is no longer available. Share it again and I'll classify it.",
        settled: true,
        choice: null,
      };
    if (
      tappedMessageId !== undefined &&
      tappedMessageId !== null &&
      current.telegramMessageId !== null &&
      tappedMessageId !== current.telegramMessageId
    )
      return {
        text: "That button belongs to an older message, so nothing was saved. Use the latest one.",
        settled: false,
        choice: null,
      };
    // A settled card reports only what the record holds. A later tap on the other button
    // can therefore never claim a Reader save that was never made.
    if (current.state === "confirmed")
      return {
        text: confirmedText(current, choice),
        settled: true,
        choice: current.choice,
      };
    // A later tap on the other button means the owner wants both, once something has
    // actually been written or is still in flight. An unconfirmed Reader attempt counts:
    // settling the card would drop a save Reader may still land, and a later tap would
    // then report it as absent. Before anything was written it is a change of mind.
    const readerUnconfirmed =
      current.readerState === "pending" || current.readerState === "uncertain";
    const written =
      current.studyState === "done" || current.readerState === "accepted";
    // Expiry writes nothing only while nothing has been written and nothing is in flight.
    // An expired card that already holds a study entry, or a Reader save that may still
    // land, is resumed and reported from the record: calling that "nothing was written"
    // would be false, and clearing its buttons would strand the write it holds. The
    // collection is checked as well, because an entry inserted by an earlier tap whose card
    // update failed is a write this row cannot see.
    if (
      current.expiresAt &&
      Date.parse(current.expiresAt) < Date.now() &&
      !written &&
      !readerUnconfirmed &&
      !(await this.store.findByCanonical(user, current.canonicalUrl))
    )
      return {
        text: "That choice expired before it was answered, so nothing was written. Share the link again and I'll classify it.",
        settled: true,
        choice: null,
      };
    const progress = written || readerUnconfirmed;
    const resolved: LinkChoice = !current.choice
      ? choice
      : current.choice === choice
        ? choice
        : progress
          ? "both"
          : choice;
    const claimed = await this.decisions.claim(user, id);
    if (!claimed)
      return {
        text: "Still working on that link — give me a moment, then tap again if nothing appears.",
        settled: false,
        choice: resolved,
      };
    // From here the claimed row is the state: the row read before the claim may already be
    // out of date if another tap finished while this one waited.
    // Each step is reported on its own, so a failure after a partial write names exactly
    // what was written. Nothing is un-written and the row stays resumable.
    const wrote: string[] = [];
    const failed: string[] = [];
    // A Reader step that never confirmed may already be stored there, so it is named
    // as uncertain rather than counted as nothing.
    const mayHave: string[] = [];
    /** The link was already on the study list, so the receipt must not claim to add it. */
    let studyExisting = false;
    /** An earlier Reader save of this link that this tap settled, when there was one. */
    let readerNote: string | undefined;
    let recordable = true;
    try {
      if (claimed.choice !== resolved)
        await this.decisions.setChoice(user, id, resolved);
    } catch (error) {
      // Nothing has been written yet; a choice that cannot be recorded is a definite
      // failure, and the card stays resumable.
      failed.push(failureMessage(error));
      recordable = false;
    }
    if (recordable && resolved !== "reader") {
      if (claimed.studyState === "done") wrote.push("your study list");
      else {
        let saved: { existing: boolean; entry: StudyEntry } | undefined;
        // A card made while the page could not be read carries no title (and no topic):
        // they come from the page now, never from the URL or a guess.
        const detail = await this.pageDetail(user, claimed, signal);
        try {
          saved = await this.store.add(user, {
            url: claimed.sharedUrl,
            canonicalUrl: claimed.canonicalUrl,
            title: detail.title ?? claimed.sharedUrl,
            source: claimed.source,
            topic: detail.topic,
            route: "study",
            reason: claimed.reason,
            confidence: claimed.confidence,
            model: detail.model,
          });
        } catch (error) {
          failed.push(
            `The study entry wasn't written (${failureMessage(error)}).`,
          );
        }
        if (saved) {
          // The entry exists from here on, so the reply says so whatever happens to the
          // card that records it (requirement 10).
          studyExisting = saved.existing;
          wrote.push("your study list");
          try {
            await this.decisions.setStudy(user, id, saved.entry.id);
          } catch (error) {
            failed.push(
              `The entry is saved, but its card couldn't be updated (${failureMessage(error)}).`,
            );
          }
        }
      }
    }
    // The Reader half still runs when the study insert failed: the owner asked for both,
    // and each write is reported on its own.
    if (recordable && resolved !== "study") {
      if (claimed.readerState === "accepted") {
        // Already done on an earlier tap: only the unfinished step is retried.
        wrote.push("Reader");
      } else {
        let outcome: ReaderOutcome | undefined;
        try {
          outcome = await this.readerSave(
            user,
            claimed.sharedUrl,
            {
              requestKey: claimed.readerRequestKey,
              rejected: claimed.readerState === "rejected",
              persist: (requestKey) =>
                // On the row before Reader is contacted: a crash here is resumable.
                this.decisions.setReaderAttempt(
                  user,
                  id,
                  requestKey,
                  "pending",
                  "Sent to Reader, waiting for its answer.",
                ),
            },
            signal,
          );
        } catch (error) {
          // readerSave() turns Reader's own failures into an outcome, so reaching here
          // means the local read or write failed and Reader was never contacted.
          failed.push(failureMessage(error));
        }
        if (outcome) {
          // The write is reported before the row is updated, so a failure to record it
          // cannot turn a completed Reader save into "nothing was written".
          if (outcome.note) readerNote = outcome.note;
          if (outcome.state === "accepted") wrote.push("Reader");
          else {
            // An unconfirmed Reader write is never settled and never called nothing, and
            // a save that was never sent is never described as one Reader may have.
            if (outcome.state === "pending") mayHave.push("Reader");
            failed.push(outcome.detail);
          }
          try {
            const recorded: DecisionRecord["readerState"] =
              outcome.state === "accepted"
                ? "accepted"
                : outcome.state === "rejected"
                  ? "rejected"
                  : outcome.state === "pending"
                    ? "uncertain"
                    : outcome.state === "blocked"
                      ? "none"
                      : "rejected";
            if (outcome.requestKey && recorded !== "none")
              // The key is stored with the outcome, so a re-tap resumes this exact request.
              await this.decisions.setReaderAttempt(
                user,
                id,
                outcome.requestKey,
                recorded,
                outcome.detail,
              );
            else
              await this.decisions.setReaderState(
                user,
                id,
                recorded,
                outcome.detail,
              );
          } catch (error) {
            failed.push(
              `The Reader save stands, but its card couldn't be updated (${failureMessage(error)}).`,
            );
          }
          if (outcome.state === "accepted" && resolved === "both")
            await this.store
              .markReaderSaved(user, claimed.canonicalUrl)
              .catch((error) => {
                // The Reader copy exists; only the cross-reference failed.
                opsLog(
                  "link.mark_reader_saved_failed",
                  "warn",
                  errorFields(error),
                );
              });
        }
      }
    }
    const settled = failed.length === 0;
    if (settled) await this.decisions.confirm(user, id);
    else {
      await this.decisions.fail(user, id, failed.join(" "));
      await this.decisions.release(user, id);
    }
    return {
      text: outcomeText(resolved, wrote, failed, claimed, mayHave, {
        studyExisting,
        readerNote,
      }),
      settled,
      choice: resolved,
    };
  }
}

const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : "an unexpected error";

function summarize(item: StudyEntry) {
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    source: item.source,
    topic: item.topic,
    tags: item.tags,
    notes: item.notes,
    status: item.status,
    statusLabel: STATUS_LABEL[item.status],
    addedAt: item.addedAt,
    reason: item.reason,
    confidence: item.confidence,
    readerSaved: item.readerSaved,
  };
}

function readerMessage(outcome: ReaderOutcome) {
  return [outcome.detail, outcome.note].filter(Boolean).join(" ");
}

/**
 * The receipt for an already-settled card: only what the record holds is claimed. A tap
 * for the other destination is told plainly that it is not there and how to correct it,
 * so a settled card can never report a Reader save that never happened.
 */
function confirmedText(row: DecisionRecord, choice: LinkChoice) {
  const has = {
    study: row.studyState === "done",
    reader: row.readerState === "accepted",
  };
  // A Reader attempt that never confirmed may still land, so it is never described as
  // absent. The card should not be settled in that state, but the record is the authority.
  const readerUnconfirmed =
    row.readerState === "pending" || row.readerState === "uncertain";
  const where = [has.study ? "your study list" : "", has.reader ? "Reader" : ""]
    .filter(Boolean)
    .join(" and ");
  const title = row.title ? `: ${row.title}` : "";
  if (!where && !readerUnconfirmed)
    return `That link is settled, but nothing was recorded for it${title}.`;
  const head = where
    ? `That's already saved to ${where}${title}.`
    : `That link is settled${title}.`;
  const wanted: ("study" | "reader")[] =
    choice === "both" ? ["study", "reader"] : [choice];
  const missing = wanted.filter((destination) => !has[destination]);
  if (!missing.length) return head;
  if (missing.includes("reader") && readerUnconfirmed)
    return `${head} The Reader copy is still unconfirmed, so it may already be there; say 'check that Reader save' and I'll settle it.`;
  const what = missing
    .map((destination) =>
      destination === "reader" ? "Reader" : "your study list",
    )
    .join(" or ");
  // Moving a study entry to Reader removes it from the study list, so a card settled to the
  // study list is not told to move: following that would lose the half the owner wanted.
  // A plain save with the owner's own words adds the Reader copy and keeps the entry.
  if (missing.includes("reader") && has.study)
    return `${head} It isn't in Reader. Say 'add it to Reader too' and I'll save a Reader copy and keep your study entry.`;
  const how = missing.includes("reader")
    ? "say 'save it to Reader'"
    : "say 'move it to my study list'";
  return `${head} It isn't in ${what}; ${how} and I'll do that.`;
}

/**
 * What the owner is told after a tap. A partial write is always named, and a failure
 * after one never says nothing was written.
 */
export function outcomeText(
  choice: LinkChoice,
  wrote: string[],
  failed: string[],
  row: { title: string | null },
  mayHave: string[] = [],
  note: {
    studyExisting?: boolean;
    /** An earlier Reader save of this link that this tap settled, when there was one. */
    readerNote?: string;
  } = {},
) {
  const title = row.title ? ` (${row.title})` : "";
  const study = note.studyExisting
    ? "Already on your study list"
    : "Saved to your study list";
  // Named beside the receipt, so a reused in-flight request is never mistaken for a second
  // save (requirement 8).
  const beside = note.readerNote ? ` ${note.readerNote}` : "";
  if (!failed.length) {
    if (choice === "both") {
      const line = note.studyExisting
        ? `${study}${title}, and saved to Reader.`
        : `Saved to your study list and Reader${title}.`;
      return `${line}${beside}`;
    }
    if (choice === "reader") return `Saved to Reader${title}.${beside}`;
    return `${study}${title}.`;
  }
  // An unconfirmed remote write is never described as nothing.
  const uncertain = mayHave.length
    ? `The result is uncertain${title}: ${mayHave.join(" and ")} may already have it. Tap again and I'll settle that same request.`
    : "";
  if (wrote.length) {
    // A study entry that was already there is not reported as newly saved.
    const done =
      wrote.length === 1 && wrote[0] === "your study list"
        ? study
        : `Saved to ${wrote.join(" and ")}`;
    return [
      `${done}${title}.`,
      ...failed,
      uncertain,
      "Nothing else was changed — tap again and I'll retry only the part that failed.",
      beside.trim(),
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    ...failed,
    uncertain || `Nothing was written${title}. Tap again to retry.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Settles an owner's uncertain study/link write that provably left no record, so one
 * restart cannot freeze every later write. Each of these tools writes only owner-scoped
 * Postgres rows keyed by the link or the entry id, plus - for the Reader hand-off - the
 * `mcp_operations` row for the request key. Once the run has stopped and the call is
 * older than two minutes, that trace decides: present means the write happened, absent
 * means it did not. A link save whose page redirected has no stored final URL to compare,
 * so a write for that owner created after the call started counts as evidence rather than
 * letting the call be called failed. Nothing is replayed, and a reader operation still in
 * flight leaves the call uncertain because its outcome belongs to Reader.
 */
export async function settleUncertainStudyWrites(db: Database, user: string) {
  const candidates = (
    await db.query(
      `SELECT c.id,c.operation,c.arguments,c.started_at FROM runtime_calls c
         JOIN runtime_runs r ON r.id=c.run_id
        WHERE r.user_id=$1 AND c.state='uncertain' AND c.operation = ANY($2::text[])
          AND r.state<>'running' AND c.started_at < now() - interval '2 minutes'`,
      [user, [...STUDY_WRITE_OPERATIONS]],
    )
  ).rows;
  let settled = 0;
  for (const row of candidates) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(row.arguments?.raw ?? "");
    } catch {
      continue;
    }
    const trace = await studyWriteTrace(
      db,
      user,
      String(row.operation),
      args,
      new Date(row.started_at),
    );
    if (trace === "unknown") continue;
    const fixed = await db.query(
      `WITH fixed AS (
         UPDATE runtime_calls c SET state=$2::text,
           result=COALESCE(c.result,'{}'::jsonb) || jsonb_build_object('reconciliation',
             jsonb_build_object('at',now(),'from','uncertain','to',$2::text,
               'basis',$3::text))
         WHERE c.id=$1 AND c.state='uncertain'
         RETURNING c.id,c.run_id
       )
       INSERT INTO events(run_id,user_id,type,data)
       SELECT run_id,$4,'runtime.call_reconciled',
         jsonb_build_object('id',id,'operation',$5::text) FROM fixed
       RETURNING run_id,data`,
      [
        row.id,
        trace === "wrote" ? "success" : "failed",
        trace === "wrote"
          ? "run stopped with the study, decision or Reader record for this link"
          : "run stopped with no study, decision or Reader record for this call",
        user,
        String(row.operation),
      ],
    );
    for (const event of fixed.rows) {
      projectEvent("runtime.call_reconciled", event.run_id, event.data);
      settled++;
    }
  }
  return settled;
}

/** What the study collection, the decision rows or Reader hold for one uncertain call. */
async function studyWriteTrace(
  db: Database,
  user: string,
  operation: string,
  args: Record<string, unknown>,
  startedAt: Date,
): Promise<"wrote" | "absent" | "unknown"> {
  const id =
    typeof args.id === "string" && /^[0-9a-f-]{36}$/i.test(args.id)
      ? args.id.toLowerCase()
      : undefined;
  let link: string | undefined;
  if (typeof args.url === "string")
    try {
      link = linkUrl(args.url);
    } catch {
      // Input that never validated cannot have written anything, but it is not this
      // settler's job to judge it: leave it for an operator.
      return "unknown";
    }
  if (operation === "study_update") {
    if (!id) return "unknown";
    const row = (
      await db.query(
        "SELECT updated_at FROM study_resources WHERE user_id=$1 AND id=$2",
        [user, id],
      )
    ).rows[0];
    // A row that has not moved since the call started did not take this update.
    return row && new Date(row.updated_at) >= startedAt ? "wrote" : "absent";
  }
  if (operation === "study_remove") {
    if (!id) return "unknown";
    const row = (
      await db.query(
        "SELECT 1 FROM study_resources WHERE user_id=$1 AND id=$2",
        [user, id],
      )
    ).rows[0];
    // The tool refuses an unknown id, so a missing row means this call removed it.
    return row ? "absent" : "wrote";
  }
  if (operation === "link_move") {
    if (args.to === "reader") {
      // Reader is the only write in this direction; the study delete follows its success.
      const reader = await startedReaderSave(db, user, startedAt);
      return reader ? "wrote" : "absent";
    }
    if (!link && id) {
      const row = (
        await db.query(
          "SELECT url FROM study_resources WHERE user_id=$1 AND id=$2",
          [user, id],
        )
      ).rows[0];
      if (!row) return "unknown";
      link = row.url as string;
    }
    if (!link) return "unknown";
    return (await studyRow(db, user, link)) ? "wrote" : "absent";
  }
  // link_save: the study entry, a decision card or a Reader save for this one link.
  if (!link) return "unknown";
  if (await linkTrace(db, user, link)) return "wrote";
  // A page that redirected is not recorded anywhere: the public fetcher follows the
  // redirect without storing it, so the final URL cannot be compared here. A study,
  // decision or Reader record for this owner created after the call started is still
  // evidence that it wrote something, and settling it as failed would claim nothing was
  // written when something was.
  return (await wroteSince(db, user, startedAt)) ? "wrote" : "absent";
}

/** Any record of a save for this link: a study entry, a choice card or a Reader save. */
async function linkTrace(db: Database, user: string, link: string) {
  if (await studyRow(db, user, link)) return true;
  const decision = (
    await db.query(
      "SELECT 1 FROM link_decisions WHERE user_id=$1 AND canonical_url=$2",
      [user, dedupeKey(link)],
    )
  ).rows[0];
  if (decision) return true;
  const operations = await readerSaves(db, user);
  const wanted = dedupeKey(link);
  for (const row of operations) {
    const sent = sentLinkUrl(row);
    if (!sent) continue;
    try {
      if (dedupeKey(sent) === wanted) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** A study, decision or Reader record for this owner created since the call started. */
async function wroteSince(db: Database, user: string, since: Date) {
  return (
    await db.query(
      `SELECT 1 FROM study_resources WHERE user_id=$1 AND added_at >= $2
       UNION ALL SELECT 1 FROM link_decisions WHERE user_id=$1 AND created_at >= $2
       UNION ALL SELECT 1 FROM mcp_operations
         WHERE user_id=$1 AND connection='reader' AND tool='save_link' AND created_at >= $2
       LIMIT 1`,
      [user, since.toISOString()],
    )
  ).rows[0];
}

/** The link Chief actually sent, which Reader resolution may have replaced in `payload`. */
function sentLinkUrl(row: any) {
  for (const value of [row.source_payload, row.payload]) {
    const url = (value as { url?: unknown } | null)?.url;
    if (typeof url === "string") return url;
  }
  return undefined;
}

async function studyRow(db: Database, user: string, link: string) {
  return (
    await db.query(
      "SELECT 1 FROM study_resources WHERE user_id=$1 AND canonical_url=$2",
      [user, dedupeKey(link)],
    )
  ).rows[0];
}

async function readerSaves(db: Database, user: string) {
  return (
    await db.query(
      `SELECT payload,source_payload,created_at FROM mcp_operations
        WHERE user_id=$1 AND connection='reader' AND tool='save_link'
          AND state<>'rejected' ORDER BY created_at DESC LIMIT 20`,
      [user],
    )
  ).rows;
}

async function startedReaderSave(db: Database, user: string, since: Date) {
  return (
    await db.query(
      `SELECT 1 FROM mcp_operations
        WHERE user_id=$1 AND connection='reader' AND tool='save_link'
          AND created_at >= $2 ORDER BY created_at DESC LIMIT 1`,
      [user, since.toISOString()],
    )
  ).rows[0];
}
