BEGIN;
-- Read-only brokerage holdings (issue #146). Additive; the feature stays off until
-- IBKR_PORTFOLIO=on. Tokens are sealed with IBKR_TOKEN_KEY (src/secret-box.ts).
CREATE TABLE IF NOT EXISTS brokerage_clients (
 provider text NOT NULL CHECK(provider='ibkr'),
 redirect_uri text NOT NULL CHECK(length(redirect_uri) BETWEEN 1 AND 500),
 client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 200),
 registered_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,redirect_uri)
);
CREATE TABLE IF NOT EXISTS brokerage_oauth_attempts (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider='ibkr'),
 state_hash text NOT NULL UNIQUE CHECK(state_hash ~ '^[0-9a-f]{64}$'),
 verifier_box bytea NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','used','expired','failed')),
 error_code text CHECK(error_code IS NULL OR length(error_code)<=80),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS brokerage_oauth_attempts_owner ON brokerage_oauth_attempts(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS brokerage_connections (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider='ibkr'),
 state text NOT NULL CHECK(state IN ('connected','refresh_uncertain','disconnected','revoked')),
 scopes text[] NOT NULL DEFAULT '{}',
 token_box bytea,
 key_version smallint NOT NULL DEFAULT 1,
 token_version integer NOT NULL DEFAULT 1 CHECK(token_version>0),
 access_expires_at timestamptz,
 refresh_lease_until timestamptz,
 last_refresh_at timestamptz,
 last_error_code text CHECK(last_error_code IS NULL OR length(last_error_code)<=80),
 disconnect_notified_at timestamptz,
 -- Start of the current grant; holdings synced under an earlier grant are never current.
 connected_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,provider),
 CHECK((state IN ('connected','refresh_uncertain')) = (token_box IS NOT NULL))
);
-- Each sync is an immutable snapshot. Only complete/empty syncs supersede earlier holdings;
-- a failed sync is recorded but never replaces them.
CREATE TABLE IF NOT EXISTS portfolio_syncs (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider='ibkr'),
 reason text NOT NULL CHECK(reason IN ('connect','schedule','owner','read')),
 status text NOT NULL CHECK(status IN ('running','complete','empty','failed')),
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 position_count integer CHECK(position_count IS NULL OR position_count>=0),
 base_currency text CHECK(base_currency IS NULL OR base_currency ~ '^[A-Z]{3}$'),
 balances jsonb CHECK(balances IS NULL OR (jsonb_typeof(balances)='array' AND octet_length(balances::text)<=16384)),
 error_code text CHECK(error_code IS NULL OR length(error_code)<=80),
 UNIQUE(id,user_id)
);
CREATE INDEX IF NOT EXISTS portfolio_syncs_owner ON portfolio_syncs(user_id,provider,started_at DESC);
CREATE TABLE IF NOT EXISTS portfolio_positions (
 sync_id uuid NOT NULL,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 contract_id bigint NOT NULL CHECK(contract_id>0),
 symbol text NOT NULL CHECK(length(symbol) BETWEEN 1 AND 64),
 asset_class text NOT NULL CHECK(length(asset_class) BETWEEN 1 AND 16),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 quantity numeric NOT NULL,
 market_price numeric,
 market_value numeric,
 average_price numeric,
 unrealized_pnl numeric,
 daily_pnl numeric,
 PRIMARY KEY(sync_id,contract_id),
 FOREIGN KEY(sync_id,user_id) REFERENCES portfolio_syncs(id,user_id) ON DELETE CASCADE
);
-- Owner-tapped portfolio cards: Chief may only propose them; a Telegram tap decides.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_operation_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_operation_check CHECK(operation IN ('job_delete','skill_activate','calendar_create','library_borrow','library_hold','library_hold_cancel','library_link','library_revoke','responsibility_confirm','portfolio_connect','portfolio_disconnect'));
INSERT INTO runtime_migrations(version) VALUES(26) ON CONFLICT DO NOTHING;
COMMIT;
