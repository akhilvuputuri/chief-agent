BEGIN;
-- Google connections made from the Telegram chat (docs/google-integrations.md). Additive; the
-- feature stays off until GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are set. Refresh
-- tokens are sealed (src/secret-box.ts). Separate from the brokerage tables, whose provider
-- columns only allow 'ibkr'.
CREATE TABLE IF NOT EXISTS google_oauth_attempts (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 account text NOT NULL CHECK(account IN ('gmail','gmail_secondary','calendar','sheets')),
 state_hash text NOT NULL UNIQUE CHECK(state_hash ~ '^[0-9a-f]{64}$'),
 verifier_box bytea NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','used','expired','failed')),
 error_code text CHECK(error_code IS NULL OR length(error_code)<=80),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS google_oauth_attempts_owner ON google_oauth_attempts(user_id,created_at DESC);
-- One row per connection. A 'disconnected' row without a token also records a broken .env
-- token, so the owner is told once.
CREATE TABLE IF NOT EXISTS google_connections (
 account text PRIMARY KEY CHECK(account IN ('gmail','gmail_secondary','calendar','sheets')),
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN ('connected','disconnected')),
 email text CHECK(email IS NULL OR length(email) BETWEEN 3 AND 254),
 scopes text[] NOT NULL DEFAULT '{}',
 token_box bytea,
 last_error_code text CHECK(last_error_code IS NULL OR length(last_error_code)<=80),
 disconnect_notified_at timestamptz,
 connected_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((state='connected') = (token_box IS NOT NULL))
);
INSERT INTO runtime_migrations(version) VALUES(37) ON CONFLICT DO NOTHING;
COMMIT;
