BEGIN;
-- Optional Singapore-time monitoring windows for the stock watchlist: an owner
-- default on stock_settings and a per-item override on watchlist_items (NULL =
-- inherit). All three columns are set together or all NULL.
ALTER TABLE stock_settings ADD COLUMN IF NOT EXISTS window_start text;
ALTER TABLE stock_settings ADD COLUMN IF NOT EXISTS window_end text;
ALTER TABLE stock_settings ADD COLUMN IF NOT EXISTS window_days text[];
ALTER TABLE watchlist_items ADD COLUMN IF NOT EXISTS window_start text;
ALTER TABLE watchlist_items ADD COLUMN IF NOT EXISTS window_end text;
ALTER TABLE watchlist_items ADD COLUMN IF NOT EXISTS window_days text[];
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_settings_window_check') THEN
    ALTER TABLE stock_settings ADD CONSTRAINT stock_settings_window_check CHECK (
      (window_start IS NULL AND window_end IS NULL AND window_days IS NULL) OR (
        window_start IS NOT NULL AND window_end IS NOT NULL
        AND window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND window_end ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
        AND window_start <> window_end
        AND (window_days IS NULL OR (cardinality(window_days) BETWEEN 1 AND 6
          AND window_days <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='watchlist_items_window_check') THEN
    ALTER TABLE watchlist_items ADD CONSTRAINT watchlist_items_window_check CHECK (
      (window_start IS NULL AND window_end IS NULL AND window_days IS NULL) OR (
        window_start IS NOT NULL AND window_end IS NOT NULL
        AND window_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND window_end ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
        AND window_start <> window_end
        AND (window_days IS NULL OR (cardinality(window_days) BETWEEN 1 AND 6
          AND window_days <@ ARRAY['mon','tue','wed','thu','fri','sat','sun']))));
  END IF;
END $$;
-- Widen (never narrow) the observation decisions with 'outside_window'; older
-- application images never write it, so an app-only rollback stays compatible.
ALTER TABLE stock_observations DROP CONSTRAINT IF EXISTS stock_observations_decision_check;
ALTER TABLE stock_observations ADD CONSTRAINT stock_observations_decision_check CHECK(decision IN
  ('alerted','below_threshold','suppressed_today','market_closed','stale','invalid','error','suspect','outside_window'));
INSERT INTO runtime_migrations(version) VALUES(20) ON CONFLICT DO NOTHING;
COMMIT;
