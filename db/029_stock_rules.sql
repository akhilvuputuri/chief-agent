BEGIN;
-- Owner-defined stock rules (docs/stock-rules.md, Phase 2b). Additive: daily-drop alerts
-- (stock_alerts) are unchanged, so an older image keeps working after a rollback.
CREATE TABLE IF NOT EXISTS watch_rules (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 scope text NOT NULL CHECK(scope IN ('item','holdings','watchlist')),
 item_id uuid REFERENCES watchlist_items(id) ON DELETE CASCADE,
 direction text NOT NULL CHECK(direction IN ('below','above')),
 reference text NOT NULL CHECK(reference IN ('prev_close','avg_cost',
   'avg_12w','avg_26w','avg_52w','low_12w','low_26w','low_52w',
   'high_12w','high_26w','high_52w','all_time_low','all_time_high')),
 margin_pct numeric NOT NULL DEFAULT 0 CHECK(margin_pct>=0 AND margin_pct<=90),
 basis text NOT NULL CHECK(basis IN ('intraday','close')),
 notify text NOT NULL DEFAULT 'cross' CHECK(notify IN ('cross','daily')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((scope='item') = (item_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS watch_rules_owner ON watch_rules(user_id,status);
-- Per rule and watched stock: crossing state and the latest evaluation, for list/digest.
CREATE TABLE IF NOT EXISTS watch_rule_states (
 rule_id uuid NOT NULL REFERENCES watch_rules(id) ON DELETE CASCADE,
 item_id uuid NOT NULL REFERENCES watchlist_items(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 armed boolean NOT NULL DEFAULT true,
 last_evaluated_at timestamptz,
 last_price numeric,
 last_reference numeric,
 last_trigger numeric,
 last_outcome text CHECK(last_outcome IS NULL OR length(last_outcome)<=120),
 last_triggered_at timestamptz,
 last_closing_date date,
 PRIMARY KEY(rule_id,item_id)
);
-- Outbox for rule alerts, same states as stock_alerts. A close-based alert is held for the
-- owner's next monitoring window rather than muted.
CREATE TABLE IF NOT EXISTS watch_rule_alerts (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 rule_id uuid NOT NULL REFERENCES watch_rules(id) ON DELETE CASCADE,
 item_id uuid NOT NULL REFERENCES watchlist_items(id) ON DELETE CASCADE,
 trading_date date NOT NULL,
 hold_for_window boolean NOT NULL DEFAULT false,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain','muted')),
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz,
 UNIQUE(rule_id,item_id,trading_date)
);
CREATE INDEX IF NOT EXISTS watch_rule_alerts_pending ON watch_rule_alerts(state,created_at);
INSERT INTO runtime_migrations(version) VALUES(29) ON CONFLICT DO NOTHING;
COMMIT;
