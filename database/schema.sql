-- database/schema.sql
-- Applied idempotently on every boot via migrate() in database/index.js.

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  goal              TEXT NOT NULL,
  cron_expression   TEXT,
  timezone          TEXT,
  status            TEXT NOT NULL DEFAULT 'idle',   -- idle | running | success | failed | awaiting_approval
  last_status       TEXT,
  last_run_at       TEXT,
  next_run_at       TEXT,
  error_message     TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks (next_run_at);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running',  -- running | success | failed | awaiting_approval
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  steps_total    INTEGER DEFAULT 0,
  steps_done     INTEGER DEFAULT 0,
  retries        INTEGER DEFAULT 0,
  result_json    TEXT,
  error_message  TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON runs (task_id);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at);

CREATE TABLE IF NOT EXISTS steps (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  tool              TEXT NOT NULL,
  args_json         TEXT,
  reasoning         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | running | success | failed
  observation_json  TEXT,
  error_message     TEXT,
  started_at        TEXT,
  finished_at       TEXT,
  FOREIGN KEY (run_id) REFERENCES runs (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_steps_run ON steps (run_id);

CREATE TABLE IF NOT EXISTS errors (
  id            TEXT PRIMARY KEY,
  run_id        TEXT,
  step_id       TEXT,
  level         TEXT NOT NULL,   -- debug | info | warn | error | fatal
  message       TEXT NOT NULL,
  stack         TEXT,
  context_json  TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_errors_created ON errors (created_at);

CREATE TABLE IF NOT EXISTS kv_store (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  domain         TEXT NOT NULL,
  label          TEXT NOT NULL DEFAULT 'default',
  metadata_json  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(domain, label)
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id             TEXT PRIMARY KEY,
  level          TEXT NOT NULL,
  subject        TEXT NOT NULL,
  body           TEXT,
  channel        TEXT NOT NULL,
  ok             INTEGER NOT NULL DEFAULT 1,
  error_message  TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications_log (created_at);

-- pending_approvals is created lazily by agent/approval.js on first use,
-- since it is only needed when HUMAN_APPROVAL_REQUIRED=true.
