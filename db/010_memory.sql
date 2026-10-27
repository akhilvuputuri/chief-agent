-- Issue #326 phase 1: revisioned memory with provenance, plus the learner's ledgers.
-- Additive only. `memories` stays as the projection of active fact heads, so job analysis,
-- job alignment and an older gateway image keep reading it unchanged. The gateway imports
-- any `memories` row that its revisions do not already hold at startup (origin 'legacy'),
-- which also covers rows an older image wrote after a rollback.
BEGIN;
CREATE TABLE IF NOT EXISTS learner_runs (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id uuid,
  state text NOT NULL CHECK (state IN ('running','completed','failed','deferred')),
  model text,
  prompt_version text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(user_id,id)
);
CREATE INDEX IF NOT EXISTS learner_runs_owner ON learner_runs(user_id,started_at);
-- Immutable revisions. A retirement or rollback is a new revision; nothing is updated or
-- deleted. value is NULL only for a retired revision.
CREATE TABLE IF NOT EXISTS memory_revisions (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  kind text NOT NULL CHECK (kind IN ('fact','lesson')),
  status text NOT NULL CHECK (status IN ('active','retired')),
  value text,
  outcome text CHECK (outcome IN ('success','pitfall')),
  domain text,
  origin text NOT NULL CHECK (origin IN ('owner','learned','legacy','rollback')),
  reason text NOT NULL,
  source jsonb NOT NULL DEFAULT '{}',
  learner_run uuid,
  trust text NOT NULL CHECK (trust IN ('owner','untrusted','unknown')),
  untrusted_sources text[] NOT NULL DEFAULT '{}',
  flags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,key,revision),
  UNIQUE(user_id,id),
  CHECK ((status = 'active') = (value IS NOT NULL)),
  CHECK (kind = 'lesson' OR outcome IS NULL),
  FOREIGN KEY(user_id,learner_run) REFERENCES learner_runs(user_id,id)
);
CREATE INDEX IF NOT EXISTS memory_revisions_learner ON memory_revisions(user_id,learner_run);
CREATE INDEX IF NOT EXISTS memory_revisions_owner_time ON memory_revisions(user_id,created_at);
CREATE TABLE IF NOT EXISTS memory_heads (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  revision_id uuid NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  PRIMARY KEY(user_id,key),
  FOREIGN KEY(user_id,revision_id) REFERENCES memory_revisions(user_id,id)
);
-- Revisions a rollback undid. A later rollback never restores one, so undoing several
-- learner runs in any order lands on the latest revision none of them wrote.
CREATE TABLE IF NOT EXISTS memory_undone (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,revision_id),
  FOREIGN KEY(user_id,revision_id) REFERENCES memory_revisions(user_id,id)
);
-- What each run had in context: the selected revisions and the ones left out by the budget.
-- "In context" is never "used".
CREATE TABLE IF NOT EXISTS memory_context (
  run_id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  selected uuid[] NOT NULL,
  omitted uuid[] NOT NULL DEFAULT '{}',
  chars integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_context_owner_time ON memory_context(user_id,created_at);
-- One outcome label per reviewed work task, so a task is learned from at most once.
CREATE TABLE IF NOT EXISTS learning_reviews (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  learner_run uuid NOT NULL,
  label text NOT NULL CHECK (label IN ('success','pitfall','skipped')),
  reasons text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,task_id),
  FOREIGN KEY(user_id,learner_run) REFERENCES learner_runs(user_id,id)
);
-- Provenance for skills the learner drafts (phase 3). NULL for owner-authored versions.
ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS learner_run uuid;
INSERT INTO runtime_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;
COMMIT;
