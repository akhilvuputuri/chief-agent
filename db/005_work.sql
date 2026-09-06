BEGIN;
CREATE TABLE IF NOT EXISTS work_tasks (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 objective text NOT NULL,request text NOT NULL,revision integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','queued','running','paused','done','cancelled')),
 passes integer NOT NULL DEFAULT 0,next_run timestamptz NOT NULL DEFAULT now(),lease uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS work_one_active ON work_tasks(user_id) WHERE status IN ('active','queued','running','paused');
CREATE TABLE IF NOT EXISTS work_steps (
 task_id uuid NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,key text NOT NULL,title text NOT NULL,
 expected_operation text,verification text NOT NULL CHECK(verification IN ('evidence','action','analysis')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','blocked')),
 result text NOT NULL DEFAULT '',proofs uuid[] NOT NULL DEFAULT '{}',PRIMARY KEY(task_id,key)
);
CREATE TABLE IF NOT EXISTS work_revisions (
 id bigserial PRIMARY KEY,task_id uuid NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,revision integer NOT NULL,
 request text NOT NULL,objective text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS work_turns (
 run_id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,request text NOT NULL,background boolean NOT NULL DEFAULT false,
 task_id uuid REFERENCES work_tasks(id),revision integer,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tool_receipts (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,run_id uuid NOT NULL,
 task_id uuid REFERENCES work_tasks(id),operation text NOT NULL,status text NOT NULL CHECK(status IN ('success','failed')),
 details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS work_evidence (
 id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
 source_id uuid NOT NULL REFERENCES research_sources(id),claim text NOT NULL,quote text NOT NULL,
 applicability text NOT NULL CHECK(applicability IN ('matched','unverified','mismatch')),reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
