-- database/schema.sql
-- Applied idempotently on every boot via migrate() in database/index.js.

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  goal            TEXT NOT NULL,
  cron_expression  TEXT,
  timezone         TEXT,
  status           TEXT NOT NULL DEFAULT 'idle',
  last_status      TEXT,
  last_run_at      TEXT,
  next_run_at      TEXT,
  error_message    TEXT,
  metadata_json    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks (next_run_at);
