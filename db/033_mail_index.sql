BEGIN;
-- Persisted gmail_recall index (docs/mail-recall.md). Headers, Gmail's snippet and embedding
-- vectors only: no email body text is stored. Owner-scoped; rows cascade with their message.
CREATE TABLE IF NOT EXISTS mail_index_state (
 user_id text PRIMARY KEY REFERENCES users(id),
 model text NOT NULL, dimensions integer NOT NULL, window_days integer NOT NULL,
 synced_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mail_index_messages (
 user_id text NOT NULL REFERENCES users(id), message_id text NOT NULL, thread_id text NOT NULL,
 received_at timestamptz NOT NULL, sender text NOT NULL, subject text NOT NULL,
 date_header text NOT NULL, snippet text NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,message_id)
);
CREATE INDEX IF NOT EXISTS mail_index_messages_received ON mail_index_messages(user_id,received_at);
CREATE TABLE IF NOT EXISTS mail_index_chunks (
 user_id text NOT NULL, message_id text NOT NULL, chunk integer NOT NULL CHECK(chunk >= 0),
 vector bytea NOT NULL,
 PRIMARY KEY(user_id,message_id,chunk),
 FOREIGN KEY(user_id,message_id) REFERENCES mail_index_messages(user_id,message_id) ON DELETE CASCADE
);
INSERT INTO runtime_migrations(version) VALUES(33) ON CONFLICT DO NOTHING;
COMMIT;
