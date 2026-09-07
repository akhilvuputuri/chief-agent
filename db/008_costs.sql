BEGIN;
CREATE TABLE IF NOT EXISTS provider_charges (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runtime_runs(id), provider text NOT NULL,
 estimated_usd numeric NOT NULL CHECK(estimated_usd >= 0), actual_usd numeric CHECK(actual_usd >= 0),
 usage jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_charges_run ON provider_charges(run_id);
COMMIT;
