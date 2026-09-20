import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.js";
import { ToolValidationError } from "./tool-errors.js";
import {
  parcelCandidate,
  parcelData,
  parcelSource,
  type ParcelAction,
  type ParcelCandidate,
  type ParcelData,
  type ParcelSource,
} from "./parcel-schema.js";

const provenance = z.record(
  z.object({
    evidenceId: z.string().uuid(),
    assertedAt: z.string().nullable(),
    protected: z.boolean(),
    quote: z.string(),
  }),
);
const rowSchema = z.object({
  id: z.string(),
  revision: z.number(),
  data: parcelData,
  provenance,
  delivery_basis: z.enum(["unknown", "reported", "user_confirmed"]),
  disputed: z.boolean(),
  archived_at: z.coerce.date().nullable(),
});
type Parcel = z.infer<typeof rowSchema>;
type Mode = "update" | "correct" | "confirm" | "dispute" | "archive" | "reopen";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = (message: string): never => {
  throw new ToolValidationError("Parcel: " + message);
};
const equal = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.trim() === b.trim();
const progression: Partial<Record<ParcelData["status"], number>> = {
  ordered: 1,
  label_created: 2,
  shipped: 3,
  in_transit: 4,
  out_for_delivery: 5,
  available_for_pickup: 5,
  delivered: 6,
};

export async function parcelForeground(
  db: Database,
  user: string,
  run: string,
) {
  const scope = (
    await db.query(
      `SELECT w.background,EXISTS(SELECT 1 FROM events e WHERE e.user_id=$1 AND e.run_id=$2 AND e.type='research.child_started') AS child
     FROM work_turns w WHERE w.user_id=$1 AND w.run_id=$2`,
      [user, run],
    )
  ).rows[0];
  if (!scope || scope.background || scope.child)
    invalid("only an on-demand owner request may change or research parcels");
}

export async function parcelUserSource(
  db: Database,
  user: string,
  run: string,
  quote: string,
  inputId?: string,
): Promise<ParcelSource> {
  const input = (
    await db.query(
      `SELECT id,message,received_at FROM conversation_inputs
     WHERE user_id=$1 AND run_id=$2 AND state IN ('running','completed')
       AND ($3::uuid IS NULL OR id=$3) ORDER BY ordinal DESC LIMIT 1`,
      [user, run, inputId ?? null],
    )
  ).rows[0];
  if (!input || !String(input.message).includes(quote))
    invalid("quote the current authenticated user input exactly");
  return {
    kind: "user",
    key: input.id,
    inputId: input.id,
    text: input.message,
    assertedAt: new Date(input.received_at).toISOString(),
    observedAt: new Date().toISOString(),
    originRun: run,
  };
}

export class Parcels {
  constructor(private db: Database) {}

  async evidence(user: string, source: ParcelSource) {
    const parsed = parcelSource.parse(source);
    const hash = digest({ text: parsed.text, assertedAt: parsed.assertedAt });
    const saved = (
      await this.db.query(
        `INSERT INTO parcel_evidence(id,user_id,kind,source_key,content_hash,source)
       VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(user_id,kind,source_key,content_hash) DO NOTHING RETURNING id`,
        [
          randomUUID(),
          user,
          parsed.kind,
          parsed.key,
          hash,
          JSON.stringify(parsed),
        ],
      )
    ).rows[0];
    if (saved) return String(saved.id);
    return String(
      (
        await this.db.query(
          "SELECT id FROM parcel_evidence WHERE user_id=$1 AND kind=$2 AND source_key=$3 AND content_hash=$4",
          [user, parsed.kind, parsed.key, hash],
        )
      ).rows[0].id,
    );
  }

  validate(candidate: ParcelCandidate, source: ParcelSource) {
    const patch: Record<string, string | null> = {};
    for (const claim of candidate.claims) {
      if (!source.text.includes(claim.quote))
        invalid("each fact needs an exact source quotation");
      patch[claim.field] = claim.value;
    }
    parcelData.parse({
      ...patch,
      ...(patch.status === null ? { status: "unknown" } : {}),
    });
    if (
      candidate.effectiveAt &&
      Date.parse(candidate.effectiveAt) > Date.now() + 300000
    )
      invalid("an event time cannot be in the future");
    if (
      patch.etaStart &&
      patch.etaEnd &&
      Date.parse(patch.etaStart) > Date.parse(patch.etaEnd)
    )
      invalid("ETA range must be ordered");
    if (
      source.kind === "gmail" &&
      candidate.effectiveAt &&
      (!candidate.effectiveAtQuote ||
        !source.text.includes(candidate.effectiveAtQuote))
    )
      invalid("an email event time needs an exact source quotation");
    if (
      source.kind === "gmail" &&
      candidate.claims.some((c) => c.value === null)
    )
      invalid("missing email facts do not clear saved fields");
  }

  async propose(
    user: string,
    run: string,
    source: ParcelSource,
    candidate: ParcelCandidate,
  ) {
    this.validate(candidate, source);
    const evidence = await this.evidence(user, source);
    const fingerprint = digest({ key: source.key, candidate });
    const old = (
      await this.db.query(
        "SELECT id FROM parcel_events WHERE user_id=$1 AND kind='proposal' AND fingerprint=$2 ORDER BY created_at LIMIT 1",
        [user, fingerprint],
      )
    ).rows[0];
    if (old) return String(old.id);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO parcel_events(id,user_id,evidence_id,run_id,kind,fingerprint,data)
       VALUES($1,$2,$3,$4,'proposal',$5,$6::jsonb)`,
      [id, user, evidence, run, fingerprint, JSON.stringify(candidate)],
    );
    return id;
  }

  async call(user: string, run: string, a: ParcelAction): Promise<unknown> {
    if (a.operation === "parcel_list") {
      const rows = (
        await this.db.query(
          `SELECT id,revision,data,provenance->'status' AS status_source,delivery_basis,disputed,archived_at,updated_at FROM parcels WHERE user_id=$1
         AND ($2='all' OR ($2='archived' AND archived_at IS NOT NULL) OR ($2 IN ('waiting','active') AND archived_at IS NULL))
         AND ($2<>'waiting' OR data->>'status' NOT IN ('delivered','returned','cancelled') OR disputed)
         ORDER BY updated_at DESC,id LIMIT 21 OFFSET $3`,
          [user, a.filter, a.offset],
        )
      ).rows;
      return {
        items: rows.slice(0, 20),
        nextOffset: rows.length > 20 ? a.offset + 20 : null,
        notice:
          "Saved last-known status. No mailbox or carrier verification was performed.",
      };
    }
    if (a.operation === "parcel_read") {
      const parcel = await this.read(user, a.id);
      const history = (
        await this.db.query(
          `SELECT e.id,e.kind,e.data,e.created_at,s.kind AS source_kind,
          s.source - 'text' AS source FROM parcel_events e JOIN parcel_evidence s ON s.user_id=e.user_id AND s.id=e.evidence_id
          WHERE e.user_id=$1 AND e.parcel_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 21 OFFSET $3`,
          [user, a.id, a.offset],
        )
      ).rows;
      return {
        ...parcel,
        history: history.slice(0, 20),
        nextOffset: history.length > 20 ? a.offset + 20 : null,
      };
    }
    await parcelForeground(this.db, user, run);
    const hash = digest(a);
    const replay = await this.replay(user, a.requestKey, hash);
    if (replay) return replay;
    let source: ParcelSource, candidate: ParcelCandidate;
    let selection: ParcelSource | undefined;
    const mode: Mode = a.operation === "parcel_save" ? a.mode : "update";
    if (a.operation === "parcel_save") {
      source = await parcelUserSource(this.db, user, run, a.quote, a.inputId);
      candidate = { claims: a.claims, effectiveAt: source.assertedAt };
    } else {
      const proposal = (
        await this.db.query(
          `SELECT e.data,s.source FROM parcel_events e JOIN parcel_evidence s ON s.user_id=e.user_id AND s.id=e.evidence_id
         WHERE e.user_id=$1 AND e.id=$2 AND e.kind='proposal'`,
          [user, a.proposalId],
        )
      ).rows[0];
      if (!proposal) invalid("proposal not found");
      source = parcelSource.parse(proposal.source);
      candidate = parcelCandidate.parse(proposal.data);
      if (source.kind !== "gmail") invalid("email proposal required");
      if (a.selectionQuote)
        selection = await parcelUserSource(
          this.db,
          user,
          run,
          a.selectionQuote,
        );
    }
    this.validate(candidate, source);
    if (mode !== "update" && !a.id)
      invalid("select the parcel to correct, confirm or archive");
    if (a.id && !a.baseRevision)
      invalid("read the parcel and supply its baseRevision");
    if (!candidate.claims.length && mode === "update")
      invalid("provide supported parcel facts");
    await this.db.query(
      "INSERT INTO parcel_owners(user_id) VALUES($1) ON CONFLICT DO NOTHING",
      [user],
    );
    const ownerRevision = Number(
      (
        await this.db.query(
          "SELECT revision FROM parcel_owners WHERE user_id=$1",
          [user],
        )
      ).rows[0].revision,
    );
    const evidenceId = await this.evidence(user, source);
    const fingerprint = digest({
      key: source.key,
      mode,
      target: source.kind === "user" ? (a.id ?? null) : null,
      claims: [...candidate.claims].sort((x, y) =>
        x.field.localeCompare(y.field),
      ),
    });
    const duplicate = (
      await this.db.query(
        `SELECT parcel_id FROM parcel_events WHERE user_id=$1 AND fingerprint=$2
       AND kind='applied' ORDER BY created_at LIMIT 1`,
        [user, fingerprint],
      )
    ).rows[0];
    if (duplicate) {
      const current = await this.read(
        user,
        z.string().uuid().parse(duplicate.parcel_id),
      );
      const result = {
        outcome: "duplicate",
        id: current.id,
        revision: current.revision,
        data: current.data,
        deliveryBasis: current.delivery_basis,
        disputed: current.disputed,
        archivedAt: current.archived_at?.toISOString() ?? null,
        decisions: {},
        replayed: true,
      };
      await this.db.query(
        `WITH saved AS (
          INSERT INTO parcel_requests(user_id,request_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)
          ON CONFLICT DO NOTHING RETURNING user_id
        ), recorded AS (
          INSERT INTO parcel_events(id,user_id,parcel_id,evidence_id,run_id,kind,fingerprint,data)
          SELECT $5::uuid,user_id,$6::uuid,$7::uuid,$8::uuid,'duplicate',$9,$4::jsonb FROM saved
        )
        INSERT INTO events(user_id,run_id,type,data) SELECT user_id,$8::uuid,'parcel.decision',
          jsonb_build_object('version',1,'eventId',$5::text,'parcelId',$6::text,'outcome','duplicate') FROM saved`,
        [
          user,
          a.requestKey,
          hash,
          JSON.stringify(result),
          randomUUID(),
          result.id,
          evidenceId,
          run,
          fingerprint,
        ],
      );
      return this.replay(user, a.requestKey, hash);
    }
    const all = (
      await this.db.query("SELECT * FROM parcels WHERE user_id=$1", [user])
    ).rows.map((r) => rowSchema.parse(r));
    const incoming = parcelData.parse(
      Object.fromEntries(
        candidate.claims.map((c) => [
          c.field,
          c.field === "status" && c.value === null ? "unknown" : c.value,
        ]),
      ),
    );
    let target = a.id ? all.find((p) => p.id === a.id) : undefined;
    if (a.id && !target) invalid("parcel not found");
    const exact = all.filter(
      (p) =>
        equal(p.data.trackingReference, incoming.trackingReference) &&
        !!p.data.carrier &&
        !!incoming.carrier &&
        p.data.carrier.toLowerCase().trim() ===
          incoming.carrier.toLowerCase().trim(),
    );
    const possible = all.filter(
      (p) =>
        equal(p.data.trackingReference, incoming.trackingReference) ||
        ((!incoming.trackingReference || !p.data.trackingReference) &&
          equal(p.data.orderReference, incoming.orderReference) &&
          !!incoming.merchant &&
          p.data.merchant?.toLowerCase() === incoming.merchant.toLowerCase()) ||
        ((!incoming.trackingReference || !p.data.trackingReference) &&
          !!incoming.label &&
          p.data.label?.toLowerCase() === incoming.label.toLowerCase()),
    );
    const priorSources = (
      await this.db.query(
        `SELECT DISTINCT parcel_id FROM parcel_events e JOIN parcel_evidence s ON s.user_id=e.user_id AND s.id=e.evidence_id
       WHERE e.user_id=$1 AND s.source_key=$2 AND s.kind=$3 AND parcel_id IS NOT NULL`,
        [user, source.key, source.kind],
      )
    ).rows.map((r) => String(r.parcel_id));
    const candidates = all.filter(
      (p) =>
        possible.includes(p) ||
        ((!incoming.trackingReference || !p.data.trackingReference) &&
          priorSources.includes(p.id)),
    );
    if (!target && exact.length === 1 && !exact[0]!.archived_at)
      target = exact[0];
    let decision = "applied";
    if (!target && (candidates.length || exact.length)) decision = "ambiguous";
    if (target && a.baseRevision && target.revision !== a.baseRevision)
      invalid("revision conflict; read the parcel again");
    if (target && source.kind === "gmail") {
      if (target.archived_at) decision = "archived_ignored";
      else if ((!exact.includes(target) || exact.length !== 1) && !selection)
        decision = "ambiguous";
      else if (
        incoming.trackingReference &&
        target.data.trackingReference &&
        !equal(incoming.trackingReference, target.data.trackingReference)
      )
        decision = "conflict";
    }
    if (
      !target &&
      decision === "applied" &&
      !incoming.label &&
      !incoming.trackingReference
    )
      invalid("a new parcel needs a label or tracking reference");
    const id = target?.id ?? (decision === "applied" ? randomUUID() : null);
    const data = target ? { ...target.data } : parcelData.parse({});
    const prov = target ? { ...target.provenance } : {};
    const decisions: Record<string, string> = {};
    const assertedAt = candidate.effectiveAt
      ? new Date(candidate.effectiveAt).toISOString()
      : source.assertedAt;
    if (decision === "applied") {
      for (const claim of candidate.claims) {
        const value =
          claim.field === "status" && claim.value === null
            ? "unknown"
            : claim.value;
        const old = prov[claim.field];
        let reason = "applied";
        if (mode === "update" && old) {
          if (data[claim.field] === value) reason = "no_change";
          else if (old.protected) reason = "conflict";
          else if (
            value === null ||
            (claim.field === "status" && value === "unknown")
          )
            reason = "unsupported";
          else if (!assertedAt || !old.assertedAt) reason = "conflict";
          else if (assertedAt < old.assertedAt) reason = "stale";
          else if (assertedAt === old.assertedAt) reason = "conflict";
          else if (
            claim.field === "status" &&
            target?.data.status === "delivered"
          )
            reason = "conflict";
          else if (
            claim.field === "status" &&
            value !== null &&
            (progression[parcelData.shape.status.parse(value)] ?? Infinity) <
              (progression[data.status] ?? 0)
          )
            reason = "conflict";
        }
        if (
          source.kind === "gmail" &&
          ["carrier", "trackingReference", "orderReference"].includes(
            claim.field,
          ) &&
          data[claim.field] &&
          data[claim.field] !== value
        )
          reason = "conflict";
        decisions[claim.field] = reason;
        if (reason === "applied") {
          Object.assign(data, { [claim.field]: value });
          prov[claim.field] = {
            evidenceId,
            assertedAt,
            protected: mode === "correct" || mode === "confirm",
            quote: claim.quote,
          };
        }
      }
    }
    let basis = target?.delivery_basis ?? "unknown";
    let disputed = target?.disputed ?? false;
    let archived = target?.archived_at?.toISOString() ?? null;
    if (decision === "applied") {
      if (mode === "confirm") {
        data.status = "delivered";
        basis = "user_confirmed";
        disputed = false;
        prov.status = {
          evidenceId,
          assertedAt,
          protected: true,
          quote: a.operation === "parcel_save" ? a.quote : "",
        };
      } else if (mode === "dispute") disputed = true;
      else if (mode === "archive") archived = new Date().toISOString();
      else if (mode === "reopen") {
        archived = null;
        if (["delivered", "returned", "cancelled"].includes(data.status)) {
          data.status = "unknown";
          prov.status = {
            evidenceId,
            assertedAt,
            protected: true,
            quote: a.operation === "parcel_save" ? a.quote : "",
          };
        }
        basis = "unknown";
        disputed = false;
      }
      if (mode !== "confirm" && decisions.status === "applied")
        basis = data.status === "delivered" ? "reported" : "unknown";
      parcelData.parse(data);
      if (
        data.etaStart &&
        data.etaEnd &&
        Date.parse(data.etaStart) > Date.parse(data.etaEnd)
      )
        invalid("ETA range must be ordered");
      if (
        target &&
        mode === "update" &&
        !Object.values(decisions).includes("applied")
      )
        decision = Object.values(decisions).includes("conflict")
          ? "conflict"
          : Object.values(decisions).includes("stale")
            ? "stale"
            : "no_change";
    }
    const mutate = decision === "applied";
    const revision = (target?.revision ?? 0) + (mutate ? 1 : 0);
    const result = {
      outcome: decision,
      id,
      revision,
      decisions,
      ...(decision === "ambiguous"
        ? {
            candidates: candidates.map((p) => ({
              id: p.id,
              revision: p.revision,
              label: p.data.label,
              trackingReference: p.data.trackingReference,
            })),
            question:
              "Which parcel does this update describe? Confirm the target or add a distinct tracking reference.",
          }
        : {}),
      ...(mutate ? { data, deliveryBasis: basis } : {}),
    };
    const eventData = {
      candidate,
      decisions,
      result,
      ...(selection
        ? {
            selection: {
              inputId: selection.inputId,
              quote:
                a.operation === "parcel_apply" ? a.selectionQuote : undefined,
            },
          }
        : {}),
    };
    const stored = await this.db.query(
      `WITH guard AS (
        UPDATE parcel_owners SET revision=revision+1 WHERE user_id=$1 AND revision=$2 RETURNING user_id
      ), changed AS (
        INSERT INTO parcels(id,user_id,revision,data,provenance,delivery_basis,disputed,archived_at)
        SELECT $3::uuid,user_id,$4,$5::jsonb,$6::jsonb,$7,$8,$9::timestamptz FROM guard WHERE $10::boolean
        ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,data=EXCLUDED.data,provenance=EXCLUDED.provenance,
          delivery_basis=EXCLUDED.delivery_basis,disputed=EXCLUDED.disputed,archived_at=EXCLUDED.archived_at,updated_at=now()
        WHERE parcels.user_id=$1 RETURNING id
      ), recorded AS (
        INSERT INTO parcel_events(id,user_id,parcel_id,evidence_id,run_id,kind,fingerprint,data)
        SELECT $11::uuid,user_id,$3::uuid,$12::uuid,$13::uuid,$14,$15,$16::jsonb FROM guard RETURNING id
      ), traced AS (
        INSERT INTO events(user_id,run_id,type,data)
        SELECT user_id,$13::uuid,'parcel.decision',jsonb_build_object('version',1,'eventId',$11::text,'parcelId',$3::text,'outcome',$14::text,'evidenceId',$12::text) FROM guard
      )
      INSERT INTO parcel_requests(user_id,request_key,request_hash,result)
      SELECT user_id,$17::uuid,$18,$19::jsonb FROM guard RETURNING result`,
      [
        user,
        ownerRevision,
        id,
        revision,
        JSON.stringify(data),
        JSON.stringify(prov),
        basis,
        disputed,
        archived,
        mutate,
        randomUUID(),
        evidenceId,
        run,
        decision,
        fingerprint,
        JSON.stringify(eventData),
        a.requestKey,
        hash,
        JSON.stringify(result),
      ],
    );
    if (!stored.rows.length) {
      const raced = await this.replay(user, a.requestKey, hash);
      if (raced) return raced;
      invalid("concurrent update; reread the saved parcels before retrying");
    }
    return result;
  }

  private async replay(user: string, key: string, hash: string) {
    const row = (
      await this.db.query(
        "SELECT request_hash,result FROM parcel_requests WHERE user_id=$1 AND request_key=$2",
        [user, key],
      )
    ).rows[0];
    if (!row) return null;
    if (row.request_hash !== hash)
      invalid("requestKey already used for different content");
    return { ...row.result, replayed: true };
  }
  private async read(user: string, id: string): Promise<Parcel> {
    const row = (
      await this.db.query("SELECT * FROM parcels WHERE user_id=$1 AND id=$2", [
        user,
        id,
      ])
    ).rows[0];
    if (!row) invalid("parcel not found");
    return rowSchema.parse(row);
  }
}
