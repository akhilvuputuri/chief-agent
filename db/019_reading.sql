BEGIN;
-- Owner-scoped daily reading bulletin (issue 50): approved feeds, candidate provenance,
-- saved editions with their ranking trace, explicit votes and versioned derived preferences.
CREATE TABLE IF NOT EXISTS reading_settings (
 user_id text PRIMARY KEY REFERENCES users(id),
 enabled boolean NOT NULL DEFAULT false,
 paused boolean NOT NULL DEFAULT false,
 interests jsonb NOT NULL DEFAULT '[]'::jsonb,
 languages jsonb NOT NULL DEFAULT '[]'::jsonb,
 preferred_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
 excluded_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
 muted_topics jsonb NOT NULL DEFAULT '[]'::jsonb,
 delivery_time text CHECK(delivery_time IS NULL OR delivery_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 timezone text,
 items_per_edition integer NOT NULL DEFAULT 5 CHECK(items_per_edition BETWEEN 1 AND 5),
 discovery_slots integer NOT NULL DEFAULT 1 CHECK(discovery_slots BETWEEN 0 AND 2),
 history_days integer NOT NULL DEFAULT 14 CHECK(history_days BETWEEN 1 AND 60),
 max_age_days integer NOT NULL DEFAULT 7 CHECK(max_age_days BETWEEN 1 AND 30),
 overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
 learning_reset_at timestamptz,
 schedule_from timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reading_sources (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 url text NOT NULL,
 name text NOT NULL,
 topics jsonb NOT NULL DEFAULT '[]'::jsonb,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
 last_fetched_at timestamptz,
 last_status text,
 last_error text,
 last_item_count integer,
 error_count integer NOT NULL DEFAULT 0,
 next_retry_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id, url)
);
-- Discovery time (first_seen_at) is recorded separately from the feed's publication time,
-- which stays NULL when the feed omits or garbles it.
CREATE TABLE IF NOT EXISTS reading_candidates (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 source_id uuid REFERENCES reading_sources(id) ON DELETE SET NULL,
 canonical_url text NOT NULL,
 url text NOT NULL,
 domain text NOT NULL,
 title text NOT NULL,
 summary text,
 content_basis text NOT NULL CHECK(content_basis IN ('feed_summary','title_only')),
 categories jsonb NOT NULL DEFAULT '[]'::jsonb,
 language text,
 published_at timestamptz,
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS reading_candidates_recent ON reading_candidates(user_id, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS reading_preference_versions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 weights jsonb NOT NULL,
 contributing jsonb NOT NULL DEFAULT '[]'::jsonb,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reading_preference_versions_user ON reading_preference_versions(user_id, id DESC);
-- One scheduled edition per owner-local date; the row doubles as the delivery outbox.
CREATE TABLE IF NOT EXISTS reading_editions (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('scheduled','on_demand')),
 edition_date date NOT NULL,
 preference_version bigint REFERENCES reading_preference_versions(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','uncertain','muted')),
 trace jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS reading_editions_scheduled ON reading_editions(user_id, edition_date) WHERE kind='scheduled';
CREATE INDEX IF NOT EXISTS reading_editions_user ON reading_editions(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS reading_items (
 id uuid PRIMARY KEY,
 edition_id uuid NOT NULL REFERENCES reading_editions(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id),
 position integer NOT NULL,
 canonical_url text NOT NULL,
 url text NOT NULL,
 domain text NOT NULL,
 source_name text NOT NULL,
 title text NOT NULL,
 summary text,
 content_basis text NOT NULL,
 published_at timestamptz,
 first_seen_at timestamptz NOT NULL,
 topics jsonb NOT NULL DEFAULT '[]'::jsonb,
 label text,
 reason text NOT NULL,
 score numeric NOT NULL,
 components jsonb NOT NULL,
 sent_at timestamptz,
 UNIQUE(edition_id, position)
);
CREATE INDEX IF NOT EXISTS reading_items_user ON reading_items(user_id, first_seen_at DESC);
-- Current explicit vote per delivered item; learning reads only these rows, so changing or
-- undoing a vote can never be counted twice.
CREATE TABLE IF NOT EXISTS reading_votes (
 item_id uuid PRIMARY KEY REFERENCES reading_items(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id),
 vote text NOT NULL CHECK(vote IN ('like','more','dislike')),
 reason text CHECK(reason IS NULL OR reason IN ('off_topic','too_shallow','already_knew','poor_source','too_repetitive')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Append-only audit of button presses and tool edits.
CREATE TABLE IF NOT EXISTS reading_feedback_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id),
 item_id uuid REFERENCES reading_items(id) ON DELETE SET NULL,
 action text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO runtime_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;
COMMIT;
