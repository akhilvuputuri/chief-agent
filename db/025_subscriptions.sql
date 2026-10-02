BEGIN;
CREATE TABLE IF NOT EXISTS subscriptions (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=8192),
 field_sources jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(field_sources)='object'),
 merchant_key text NOT NULL DEFAULT '', plan_key text NOT NULL DEFAULT '', account_key text NOT NULL DEFAULT '',
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_owner ON subscriptions(user_id,updated_at DESC,id);
-- Plan/account identities stay decisive, including after cancellation.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_identity ON subscriptions(user_id,merchant_key,plan_key,account_key)
 WHERE merchant_key<>'';
CREATE TABLE IF NOT EXISTS subscription_updates (
 id uuid PRIMARY KEY, subscription_id uuid NOT NULL,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_key uuid NOT NULL, request_hash text NOT NULL,
 source_kind text NOT NULL DEFAULT 'owner' CHECK(source_kind='owner'),
 source_ref jsonb NOT NULL CHECK(jsonb_typeof(source_ref)='object' AND octet_length(source_ref::text)<=4096),
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='object' AND octet_length(changes::text)<=8192),
 revision integer NOT NULL CHECK(revision>0),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(subscription_id,user_id) REFERENCES subscriptions(id,user_id) ON DELETE CASCADE,
 UNIQUE(user_id,request_key), UNIQUE(subscription_id,revision)
);
CREATE INDEX IF NOT EXISTS subscription_updates_history ON subscription_updates(user_id,subscription_id,revision DESC);
ALTER TABLE daily_schedules ADD COLUMN IF NOT EXISTS subscription_id uuid;
ALTER TABLE daily_schedules ADD COLUMN IF NOT EXISTS subscription_date date;
ALTER TABLE daily_schedules ADD COLUMN IF NOT EXISTS subscription_revision integer;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='daily_subscription_owner') THEN
  ALTER TABLE daily_schedules ADD CONSTRAINT daily_subscription_owner
   FOREIGN KEY(subscription_id,user_id) REFERENCES subscriptions(id,user_id) ON DELETE CASCADE;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='daily_subscription_date') THEN
  ALTER TABLE daily_schedules ADD CONSTRAINT daily_subscription_date
   CHECK((subscription_id IS NULL AND subscription_date IS NULL AND subscription_revision IS NULL)
     OR (subscription_id IS NOT NULL AND subscription_date IS NOT NULL AND subscription_revision IS NOT NULL AND kind='reminder'));
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS daily_subscription_occurrence ON daily_schedules(subscription_id,subscription_date)
 WHERE subscription_id IS NOT NULL;
-- One atomic counter shared by every schedule writer, including generic reminders.
-- AFTER row triggers count the actual INSERT/UPDATE path of an upsert, never its
-- attempted INSERT. Existing records are retained, even if a historical race
-- exceeded capacity; new active occurrences then wait until capacity is available.
CREATE TABLE IF NOT EXISTS daily_schedule_capacity (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 active_count integer NOT NULL DEFAULT 0 CHECK(active_count>=0)
);
INSERT INTO daily_schedule_capacity(user_id,active_count)
 SELECT user_id,count(*)::integer FROM daily_schedules WHERE status IN ('scheduled','processing') GROUP BY user_id
 ON CONFLICT(user_id) DO NOTHING;
CREATE OR REPLACE FUNCTION maintain_daily_schedule_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE was_active integer := 0; is_active integer := 0; owner_id text;
BEGIN
 IF TG_OP<>'INSERT' THEN
  was_active := CASE WHEN OLD.status IN ('scheduled','processing') THEN 1 ELSE 0 END;
  owner_id := OLD.user_id;
 END IF;
 IF TG_OP<>'DELETE' THEN
  is_active := CASE WHEN NEW.status IN ('scheduled','processing') THEN 1 ELSE 0 END;
  owner_id := NEW.user_id;
 END IF;
 IF TG_OP='UPDATE' AND NEW.user_id<>OLD.user_id THEN
  RAISE EXCEPTION 'Schedule ownership cannot change' USING ERRCODE='23514';
 END IF;
 IF is_active>was_active THEN
  INSERT INTO daily_schedule_capacity(user_id) VALUES(owner_id) ON CONFLICT DO NOTHING;
  UPDATE daily_schedule_capacity SET active_count=active_count+1 WHERE user_id=owner_id AND active_count<50;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Limit of 50 active schedules reached' USING ERRCODE='23514', CONSTRAINT='daily_schedule_capacity_limit';
  END IF;
 ELSIF was_active>is_active THEN
  UPDATE daily_schedule_capacity SET active_count=active_count-1 WHERE user_id=owner_id;
  -- A missing counter is valid while an owner deletion cascades through both tables.
 END IF;
 RETURN NULL;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='daily_schedule_capacity_trigger') THEN
  CREATE TRIGGER daily_schedule_capacity_trigger AFTER INSERT OR UPDATE OR DELETE ON daily_schedules
   FOR EACH ROW EXECUTE FUNCTION maintain_daily_schedule_capacity();
 END IF;
END $$;
INSERT INTO runtime_migrations(version) VALUES(25) ON CONFLICT DO NOTHING;
COMMIT;
