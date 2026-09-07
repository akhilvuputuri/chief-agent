BEGIN;
CREATE TABLE IF NOT EXISTS task_scopes (
 task_id uuid PRIMARY KEY REFERENCES work_tasks(id), user_id text NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1, source_call_id uuid NOT NULL REFERENCES runtime_calls(id),
 bound_run uuid NOT NULL REFERENCES runtime_runs(id), targets jsonb NOT NULL,
 history jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_findings (
 task_id uuid NOT NULL REFERENCES work_tasks(id), target_id text NOT NULL, target_hash text NOT NULL,
 summary text NOT NULL, status text NOT NULL CHECK(status IN ('complete','blocked')),
 observation_ids uuid[] NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,target_id)
);
COMMIT;
