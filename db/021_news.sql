BEGIN;
-- Daily news bulletin (issue #50, lean restart after PR #83): sites the owner
-- follows (resolved to feeds), Singapore-time delivery, topics and explicit
-- per-item 👍/👎 votes. Editions double as the delivery outbox.
CREATE TABLE IF NOT EXISTS news_settings (
 user_id text PRIMARY KEY REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT false,
 delivery_time text CHECK(delivery_time IS NULL OR delivery_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 topics text[] NOT NULL DEFAULT '{}' CHECK(cardinality(topics) <= 20),
 items_per_edition integer NOT NULL DEFAULT 5 CHECK(items_per_edition BETWEEN 1 AND 8),
 -- Enabling or moving the time restarts the clock: a slot before this is not caught up.
 schedule_from timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS news_sources (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 name text NOT NULL,
 site_url text NOT NULL,
 feed_url text NOT NULL,
 domain text NOT NULL,
 last_fetched_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id, feed_url)
);
CREATE TABLE IF NOT EXISTS news_editions (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 edition_date date NOT NULL,
 kind text NOT NULL CHECK(kind IN ('scheduled','on_demand')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain','muted')),
 payload jsonb NOT NULL,
 trace jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS news_editions_scheduled_day
 ON news_editions(user_id, edition_date) WHERE kind='scheduled';
CREATE TABLE IF NOT EXISTS news_items (
 id uuid PRIMARY KEY,
 edition_id uuid NOT NULL REFERENCES news_editions(id),
 user_id text NOT NULL REFERENCES users(id),
 position integer NOT NULL,
 source_id uuid REFERENCES news_sources(id) ON DELETE SET NULL,
 source_name text NOT NULL,
 url text NOT NULL,
 canonical_url text NOT NULL,
 domain text NOT NULL,
 title text NOT NULL,
 excerpt text,
 published_at timestamptz,
 topics text[] NOT NULL DEFAULT '{}',
 score jsonb NOT NULL DEFAULT '{}'::jsonb,
 vote smallint CHECK(vote IN (-1, 1)),
 voted_at timestamptz,
 UNIQUE(edition_id, position)
);
CREATE INDEX IF NOT EXISTS news_items_owner_url ON news_items(user_id, canonical_url);
INSERT INTO runtime_migrations(version) VALUES(21) ON CONFLICT DO NOTHING;
COMMIT;
