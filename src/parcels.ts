import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
import { ToolValidationError } from "./tool-errors.js";
import type { ParcelStatus } from "./parcel-schema.js";
export type ParcelAction = Extract<Action, { operation: `parcel_${string}` }>;
type Source = {
  sourceKind: "email" | "user";
  messageId?: string;
  threadId?: string;
  account?: string;
  sender?: string;
  subject?: string;
  observedAt?: string;
};
/**
 * Page sizes and the serialised bound. Results must stay below the 12,000-character
 * observation projection in src/observations.ts, which otherwise replaces them with a
 * bare excerpt and would drop the notice and the match verdict.
 */
export const parcelLimits = {
  historyPage: 20,
  listPage: 10,
  serialised: 11_000,
};
/** A clock-skew allowance; anything further ahead would block later real observations. */
const FUTURE_SKEW_MS = 86_400_000;
const UNVERIFIED =
  "Last known from email or from what you told me. Nothing here is checked with the carrier.";
/** Comparison key for references: case and punctuation never distinguish two tracking numbers. */
export function refKey(value: string | undefined) {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/**
 * Does a new observation replace the one currently deciding a parcel's status?
 *
 * A more recently observed fact wins outright, so today's carrier email updates a parcel
 * the owner last mentioned weeks ago. When the new observation is not newer, it wins only
 * with higher authority, which is what stops a Tuesday shipping notice from undoing the
 * owner's Thursday "this arrived" while still letting them correct a fresher email.
 */
export function decides(
  next: { authority: number; observedAt: number },
  current: { authority: number; observedAt: number } | null,
) {
  if (!current) return true;
  if (next.observedAt > current.observedAt) return true;
  return next.authority > current.authority;
}
export function ignoredReason(
  next: { authority: number; observedAt: number },
  current: { authority: number; observedAt: number },
) {
  if (next.authority < current.authority)
    return next.observedAt === current.observedAt
      ? "you told me about that same moment; recorded but not applied"
      : "you told me something more recent; recorded but not applied";
  return next.observedAt === current.observedAt
    ? "an already recorded update describes that same moment; recorded but not applied"
    : "an already recorded update describes a later moment; recorded but not applied";
}
function authorityOf(source: Source) {
  return source.sourceKind === "user" ? 2 : 1;
}
function observedAtOf(source: Source, now: number) {
  // An email must name the moment it describes; only a user statement may mean "now".
  if (
    source.sourceKind === "email" &&
    (!source.messageId || !source.observedAt)
  )
    throw new ToolValidationError(
      "Parcel validation: an email source needs messageId and the message's own Date as observedAt",
    );
  const at = source.observedAt ? Date.parse(source.observedAt) : now;
  if (!Number.isFinite(at))
    throw new ToolValidationError(
      "Parcel validation: observedAt is not a date",
    );
  // A future moment would outrank every later real observation, including the owner's.
  if (at > now + FUTURE_SKEW_MS)
    throw new ToolValidationError(
      "Parcel validation: observedAt is in the future; pass when the fact was true, never an expected delivery date",
    );
  return at;
}
function sourceRef(source: Source) {
  return source.sourceKind === "email"
    ? {
        kind: "email",
        account: source.account ?? "primary",
        messageId: source.messageId,
        ...(source.threadId ? { threadId: source.threadId } : {}),
        ...(source.sender ? { from: source.sender } : {}),
        ...(source.subject ? { subject: source.subject } : {}),
      }
    : { kind: "user" };
}
/** A concurrent write took the tracking reference between the check and the write. */
function duplicateTracking(error: unknown) {
  const e = error as { code?: string; constraint?: string; message?: string };
  return (
    String(e?.code) === "23505" &&
    /parcels_tracking/.test(String(e?.constraint ?? e?.message ?? ""))
  );
}
const TRACKING_TAKEN =
  "Parcel validation: that tracking reference was just saved on another parcel; match it and pass that parcel's id";
/** Only the one-email-per-parcel index, never some other unique violation. */
function duplicateMessage(error: unknown) {
  const e = error as { code?: string; constraint?: string; message?: string };
  return (
    String(e?.code) === "23505" &&
    /parcel_updates_message/.test(String(e?.constraint ?? e?.message ?? ""))
  );
}
/** The later of two optional timestamps, as the database returned them. */
function latest(a: unknown, b: unknown) {
  const times = [a, b].filter((t) => t !== null && t !== undefined) as (
    string | Date
  )[];
  if (!times.length) return undefined;
  return times.reduce((x, y) =>
    new Date(y).getTime() > new Date(x).getTime() ? y : x,
  );
}
function shown(row: any, brief = false) {
  return {
    id: row.id,
    label: row.label,
    merchant: row.merchant || undefined,
    carrier: row.carrier || undefined,
    trackingRef: row.tracking_ref || undefined,
    orderRef: row.order_ref || undefined,
    status: row.status as ParcelStatus,
    // Carrier wording kept verbatim when it did not map to a supported status.
    rawStatus: row.raw_status || undefined,
    statusSource: row.status_source ?? undefined,
    // The moment the status fact describes, not when it was recorded; absent when no
    // status has ever been observed.
    asOf: latest(row.observed_at, row.corroborated_at),
    eta: row.eta || undefined,
    // The delivery date keeps its own clock.
    etaAsOf: row.eta_observed_at ?? undefined,
    lastCheckedAt: row.last_checked_at ?? undefined,
    note: brief ? undefined : row.note || undefined,
    archived: !!row.archived_at,
  };
}
export class ParcelTools {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
    private limits = parcelLimits,
  ) {}
  private async owned(user: string, id: string) {
    const row = (
      await this.db.query("SELECT * FROM parcels WHERE id=$1 AND user_id=$2", [
        id,
        user,
      ])
    ).rows[0];
    if (!row) throw new ToolValidationError("Parcel not found");
    return row as any;
  }
  async call(user: string, action: ParcelAction, run?: string) {
    if (action.operation === "parcel_list")
      return action.id ? this.read(user, action) : this.list(user, action);
    if (action.operation === "parcel_match") return this.match(user, action);
    // Carrier wording describes a status; alone it would be kept in history but never
    // shown on the parcel, so require the status it qualifies (usually "unknown").
    if (action.rawStatus !== undefined && action.status === undefined)
      throw new ToolValidationError(
        'Parcel validation: rawStatus needs a status; pass status "unknown" with the carrier wording',
      );
    return action.id
      ? this.update(user, action, run)
      : this.save(user, action, run);
  }
  private async list(
    user: string,
    a: Extract<ParcelAction, { operation: "parcel_list" }>,
  ) {
    const offset = a.offset ?? 0;
    const rows = (
      await this.db.query(
        `SELECT * FROM parcels WHERE user_id=$1
           AND ($2::boolean OR archived_at IS NULL)
           AND ($3::text IS NULL OR status=$3)
         ORDER BY archived_at NULLS FIRST, updated_at DESC OFFSET $4 LIMIT $5`,
        [
          user,
          a.includeArchived ?? false,
          a.status ?? null,
          offset,
          this.limits.listPage,
        ],
      )
    ).rows;
    const total = Number(
      (
        await this.db.query(
          `SELECT count(*)::int n FROM parcels WHERE user_id=$1
             AND ($2::boolean OR archived_at IS NULL)
             AND ($3::text IS NULL OR status=$3)`,
          [user, a.includeArchived ?? false, a.status ?? null],
        )
      ).rows[0].n,
    );
    const result = {
      notice: UNVERIFIED,
      parcels: rows.map((row) => shown(row, true)),
      total,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
      detail: "Notes and full history come from parcel_list with a parcel id.",
    };
    // Keep the result under the projection limit so the notice is never replaced.
    while (
      result.parcels.length > 1 &&
      JSON.stringify(result).length > this.limits.serialised
    ) {
      result.parcels.pop();
      result.nextOffset = offset + result.parcels.length;
    }
    return result;
  }
  private async read(
    user: string,
    a: Extract<ParcelAction, { operation: "parcel_list" }>,
  ) {
    const parcel = await this.owned(user, a.id!);
    const offset = a.offset ?? 0;
    const history = (
      await this.db.query(
        `SELECT id,source_kind,source_ref,status,raw_status,eta,note,observed_at,recorded_at,deciding,status_applied,eta_applied,ignored_reason
         FROM parcel_updates WHERE parcel_id=$1 AND user_id=$2
         ORDER BY observed_at DESC,recorded_at DESC OFFSET $3 LIMIT $4`,
        [a.id!, user, offset, this.limits.historyPage],
      )
    ).rows;
    const total = Number(
      (
        await this.db.query(
          "SELECT count(*)::int n FROM parcel_updates WHERE parcel_id=$1 AND user_id=$2",
          [a.id!, user],
        )
      ).rows[0].n,
    );
    const read = {
      notice: UNVERIFIED,
      ...shown(parcel),
      history: history.map((h: any) => ({
        id: h.id,
        source: h.source_ref,
        status: h.status ?? undefined,
        rawStatus: h.raw_status || undefined,
        eta: h.eta || undefined,
        note: h.note || undefined,
        observedAt: h.observed_at,
        recordedAt: h.recorded_at,
        // applied: this observation changed the parcel in some way.
        applied: h.deciding,
        statusApplied: h.status !== null ? h.status_applied : undefined,
        etaApplied: h.eta ? h.eta_applied : undefined,
        ignoredReason: h.ignored_reason || undefined,
      })),
      totalUpdates: total,
      nextOffset:
        offset + history.length < total ? offset + history.length : null,
    };
    while (
      read.history.length > 1 &&
      JSON.stringify(read).length > this.limits.serialised
    ) {
      read.history.pop();
      read.nextOffset = offset + read.history.length;
    }
    return read;
  }
  /**
   * Host-computed candidates. A tracking reference identifies a parcel on its own; an
   * order reference plus merchant does; a merchant or label alone never does, because
   * several parcels can share them. The caller must still choose explicitly.
   */
  private async match(
    user: string,
    a: Extract<ParcelAction, { operation: "parcel_match" }>,
  ) {
    const tracking = refKey(a.trackingRef);
    const order = refKey(a.orderRef);
    const merchant = (a.merchant ?? "").trim().toLowerCase();
    const label = (a.label ?? "").trim().toLowerCase();
    if (!tracking && !order && !merchant && !label)
      throw new ToolValidationError(
        "Parcel validation: give a tracking reference, an order reference, a merchant or a label to match on",
      );
    // Decisive references are looked up directly, so a parcel outside the recent
    // window is still found; weak bases only ever scan recent active parcels.
    const rows = (
      await this.db.query(
        `SELECT * FROM parcels WHERE user_id=$1 AND (
            ($2<>'' AND tracking_key=$2) OR ($3<>'' AND order_key=$3)
            OR (archived_at IS NULL AND id IN (
              SELECT id FROM parcels WHERE user_id=$1 AND archived_at IS NULL
              ORDER BY updated_at DESC LIMIT 100))
         ) ORDER BY (($2<>'' AND tracking_key=$2) OR ($3<>'' AND order_key=$3)) DESC,
           updated_at DESC LIMIT 100`,
        [user, tracking, order],
      )
    ).rows as any[];
    const scored = rows
      .map((row) => {
        if (tracking && row.tracking_key && row.tracking_key === tracking)
          return { row, basis: "tracking reference", decisive: true };
        if (order && row.order_key && row.order_key === order) {
          const sameMerchant =
            !!merchant && row.merchant.toLowerCase() === merchant;
          return {
            row,
            basis: sameMerchant
              ? "order reference and merchant"
              : "order reference",
            decisive: sameMerchant,
          };
        }
        if (merchant && row.merchant.toLowerCase() === merchant)
          return { row, basis: "merchant only", decisive: false };
        if (label && row.label.toLowerCase().includes(label))
          return { row, basis: "label text only", decisive: false };
        return null;
      })
      .filter(Boolean) as { row: any; basis: string; decisive: boolean }[];
    // A tracking reference outranks an order reference: when one parcel holds the tracking
    // reference, a different parcel sharing only the order does not make it ambiguous.
    const byTracking = scored.filter(
      (c) => c.decisive && c.basis === "tracking reference",
    );
    const decisive = byTracking.length
      ? byTracking
      : scored.filter((c) => c.decisive);
    // Two parcels under one order stay ambiguous until a tracking reference separates them.
    const ambiguous = decisive.length !== 1;
    const result = {
      notice: UNVERIFIED,
      candidates: scored.slice(0, 10).map((c) => ({
        ...shown(c.row, true),
        matchedOn: c.basis,
        decisive: c.decisive,
      })),
      ambiguous,
      resolvedId: ambiguous ? null : decisive[0]!.row.id,
      hint: ambiguous
        ? scored.length
          ? "More than one parcel fits, or the match is not decisive. Ask which one before recording anything."
          : "No saved parcel matches. Save a new one rather than attaching this to an existing parcel."
        : undefined,
    };
    // Ambiguity and resolvedId must never be lost to a projection excerpt.
    while (
      result.candidates.length > 1 &&
      JSON.stringify(result).length > this.limits.serialised
    )
      result.candidates.pop();
    return result;
  }
  /**
   * One history row, as a column list and values. Both write paths insert it with
   * INSERT ... SELECT FROM the parcel write, so it exists only if that write did.
   */
  private history(
    id: string,
    user: string,
    a: {
      status?: ParcelStatus;
      rawStatus?: string;
      eta?: string;
      note?: string;
    },
    source: Source,
    observedAt: number,
    outcome: {
      changed: boolean;
      status: boolean;
      eta: boolean;
      ignored: string;
    },
    run?: string,
  ) {
    const row: [string, unknown, string?][] = [
      ["user_id", user],
      ["source_kind", source.sourceKind],
      ["source_ref", JSON.stringify(sourceRef(source)), "jsonb"],
      ["status", a.status ?? null],
      ["raw_status", a.rawStatus ?? ""],
      ["eta", a.eta ?? ""],
      ["note", a.note ?? ""],
      ["authority", authorityOf(source)],
      ["observed_at", new Date(observedAt).toISOString()],
      ["deciding", outcome.changed],
      ["status_applied", outcome.status],
      ["eta_applied", outcome.eta],
      ["ignored_reason", outcome.ignored],
      ["run_id", run ?? null],
    ];
    return {
      id,
      columns: row.map(([c]) => c),
      values: row.map(([, v]) => v),
      casts: row.map(([, , cast]) => cast),
    };
  }
  private insertHistory(h: ReturnType<ParcelTools["history"]>, first: number) {
    const binds = h.columns.map(
      (_, i) => `$${first + i}${h.casts[i] ? "::" + h.casts[i] : ""}`,
    );
    return `INSERT INTO parcel_updates(id,parcel_id,${h.columns.join(",")})
             SELECT '${h.id}'::uuid,p.id,${binds.join(",")} FROM p RETURNING id`;
  }
  /**
   * Creates the parcel and its first observation in one statement, so a rejected
   * observation cannot leave a parcel behind with no provenance.
   */
  private async save(
    user: string,
    a: Extract<ParcelAction, { operation: "parcel_record" }>,
    run?: string,
  ) {
    if (!a.label)
      throw new ToolValidationError(
        "Parcel validation: a new parcel needs a label; pass id to update an existing one",
      );
    if (a.archive !== undefined)
      throw new ToolValidationError(
        "Parcel validation: archive applies to a saved parcel; save it first, then archive it by id",
      );
    const tracking = refKey(a.trackingRef);
    await this.refuseDuplicateTracking(user, tracking);
    const now = this.now();
    const observedAt = observedAtOf(a, now);
    const authority = authorityOf(a);
    const stamp = new Date(observedAt).toISOString();
    // No status given means no status observation: the clock stays empty, so an older
    // shipping email can still set the status later.
    const hasStatus = a.status !== undefined;
    const id = randomUUID();
    const update = randomUUID();
    const parcel: [string, unknown][] = [
      ["id", id],
      ["user_id", user],
      ["label", a.label],
      ["merchant", a.merchant ?? ""],
      ["carrier", a.carrier ?? ""],
      ["tracking_ref", a.trackingRef ?? ""],
      ["tracking_key", tracking],
      ["order_ref", a.orderRef ?? ""],
      ["order_key", refKey(a.orderRef)],
      ["status", a.status ?? "unknown"],
      ["raw_status", hasStatus ? (a.rawStatus ?? "") : ""],
      ["status_source", hasStatus ? a.sourceKind : null],
      ["authority", hasStatus ? authority : 0],
      ["observed_at", hasStatus ? stamp : null],
      ["eta", a.eta ?? ""],
      ["eta_observed_at", a.eta ? stamp : null],
      ["eta_authority", a.eta ? authority : 0],
      [
        "last_checked_at",
        a.sourceKind === "email" ? new Date(now).toISOString() : null,
      ],
      ["note", a.note ?? ""],
      ["deciding_update_id", hasStatus ? update : null],
    ];
    const h = this.history(
      update,
      user,
      a,
      a,
      observedAt,
      { changed: true, status: hasStatus, eta: !!a.eta, ignored: "" },
      run,
    );
    let row: any;
    try {
      row = (
        await this.db.query(
          `WITH p AS (
           INSERT INTO parcels(${parcel.map(([c]) => c).join(",")})
           VALUES(${parcel.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *
         ), u AS (
           ${this.insertHistory(h, parcel.length + 1)}
         ) SELECT p.* FROM p JOIN u ON true`,
          [...parcel.map(([, v]) => v), ...h.values],
        )
      ).rows[0];
    } catch (error) {
      if (duplicateTracking(error))
        throw new ToolValidationError(TRACKING_TAKEN);
      throw error;
    }
    return { notice: UNVERIFIED, ...shown(row), created: true };
  }
  /** A decisive reference must stay decisive: two parcels may never share one. */
  private async refuseDuplicateTracking(
    user: string,
    tracking: string,
    except?: string,
  ) {
    if (!tracking) return;
    const clash = (
      await this.db.query(
        "SELECT id,archived_at FROM parcels WHERE user_id=$1 AND tracking_key=$2 AND ($3::uuid IS NULL OR id<>$3) LIMIT 1",
        [user, tracking, except ?? null],
      )
    ).rows[0] as { id: string; archived_at: string | null } | undefined;
    if (clash)
      throw new ToolValidationError(
        `Parcel validation: that tracking reference is already saved as parcel ${clash.id}${clash.archived_at ? ", which is archived; pass its id to reopen it" : "; pass its id to update it"}`,
      );
  }
  /**
   * Appends one observation. The parcel update and the history row are a single
   * statement: if the compare-and-swap matches nothing the history row is never
   * written, so history can never claim an application that did not happen and the
   * email stays available to apply on a retry.
   *
   * Three things are decided separately:
   * - status, by its own clock: newer wins, otherwise higher authority wins, and no
   *   email can move a delivery the owner confirmed back to an earlier state;
   * - delivery date, by its own clock with the same rule;
   * - details (carrier, references, note): the owner's statement always applies, while
   *   an email fills an empty field or overwrites only when its status applied.
   */
  private async update(
    user: string,
    a: Extract<ParcelAction, { operation: "parcel_record" }>,
    run?: string,
  ) {
    const parcel = await this.owned(user, a.id!);
    const now = this.now();
    const observedAt = observedAtOf(a, now);
    const authority = authorityOf(a);
    const owner = a.sourceKind === "user";
    if (!owner && a.archive !== undefined)
      throw new ToolValidationError(
        "Parcel validation: only you can archive or reopen a parcel, not an email",
      );
    const next = { authority, observedAt };
    const statusKey = parcel.observed_at
      ? {
          authority: Number(parcel.authority),
          observedAt: Math.max(
            Date.parse(parcel.observed_at),
            !owner && parcel.corroborated_at
              ? Date.parse(parcel.corroborated_at)
              : 0,
          ),
        }
      : null;
    const etaKey = parcel.eta_observed_at
      ? {
          authority: Number(parcel.eta_authority),
          observedAt: Date.parse(parcel.eta_observed_at),
        }
      : null;
    // A delivery the owner confirmed cannot be walked back by a lagging carrier email.
    // A later return is a genuine next event, so it still applies.
    const confirmedDelivered =
      parcel.status === "delivered" && parcel.status_source === "user";
    const statusBlockedByOwner =
      !owner &&
      confirmedDelivered &&
      a.status !== undefined &&
      !["delivered", "returned"].includes(a.status);
    // An email repeating a status the owner stated adds nothing, and applying it would
    // replace the owner's provenance, which is what the delivery lock is keyed on.
    const echoesOwner =
      !owner &&
      parcel.status_source === "user" &&
      a.status !== undefined &&
      a.status === parcel.status &&
      !(
        a.status === "unknown" &&
        !!a.rawStatus &&
        a.rawStatus !== parcel.raw_status
      );
    // Two different questions. Is this observation current enough to count? That decides
    // whether an email may overwrite details. Does its status change anything? An echo
    // of the owner's own status is current but changes nothing.
    const statusCurrent =
      a.status !== undefined &&
      !statusBlockedByOwner &&
      decides(next, statusKey);
    const statusApplies = statusCurrent && !echoesOwner;
    // A current echo corroborates: the owner stays the source, the moment advances.
    const corroborates = echoesOwner && statusCurrent;
    const etaApplies = a.eta !== undefined && decides(next, etaKey);

    // Details: compute final values here; the revision compare-and-swap guarantees the
    // row these were computed from is the row being written.
    const details: [string, string | undefined, string][] = [
      ["label", a.label, "label"],
      ["merchant", a.merchant, "merchant"],
      ["carrier", a.carrier, "carrier"],
      ["tracking_ref", a.trackingRef, "tracking reference"],
      ["order_ref", a.orderRef, "order reference"],
      ["note", a.note, "note"],
    ];
    const changes: [string, string][] = [];
    const changedDetails: string[] = [];
    const refusedDetails: string[] = [];
    const sameReference = (column: string, value: string) =>
      (column === "tracking_ref" && refKey(value) === parcel.tracking_key) ||
      (column === "order_ref" && refKey(value) === parcel.order_key);
    for (const [column, value, name] of details) {
      if (value === undefined || value === parcel[column]) continue;
      // Re-punctuating the same reference is cosmetic: the owner may, an email need not.
      if (value !== "" && sameReference(column, value) && !owner) continue;
      // The owner may correct or clear any detail. An email may fill an empty field, or
      // overwrite one when its own status applied, but never renames the owner's label
      // and never clears anything.
      const emailMay =
        column !== "label" &&
        value !== "" &&
        (statusCurrent || parcel[column] === "");
      if (owner || emailMay) {
        changes.push([column, value]);
        changedDetails.push(name);
        if (column === "tracking_ref")
          changes.push(["tracking_key", refKey(value)]);
        if (column === "order_ref") changes.push(["order_key", refKey(value)]);
      } else refusedDetails.push(name);
    }
    const newTracking = changes.find(([c]) => c === "tracking_key")?.[1];
    if (newTracking)
      await this.refuseDuplicateTracking(user, newTracking, a.id!);

    const losses = [
      statusBlockedByOwner
        ? "status not applied: you confirmed this parcel was delivered, and an email cannot change that"
        : echoesOwner
          ? corroborates
            ? "status unchanged: you already told me this; your confirmation stays the source, now known to hold as of this email"
            : "status not applied: you already told me this, and this email describes an earlier moment"
          : a.status !== undefined && !statusApplies && statusKey
            ? `status not applied: ${ignoredReason(next, statusKey)}`
            : "",
      a.eta !== undefined && !etaApplies && etaKey
        ? `delivery date not applied: ${ignoredReason(next, etaKey)}`
        : "",
      refusedDetails.length
        ? `${refusedDetails.join(", ")} not applied: an email only fills an empty field unless it is the most current status report, and never renames or clears`
        : "",
    ].filter(Boolean);
    const ignored = losses.join("; ");
    const archiveChanges =
      a.archive !== undefined && a.archive !== !!parcel.archived_at;
    // Carrier wording from an echo is new information; keep it without changing the source.
    const echoWording =
      echoesOwner && statusCurrent && !!a.rawStatus && !parcel.raw_status;
    if (echoWording) changedDetails.push("carrier wording");
    const changed =
      statusApplies ||
      etaApplies ||
      changes.length > 0 ||
      archiveChanges ||
      echoWording ||
      corroborates;

    const update = randomUUID();
    const stamp = new Date(observedAt).toISOString();
    const sets: string[] = ["revision=revision+1", "updated_at=now()"];
    const values: unknown[] = [a.id!, user, parcel.revision];
    const set = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column}=$${values.length}`);
    };
    for (const [column, value] of changes) set(column, value);
    if (echoWording) set("raw_status", a.rawStatus!);
    if (corroborates) set("corroborated_at", stamp);
    if (statusApplies) {
      set("status", a.status!);
      set("raw_status", a.rawStatus ?? "");
      set("status_source", a.sourceKind);
      set("authority", authority);
      set("observed_at", stamp);
      // A new status starts a new clock; earlier corroboration was of the old one.
      set("corroborated_at", null);
      // The deciding update is the one that decided the status, and only that.
      set("deciding_update_id", update);
    }
    if (etaApplies) {
      set("eta", a.eta!);
      set("eta_observed_at", stamp);
      set("eta_authority", authority);
    }
    if (!owner) set("last_checked_at", new Date(now).toISOString());
    if (archiveChanges)
      set("archived_at", a.archive ? new Date(now).toISOString() : null);
    const h = this.history(
      update,
      user,
      a,
      a,
      observedAt,
      { changed, status: statusApplies, eta: etaApplies, ignored },
      run,
    );
    const first = values.length + 1;
    values.push(...h.values);
    try {
      const updated = (
        await this.db.query(
          `WITH p AS (
             UPDATE parcels SET ${sets.join(",")}
             WHERE id=$1 AND user_id=$2 AND revision=$3 RETURNING *
           ), u AS (
             ${this.insertHistory(h, first)}
           ) SELECT p.* FROM p JOIN u ON true`,
          values,
        )
      ).rows[0] as any;
      if (!updated)
        throw new ToolValidationError(
          "Parcel changed while this update was being recorded; read it again before retrying",
        );
      return {
        notice: UNVERIFIED,
        ...shown(updated),
        applied: changed,
        ...(a.status !== undefined ? { statusApplied: statusApplies } : {}),
        ...(a.eta !== undefined ? { etaApplied: etaApplies } : {}),
        ...(changedDetails.length ? { detailsChanged: changedDetails } : {}),
        updateId: update,
        ...(ignored ? { ignoredReason: ignored } : {}),
      };
    } catch (error) {
      if (duplicateTracking(error))
        throw new ToolValidationError(TRACKING_TAKEN);
      // The same message applies once per parcel; a repeat is a no-op, not an error.
      if (duplicateMessage(error))
        return {
          notice: UNVERIFIED,
          ...shown(await this.owned(user, a.id!)),
          duplicate: true,
          applied: false,
          detail:
            "This email is already recorded against this parcel; nothing changed.",
        };
      throw error;
    }
  }
}
