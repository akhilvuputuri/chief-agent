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
  sender?: string;
  subject?: string;
  observedAt?: string;
};
const HISTORY_PAGE = 20;
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
  return next.authority < current.authority
    ? "you told me something more recent; recorded but not applied"
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
  return at;
}
function sourceRef(source: Source) {
  return source.sourceKind === "email"
    ? {
        kind: "email",
        messageId: source.messageId,
        ...(source.threadId ? { threadId: source.threadId } : {}),
        ...(source.sender ? { from: source.sender } : {}),
        ...(source.subject ? { subject: source.subject } : {}),
      }
    : { kind: "user" };
}
function shown(row: any) {
  return {
    id: row.id,
    label: row.label,
    merchant: row.merchant || undefined,
    carrier: row.carrier || undefined,
    trackingRef: row.tracking_ref || undefined,
    orderRef: row.order_ref || undefined,
    status: row.status as ParcelStatus,
    statusSource: row.status_source,
    // The moment the deciding fact describes, not the moment it was recorded.
    asOf: row.observed_at,
    eta: row.eta || undefined,
    lastCheckedAt: row.last_checked_at ?? undefined,
    note: row.note || undefined,
    archived: !!row.archived_at,
  };
}
export class ParcelTools {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
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
    return action.id
      ? this.update(user, action, run)
      : this.save(user, action, run);
  }
  private async list(
    user: string,
    a: Extract<ParcelAction, { operation: "parcel_list" }>,
  ) {
    const rows = (
      await this.db.query(
        `SELECT * FROM parcels WHERE user_id=$1
           AND ($2::boolean OR archived_at IS NULL)
           AND ($3::text IS NULL OR status=$3)
         ORDER BY archived_at NULLS FIRST, updated_at DESC LIMIT 50`,
        [user, a.includeArchived ?? false, a.status ?? null],
      )
    ).rows;
    return { parcels: rows.map(shown), notice: UNVERIFIED };
  }
  private async read(
    user: string,
    a: Extract<ParcelAction, { operation: "parcel_list" }>,
  ) {
    const parcel = await this.owned(user, a.id!);
    const offset = a.offset ?? 0;
    const history = (
      await this.db.query(
        `SELECT id,source_kind,source_ref,status,raw_status,eta,note,observed_at,recorded_at,deciding,ignored_reason
         FROM parcel_updates WHERE parcel_id=$1 AND user_id=$2
         ORDER BY observed_at DESC,recorded_at DESC OFFSET $3 LIMIT $4`,
        [a.id!, user, offset, HISTORY_PAGE],
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
    return {
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
        applied: h.deciding,
        ignoredReason: h.ignored_reason || undefined,
      })),
      totalUpdates: total,
      nextOffset:
        offset + history.length < total ? offset + history.length : null,
      notice: UNVERIFIED,
    };
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
    const rows = (
      await this.db.query(
        "SELECT * FROM parcels WHERE user_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 100",
        [user],
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
    const decisive = scored.filter((c) => c.decisive);
    // Two parcels under one order stay ambiguous until a tracking reference separates them.
    const ambiguous = decisive.length !== 1;
    return {
      candidates: scored.slice(0, 10).map((c) => ({
        ...shown(c.row),
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
      notice: UNVERIFIED,
    };
  }
  private async save(
    user: string,
    a: Extract<ParcelAction, { operation: "parcel_record" }>,
    run?: string,
  ) {
    if (!a.label)
      throw new ToolValidationError(
        "Parcel validation: a new parcel needs a label; pass id to update an existing one",
      );
    // Creating past an existing decisive match would silently duplicate a parcel.
    if (a.trackingRef) {
      const clash = (
        await this.db.query(
          "SELECT id FROM parcels WHERE user_id=$1 AND tracking_key=$2 LIMIT 1",
          [user, refKey(a.trackingRef)],
        )
      ).rows[0] as { id: string } | undefined;
      if (clash)
        throw new ToolValidationError(
          `Parcel validation: that tracking reference is already saved as parcel ${clash.id}; pass its id to update it`,
        );
    }
    const now = this.now();
    const observedAt = observedAtOf(a, now);
    const authority = authorityOf(a);
    const id = randomUUID();
    const row = (
      await this.db.query(
        `INSERT INTO parcels(id,user_id,label,merchant,carrier,tracking_ref,tracking_key,order_ref,order_key,
           status,status_source,authority,observed_at,eta,eta_observed_at,last_checked_at,note)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [
          id,
          user,
          a.label!,
          a.merchant ?? "",
          a.carrier ?? "",
          a.trackingRef ?? "",
          refKey(a.trackingRef),
          a.orderRef ?? "",
          refKey(a.orderRef),
          a.status ?? "unknown",
          a.sourceKind,
          authority,
          new Date(observedAt).toISOString(),
          a.eta ?? "",
          a.eta ? new Date(observedAt).toISOString() : null,
          a.sourceKind === "email" ? new Date(now).toISOString() : null,
          a.note ?? "",
        ],
      )
    ).rows[0] as any;
    const update = await this.record(
      user,
      id,
      a,
      a,
      observedAt,
      authority,
      true,
      "",
      run,
    );
    await this.db.query(
      "UPDATE parcels SET deciding_update_id=$2 WHERE id=$1",
      [id, update],
    );
    return { ...shown(row), created: true, notice: UNVERIFIED };
  }
  private async record(
    user: string,
    parcel: string,
    a: {
      status?: ParcelStatus;
      rawStatus?: string;
      eta?: string;
      note?: string;
    },
    source: Source,
    observedAt: number,
    authority: number,
    deciding: boolean,
    ignored: string,
    run?: string,
  ) {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO parcel_updates(id,parcel_id,user_id,source_kind,source_ref,status,raw_status,eta,note,
         authority,observed_at,deciding,ignored_reason,run_id)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        parcel,
        user,
        source.sourceKind,
        JSON.stringify(sourceRef(source)),
        a.status ?? null,
        a.rawStatus ?? "",
        a.eta ?? "",
        a.note ?? "",
        authority,
        new Date(observedAt).toISOString(),
        deciding,
        ignored,
        run ?? null,
      ],
    );
    return id;
  }
  private async update(
    user: string,
    a: Extract<ParcelAction, { operation: "parcel_record" }>,
    run?: string,
  ) {
    const parcel = await this.owned(user, a.id!);
    const now = this.now();
    const observedAt = observedAtOf(a, now);
    const authority = authorityOf(a);
    if (a.sourceKind === "email" && a.archive)
      throw new ToolValidationError(
        "Parcel validation: only you can archive a parcel, not an email",
      );
    const current = parcel.observed_at
      ? {
          authority: Number(parcel.authority),
          observedAt: Date.parse(parcel.observed_at),
        }
      : null;
    const next = { authority, observedAt };
    // A note-only update never moves the status, whoever it came from.
    const carriesFact = a.status !== undefined || a.eta !== undefined;
    const applies = carriesFact && decides(next, current);
    const ignored =
      carriesFact && !applies && current ? ignoredReason(next, current) : "";
    let update: string;
    try {
      update = await this.record(
        user,
        a.id!,
        a,
        a,
        observedAt,
        authority,
        applies,
        ignored,
        run,
      );
    } catch (error) {
      // The same Gmail message can only apply once; a repeat is a no-op, not an error.
      if (String((error as { code?: string }).code) === "23505")
        return {
          ...shown(await this.owned(user, a.id!)),
          duplicate: true,
          applied: false,
          detail: "This email was already recorded against this parcel.",
          notice: UNVERIFIED,
        };
      throw error;
    }
    // Identity fields fill a gap freely; they overwrite only when the update decides.
    const fill = (column: string, value: string | undefined) =>
      value === undefined ? null : { column, value, force: applies };
    const sets: string[] = [];
    const values: unknown[] = [a.id!, parcel.revision];
    const push = (fragment: string, value: unknown) => {
      values.push(value);
      sets.push(fragment.replace("$n", `$${values.length}`));
    };
    for (const field of [
      fill("carrier", a.carrier),
      fill("note", a.note),
    ].filter(Boolean) as { column: string; value: string; force: boolean }[])
      push(
        `${field.column}=CASE WHEN ${field.force ? "true" : `${field.column}=''`} THEN $n ELSE ${field.column} END`,
        field.value,
      );
    if (a.trackingRef !== undefined) {
      push(
        `tracking_ref=CASE WHEN ${applies ? "true" : "tracking_ref=''"} THEN $n ELSE tracking_ref END`,
        a.trackingRef,
      );
      push(
        `tracking_key=CASE WHEN ${applies ? "true" : "tracking_key=''"} THEN $n ELSE tracking_key END`,
        refKey(a.trackingRef),
      );
    }
    if (a.orderRef !== undefined) {
      push(
        `order_ref=CASE WHEN ${applies ? "true" : "order_ref=''"} THEN $n ELSE order_ref END`,
        a.orderRef,
      );
      push(
        `order_key=CASE WHEN ${applies ? "true" : "order_key=''"} THEN $n ELSE order_key END`,
        refKey(a.orderRef),
      );
    }
    if (applies) {
      if (a.status !== undefined) {
        push("status=$n", a.status);
        push("status_source=$n", a.sourceKind);
        push("authority=$n", authority);
      }
      push("observed_at=$n", new Date(observedAt).toISOString());
      push("deciding_update_id=$n", update);
      if (a.eta !== undefined) {
        push("eta=$n", a.eta);
        push("eta_observed_at=$n", new Date(observedAt).toISOString());
      }
    }
    if (a.sourceKind === "email")
      push("last_checked_at=$n", new Date(now).toISOString());
    if (a.archive !== undefined)
      push("archived_at=$n", a.archive ? new Date(now).toISOString() : null);
    const updated = (
      await this.db.query(
        `UPDATE parcels SET ${sets.join(",")},revision=revision+1,updated_at=now()
         WHERE id=$1 AND revision=$2 RETURNING *`,
        values,
      )
    ).rows[0] as any;
    if (!updated)
      throw new ToolValidationError(
        "Parcel changed while this update was being recorded; read it again before retrying",
      );
    return {
      ...shown(updated),
      applied: applies,
      updateId: update,
      ...(ignored ? { ignoredReason: ignored } : {}),
      notice: UNVERIFIED,
    };
  }
}
