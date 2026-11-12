// Link saving and the study list (docs/links.md). A link the owner shares to save is
// classified first (LinkClassifier, on Jev) as study material or offline reading. Study
// material goes to the owner-scoped study_resources table; offline reading goes to Reader
// through the reviewed MCP grant. When Jev is unsure, the owner gets three buttons instead
// of an open question, and Chief never falls back to Reader.
//
// Reader request keys (journal 178): the URL used to look up an earlier save and the URL
// sent as the save_link payload are the same canonical string, so a key is only reused for
// an identical payload. A pending earlier save is retried with its own key (and the owner is
// told), a completed one is not sent again, and a rejected one never blocks a new attempt:
// that gets a fresh key.
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { event } from "./db.js";
import {
  LinkClassifier,
  type Classification,
  type Destination,
  type PageFacts,
} from "./link-classifier.js";
import type { LinkAction } from "./links-schema.js";
import { linkMove, linkSave } from "./links-schema.js";
import { canonicalUrl } from "./link-url.js";
import type { McpTools } from "./mcp.js";
import { mcpReaderLink } from "./news.js";
import {
  PublicFeedFetcher,
  pageMeta,
  withDeadline,
  type FeedFetcher,
} from "./news-feed.js";
import { errorFields, opsLog } from "./ops-log.js";
import { spending } from "./spending.js";
import { ToolValidationError } from "./tool-errors.js";

export { canonicalUrl };

export type ReaderOutcome = {
  state:
    | "complete"
    | "pending"
    | "rejected"
    | "blocked"
    | "uncertain"
    | "refused"
    | "unavailable";
  key?: string;
  /** The exact URL sent (or that would have been sent) as the save_link payload. */
  url: string;
  status?: string;
  already?: boolean;
  earlierPending?: boolean;
  category?: string;
  retryAfterSeconds?: number;
  message?: string;
};

type Row = Record<string, any>;
const LEASE = "interval '2 minutes'";
const STATUS_LABEL: Record<string, string> = {
  to_study: "to study",
  in_progress: "in progress",
  done: "done",
};

function hostOf(url: string) {
  return new URL(url).hostname.replace(/^www\./, "");
}

/** Plain-text first heading or "Title:" line of stored page text (web_read output). */
function sourceTitle(content: string) {
  const head = content.slice(0, 3000);
  const m =
    /^Title:[ \t]*(.{3,300})$/m.exec(head) ?? /^#[ \t]+(.{3,300})$/m.exec(head);
  return m?.[1]?.trim() || null;
}

export function studyLine(entry: Row) {
  const title = entry.title ?? entry.site ?? hostOf(entry.url);
  return `${title}${entry.site && entry.title ? ` (${entry.site})` : ""}${entry.topic ? ` · ${entry.topic}` : ""} · ${STATUS_LABEL[entry.status] ?? entry.status}`;
}

function compact(entry: Row) {
  return {
    id: entry.id,
    title: entry.title,
    site: entry.site,
    url: entry.url,
    topic: entry.topic,
    tags: entry.tags ?? [],
    status: entry.status,
    notes: entry.notes,
    addedAt:
      entry.added_at instanceof Date
        ? entry.added_at.toISOString()
        : entry.added_at,
    classification: {
      reason: entry.classification_reason,
      confidence: entry.classification_confidence,
      by: entry.classified_by,
    },
    line: studyLine(entry),
  };
}

export class LinkTools {
  constructor(
    private db: Database,
    private options: {
      classifier?: LinkClassifier;
      fetcher?: FeedFetcher;
      mcp?: () => McpTools | undefined;
      /** Upper bound for reading the page, in ms. */
      readMs?: number;
    } = {},
  ) {}

  private get reader() {
    const mcp = this.options.mcp?.();
    return mcp?.configured ? mcp : undefined;
  }

  async call(user: string, run: string, a: LinkAction, signal?: AbortSignal) {
    if (a.operation === "link_save") return this.save(user, run, a, signal);
    if (a.operation === "link_move") return this.move(user, a, signal);
    if (a.operation === "study_list") return this.list(user, a);
    if (a.operation === "study_update") return this.update(user, a);
    return this.remove(user, a.id);
  }

  /** Page facts from the page itself (or a stored web_read source); never invented. */
  async page(
    user: string,
    input: string,
    sourceId?: string,
    signal?: AbortSignal,
  ): Promise<PageFacts & { candidates: string[] }> {
    const original = canonicalUrl(input);
    const candidates = [original];
    let url = original;
    let meta = {
      title: null as string | null,
      site: null as string | null,
      description: null as string | null,
      excerpt: null as string | null,
    };
    if (sourceId) {
      const source = (
        await this.db.query(
          "SELECT url,content FROM research_sources WHERE id=$1 AND user_id=$2",
          [sourceId, user],
        )
      ).rows[0];
      if (!source) throw new ToolValidationError("Source not found");
      const text = String(source.content ?? "");
      meta = {
        title: sourceTitle(text),
        site: null,
        description: null,
        excerpt: text.slice(0, 1500) || null,
      };
    } else {
      try {
        const fetcher = this.options.fetcher ?? new PublicFeedFetcher();
        const got = await withDeadline(
          fetcher.get(original, signal),
          this.options.readMs ?? 20000,
        );
        meta = pageMeta(got.body);
        const final = canonicalUrl(got.finalUrl);
        if (final !== original) {
          url = final;
          candidates.unshift(final);
        }
      } catch {
        // Unreadable page: classify from the link and the owner's words only.
      }
    }
    return {
      url,
      site: meta.site ?? hostOf(url),
      title: meta.title,
      description: meta.description,
      excerpt: meta.excerpt,
      candidates,
    };
  }

  /**
   * The owner's learning interests: those Chief passes, else the owner's explicit memories
   * about them (a learning_interests memory first, then any active fact memory whose key
   * names learning, interests or study). Nothing about the owner is stored in code.
   */
  private async interests(user: string, given?: string[]) {
    if (given?.length) return given;
    const rows = (
      await this.db.query(
        `SELECT r.key,r.value FROM memory_heads h JOIN memory_revisions r ON r.id=h.revision_id AND r.user_id=h.user_id
         WHERE h.user_id=$1 AND r.status='active' AND r.kind='fact' AND r.trust='owner' AND r.value IS NOT NULL
           AND (r.key='learning_interests' OR r.key ~ '(learn|interest|study)')
         ORDER BY (r.key='learning_interests') DESC, r.key LIMIT 3`,
        [user],
      )
    ).rows;
    return [
      ...new Set(
        rows.flatMap((row) =>
          String(row.value)
            .split(/[,;\n]/)
            .map((s: string) => s.trim().slice(0, 100))
            .filter(Boolean),
        ),
      ),
    ].slice(0, 8);
  }

  private async save(
    user: string,
    run: string,
    input: Extract<LinkAction, { operation: "link_save" }>,
    signal?: AbortSignal,
  ) {
    const a = linkSave.parse(input);
    const page = await this.page(user, a.url, a.sourceId, signal);
    if (a.title) page.title = a.title;
    const interests = await this.interests(user, a.interests);
    const explicit: Destination | undefined =
      a.destination === "study" || a.destination === "reader"
        ? a.destination
        : undefined;
    const requested: Destination | undefined =
      a.destination === "both" ? "study" : explicit;
    let classification: Classification = this.options.classifier
      ? await this.options.classifier.classify(
          {
            ownerMessage: await this.ownerMessage(user, run),
            page,
            interests,
            explicit: requested,
          },
          spending.getStore(),
        )
      : requested
        ? {
            ok: true,
            destination: requested,
            confidence: 1,
            by: "owner",
            topic: null,
            reason: "",
          }
        : {
            ok: false,
            outcome: "unconfigured",
            topic: null,
            reason: "Link classification is not configured.",
          };
    if (requested && classification.ok)
      classification = {
        ...classification,
        reason:
          a.destination === "both"
            ? "You asked for both."
            : requested === "study"
              ? "You asked for the study list."
              : "You asked for Reader.",
      };
    await event(this.db, user, run, "link.classified", {
      ok: classification.ok,
      outcome: classification.ok ? "confident" : classification.outcome,
      destination: classification.ok ? classification.destination : null,
      requested: a.destination,
      confidence: classification.ok
        ? classification.confidence
        : (classification.confidence ?? null),
      by: classification.ok ? classification.by : null,
    });
    const facts = {
      url: page.url,
      title: page.title,
      site: page.site,
      topic: classification.topic,
    };
    if (!classification.ok) {
      // An earlier uncertain save of this link only ever left inspectable effects (a study
      // row, a recorded Reader save), so it is settled here too; otherwise it would keep
      // blocking the owner's writes while they decide on the card.
      await this.settleUncertain(
        user,
        canonicalUrl(a.url),
        page.candidates,
      ).catch((error) =>
        opsLog("links.settle_failed", "warn", errorFields(error)),
      );
      const id = randomUUID();
      await this.db.query(
        "INSERT INTO link_choices(id,user_id,url,page,classification,run_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)",
        [
          id,
          user,
          page.url,
          JSON.stringify({ ...page, tags: a.tags ?? [], notes: a.notes }),
          JSON.stringify(classification),
          run,
        ],
      );
      return {
        state: "needs_choice",
        choiceId: id,
        ...facts,
        reason: classification.reason,
        where:
          "I wasn't sure whether this is study material or offline reading, so I've sent you buttons: Study list, Reader or Both. Nothing is saved until you tap one.",
        instruction:
          "The host sends the buttons after your reply. Do not ask an open question about where to save it.",
      };
    }
    const target =
      a.destination === "both" ? "both" : classification.destination;
    // Both: each write is attempted and reported on its own, so one failing never hides the
    // other's outcome. A single-destination failure propagates and the host keeps it uncertain.
    let studyError = false;
    let study: { duplicate: boolean; entry: Row } | undefined;
    if (target === "study" || target === "both")
      try {
        study = await this.addStudy(
          user,
          page,
          classification,
          a.tags,
          a.notes,
        );
      } catch (error) {
        if (target !== "both") throw error;
        studyError = true;
        opsLog("links.study_failed", "warn", errorFields(error));
      }
    let reader: ReaderOutcome | undefined;
    if (target === "reader" || target === "both")
      try {
        reader = await this.readerSave(user, page.candidates, signal);
      } catch (error) {
        if (target !== "both") throw error;
        opsLog("links.reader_failed", "warn", errorFields(error));
        reader = {
          state: "uncertain",
          url: page.url,
          message:
            "Couldn't confirm the Reader save; ask me again to settle it safely.",
        };
      }
    await this.settleUncertain(
      user,
      canonicalUrl(a.url),
      page.candidates,
    ).catch((error) =>
      opsLog("links.settle_failed", "warn", errorFields(error)),
    );
    return {
      // saved: every requested write confirmed; partial: some; not_confirmed: none.
      state: [
        ...(target !== "reader" ? [!!study] : []),
        ...(target !== "study" ? [reader?.state === "complete"] : []),
      ].every(Boolean)
        ? "saved"
        : study || reader?.state === "complete"
          ? "partial"
          : "not_confirmed",
      destination: target,
      ...facts,
      reason: classification.reason,
      confidence: classification.confidence,
      classifiedBy: classification.by,
      ...(study
        ? {
            study: {
              duplicate: study.duplicate,
              entry: compact(study.entry),
            },
          }
        : {}),
      ...(reader ? { reader } : {}),
      ...(studyError ? { studyUncertain: true } : {}),
      where:
        (studyError
          ? "Couldn't confirm the study list save; it may or may not have been added. Ask me again to settle it safely. "
          : "") + whereLine(target, classification.topic, study, reader),
    };
  }

  /** The owner's own latest words in this turn, for Jev's explicit-cue check. */
  private async ownerMessage(user: string, run: string) {
    const row = (
      await this.db
        .query(
          `SELECT i.message FROM conversation_inputs i WHERE i.user_id=$1 AND i.run_id IN (
           SELECT $2::uuid UNION SELECT (e.data->>'parentRunId')::uuid FROM events e
           WHERE e.run_id=$2::uuid AND e.user_id=$1 AND e.type IN ('agent.child_started','research.child_started'))
         ORDER BY i.ordinal DESC LIMIT 1`,
          [user, run],
        )
        .catch(() => ({ rows: [] as Row[] }))
    ).rows[0];
    return typeof row?.message === "string" ? row.message : "";
  }

  /** Insert, or report the existing entry for the same link. The unique key decides. */
  async addStudy(
    user: string,
    page: PageFacts & { candidates?: string[] },
    classification: {
      reason: string;
      confidence?: number;
      by?: "jev" | "owner";
      topic: string | null;
    },
    tags?: string[],
    notes?: string,
  ): Promise<{ duplicate: boolean; entry: Row }> {
    const candidates = page.candidates?.length ? page.candidates : [page.url];
    const existing = (
      await this.db.query(
        "SELECT * FROM study_resources WHERE user_id=$1 AND url=ANY($2::text[]) ORDER BY added_at LIMIT 1",
        [user, candidates],
      )
    ).rows[0];
    if (existing) return { duplicate: true, entry: existing };
    const inserted = (
      await this.db.query(
        `INSERT INTO study_resources(id,user_id,url,title,site,topic,tags,notes,classification_reason,classification_confidence,classified_by)
         VALUES($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11) ON CONFLICT(user_id,url) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          user,
          page.url,
          page.title,
          page.site,
          classification.topic,
          [...new Set(tags ?? [])],
          notes ?? null,
          classification.reason,
          classification.confidence ?? null,
          classification.by ?? null,
        ],
      )
    ).rows[0];
    if (inserted) return { duplicate: false, entry: inserted };
    const raced = (
      await this.db.query(
        "SELECT * FROM study_resources WHERE user_id=$1 AND url=$2",
        [user, page.url],
      )
    ).rows[0];
    if (!raced) throw new Error("Study list entry could not be confirmed");
    return { duplicate: true, entry: raced };
  }

  /**
   * The newest Reader save of this link, for this owner: one whose payload URL is one of
   * these canonical forms, or one recorded for them in link_reader_keys (a link shared as
   * twitter.com whose save was sent as the redirected x.com URL).
   */
  private async earlierReaderSave(user: string, urls: string[]) {
    return (
      await this.db.query(
        `SELECT o.request_key,o.state,o.result,COALESCE(o.source_payload,o.payload)->>'url' AS url FROM mcp_operations o
         WHERE o.user_id=$1 AND o.connection='reader' AND o.tool='save_link'
           AND (COALESCE(o.source_payload,o.payload)->>'url' = ANY($2::text[])
             OR EXISTS (SELECT 1 FROM link_reader_keys k WHERE k.user_id=o.user_id AND k.request_key=o.request_key AND k.url=ANY($2::text[])))
         ORDER BY CASE o.state WHEN 'pending' THEN 0 WHEN 'complete' THEN 1 ELSE 2 END, o.created_at DESC LIMIT 1`,
        [user, urls],
      )
    ).rows[0];
  }

  /**
   * Saves to Reader. The key is reused only for a genuine retry of the identical payload
   * (an earlier pending save of the same URL, or `preferKey` when nothing was stored under
   * it yet); a completed save is not sent again; after a rejection, a new key.
   */
  async readerSave(
    user: string,
    candidates: string[],
    signal?: AbortSignal,
    preferKey?: string | null,
    beforeSend?: (key: string, url: string) => Promise<void>,
  ): Promise<ReaderOutcome> {
    const mcp = this.reader;
    const urls = candidates.map((u) => canonicalUrl(u));
    let url = urls[0]!;
    if (!mcp)
      return {
        state: "unavailable",
        url,
        message: "Reader isn't connected to Chief, so nothing was saved there.",
      };
    const earlier = await this.earlierReaderSave(user, urls);
    let key: string;
    let earlierPending = false;
    if (earlier?.state === "complete")
      return {
        state: "complete",
        key: earlier.request_key,
        url: earlier.url,
        already: true,
        status: earlier.result?.status,
        message: "It was already saved to Reader earlier.",
      };
    if (earlier?.state === "pending") {
      // Same key, same payload URL: an exact retry that Reader replays, never a second save.
      key = earlier.request_key;
      url = earlier.url;
      earlierPending = true;
    } else if (
      preferKey &&
      !(
        await this.db.query(
          "SELECT 1 FROM mcp_operations WHERE user_id=$1 AND connection='reader' AND request_key=$2",
          [user, preferKey],
        )
      ).rows.length
    )
      key = preferKey;
    else key = randomUUID();
    // Every form of the link (as shared, after redirects, the payload) maps to this key
    // before anything is sent, so a later save of any of them finds this request.
    await this.db.query(
      "INSERT INTO link_reader_keys(user_id,url,request_key) SELECT $1,u,$3 FROM unnest($2::text[]) u ON CONFLICT DO NOTHING",
      [user, [...new Set([...urls, url])], key],
    );
    await beforeSend?.(key, url);
    const base = { key, url, ...(earlierPending ? { earlierPending } : {}) };
    let r: any;
    try {
      r = await mcpReaderLink(mcp).save(user, key, url, signal);
    } catch (error) {
      if (error instanceof ToolValidationError) {
        if (/pending MCP write/.test(error.message))
          return {
            ...base,
            state: "blocked",
            message:
              "Another Reader save is still unconfirmed, so this one wasn't sent. Ask me to check Reader's pending save, then try again.",
          };
        if (/bound to another connection/.test(error.message))
          return {
            ...base,
            state: "refused",
            message:
              "An earlier Reader save of this link was made under Chief's previous Reader connection, so it can't be retried from here; check Reader's Imports.",
          };
        if (
          /no write was submitted|could not be verified|not configured/.test(
            error.message,
          )
        )
          return {
            ...base,
            state: "refused",
            message: `Reader save not sent: ${error.message}`,
          };
        return {
          ...base,
          state: "uncertain",
          message: `Couldn't confirm the Reader save (${error.message}). Ask me again to settle it safely.`,
        };
      }
      return {
        ...base,
        state: "uncertain",
        message:
          "Couldn't confirm the Reader save; ask me again to settle it safely with the same request.",
      };
    }
    const status = r?.result?.status;
    if (r?.state === "complete")
      return {
        ...base,
        state: "complete",
        status,
        already: status === "already_saved",
        message:
          status === "bookmark"
            ? "Saved to Reader, but Reader couldn't prepare the article; it's in Reader's Imports."
            : status === "already_saved"
              ? "It was already in Reader."
              : "Saved to Reader for offline reading.",
      };
    if (r?.state === "rejected")
      return {
        ...base,
        state: "rejected",
        message:
          "Reader refused this link, so it isn't in Reader. If you ask me again, I'll send it as a fresh request.",
      };
    return {
      ...base,
      state: "pending",
      category: r?.category,
      retryAfterSeconds: r?.retryAfterSeconds,
      message:
        r?.category === "auth"
          ? "Reader rejected Chief's connection, so the save isn't confirmed. Reconnect Reader, then ask me again."
          : r?.category === "capacity"
            ? `Reader is rate-limiting Chief; ask me again in about ${r.retryAfterSeconds ?? 60} seconds.`
            : "Couldn't confirm the Reader save yet; ask me again to settle it safely with the same request.",
    };
  }

  /** The canonical link a link_save or link_move call names, or undefined. */
  private async linkOf(user: string, input: unknown) {
    const op = (input as any)?.operation;
    try {
      if (op === "link_save") return canonicalUrl(linkSave.parse(input).url);
      if (op === "link_move") {
        const m = linkMove.parse(input);
        if (m.url) return canonicalUrl(m.url);
        const url = (
          await this.db.query(
            "SELECT url FROM study_resources WHERE id=$1 AND user_id=$2",
            [m.id, user],
          )
        ).rows[0]?.url;
        return typeof url === "string" ? url : undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /**
   * Whether this call is a retry of the same link that every uncertain write is about. A
   * link save is idempotent by link: the study list has one row per link, and a Reader save
   * is recorded before it is sent, so a repeat finds and reuses it. Vacuously true with no
   * uncertain writes.
   */
  async retriesUncertain(
    user: string,
    input: unknown,
    uncertain: { operation: string; arguments: any }[],
  ) {
    const url = await this.linkOf(user, input);
    if (!url) return false;
    for (const call of uncertain) {
      if (call.operation !== "link_save" && call.operation !== "link_move")
        return false;
      let prior: unknown;
      try {
        prior = {
          ...JSON.parse(call.arguments?.raw ?? ""),
          operation: call.operation,
        };
      } catch {
        return false;
      }
      if ((await this.linkOf(user, prior)) !== url) return false;
    }
    return true;
  }

  /**
   * After a later save of the same link, an earlier uncertain link_save/link_move of it in a
   * stopped run is settled: its only effects (a study list row, a recorded Reader save) are
   * now durable and inspectable, unless a Reader save of the link is still pending.
   */
  private async settleUncertain(user: string, url: string, urls: string[]) {
    const pending = (
      await this.db.query(
        `SELECT 1 FROM mcp_operations o WHERE o.user_id=$1 AND o.connection='reader' AND o.state='pending'
           AND (COALESCE(o.source_payload,o.payload)->>'url'=ANY($2::text[])
             OR EXISTS (SELECT 1 FROM link_reader_keys k WHERE k.user_id=o.user_id AND k.request_key=o.request_key AND k.url=ANY($2::text[])))`,
        [user, [...new Set([url, ...urls])]],
      )
    ).rows.length;
    if (pending) return;
    const calls = (
      await this.db.query(
        "SELECT c.id,c.operation,c.arguments FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.user_id=$1 AND r.state='stopped' AND c.operation IN ('link_save','link_move') AND c.state='uncertain'",
        [user],
      )
    ).rows;
    for (const call of calls) {
      let prior: unknown;
      try {
        prior = {
          ...JSON.parse(call.arguments?.raw ?? ""),
          operation: call.operation,
        };
      } catch {
        continue;
      }
      if ((await this.linkOf(user, prior)) !== url) continue;
      await this.db.query(
        "UPDATE runtime_calls SET state='success',finished_at=now(),result=COALESCE(result,'{}'::jsonb) || jsonb_build_object('reconciliation','settled by a later save of the same link') WHERE id=$1 AND state='uncertain'",
        [call.id],
      );
    }
  }

  /**
   * Agent-boundary exception to the "pending MCP write blocks every write" rule: a link_save
   * or link_move of the very link whose Reader save is pending is the genuine retry that
   * settles it, so it may run. Anything else stays blocked.
   */
  async retriesPending(user: string, input: unknown) {
    const op = (input as any)?.operation;
    if (op === "link_move" && (input as any)?.to !== "reader") return false;
    const url = await this.linkOf(user, input);
    if (!url) return false;
    // The pending save matches by its payload URL or by any recorded form of the link, so a
    // link that redirected (twitter.com to x.com) is still recognised as the same retry.
    const pending = (
      await this.db.query(
        `SELECT o.connection,o.tool,COALESCE(o.source_payload,o.payload)->>'url' AS url,
           EXISTS (SELECT 1 FROM link_reader_keys k WHERE k.user_id=o.user_id AND k.request_key=o.request_key AND k.url=$2) AS alias
         FROM mcp_operations o WHERE o.user_id=$1 AND o.state='pending'`,
        [user, url],
      )
    ).rows;
    return (
      pending.length > 0 &&
      pending.every(
        (p) =>
          p.connection === "reader" &&
          p.tool === "save_link" &&
          (p.url === url || p.alias === true),
      )
    );
  }

  private async find(user: string, id?: string, url?: string) {
    if (!id && !url)
      throw new ToolValidationError("Give the study list entry id or its link");
    const urls = url ? [canonicalUrl(url)] : [];
    return (
      await this.db.query(
        "SELECT * FROM study_resources WHERE user_id=$1 AND (id=$2::uuid OR url=ANY($3::text[])) LIMIT 1",
        [user, id ?? null, urls],
      )
    ).rows[0] as Row | undefined;
  }

  private async move(
    user: string,
    input: Extract<LinkAction, { operation: "link_move" }>,
    signal?: AbortSignal,
  ) {
    const a = linkMove.parse(input);
    if (a.to === "reader") {
      const entry = await this.find(user, a.id, a.url);
      if (!entry) {
        if (!a.url) throw new ToolValidationError("Study list entry not found");
        const reader = await this.readerSave(user, [a.url], signal);
        return { moved: false, reader, where: reader.message };
      }
      const reader = await this.readerSave(user, [entry.url], signal);
      // Nothing is removed from the study list until Reader has confirmed the save.
      if (reader.state !== "complete")
        return {
          moved: false,
          kept: compact(entry),
          reader,
          where: `${reader.message} It stays on your study list for now.`,
        };
      const removed = (
        await this.db.query(
          "DELETE FROM study_resources WHERE id=$1 AND user_id=$2 RETURNING id",
          [entry.id, user],
        )
      ).rows.length;
      await this.settleUncertain(user, entry.url, []).catch((error) =>
        opsLog("links.settle_failed", "warn", errorFields(error)),
      );
      return {
        moved: true,
        reader,
        removedFromStudyList: removed > 0,
        where: `Moved to Reader for offline reading${reader.already ? " (it was already there)" : ""} and took it off your study list.`,
      };
    }
    if (!a.url) {
      const entry = a.id ? await this.find(user, a.id) : undefined;
      if (entry)
        return {
          moved: false,
          entry: compact(entry),
          where: "It's already on your study list.",
        };
      throw new ToolValidationError(
        "Give the link to move it from Reader to the study list",
      );
    }
    const page = await this.page(user, a.url, undefined, signal);
    const study = await this.addStudy(user, page, {
      reason: "You moved it from Reader.",
      confidence: 1,
      by: "owner",
      topic: null,
    });
    return {
      moved: !study.duplicate,
      entry: compact(study.entry),
      where: study.duplicate
        ? "It's already on your study list. Chief can't delete from Reader, so remove it there if you don't want it in both."
        : "Added to your study list. Chief can't delete from Reader, so remove it there if you don't want it in both.",
    };
  }

  private async list(
    user: string,
    a: Extract<LinkAction, { operation: "study_list" }>,
  ) {
    const like = a.topic
      ? "%" + a.topic.replace(/[\\%_]/g, (c) => "\\" + c) + "%"
      : null;
    const where = `user_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR topic ILIKE $3 OR title ILIKE $3)
      AND ($4::text IS NULL OR $4=ANY(tags))`;
    const params = [user, a.status ?? null, like, a.tag ?? null];
    const rows = (
      await this.db.query(
        `SELECT * FROM study_resources WHERE ${where} ORDER BY added_at DESC,id LIMIT $5 OFFSET $6`,
        [...params, a.limit + 1, a.offset],
      )
    ).rows;
    const counts = Object.fromEntries(
      (
        await this.db.query(
          `SELECT status,count(*)::int AS n FROM study_resources WHERE ${where} GROUP BY status`,
          params,
        )
      ).rows.map((r) => [r.status, r.n]),
    );
    return {
      entries: rows.slice(0, a.limit).map(compact),
      counts,
      nextOffset: rows.length > a.limit ? a.offset + a.limit : null,
      presentation:
        "Reply as a short phone list grouped by status: title, site, topic. No tables.",
    };
  }

  private async update(
    user: string,
    a: Extract<LinkAction, { operation: "study_update" }>,
  ) {
    if (
      a.status === undefined &&
      a.notes === undefined &&
      a.tags === undefined &&
      a.topic === undefined
    )
      throw new ToolValidationError("Nothing to update");
    const row = (
      await this.db.query(
        `UPDATE study_resources SET status=COALESCE($3,status),
           notes=CASE WHEN $4::boolean THEN $5 ELSE notes END,
           tags=COALESCE($6::text[],tags),topic=COALESCE($7,topic),updated_at=now()
         WHERE id=$1 AND user_id=$2 RETURNING *`,
        [
          a.id,
          user,
          a.status ?? null,
          a.notes !== undefined,
          a.notes ?? null,
          a.tags ? [...new Set(a.tags)] : null,
          a.topic ?? null,
        ],
      )
    ).rows[0];
    if (!row) throw new ToolValidationError("Study list entry not found");
    return { entry: compact(row) };
  }

  private async remove(user: string, id: string) {
    const row = (
      await this.db.query(
        "DELETE FROM study_resources WHERE id=$1 AND user_id=$2 RETURNING *",
        [id, user],
      )
    ).rows[0];
    if (!row) throw new ToolValidationError("Study list entry not found");
    return {
      removed: true,
      entry: compact(row),
      where: `Removed "${row.title ?? hostOf(row.url)}" from your study list.`,
    };
  }

  /**
   * Applies the owner's tap on a link-choice card. The row is claimed with a lease so two
   * taps cannot both run; each write is recorded before and after it happens, so a failure
   * part-way says what may have been saved. A result that is not final reopens the card.
   */
  async applyChoice(
    user: string,
    id: string,
    choice: "study" | "reader" | "both",
    signal?: AbortSignal,
  ): Promise<{ final: boolean; message: string; claimed: boolean }> {
    const claimed = (
      await this.db.query(
        `UPDATE link_choices SET state='applying',claimed_at=now(),choice=$3
         WHERE id=$1 AND user_id=$2 AND (state='open' OR (state='applying' AND claimed_at < now()-${LEASE}))
         RETURNING *`,
        [id, user, choice],
      )
    ).rows[0];
    if (!claimed) {
      const row = (
        await this.db.query(
          "SELECT state,outcome FROM link_choices WHERE id=$1 AND user_id=$2",
          [id, user],
        )
      ).rows[0];
      if (!row)
        return {
          final: true,
          claimed: false,
          message: "That link choice is no longer available.",
        };
      return row.state === "done"
        ? {
            final: true,
            claimed: false,
            message: row.outcome ?? "Already saved.",
          }
        : {
            final: false,
            claimed: false,
            message:
              "Already saving this one; give it a moment, then tap again if nothing changes.",
          };
    }
    const page = claimed.page as PageFacts & {
      tags?: string[];
      notes?: string;
    };
    const classification = claimed.classification as Classification;
    // What may have been written, for an honest message if anything fails part-way.
    let study: "none" | "maybe" | "saved" = claimed.study_written
      ? "saved"
      : "none";
    // An earlier tap's Reader save counts too: it may still be unconfirmed (pending, or
    // interrupted while sending) even if this tap does not ask for Reader.
    const UNCONFIRMED = ["sending", "pending", "uncertain"];
    let reader: "none" | "maybe" | "saved" =
      claimed.reader_state === "complete"
        ? "saved"
        : UNCONFIRMED.includes(claimed.reader_state)
          ? "maybe"
          : "none";
    const parts: string[] = [];
    let final = true;
    try {
      if (choice === "study" || choice === "both") {
        if (study === "none") study = "maybe";
        const added = await this.addStudy(
          user,
          { ...page, url: claimed.url },
          {
            reason: `You chose the study list. ${classification.reason}`.slice(
              0,
              500,
            ),
            confidence: 1,
            by: "owner",
            topic: classification.topic,
          },
          page.tags,
          page.notes,
        );
        study = "saved";
        await this.db.query(
          "UPDATE link_choices SET study_written=true WHERE id=$1 AND user_id=$2",
          [id, user],
        );
        parts.push(
          added.duplicate && !claimed.study_written
            ? "It was already on your study list."
            : `Saved to your study list${classification.topic ? ` (${classification.topic})` : ""}.`,
        );
      } else if (claimed.study_written)
        parts.push(
          "The study list entry from your earlier tap stays; ask me to remove it if you don't want it there.",
        );
      if (choice === "study" && reader !== "none") {
        // The owner switched to the study list after a Reader tap. Say what happened to that
        // save; an unconfirmed one keeps the card open, since only its own retry settles it.
        const op = (
          await this.db.query(
            "SELECT state FROM mcp_operations WHERE user_id=$1 AND connection='reader' AND request_key=$2",
            [user, claimed.reader_key],
          )
        ).rows[0];
        if (op?.state === "complete" || reader === "saved")
          parts.push(
            "Your earlier Reader save went through, so it's in Reader too; Chief can't delete from Reader, so remove it there if you want.",
          );
        else if (op?.state === "rejected")
          parts.push(
            "Reader refused your earlier save, so it isn't in Reader.",
          );
        else if (op?.state === "pending" || !op) {
          parts.push(
            "Your earlier Reader save of this link is still unconfirmed and holds up other Reader saves; tap Reader or Both to settle it with the same request.",
          );
          final = false;
        }
      }
      if (choice === "reader" || choice === "both") {
        const outcome = await this.readerSave(
          user,
          [claimed.url],
          signal,
          claimed.reader_key,
          async (key) => {
            await this.db.query(
              "UPDATE link_choices SET reader_key=$3,reader_state='sending' WHERE id=$1 AND user_id=$2",
              [id, user, key],
            );
            reader = "maybe";
          },
        );
        if (outcome.state === "complete") reader = "saved";
        await this.db.query(
          "UPDATE link_choices SET reader_state=$3 WHERE id=$1 AND user_id=$2",
          [id, user, outcome.state],
        );
        if (outcome.earlierPending)
          parts.push(
            "An earlier Reader save of this link was still pending, so I retried that same request.",
          );
        parts.push(outcome.message ?? "");
        if (
          !["complete", "rejected", "refused", "unavailable"].includes(
            outcome.state,
          )
        )
          final = false;
      }
      const message = parts.filter(Boolean).join(" ");
      if (final)
        await this.db.query(
          "UPDATE link_choices SET state='done',outcome=$3 WHERE id=$1 AND user_id=$2",
          [id, user, message],
        );
      else
        await this.db.query(
          "UPDATE link_choices SET state='open',claimed_at=NULL,outcome=$3 WHERE id=$1 AND user_id=$2 AND state='applying'",
          [id, user, message],
        );
      return {
        final,
        claimed: true,
        message: final ? message : `${message} Tap again to retry safely.`,
      };
    } catch (error) {
      opsLog("links.choice_failed", "warn", errorFields(error));
      const what = [
        study === "saved"
          ? "your study list entry was saved"
          : study === "maybe"
            ? "your study list entry may have been saved"
            : null,
        reader === "saved"
          ? "the Reader save went through"
          : reader === "maybe"
            ? "the Reader save may or may not have gone through"
            : null,
      ].filter(Boolean);
      let reopened = false;
      try {
        reopened =
          (
            await this.db.query(
              "UPDATE link_choices SET state='open',claimed_at=NULL WHERE id=$1 AND user_id=$2 AND state='applying' RETURNING id",
              [id, user],
            )
          ).rows.length > 0;
      } catch (reopenError) {
        // The two-minute claim lease still lets a later tap take the card.
        opsLog("links.choice_reopen_failed", "warn", errorFields(reopenError));
      }
      return {
        final: false,
        claimed: true,
        message:
          (what.length
            ? `Result uncertain: ${what.join("; ")}.`
            : "Couldn't finish saving this link, and nothing was confirmed as saved.") +
          (reopened
            ? " Tap a button again to settle it safely."
            : " Tap a button again in two minutes to settle it safely."),
      };
    }
  }
}

function whereLine(
  target: "study" | "reader" | "both",
  topic: string | null,
  study?: { duplicate: boolean; entry: Row },
  reader?: ReaderOutcome,
) {
  const studyText = study
    ? study.duplicate
      ? `It's already on your study list (added ${String(
          study.entry.added_at instanceof Date
            ? study.entry.added_at.toISOString()
            : study.entry.added_at,
        ).slice(
          0,
          10,
        )}, ${STATUS_LABEL[study.entry.status] ?? study.entry.status}).`
      : `Saved to your study list${topic ? ` (${topic})` : ""}.`
    : "";
  const readerText = reader
    ? (reader.earlierPending
        ? "An earlier Reader save of this link was still pending, so I retried that same request. "
        : "") + (reader.message ?? "")
    : "";
  const correction =
    target === "study"
      ? ' Say "move it to Reader" to change.'
      : target === "reader" && reader?.state === "complete"
        ? ' Say "move it to my study list" to change.'
        : "";
  return [studyText, readerText].filter(Boolean).join(" ") + correction;
}

/** Text and buttons of a link-choice card. */
export function choiceCard(row: Row) {
  const page = row.page as PageFacts;
  const label = page.title ?? page.site ?? row.url;
  return {
    text: `Where should this go?\n${label}\n${(row.classification as Classification).reason}`,
    buttons: [
      [
        { text: "Study list", callback_data: `lk:${row.id}:s` },
        { text: "Reader", callback_data: `lk:${row.id}:r` },
        { text: "Both", callback_data: `lk:${row.id}:b` },
      ],
    ],
  };
}
