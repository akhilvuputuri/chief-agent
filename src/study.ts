// The owner-scoped study-resources collection (docs/study-resources.md). Study material is
// stored here in Postgres, not as a canvas snapshot and not in Reader; Reader is only for
// offline reading. Every link save records its route, so a confident Reader save can later
// be corrected. Classification is Jev's judgement (src/link-router.ts), and the host fills
// titles, sites and links from the page; no tool accepts them from the model.
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { FeedFetcher } from "./news-feed.js";
import { PublicFeedFetcher, domainOf } from "./news-feed.js";
import { canonicalLink, normalizeLink, readLinkPage } from "./link-page.js";
import {
  LinkRouter,
  type LinkClassification,
  type LinkRoute,
} from "./link-router.js";
import { Spending } from "./spending.js";
import { ToolValidationError } from "./tool-errors.js";
import type {
  StudyStatus,
  StudyTopic,
  StudyUpdate,
  StudyList,
  LinkSave,
  LinkMove,
  StudyRemove,
} from "./study-schema.js";

/** The Reader write Chief may use, structurally compatible with news.ts's ReaderLink. */
export interface ReaderSave {
  save(
    user: string,
    requestKey: string,
    url: string,
    signal?: AbortSignal,
    target?: "article" | "discussion",
  ): Promise<any>;
}

export interface StudyResource {
  id: string;
  user_id: string;
  canonical_url: string;
  url: string;
  title: string;
  site: string;
  topic: StudyTopic;
  tags: string[];
  notes: string | null;
  status: StudyStatus;
  reason: string;
  confidence: number | null;
  added_at: string;
  updated_at: string;
}

type LinkSaveRow = {
  id: string;
  user_id: string;
  canonical_url: string;
  page_url: string;
  title: string;
  site: string;
  topic: StudyTopic;
  route: LinkRoute | "unsure";
  reason: string;
  confidence: number | null;
  study_id: string | null;
  reader_request_key: string | null;
  reader_state: string | null;
  run_id: string | null;
  telegram_message_id: string | number | null;
  claimed_at: string | null;
  delivering_at: string | null;
};

export const TOPIC_LABELS: Record<StudyTopic, string> = {
  "applied-ai-engineering": "applied AI engineering",
  "agent-platforms": "agent platforms",
  "developer-tools": "developer tools",
  "voice-conversational-ai": "voice and conversational AI",
  other: "other",
};
const STATUS_LABELS: Record<StudyStatus, string> = {
  to_study: "to study",
  in_progress: "in progress",
  done: "done",
};
const clean = (value: unknown) =>
  String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300)
    .trim();
const clip = (value: string, max: number) => [...value].slice(0, max).join("");

/**
 * A stable Reader request key for one (owner, URL), so a repeat or a concurrent save replays
 * the same MCP operation instead of writing the article twice. A valid UUID shape for the
 * existing request-key validation.
 */
export function readerRequestKey(user: string, url: string) {
  const hex = createHash("sha256")
    .update(`chief-study-reader\n${user}\n${url}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type StudyDeps = {
  /** Jev; without it every classification is unsure and nothing is saved automatically. */
  router?: LinkRouter;
  /** Optional link resolution (Reddit outbound, verified publisher article). */
  links?: { resolve(user: string, url: string): Promise<any> };
  /** Reader, used only for offline reading. */
  reader?: ReaderSave;
  fetcher?: FeedFetcher;
};

export class Study {
  private fetcher: FeedFetcher;
  constructor(
    private db: Database,
    private deps: StudyDeps = {},
  ) {
    this.fetcher = deps.fetcher ?? new PublicFeedFetcher();
  }

  async call(
    user: string,
    run: string,
    a: { operation: string } & Record<string, any>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (a.operation) {
      case "link_save":
        return this.save(user, run, a as LinkSave, signal);
      case "link_move":
        return this.move(user, run, a as LinkMove, signal);
      case "study_list":
        return this.list(user, a as StudyList);
      case "study_update":
        return this.update(user, a as StudyUpdate);
      case "study_remove":
        return this.remove(user, a as StudyRemove);
      default:
        throw new ToolValidationError(`Unknown study operation ${a.operation}`);
    }
  }

  /** The persisted unsure prompt for a turn, delivered as host-owned tap buttons. */
  async pending(user: string, run: string) {
    return (
      await this.db.query(
        "SELECT id,title,site,page_url AS url FROM link_saves WHERE user_id=$1 AND run_id=$2 AND route='unsure' AND telegram_message_id IS NULL AND delivering_at IS NULL ORDER BY created_at LIMIT 3",
        [user, run],
      )
    ).rows as { id: string; title: string; site: string; url: string }[];
  }

  /** Claims one prompt for delivery so two delivery paths cannot send the same card. */
  async claimDelivery(user: string, id: string) {
    const row = (
      await this.db.query(
        "UPDATE link_saves SET delivering_at=now() WHERE id=$1 AND user_id=$2 AND route='unsure' AND telegram_message_id IS NULL AND delivering_at IS NULL RETURNING id,title,site,page_url AS url",
        [id, user],
      )
    ).rows[0];
    return row as
      { id: string; title: string; site: string; url: string } | undefined;
  }

  async delivered(user: string, id: string, messageId: number | string) {
    await this.db.query(
      "UPDATE link_saves SET telegram_message_id=$3,delivering_at=NULL WHERE id=$1 AND user_id=$2 AND route='unsure'",
      [id, user, String(messageId)],
    );
  }

  /** A failed send releases the delivery claim so a later delivery can retry it. */
  async releaseDelivery(user: string, id: string) {
    await this.db.query(
      "UPDATE link_saves SET delivering_at=NULL WHERE id=$1 AND user_id=$2 AND route='unsure' AND telegram_message_id IS NULL",
      [id, user],
    );
  }

  /**
   * One owner tap. The row is claimed with a conditional update before any work, so two taps
   * cannot both write, and a foreign user or another message cannot claim it at all.
   */
  async choose(
    user: string,
    id: string,
    route: LinkRoute,
    messageId: number | string,
  ) {
    const row = (
      await this.db.query(
        "UPDATE link_saves SET claimed_at=now(),route=$3 WHERE id=$1 AND user_id=$2 AND route='unsure' AND telegram_message_id=$4 AND claimed_at IS NULL RETURNING *",
        [id, user, route, String(messageId)],
      )
    ).rows[0] as LinkSaveRow | undefined;
    if (!row)
      return {
        status: "unavailable" as const,
        text: "That choice is already handled or no longer available. Ask me to save the link again.",
      };
    try {
      const result = await this.fulfil(user, row, route);
      if (!result.finished) {
        // A Reader write that did not complete keeps its buttons: the row is released and a
        // retry replays the same request key, so nothing is written twice.
        await this.reopen(user, id, route);
        return {
          ...result,
          status: "unfinished" as const,
          text: `${result.receipt} ${
            result.reader === "rejected"
              ? "Choose another option, or ask me to check the link."
              : "Tap again to retry, or choose another option."
          }`,
        };
      }
      return { ...result, status: "saved" as const, text: result.receipt };
    } catch (error) {
      // Nothing was written for a study failure; release the claim so the buttons still work.
      await this.reopen(user, id, route);
      throw error;
    }
  }

  /** Releases a claimed prompt so an unfinished tap can be tried again. */
  private async reopen(user: string, id: string, route: LinkRoute) {
    await this.db.query(
      "UPDATE link_saves SET claimed_at=NULL,route='unsure' WHERE id=$1 AND user_id=$2 AND route=$3",
      [id, user, route],
    );
  }

  private async save(
    user: string,
    run: string,
    a: LinkSave,
    signal?: AbortSignal,
  ) {
    let shared: string;
    try {
      shared = normalizeLink(a.url);
    } catch {
      throw new ToolValidationError(
        "Use a public HTTPS link; nothing was saved.",
      );
    }
    const root = await this.rootRun(user, run);
    let pageUrl = shared;
    if (this.deps.links) {
      try {
        const resolved = await this.deps.links.resolve(user, shared);
        pageUrl = resolved?.articleUrl ?? resolved?.pageUrl ?? shared;
      } catch (error) {
        if (signal?.aborted) throw error;
        // Resolution failure is not fatal: the shared public URL is still read below.
      }
    }
    const page = await readLinkPage(pageUrl, this.fetcher, signal);
    const url = page.pageUrl;
    const canonical = canonicalLink(url);
    // Duplicate detection runs after classification, because an explicit owner cue always
    // wins: a link already on the study list can still be sent to Reader when asked.
    const existingStudy = await this.find(user, canonical);
    const existingReader = await this.readerSaved(user, canonical);
    const classification = await this.classify(
      user,
      run,
      await this.ownerMessage(user, root, url, shared),
      {
        url,
        pageUrl: page.pageUrl,
        site: page.site,
        title: page.title,
        description: page.description,
        postText: page.postText,
      },
    );
    const already = this.alreadySaved(existingStudy, existingReader);
    if (
      already &&
      (classification.route === "unsure" ||
        (classification.route === "study" && existingStudy) ||
        (classification.route === "reader" && existingReader) ||
        (classification.route === "both" && existingStudy && existingReader))
    )
      return { ...already, duplicate: true };
    const id = randomUUID();
    // A repeat or a concurrent save reuses one Reader request key, so the MCP replay path
    // cannot write the same article twice. A pending attempt keeps its own key.
    const requestKey =
      classification.route === "study"
        ? null
        : await this.readerKey(user, canonical, url);
    const row = (
      await this.db.query(
        `INSERT INTO link_saves(id,user_id,canonical_url,page_url,title,site,topic,route,reason,confidence,reader_request_key,run_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          id,
          user,
          canonical,
          url,
          clip(page.title, 300),
          clip(page.site, 100),
          classification.topic,
          classification.route,
          clip(classification.reason, 300),
          classification.confidence,
          requestKey,
          root,
        ],
      )
    ).rows[0] as LinkSaveRow;
    if (classification.route === "unsure")
      return {
        route: "unsure" as const,
        title: row.title,
        site: row.site,
        topic: row.topic,
        url: row.page_url,
        options: ["study", "reader", "both"],
        receipt: `Not sure where this belongs: ${row.title}.`,
        note: "Chief was not confident, so nothing was saved. The host is showing three tap options in a separate Telegram message; do not choose a list yourself. Tell the owner briefly that you're not sure and to tap one.",
      };
    return this.fulfil(user, row, classification.route, a.note);
  }

  /** The latest completed Reader save for this link, whether or not a study entry exists. */
  private async readerSaved(user: string, canonical: string) {
    return (
      await this.db.query(
        "SELECT title,site,topic,page_url FROM link_saves WHERE user_id=$1 AND canonical_url=$2 AND reader_state='complete' AND route IN ('reader','both') ORDER BY created_at DESC LIMIT 1",
        [user, canonical],
      )
    ).rows[0] as
      | { title: string; site: string; topic: StudyTopic; page_url: string }
      | undefined;
  }

  /** What the owner already has for this link, so a repeat reports it instead of writing. */
  private alreadySaved(
    study: StudyResource | undefined,
    reader:
      | { title: string; site: string; topic: StudyTopic; page_url: string }
      | undefined,
  ) {
    if (study && reader)
      return {
        route: "both" as const,
        title: study.title,
        site: study.site,
        topic: study.topic,
        url: study.url,
        receipt: `Already on your study list and in Reader: ${study.title}. Anything to change?`,
      };
    if (study)
      return {
        route: "study" as const,
        title: study.title,
        site: study.site,
        topic: study.topic,
        url: study.url,
        status: study.status,
        receipt: `Already on your study list: ${study.title}.`,
      };
    if (reader)
      return {
        route: "reader" as const,
        title: reader.title,
        site: reader.site,
        topic: reader.topic,
        url: reader.page_url,
        receipt: `Already saved to Reader for offline reading: ${reader.title}.`,
      };
    return undefined;
  }

  /** One Reader request key per (owner, link): a repeat replays instead of saving twice. */
  private async readerKey(user: string, canonical: string, url: string) {
    const pending = (
      await this.db.query(
        "SELECT reader_request_key FROM link_saves WHERE user_id=$1 AND canonical_url=$2 AND reader_request_key IS NOT NULL AND reader_state IN ('pending','uncertain') ORDER BY created_at DESC LIMIT 1",
        [user, canonical],
      )
    ).rows[0];
    return pending?.reader_request_key
      ? String(pending.reader_request_key)
      : readerRequestKey(user, url);
  }

  private async classify(
    user: string,
    run: string,
    ownerMessage: string,
    link: {
      url: string;
      pageUrl: string;
      site: string;
      title: string;
      description: string;
      postText?: string;
    },
  ): Promise<LinkClassification> {
    if (!this.deps.router)
      return {
        ok: false,
        route: "unsure",
        topic: "other",
        reason: "Link classification is not configured, so nothing was saved.",
        confidence: 0,
        unsure: 1,
        latencyMs: 0,
        costUsd: null,
        model: null,
        error: "not_configured",
      };
    const recent = (
      await this.db.query(
        "SELECT title,site FROM study_resources WHERE user_id=$1 ORDER BY added_at DESC LIMIT 5",
        [user],
      )
    ).rows as { title: string; site: string }[];
    return this.deps.router.classify(
      { ownerMessage, link, recent },
      new Spending(this.db, user, run),
    );
  }

  /** Writes exactly the chosen route and returns what the owner can be told. */
  private async fulfil(
    user: string,
    row: LinkSaveRow,
    route: LinkRoute,
    note?: string,
  ) {
    let study: StudyResource | undefined;
    let duplicate = false;
    const parts: string[] = [];
    if (route === "study" || route === "both") {
      const added = await this.add(user, {
        canonical_url: row.canonical_url,
        url: row.page_url,
        title: row.title,
        site: row.site,
        topic: row.topic,
        notes: note ?? null,
        reason: row.reason,
        confidence: row.confidence ?? null,
      });
      study = added.row;
      duplicate = added.duplicate;
      parts.push(
        duplicate
          ? `Already on your study list: ${study.title}.`
          : `Saved to your study list: ${study.title} — ${TOPIC_LABELS[study.topic]}.`,
      );
    }
    let readerState: string | undefined;
    let readerStatus: string | undefined;
    if (route === "reader" || route === "both") {
      const done = await this.readerSaved(user, row.canonical_url);
      if (done) {
        // Already in Reader: report it rather than saving the same article twice.
        readerState = "complete";
        parts.push(
          `Already saved to Reader for offline reading: ${row.title}.`,
        );
      } else {
        const requestKey =
          row.reader_request_key ??
          (await this.readerKey(user, row.canonical_url, row.page_url));
        if (!row.reader_request_key)
          await this.db.query(
            "UPDATE link_saves SET reader_request_key=$3 WHERE id=$1 AND user_id=$2",
            [row.id, user, requestKey],
          );
        const saved = await this.saveReader(user, row.page_url, requestKey);
        readerState = saved.state;
        readerStatus = saved.status;
        parts.push(
          saved.text ??
            (saved.state === "complete"
              ? `Saved to Reader for offline reading: ${row.title}.`
              : saved.state === "pending"
                ? `Sent to Reader but not confirmed yet: ${row.title}.`
                : `Reader did not save ${row.title}.`),
        );
      }
      // A Reader save for a link that also sits on the study list is a partial correction:
      // say so, and the owner can move it with link_move.
      if (route === "reader" && (await this.find(user, row.canonical_url)))
        parts.push(
          `It is still on your study list; say "move it to Reader" to take it off.`,
        );
    }
    await this.db.query(
      "UPDATE link_saves SET route=$3,study_id=$4,reader_state=$5 WHERE id=$1 AND user_id=$2",
      [row.id, user, route, study?.id ?? row.study_id, readerState ?? null],
    );
    return {
      route,
      title: row.title,
      site: row.site,
      topic: row.topic,
      url: row.page_url,
      finished:
        route === "reader" || route === "both"
          ? readerState === "complete"
          : true,
      ...(study ? { id: study.id, studyStatus: study.status } : {}),
      ...(duplicate ? { duplicate: true } : {}),
      ...(readerState ? { reader: readerState } : {}),
      ...(readerStatus ? { readerStatus } : {}),
      receipt: parts.join(" "),
    };
  }

  private async saveReader(user: string, url: string, requestKey: string) {
    if (!this.deps.reader)
      return {
        state: "unavailable" as const,
        text: "Reader is not connected here, so it was not saved for offline reading.",
      };
    try {
      const result = await this.deps.reader.save(user, requestKey, url);
      if (result?.state === "complete") {
        const status = result?.result?.status;
        if (status === "bookmark")
          return {
            state: "failed" as const,
            status,
            text: `Reader saved only a bookmark: it could not extract the article (${result?.result?.error ?? "no text found"}).`,
          };
        return { state: "complete" as const, status };
      }
      if (result?.state === "pending") return { state: "pending" as const };
      if (result?.state === "rejected")
        return {
          state: "rejected" as const,
          text: "Reader refused the save; nothing was added there. Check the link and ask me again.",
        };
      return { state: "failed" as const };
    } catch (error) {
      // The host refused the invocation before dispatch, so nothing was submitted.
      if (error instanceof ToolValidationError)
        return {
          state: "rejected" as const,
          text: `Reader did not submit the save (${clean((error as Error)?.message)}), so nothing new was added there.`,
        };
      return {
        state: "uncertain" as const,
        text: `Could not confirm the Reader save (${clean((error as Error)?.message)}). Ask me to check it before relying on it.`,
      };
    }
  }

  private async add(
    user: string,
    entry: {
      canonical_url: string;
      url: string;
      title: string;
      site: string;
      topic: StudyTopic;
      notes: string | null;
      reason: string;
      confidence: number | null;
    },
  ) {
    const id = randomUUID();
    const inserted = (
      await this.db.query(
        `INSERT INTO study_resources(id,user_id,canonical_url,url,title,site,topic,notes,reason,confidence)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (user_id,canonical_url) DO NOTHING RETURNING *`,
        [
          id,
          user,
          entry.canonical_url,
          entry.url,
          clip(entry.title, 300),
          clip(entry.site, 100),
          entry.topic,
          entry.notes,
          clip(entry.reason, 300),
          entry.confidence,
        ],
      )
    ).rows[0] as StudyResource | undefined;
    if (inserted) return { row: inserted, duplicate: false };
    const existing = await this.find(user, entry.canonical_url);
    if (!existing) throw new Error("Study entry unavailable after insert");
    return { row: existing, duplicate: true };
  }

  private async find(user: string, canonical: string) {
    return (
      await this.db.query(
        "SELECT * FROM study_resources WHERE user_id=$1 AND canonical_url=$2",
        [user, canonical],
      )
    ).rows[0] as StudyResource | undefined;
  }

  private async list(user: string, a: StudyList) {
    const where = ["user_id=$1"];
    const values: unknown[] = [user];
    if (a.status) {
      values.push(a.status);
      where.push(`status=$${values.length}`);
    }
    if (a.topic) {
      values.push(a.topic);
      where.push(`topic=$${values.length}`);
    }
    if (a.tag) {
      values.push(a.tag);
      where.push(`$${values.length}=ANY(tags)`);
    }
    // The header counts everything that matches, not only the rows on this page, so the
    // phone list never understates what is saved.
    const total = Number(
      (
        await this.db.query(
          `SELECT count(*) AS n FROM study_resources WHERE ${where.join(" AND ")}`,
          values,
        )
      ).rows[0]?.n ?? 0,
    );
    values.push(a.limit ?? 20);
    const rows = (
      await this.db.query(
        `SELECT * FROM study_resources WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'to_study' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,added_at DESC LIMIT $${values.length}`,
        values,
      )
    ).rows as StudyResource[];
    const filters = [
      a.status ? STATUS_LABELS[a.status] : null,
      a.topic ? TOPIC_LABELS[a.topic] : null,
      a.tag ? `#${a.tag}` : null,
    ].filter(Boolean);
    const header = total
      ? `Study list${filters.length ? ` (${filters.join(", ")})` : ""}: ${total} item${total === 1 ? "" : "s"}`
      : `Nothing on your study list${filters.length ? ` for ${filters.join(", ")}` : ""}.`;
    const lines: string[] = [header];
    let current: StudyStatus | undefined;
    for (const row of rows) {
      if (row.status !== current) {
        current = row.status;
        lines.push(
          "",
          STATUS_LABELS[row.status].replace(/^./, (c) => c.toUpperCase()),
        );
      }
      lines.push(
        `• ${row.title} — ${row.site} [${TOPIC_LABELS[row.topic]}]${row.tags.length ? ` #${row.tags.join(" #")}` : ""}${row.notes ? " · note" : ""}`,
      );
    }
    if (total > rows.length)
      lines.push("", `…and ${total - rows.length} more.`);
    return {
      count: rows.length,
      total,
      filters: a,
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        site: row.site,
        topic: row.topic,
        status: row.status,
        tags: row.tags,
        notes: row.notes,
        url: row.url,
        addedAt: row.added_at,
      })),
      text: lines.join("\n"),
    };
  }

  private async update(user: string, a: StudyUpdate) {
    const sets: string[] = [];
    const values: unknown[] = [a.id, user];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column}=$${values.length}`);
    };
    if (a.status) set("status", a.status);
    if (a.notes !== undefined) set("notes", a.notes);
    if (a.tags !== undefined) set("tags", a.tags ?? []);
    if (a.topic) set("topic", a.topic);
    if (!sets.length)
      throw new ToolValidationError(
        "Supply at least one of status, notes, tags or topic to update",
      );
    const row = (
      await this.db.query(
        `UPDATE study_resources SET ${sets.join(",")},updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
        values,
      )
    ).rows[0] as StudyResource | undefined;
    if (!row)
      throw new ToolValidationError("Study entry not found for this owner");
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      topic: row.topic,
      tags: row.tags,
      notes: row.notes,
      receipt: `Updated ${row.title}: ${STATUS_LABELS[row.status]}${row.tags.length ? `, #${row.tags.join(" #")}` : ""}${row.notes ? ", note kept" : ""}.`,
    };
  }

  private async remove(user: string, a: StudyRemove) {
    const row = (
      await this.db.query(
        "DELETE FROM study_resources WHERE id=$1 AND user_id=$2 RETURNING *",
        [a.id, user],
      )
    ).rows[0] as StudyResource | undefined;
    if (!row)
      throw new ToolValidationError("Study entry not found for this owner");
    return {
      id: row.id,
      title: row.title,
      receipt: `Removed ${row.title} from your study list. Any Reader save is unchanged.`,
    };
  }

  private async move(
    user: string,
    run: string,
    a: LinkMove,
    signal?: AbortSignal,
  ) {
    if (!!a.id === !!a.url)
      throw new ToolValidationError("Supply exactly one of id or url");
    let study: StudyResource | undefined;
    let record: LinkSaveRow | undefined;
    if (a.id) {
      study = (
        await this.db.query(
          "SELECT * FROM study_resources WHERE id=$1 AND user_id=$2",
          [a.id, user],
        )
      ).rows[0] as StudyResource | undefined;
      if (!study)
        throw new ToolValidationError("Study entry not found for this owner");
      record = (
        await this.db.query(
          "SELECT * FROM link_saves WHERE user_id=$1 AND canonical_url=$2 ORDER BY created_at DESC LIMIT 1",
          [user, study.canonical_url],
        )
      ).rows[0] as LinkSaveRow | undefined;
    } else {
      const canonical = canonicalLink(a.url!);
      study = await this.find(user, canonical);
      record = (
        await this.db.query(
          "SELECT * FROM link_saves WHERE user_id=$1 AND canonical_url=$2 ORDER BY created_at DESC LIMIT 1",
          [user, canonical],
        )
      ).rows[0] as LinkSaveRow | undefined;
      if (!study && !record)
        throw new ToolValidationError(
          "No saved link matches that URL. Share it with me first, then I can move it.",
        );
    }
    // A study entry added before this feature (or by an owner edit) may have no route record;
    // its own stored metadata is then the record, never a guess.
    record ??= study
      ? ({
          id: "",
          user_id: user,
          canonical_url: study.canonical_url,
          page_url: study.url,
          title: study.title,
          site: study.site,
          topic: study.topic,
          route: "study",
          reason: study.reason,
          confidence: study.confidence,
          study_id: study.id,
          reader_request_key: null,
          reader_state: null,
          run_id: null,
          telegram_message_id: null,
          claimed_at: null,
          delivering_at: null,
        } as LinkSaveRow)
      : undefined;
    if (!record)
      throw new ToolValidationError(
        "No saved link matches that URL. Share it with me first, then I can move it.",
      );
    const title = study?.title ?? record.title;
    const url = study?.url ?? record.page_url;
    const topic = study?.topic ?? record.topic;
    if (a.to === "remove") {
      if (!study)
        throw new ToolValidationError("That link is not on your study list");
      await this.db.query(
        "DELETE FROM study_resources WHERE id=$1 AND user_id=$2",
        [study.id, user],
      );
      return {
        route: "remove",
        title,
        receipt: `Removed ${title} from your study list. Reader is unchanged.`,
      };
    }
    if (a.to === "study") {
      if (study)
        return {
          route: "study",
          id: study.id,
          title,
          receipt: `Already on your study list: ${title}.`,
        };
      const added = await this.add(user, {
        canonical_url: record!.canonical_url,
        url,
        title,
        site: record!.site,
        topic,
        notes: null,
        reason: clip(
          `Moved to the study list by the owner. ${record!.reason}`,
          300,
        ),
        confidence: record!.confidence,
      });
      await this.record(user, run, record!, "study", added.row.id, undefined);
      return {
        route: "study",
        id: added.row.id,
        title,
        receipt: `Added ${title} to your study list. Reader keeps its own copy; I can't remove Reader saves.`,
      };
    }
    // to Reader: the remote write finishes before anything local is removed.
    const already = (
      await this.db.query(
        "SELECT 1 FROM link_saves WHERE user_id=$1 AND canonical_url=$2 AND reader_state='complete' AND route IN ('reader','both') LIMIT 1",
        [user, record!.canonical_url],
      )
    ).rows.length;
    if (!already) {
      // The same request key as link_save, so a replay cannot save the same URL twice.
      const requestKey = await this.readerKey(user, record!.canonical_url, url);
      const saved = await this.saveReader(user, url, requestKey);
      if (saved.state !== "complete")
        return {
          route: "reader",
          title,
          reader: saved.state,
          receipt:
            saved.text ??
            `Reader has not confirmed the save, so ${study ? `${title} stays on your study list` : `${title} was not added anywhere`}.`,
        };
    }
    // Record the move before removing the local entry, so the route journal survives a
    // failed delete and a retry can finish it.
    await this.record(user, run, record, "reader", undefined, undefined);
    if (study)
      await this.db.query(
        "DELETE FROM study_resources WHERE id=$1 AND user_id=$2",
        [study.id, user],
      );
    return {
      route: "reader",
      title,
      receipt: `Moved ${title} to Reader for offline reading.`,
    };
  }

  private async record(
    user: string,
    run: string,
    from: LinkSaveRow,
    route: LinkRoute,
    studyId: string | undefined,
    readerState: string | undefined,
  ) {
    await this.db.query(
      `INSERT INTO link_saves(id,user_id,canonical_url,page_url,title,site,topic,route,reason,confidence,study_id,reader_state,run_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        randomUUID(),
        user,
        from.canonical_url,
        from.page_url,
        from.title,
        from.site,
        from.topic,
        route,
        clip(`Moved by the owner. ${from.reason}`, 300),
        from.confidence,
        studyId ?? null,
        readerState ?? (route === "reader" ? "complete" : null),
        await this.rootRun(user, run),
      ],
    );
  }

  /** The coordinator run behind an agent's child run, where the owner's message lives. */
  private async rootRun(user: string, run: string) {
    const row = (
      await this.db.query(
        `SELECT COALESCE((SELECT (e.data->>'parentRunId')::uuid FROM events e WHERE e.run_id=$2 AND e.user_id=$1 AND e.type IN ('agent.child_started','research.child_started') AND e.data->>'parentRunId' IS NOT NULL LIMIT 1),$2::uuid) AS id`,
        [user, run],
      )
    ).rows[0];
    return String(row?.id ?? run);
  }

  /** The owner's own words for this turn: the link_save tool never receives them from a model. */
  private async ownerMessage(
    user: string,
    root: string,
    url: string,
    shared: string,
  ) {
    const rows = (
      await this.db.query(
        "SELECT message FROM conversation_inputs WHERE user_id=$1 AND run_id=$2 ORDER BY ordinal",
        [user, root],
      )
    ).rows as { message: string | null }[];
    const messages = rows.map((r) => String(r.message ?? "")).filter(Boolean);
    if (!messages.length) return "";
    const host = domainOf(url);
    const hit = messages.findIndex(
      (m) => m.includes(url) || m.includes(shared) || m.includes(host),
    );
    // A cue can arrive in a separate message of the same turn ("save this" then "for AI
    // learning"), so the neighbouring messages are included with the link's own message.
    const around =
      hit < 0
        ? messages.slice(-3)
        : messages.slice(Math.max(0, hit - 1), hit + 2);
    return clip(around.join("\n"), 2000);
  }
}
