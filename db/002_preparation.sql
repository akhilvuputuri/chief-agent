BEGIN;
CREATE TABLE IF NOT EXISTS research_sources (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 url text NOT NULL, content text NOT NULL, retrieved_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS preparation_requirements (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 topic text NOT NULL, importance text NOT NULL CHECK(importance IN ('required','preferred','inferred')),
 source_id uuid REFERENCES research_sources(id), source_quote text NOT NULL,
 assessment text NOT NULL CHECK(assessment IN ('strength','gap','unknown')),
 evidence text NOT NULL DEFAULT '', question text NOT NULL DEFAULT '',
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(job_id,topic)
);
CREATE TABLE IF NOT EXISTS preparation_tasks (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 topic text NOT NULL, exercise text NOT NULL, completion_criteria text NOT NULL,
 status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
 priority text NOT NULL CHECK(priority IN ('high','medium','low')),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,topic)
);
COMMIT;
