// The study list: a durable, owner-scoped collection of links the owner studies from. Its
// tools are the only way a shared link is saved, and a link is classified first (see
// src/link-router.ts). Reader stays what it is: offline reading. A failed classification
// never falls back to Reader; it asks the owner with quick buttons instead.
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import {
  linkKey,
  linkReason,
  readLinkPage,
  readLinkRouting,
  type LinkClassification,
  type LinkClassifier,
  type LinkDecision,
  type LinkFacts,
  type LinkRoutingConfig,
  type PageFacts,
} from "./link-router.js";
import { PublicFeedFetcher, type FeedFetcher } from "./news-feed.js";
import type { ReaderLink } from "./news.js";
import type { Action } from "./protocol.js";
import { Spending } from "./spending.js";
import { ToolValidationError } from "./tool-errors.js";
import type { StudyStatus } from "./study-schema.js";

export type StudyAction = Extract<
  Action,
  { operation: `study_${string}` } | { operation: "link_save" }
>;
export type PromptResolution = "study" | "reader" | "both";

/**
 * Page sizes and the serialised bound. List results must stay below the 12,000-character
 * observation projection in src/observations.ts, which would otherwise drop the items.
 */
export const studyLimits = { listPage: 10, serialised: 11_000, excerpt: 400 };

export interface StudyStore {
  /** Absent when Jev is not configured: every shared link then asks the owner. */
  classifier?: Pick<LinkClassifier, "classify" | "config" | "model">;
  fetcher?: FeedFetcher;
  /** Reader through Chief's reviewed grants; absent when no connector is configured. */
  reader?: () => ReaderLink | undefined;
}

/** Stable per owner and link, so a retried Reader save replays instead of duplicating. */
export function readerRequestKey(user: string, url: string) {
  const hex = createHash("sha256")
    .update(`${user}\u0000${linkKey(url)}`)
    .digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const clip = (value: string | null | undefined, n: number) => {
  if (!value) return undefined;
  const points = [...value];
  return points.length > n ? `${points.slice(0, n).join("")}…` : value;
};

export interface StudyItem {
  id: string;
  url: string;
  title: string;
  source: string | null;
  topic: string | null;
  tags: string[];
  notes: string | null;
  status: StudyStatus;
  addedAt: string;
  reason: string | null;
  confidence: number | null;
}

/** The classification record stored with an entry: what decided it, and how sure. */
export function classificationRecord(
  decision: LinkDecision & { model?: string | null; error?: string },
  reason: string,
  extra: Record<string, unknown> = {},
) {
  return {
    destination: decision.verdict,
    reason,
    confidence: Math.round(decision.confidence * 10_000) / 10_000,
    probabilities: decision.probabilities,
    ...(decision.choice ? { choice: decision.choice } : {}),
    ...(decision.cue === undefined ? {} : { cue: decision.cue }),
    ...(decision.via ? { via: decision.via } : {}),
    ...(decision.model ? { model: decision.model } : {}),
    classifiedAt: new Date().toISOString(),
    ...(decision.error ? { error: decision.error } : {}),
    ...extra,
  };
}

const itemOf = (row: any): StudyItem => ({
  id: row.id,
  url: row.url,
  title: row.title,
  source: row.source ?? null,
  topic: row.topic ?? null,
  tags: row.tags ?? [],
  notes: row.notes ?? null,
  status: row.status,
  addedAt: new Date(row.added_at).toISOString(),
  reason: clip(row.classification?.reason, 200) ?? null,
  confidence:
    typeof row.classification?.confidence === "number"
      ? Math.round(row.classification.confidence * 100)
      : null,
});

/** One line per item for a phone; the model turns these into prose. */
export function summarizeItem(item: StudyItem) {
  return `${item.title} — ${item.source ?? "no site"}${
    item.topic ? ` · ${item.topic}` : ""
  } · ${item.status.replaceAll("_", " ")}`;
}

const failure = (error: unknown) =>
  clip((error as Error)?.message, 200) ??
  "Reader reported a failure without details";

export class Study {
  private config: LinkRoutingConfig;
  private fetcher: FeedFetcher;
  constructor(
    private db: Database,
    private deps: StudyStore = {},
  ) {
    this.config = deps.classifier?.config ?? readLinkRouting();
    this.fetcher = deps.fetcher ?? new PublicFeedFetcher();
  }

  private get ttl() {
    return this.config.cardTtlMinutes;
  }

  /** The classifier's Jev snapshot, for the record; absent when Jev is not configured. */
  get model() {
    return this.deps.classifier?.model ?? null;
  }

  private async page(url: string, signal?: AbortSignal) {
    return readLinkPage(url, this.fetcher, signal);
  }

  private async existing(user: string, url: string) {
    return (
      await this.db.query(
        "SELECT * FROM study_resources WHERE user_id=$1 AND url_key=$2",
        [user, linkKey(url)],
      )
    ).rows[0];
  }

  private async insert(
    user: string,
    row: {
      page: PageFacts;
      topic?: string;
      tags?: string[];
      notes?: string;
      status?: StudyStatus;
      classification: object;
    },
  ) {
    const id = randomUUID();
    const inserted = (
      await this.db.query(
        `INSERT INTO study_resources(id,user_id,url,url_key,title,source,topic,tags,notes,status,classification)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT(user_id,url_key) DO NOTHING RETURNING *`,
        [
          id,
          user,
          row.page.url,
          linkKey(row.page.url),
          // The page's own title; a page that could not be read is stored as its URL
          // rather than a guessed name.
          row.page.title ?? row.page.url,
          row.page.site ?? null,
          row.topic ?? row.page.topic ?? null,
          row.tags?.length ? row.tags : row.page.tags,
          row.notes ?? null,
          row.status ?? "to_study",
          JSON.stringify(row.classification),
        ],
      )
    ).rows[0];
    if (inserted) return { row: inserted, duplicate: false };
    const existing = await this.existing(user, row.page.url);
    if (existing) return { row: existing, duplicate: true };
    throw new ToolValidationError(
      "The study list changed while saving; read it again before retrying",
    );
  }

  private saveResult(
    row: any,
    duplicate: boolean,
    page: PageFacts,
    classification: object & { reason?: string; confidence?: number },
  ) {
    return {
      savedTo: "study",
      duplicate,
      needsChoice: false,
      id: row.id,
      title: row.title,
      source: row.source ?? null,
      topic: row.topic ?? null,
      tags: row.tags ?? [],
      status: row.status,
      url: row.url,
      reason: classification.reason ?? null,
      confidence:
        typeof classification.confidence === "number"
          ? Math.round(classification.confidence * 100)
          : null,
      // Read from the page itself, so Chief can name a real topic in one more call.
      ...(page.readable && page.excerpt
        ? { excerpt: clip(page.excerpt, studyLimits.excerpt) }
        : {}),
      ...(page.title ? {} : { titleFromUrl: true }),
    };
  }

  private async prompt(
    user: string,
    facts: LinkFacts,
    classification: object & { reason?: string },
  ) {
    // One open question per link: repeating "save this" must not stack cards.
    const open = (
      await this.db.query(
        "SELECT id FROM study_link_prompts WHERE user_id=$1 AND url_key=$2 AND resolved_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
        [user, linkKey(facts.page.url)],
      )
    ).rows[0];
    if (open) return open.id as string;
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO study_link_prompts(id,user_id,url,url_key,title,source,topic,tags,classification,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,now()+make_interval(mins=>$10))`,
      [
        id,
        user,
        facts.page.url,
        linkKey(facts.page.url),
        facts.page.title ?? facts.page.url,
        facts.page.site ?? null,
        facts.page.topic ?? null,
        facts.page.tags,
        JSON.stringify(classification),
        this.ttl,
      ],
    );
    return id;
  }

  private classify(
    facts: LinkFacts,
    ledger?: Spending,
  ): Promise<LinkClassification> {
    if (this.deps.classifier)
      return this.deps.classifier.classify(facts, ledger);
    return Promise.resolve({
      ok: false,
      verdict: "unsure",
      probabilities: {},
      confidence: 0,
      latencyMs: 0,
      costUsd: null,
      model: null,
      error: "classifier_unavailable",
    });
  }

  private reason(
    facts: LinkFacts,
    decision: LinkDecision,
    ownerMessage?: string,
  ) {
    return decision.verdict === "unsure" && !decision.choice
      ? "Chief could not classify this link, so it asked instead of choosing Reader."
      : linkReason(this.config, facts, decision, ownerMessage);
  }

  /**
   * The single entry point for a shared link: resolve the page, classify on Jev, then save
   * to the study list, save to Reader, or ask. Reader is never the fallback.
   */
  async saveLink(
    user: string,
    input: {
      url: string;
      ownerMessage?: string;
      topic?: string;
      tags?: string[];
      notes?: string;
      signal?: AbortSignal;
      ledger?: Spending;
    },
  ): Promise<unknown> {
    const page = await this.page(input.url, input.signal);
    const facts: LinkFacts = {
      url: page.url,
      ...(input.ownerMessage?.trim()
        ? { ownerMessage: input.ownerMessage.trim() }
        : {}),
      page,
    };
    // A link already on the list is reported, not saved twice, and not re-asked.
    const already = await this.existing(user, page.url);
    if (already)
      return this.saveResult(already, true, page, already.classification ?? {});
    const classification = await this.classify(facts, input.ledger);
    const reason = this.reason(facts, classification, input.ownerMessage);
    const record = classificationRecord(
      { ...classification, model: this.model },
      reason,
    );
    if (classification.verdict === "study") {
      const { row, duplicate } = await this.insert(user, {
        page,
        ...(input.topic ? { topic: input.topic } : {}),
        ...(input.tags?.length ? { tags: input.tags } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        classification: record,
      });
      return this.saveResult(row, duplicate, page, record);
    }
    if (classification.verdict === "reader") {
      const reader = this.deps.reader?.();
      if (!reader)
        return {
          savedTo: null,
          needsChoice: false,
          title: page.title ?? page.url,
          url: page.url,
          reason,
          note: "Reader is not connected to Chief, so nothing was saved. Ask me to put it on your study list instead.",
        };
      try {
        await reader.save(
          user,
          readerRequestKey(user, page.url),
          page.url,
          input.signal,
        );
        return {
          savedTo: "reader",
          needsChoice: false,
          title: page.title ?? page.url,
          source: page.site ?? null,
          url: page.url,
          reason,
          confidence: Math.round(classification.confidence * 100),
        };
      } catch (error) {
        // A refused Reader save asks the owner instead of saving somewhere else.
        const promptId = await this.prompt(user, facts, record);
        return {
          needsChoice: true,
          promptId,
          title: page.title ?? page.url,
          source: page.site ?? null,
          url: page.url,
          reason,
          readerError: failure(error),
        };
      }
    }
    const promptId = await this.prompt(user, facts, record);
    return {
      needsChoice: true,
      promptId,
      title: page.title ?? page.url,
      source: page.site ?? null,
      url: page.url,
      reason,
      ...(page.readable && page.excerpt
        ? { excerpt: clip(page.excerpt, studyLimits.excerpt) }
        : {}),
    };
  }

  /** An explicit "put this on my study list": the owner decided, so nothing is guessed. */
  async saveStudy(
    user: string,
    input: {
      url: string;
      ownerMessage?: string;
      topic?: string;
      tags?: string[];
      notes?: string;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    const page = await this.page(input.url, input.signal);
    const record = classificationRecord(
      {
        verdict: "study",
        probabilities: {},
        confidence: 1,
        via: "cue",
        model: this.model,
      },
      "You asked for this on your study list.",
      { explicit: true },
    );
    const { row, duplicate } = await this.insert(user, {
      page,
      ...(input.topic ? { topic: input.topic } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      classification: record,
    });
    return this.saveResult(row, duplicate, page, record);
  }

  async list(
    user: string,
    query: {
      topic?: string;
      tag?: string;
      status?: StudyStatus;
      limit?: number;
    } = {},
  ) {
    const limit = Math.min(
      query.limit ?? studyLimits.listPage,
      studyLimits.listPage,
    );
    const rows = (
      await this.db.query(
        `SELECT * FROM study_resources WHERE user_id=$1
         AND ($2::text IS NULL OR lower(topic)=lower($2))
         AND ($3::text IS NULL OR $3 = ANY(tags))
         AND ($4::text IS NULL OR status=$4)
         ORDER BY added_at DESC,id DESC LIMIT $5`,
        [
          user,
          query.topic ?? null,
          query.tag ?? null,
          query.status ?? null,
          limit + 1,
        ],
      )
    ).rows;
    const counts = Object.fromEntries(
      (
        await this.db.query(
          "SELECT status,count(*)::int AS n FROM study_resources WHERE user_id=$1 GROUP BY status",
          [user],
        )
      ).rows.map((r) => [r.status, r.n]),
    );
    const items = rows.slice(0, limit).map(itemOf);
    return {
      count: items.length,
      counts: {
        to_study: counts.to_study ?? 0,
        in_progress: counts.in_progress ?? 0,
        done: counts.done ?? 0,
      },
      filter: {
        ...(query.topic ? { topic: query.topic } : {}),
        ...(query.tag ? { tag: query.tag } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      items,
      lines: items.map(summarizeItem),
      more: rows.length > limit,
      note: items.length
        ? "Newest first. Each line is title — site · topic · status."
        : "Nothing saved with that filter yet.",
    };
  }

  async update(
    user: string,
    patch: {
      id: string;
      status?: StudyStatus;
      notes?: string;
      tags?: string[];
      topic?: string;
    },
  ) {
    if (
      patch.status === undefined &&
      patch.notes === undefined &&
      patch.tags === undefined &&
      patch.topic === undefined
    )
      throw new ToolValidationError(
        "Say what to change: status, notes, tags or topic",
      );
    const sets: string[] = [];
    const values: unknown[] = [patch.id, user];
    const set = (sql: string, value: unknown) => {
      values.push(value);
      sets.push(sql.replace("$?", `$${values.length}`));
    };
    if (patch.status) set("status=$?", patch.status);
    if (patch.notes !== undefined)
      set("notes=NULLIF($?, '')", patch.notes.trim());
    if (patch.tags) set("tags=$?", patch.tags);
    if (patch.topic) set("topic=$?", patch.topic);
    sets.push("updated_at=now()");
    const row = (
      await this.db.query(
        `UPDATE study_resources SET ${sets.join(",")} WHERE id=$1 AND user_id=$2 RETURNING *`,
        values,
      )
    ).rows[0];
    if (!row)
      throw new ToolValidationError("That item is not in your study list");
    const item = itemOf(row);
    return { updated: true, item, line: summarizeItem(item) };
  }

  async remove(user: string, id: string) {
    const row = (
      await this.db.query(
        "DELETE FROM study_resources WHERE id=$1 AND user_id=$2 RETURNING id,title",
        [id, user],
      )
    ).rows[0];
    if (!row)
      throw new ToolValidationError("That item is not in your study list");
    return { removed: true, id: row.id, title: row.title };
  }

  /** Owner corrections: study → Reader, or Reader → study. */
  async move(
    user: string,
    input: { to: "study" | "reader"; id?: string; url?: string },
  ) {
    if (input.to === "reader" && !input.id)
      throw new ToolValidationError(
        "Give the study item id to move it to Reader; read the list first",
      );
    if (input.to === "reader") {
      const row = (
        await this.db.query(
          "SELECT * FROM study_resources WHERE id=$1 AND user_id=$2",
          [input.id, user],
        )
      ).rows[0];
      if (!row)
        throw new ToolValidationError("That item is not in your study list");
      const reader = this.deps.reader?.();
      if (!reader)
        throw new ToolValidationError(
          "Reader is not connected to Chief, so nothing moved; the item is still in your study list.",
        );
      await reader.save(user, readerRequestKey(user, row.url), row.url);
      await this.db.query(
        "DELETE FROM study_resources WHERE id=$1 AND user_id=$2",
        [row.id, user],
      );
      return {
        moved: "reader",
        savedTo: "reader",
        title: row.title,
        url: row.url,
        note: "Removed from the study list and saved to Reader for offline reading.",
      };
    }
    const url =
      input.url ??
      (input.id
        ? (
            await this.db.query(
              "SELECT url FROM study_resources WHERE id=$1 AND user_id=$2",
              [input.id, user],
            )
          ).rows[0]?.url
        : undefined);
    if (!url)
      throw new ToolValidationError(
        "Give the link's URL to add it to the study list",
      );
    const page = await this.page(url);
    const record = classificationRecord(
      {
        verdict: "study",
        probabilities: {},
        confidence: 1,
        via: "cue",
        model: this.model,
      },
      "You moved this to your study list.",
      { explicit: true },
    );
    const { row, duplicate } = await this.insert(user, {
      page,
      classification: record,
    });
    return {
      ...this.saveResult(row, duplicate, page, record),
      moved: "study",
      note: "Reader keeps its own copy; Chief cannot delete it there.",
    };
  }

  /** Unanswered asks that the owner has not been shown yet, oldest first. */
  async pending(user: string) {
    return (
      await this.db.query(
        `SELECT id,url,title,source,topic FROM study_link_prompts
         WHERE user_id=$1 AND resolved_at IS NULL AND notified_at IS NULL AND expires_at>now()
         ORDER BY created_at LIMIT 3`,
        [user],
      )
    ).rows;
  }

  async announced(user: string, id: string) {
    await this.db.query(
      "UPDATE study_link_prompts SET notified_at=now() WHERE id=$1 AND user_id=$2 AND notified_at IS NULL",
      [id, user],
    );
  }

  /**
   * A tapped option. Reader work happens before the prompt is closed, so a failed Reader
   * save leaves the ask open instead of pretending the link was stored somewhere.
   */
  async resolvePrompt(
    user: string,
    promptId: string,
    resolution: PromptResolution,
    signal?: AbortSignal,
  ) {
    const row = (
      await this.db.query(
        "SELECT * FROM study_link_prompts WHERE id=$1 AND user_id=$2 AND resolved_at IS NULL AND expires_at>now()",
        [promptId, user],
      )
    ).rows[0];
    if (!row)
      return {
        ok: false,
        saved: null,
        text: "That save has expired or was already answered, so nothing changed.",
      };
    let study: StudyItem | undefined;
    if (resolution !== "reader") {
      const inserted = await this.insert(user, {
        page: {
          url: row.url,
          readable: false,
          ...(row.title ? { title: row.title } : {}),
          ...(row.source ? { site: row.source } : {}),
          ...(row.topic ? { topic: row.topic } : {}),
          tags: row.tags ?? [],
        },
        classification: {
          ...(row.classification ?? {}),
          reason: "You chose the study list.",
          resolvedBy: "owner_button",
        },
      });
      study = itemOf(inserted.row);
    }
    if (resolution !== "study") {
      const reader = this.deps.reader?.();
      if (!reader)
        return {
          ok: false,
          saved: study ?? null,
          text: `${study ? `Saved to your study list: "${row.title}". ` : ""}Reader is not connected to Chief, so nothing went there.`,
        };
      try {
        await reader.save(
          user,
          readerRequestKey(user, row.url),
          row.url,
          signal,
        );
      } catch (error) {
        return {
          ok: false,
          saved: study ?? null,
          text: `Reader could not take "${row.title}" (${failure(error)}). ${
            study
              ? "It is on your study list."
              : "Nothing was saved; ask me to put it on your study list instead."
          }`,
        };
      }
    }
    const saved =
      resolution === "both"
        ? "both"
        : resolution === "reader"
          ? "reader"
          : "study";
    await this.db.query(
      "UPDATE study_link_prompts SET resolved_at=now(), resolution=$3 WHERE id=$1 AND user_id=$2 AND resolved_at IS NULL",
      [promptId, user, saved],
    );
    return {
      ok: true,
      saved,
      text:
        saved === "both"
          ? `Saved to your study list and Reader: "${row.title}".`
          : saved === "reader"
            ? `Saved to Reader for offline reading: "${row.title}".`
            : `Saved to your study list: "${row.title}".`,
    };
  }

  async call(
    user: string,
    a: StudyAction,
    run: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const ledger = new Spending(this.db, user, run);
    if (a.operation === "link_save")
      return this.saveLink(user, {
        url: a.url,
        ...(a.ownerMessage ? { ownerMessage: a.ownerMessage } : {}),
        ...(a.topic ? { topic: a.topic } : {}),
        ...(a.tags?.length ? { tags: a.tags } : {}),
        ...(a.notes ? { notes: a.notes } : {}),
        signal,
        ledger,
      });
    if (a.operation === "study_save")
      return this.saveStudy(user, {
        url: a.url,
        ...(a.ownerMessage ? { ownerMessage: a.ownerMessage } : {}),
        ...(a.topic ? { topic: a.topic } : {}),
        ...(a.tags?.length ? { tags: a.tags } : {}),
        ...(a.notes ? { notes: a.notes } : {}),
        signal,
      });
    if (a.operation === "study_list") return this.list(user, a);
    if (a.operation === "study_update")
      return this.update(user, {
        id: a.id,
        ...(a.status ? { status: a.status } : {}),
        ...(a.notes === undefined ? {} : { notes: a.notes }),
        ...(a.tags ? { tags: a.tags } : {}),
        ...(a.topic ? { topic: a.topic } : {}),
      });
    if (a.operation === "study_remove") return this.remove(user, a.id);
    return this.move(user, {
      to: a.to,
      ...(a.id ? { id: a.id } : {}),
      ...(a.url ? { url: a.url } : {}),
    });
  }
}
