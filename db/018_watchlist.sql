BEGIN;
-- Owner-scoped stock watchlist, alert outbox and bounded observation traces (issue 46).
CREATE TABLE IF NOT EXISTS stock_settings (
 user_id text PRIMARY KEY REFERENCES users(id),
 default_drop_pct numeric NOT NULL DEFAULT 5 CHECK(default_drop_pct > 0 AND default_drop_pct <= 50),
 paused boolean NOT NULL DEFAULT false,
 poll_minutes integer NOT NULL DEFAULT 15 CHECK(poll_minutes >= 5 AND poll_minutes <= 240),
 include_extended boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS watchlist_items (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 symbol text NOT NULL,
 name text NOT NULL,
 exchange text NOT NULL,
 mic_code text NOT NULL,
 exchange_timezone text NOT NULL,
 currency text NOT NULL,
 drop_pct numeric CHECK(drop_pct IS NULL OR (drop_pct > 0 AND drop_pct <= 50)),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
 last_polled_at timestamptz,
 next_retry_at timestamptz,
 error_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id, symbol, mic_code)
);
-- One row per item per exchange trading day doubles as the notification state and
-- the delivery outbox; 'muted' markers suppress further alerts for that day.
CREATE TABLE IF NOT EXISTS stock_alerts (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 item_id uuid NOT NULL REFERENCES watchlist_items(id) ON DELETE CASCADE,
 trading_date date NOT NULL,
 payload jsonb,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain','muted')),
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 UNIQUE(item_id, trading_date)
);
CREATE TABLE IF NOT EXISTS stock_observations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 item_id uuid NOT NULL REFERENCES watchlist_items(id) ON DELETE CASCADE,
 observed_at timestamptz NOT NULL DEFAULT now(),
 quote_time timestamptz,
 price numeric,
 prev_close numeric,
 change_pct numeric,
 market_state text,
 decision text NOT NULL CHECK(decision IN
   ('alerted','below_threshold','suppressed_today','market_closed','stale','invalid','error','suspect')),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS stock_observations_item ON stock_observations(item_id, observed_at DESC);
-- Provider exchange calendar cache: sessions and holidays per market day.
CREATE TABLE IF NOT EXISTS stock_exchange_hours (
 mic_code text NOT NULL,
 for_date date NOT NULL,
 timezone text NOT NULL,
 sessions jsonb NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(mic_code, for_date)
);
INSERT INTO runtime_migrations(version) VALUES(18) ON CONFLICT DO NOTHING;
COMMIT;
