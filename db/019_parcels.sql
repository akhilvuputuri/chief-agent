BEGIN;
-- Provenance is structural: a parcel_updates row names the Gmail message it came from.
-- Message bodies are never copied here; re-read the message to see its text.
CREATE TABLE IF NOT EXISTS parcels (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
 label text NOT NULL, merchant text NOT NULL DEFAULT '', carrier text NOT NULL DEFAULT '',
 tracking_ref text NOT NULL DEFAULT '', tracking_key text NOT NULL DEFAULT '',
 order_ref text NOT NULL DEFAULT '', order_key text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'unknown' CHECK(status IN ('ordered','shipped','in_transit','out_for_delivery','delivered','delayed','returned','cancelled','unknown')),
 status_source text CHECK(status_source IN ('email','user')),
 authority integer NOT NULL DEFAULT 0, observed_at timestamptz,
 raw_status text NOT NULL DEFAULT '', corroborated_at timestamptz,
 eta text NOT NULL DEFAULT '' CHECK(eta='' OR to_char(to_date(eta,'YYYY-MM-DD'),'YYYY-MM-DD')=eta),
 eta_observed_at timestamptz, eta_authority integer NOT NULL DEFAULT 0,
 deciding_update_id uuid,
 last_checked_at timestamptz, note text NOT NULL DEFAULT '',
 archived_at timestamptz, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parcels_active ON parcels(user_id,updated_at DESC) WHERE archived_at IS NULL;
-- A tracking reference is decisive only if one parcel holds it; the database enforces
-- that, so two concurrent writes cannot both pass the host's pre-write check.
CREATE UNIQUE INDEX IF NOT EXISTS parcels_tracking ON parcels(user_id,tracking_key) WHERE tracking_key<>'';
CREATE INDEX IF NOT EXISTS parcels_order ON parcels(user_id,order_key) WHERE order_key<>'';
-- Append-only history. A correction is a new row; nothing here is ever mutated.
CREATE TABLE IF NOT EXISTS parcel_updates (
 id uuid PRIMARY KEY, parcel_id uuid NOT NULL REFERENCES parcels(id),
 user_id text NOT NULL REFERENCES users(id),
 source_kind text NOT NULL CHECK(source_kind IN ('email','user')),
 source_ref jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK(jsonb_typeof(source_ref)='object' AND octet_length(source_ref::text)<=4096),
 status text CHECK(status IN ('ordered','shipped','in_transit','out_for_delivery','delivered','delayed','returned','cancelled','unknown')),
 raw_status text NOT NULL DEFAULT '',
 eta text NOT NULL DEFAULT '' CHECK(eta='' OR to_char(to_date(eta,'YYYY-MM-DD'),'YYYY-MM-DD')=eta),
 note text NOT NULL DEFAULT '',
 authority integer NOT NULL CHECK(authority IN (1,2)),
 observed_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 deciding boolean NOT NULL DEFAULT false, status_applied boolean NOT NULL DEFAULT false,
 eta_applied boolean NOT NULL DEFAULT false, ignored_reason text NOT NULL DEFAULT '',
 run_id uuid
);
CREATE INDEX IF NOT EXISTS parcel_updates_history ON parcel_updates(parcel_id,observed_at DESC,recorded_at DESC);
-- One Gmail message applies once per parcel: a single shipment email can describe
-- two parcels of one order, but repeating it against one parcel changes nothing.
-- Message ids belong to a mailbox, so the mailbox is part of the identity.
CREATE UNIQUE INDEX IF NOT EXISTS parcel_updates_message ON parcel_updates(user_id,parcel_id,(coalesce(source_ref->>'account','primary')),(source_ref->>'messageId')) WHERE source_kind='email';
INSERT INTO runtime_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;
COMMIT;
