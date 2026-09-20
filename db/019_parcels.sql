BEGIN;
CREATE TABLE IF NOT EXISTS parcel_owners (
 user_id text PRIMARY KEY REFERENCES users(id), revision integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS parcels (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), revision integer NOT NULL,
 data jsonb NOT NULL, provenance jsonb NOT NULL,
 delivery_basis text NOT NULL CHECK(delivery_basis IN ('unknown','reported','user_confirmed')),
 disputed boolean NOT NULL DEFAULT false, archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,id)
);
CREATE INDEX IF NOT EXISTS parcels_owner_state ON parcels(user_id,archived_at,(data->>'status'));
CREATE INDEX IF NOT EXISTS parcels_tracking ON parcels(user_id,(data->>'trackingReference'));
CREATE TABLE IF NOT EXISTS parcel_evidence (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('user','gmail')), source_key text NOT NULL,
 content_hash text NOT NULL, source jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,id), UNIQUE(user_id,kind,source_key,content_hash)
);
CREATE TABLE IF NOT EXISTS parcel_events (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), parcel_id uuid,
 evidence_id uuid NOT NULL, run_id uuid NOT NULL,
 kind text NOT NULL, fingerprint text NOT NULL, data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,id),
 FOREIGN KEY(user_id,parcel_id) REFERENCES parcels(user_id,id),
 FOREIGN KEY(user_id,evidence_id) REFERENCES parcel_evidence(user_id,id),
 FOREIGN KEY(user_id,run_id) REFERENCES runtime_runs(user_id,id)
);
CREATE INDEX IF NOT EXISTS parcel_events_history ON parcel_events(user_id,parcel_id,created_at,id);
CREATE INDEX IF NOT EXISTS parcel_events_fingerprint ON parcel_events(user_id,fingerprint);
CREATE TABLE IF NOT EXISTS parcel_requests (
 user_id text NOT NULL REFERENCES users(id), request_key uuid NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,request_key)
);
INSERT INTO runtime_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;
COMMIT;
