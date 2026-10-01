BEGIN;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_operation_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_operation_check CHECK(operation IN ('job_delete','skill_activate','calendar_create','library_borrow','library_hold','library_hold_cancel','library_link','library_revoke','responsibility_confirm'));
CREATE TABLE IF NOT EXISTS responsibilities (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), revision integer NOT NULL DEFAULT 1,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','resolved','expired','cancelled')),
 understanding text NOT NULL DEFAULT '', attention_weight integer NOT NULL DEFAULT 0 CHECK(attention_weight BETWEEN -3 AND 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS responsibility_revisions (
 responsibility_id uuid NOT NULL REFERENCES responsibilities(id), revision integer NOT NULL,
 user_id text NOT NULL REFERENCES users(id), spec jsonb NOT NULL, approval_id uuid NOT NULL REFERENCES approvals(id),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(responsibility_id,revision)
);
CREATE TABLE IF NOT EXISTS responsibility_triggers (
 id uuid PRIMARY KEY, responsibility_id uuid NOT NULL REFERENCES responsibilities(id), user_id text NOT NULL REFERENCES users(id),
 revision integer NOT NULL, kind text NOT NULL CHECK(kind IN ('gmail','calendar','schedule','parcel')),
 config jsonb NOT NULL, cursor jsonb NOT NULL DEFAULT '{}', next_check timestamptz,
 health text NOT NULL DEFAULT 'healthy' CHECK(health IN ('healthy','degraded')), last_check timestamptz,
 last_success timestamptz, lease uuid, lease_until timestamptz,
 FOREIGN KEY(responsibility_id,revision) REFERENCES responsibility_revisions(responsibility_id,revision),
 UNIQUE(responsibility_id,revision,kind)
);
CREATE TABLE IF NOT EXISTS responsibility_checks (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), trigger_id uuid NOT NULL REFERENCES responsibility_triggers(id),
 outcome text NOT NULL, candidates integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS responsibility_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL REFERENCES users(id), parcel_id uuid NOT NULL REFERENCES parcels(id),
 parcel_revision integer NOT NULL, payload jsonb NOT NULL, run_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(parcel_id,parcel_revision)
);
CREATE TABLE IF NOT EXISTS responsibility_candidates (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), responsibility_id uuid NOT NULL REFERENCES responsibilities(id),
 revision integer NOT NULL, source_key text NOT NULL, payload jsonb NOT NULL,
 task_id uuid REFERENCES work_tasks(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(responsibility_id,revision) REFERENCES responsibility_revisions(responsibility_id,revision),
 UNIQUE(responsibility_id,revision,source_key)
);
CREATE TABLE IF NOT EXISTS responsibility_investigations (
 task_id uuid PRIMARY KEY REFERENCES work_tasks(id), user_id text NOT NULL REFERENCES users(id),
 responsibility_id uuid NOT NULL REFERENCES responsibilities(id), revision integer NOT NULL,
 state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','complete','cancelled')),
 finding jsonb, report_run uuid REFERENCES runtime_runs(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(responsibility_id,revision) REFERENCES responsibility_revisions(responsibility_id,revision)
);
CREATE TABLE IF NOT EXISTS responsibility_findings (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), responsibility_id uuid NOT NULL REFERENCES responsibilities(id),
 revision integer NOT NULL, task_id uuid UNIQUE REFERENCES work_tasks(id), payload jsonb NOT NULL,
 notice_task_id uuid UNIQUE REFERENCES work_tasks(id),
 decision text NOT NULL CHECK(decision IN ('now','briefing','quiet','drop')), reason text NOT NULL,
 fact_key text NOT NULL, due_at timestamptz, closing boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'quiet' CHECK(state IN ('quiet','pending','sending','sent','uncertain','suppressed')),
 feedback text, message_id bigint, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(responsibility_id,revision) REFERENCES responsibility_revisions(responsibility_id,revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS responsibility_closure_once ON responsibility_findings(responsibility_id) WHERE closing;
CREATE TABLE IF NOT EXISTS responsibility_feedback (
 finding_id uuid NOT NULL REFERENCES responsibility_findings(id), user_id text NOT NULL REFERENCES users(id),
 choice text NOT NULL CHECK(choice IN ('useful','later','resolved','less')), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(finding_id,choice)
);
CREATE INDEX IF NOT EXISTS responsibility_pending_candidates ON responsibility_candidates(responsibility_id,created_at) WHERE task_id IS NULL;
CREATE INDEX IF NOT EXISTS responsibility_delivery_due ON responsibility_findings(due_at) WHERE state='pending';
CREATE INDEX IF NOT EXISTS responsibility_trigger_due ON responsibility_triggers(next_check);
CREATE OR REPLACE FUNCTION responsibility_parcel_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_OP='INSERT' OR ROW(NEW.status,NEW.eta,NEW.raw_status,NEW.archived_at) IS DISTINCT FROM ROW(OLD.status,OLD.eta,OLD.raw_status,OLD.archived_at))
 AND EXISTS(SELECT 1 FROM responsibilities r JOIN responsibility_revisions v ON v.responsibility_id=r.id AND v.revision=r.revision
 WHERE r.user_id=NEW.user_id AND r.status='active' AND v.spec->'parcelIds' ? NEW.id::text) THEN
 INSERT INTO responsibility_events(user_id,parcel_id,parcel_revision,payload)
 VALUES(NEW.user_id,NEW.id,NEW.revision,jsonb_build_object('kind','parcel','parcelId',NEW.id,'status',NEW.status,'eta',NEW.eta,'archived',NEW.archived_at IS NOT NULL,'rawStatus',NEW.raw_status))
 ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS responsibility_parcel_event ON parcels;
CREATE TRIGGER responsibility_parcel_event AFTER INSERT OR UPDATE ON parcels FOR EACH ROW EXECUTE FUNCTION responsibility_parcel_event();
CREATE OR REPLACE FUNCTION responsibility_parcel_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE responsibility_events SET run_id=NEW.run_id WHERE parcel_id=NEW.parcel_id AND user_id=NEW.user_id
 AND parcel_revision=(SELECT revision FROM parcels WHERE id=NEW.parcel_id);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS responsibility_parcel_origin ON parcel_updates;
CREATE TRIGGER responsibility_parcel_origin AFTER INSERT ON parcel_updates FOR EACH ROW EXECUTE FUNCTION responsibility_parcel_origin();
INSERT INTO runtime_migrations(version) VALUES(23) ON CONFLICT DO NOTHING;
COMMIT;
