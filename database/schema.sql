-- database/schema.sql
-- Applied idempotently on every boot via migrate() in database/index.js.

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  goal              TEXT NOT NULL,
  cron_expression   TEXT,
  timezone          TEXT,
  status            TEXT NOT NULL DEFAULT 'idle',
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
  status         TEXT NOT NULL DEFAULT 'running',
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
  status            TEXT NOT NULL DEFAULT 'pending',
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
  level         TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS website_samples (
  id                TEXT PRIMARY KEY,
  task_id           TEXT,
  run_id            TEXT,
  prospect_name     TEXT,
  status            TEXT NOT NULL DEFAULT 'SPECULATIVE_SAMPLE',
  business_type     TEXT,
  location          TEXT,
  website_goal      TEXT,
  style             TEXT,
  files_json        TEXT,
  preview_path      TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_website_samples_created ON website_samples (created_at);
CREATE INDEX IF NOT EXISTS idx_website_samples_task ON website_samples (task_id);

CREATE TABLE IF NOT EXISTS prospects (
  id                TEXT PRIMARY KEY,
  task_id           TEXT,
  run_id            TEXT,
  business_name     TEXT,
  website_url       TEXT,
  location          TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  social_profiles_json TEXT,
  service_gaps_json TEXT,
  source_url        TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'NEW',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prospects_created ON prospects (created_at);
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects (status);
CREATE INDEX IF NOT EXISTS idx_prospects_task ON prospects (task_id);

CREATE TABLE IF NOT EXISTS opportunities (
  id                      TEXT PRIMARY KEY,
  prospect_id             TEXT NOT NULL,
  task_id                 TEXT,
  run_id                  TEXT,
  score                   INTEGER NOT NULL,
  priority                TEXT NOT NULL,
  opportunity_type        TEXT,
  summary                 TEXT,
  identified_problems_json    TEXT,
  recommended_services_json   TEXT,
  recommended_actions_json    TEXT,
  recommended_sample_type TEXT,
  recommended_sample_reason TEXT,
  estimated_value         TEXT,
  confidence              TEXT,
  status                  TEXT NOT NULL DEFAULT 'NEW',
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (prospect_id) REFERENCES prospects(id)
);

CREATE INDEX IF NOT EXISTS idx_opportunities_prospect ON opportunities (prospect_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities (status);
CREATE INDEX IF NOT EXISTS idx_opportunities_score ON opportunities (score);
CREATE INDEX IF NOT EXISTS idx_opportunities_priority ON opportunities (priority);

CREATE TABLE IF NOT EXISTS samples (
  id                TEXT PRIMARY KEY,
  prospect_id       TEXT NOT NULL,
  opportunity_id    TEXT NOT NULL,
  task_id           TEXT,
  run_id            TEXT,
  sample_type       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  content_kind      TEXT NOT NULL,
  website_sample_id TEXT,
  concept_content_json TEXT,
  preview_path      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (prospect_id) REFERENCES prospects(id),
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id),
  FOREIGN KEY (website_sample_id) REFERENCES website_samples(id)
);

CREATE INDEX IF NOT EXISTS idx_samples_opportunity ON samples (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_samples_prospect ON samples (prospect_id);
CREATE INDEX IF NOT EXISTS idx_samples_status ON samples (status);
CREATE INDEX IF NOT EXISTS idx_samples_content_kind ON samples (content_kind);

CREATE TABLE IF NOT EXISTS proposals (
  id                      TEXT PRIMARY KEY,
  prospect_id             TEXT NOT NULL,
  opportunity_id          TEXT NOT NULL,
  sample_id               TEXT,
  task_id                 TEXT,
  run_id                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'DRAFT',
  pitch                   TEXT,
  service_recommendation  TEXT,
  value_proposition       TEXT,
  suggested_package       TEXT,
  call_to_action          TEXT,
  assumptions_json        TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (prospect_id) REFERENCES prospects(id),
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id),
  FOREIGN KEY (sample_id) REFERENCES samples(id)
);

CREATE INDEX IF NOT EXISTS idx_proposals_opportunity ON proposals (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_proposals_prospect ON proposals (prospect_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals (status);

CREATE TABLE IF NOT EXISTS outreach_messages (
  id                TEXT PRIMARY KEY,
  prospect_id       TEXT NOT NULL,
  opportunity_id    TEXT NOT NULL,
  proposal_id       TEXT NOT NULL,
  sample_id         TEXT,
  task_id           TEXT,
  run_id            TEXT,
  channel           TEXT NOT NULL,
  recipient         TEXT NOT NULL,
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (prospect_id) REFERENCES prospects(id),
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id),
  FOREIGN KEY (proposal_id) REFERENCES proposals(id),
  FOREIGN KEY (sample_id) REFERENCES samples(id)
);

CREATE INDEX IF NOT EXISTS idx_outreach_messages_prospect ON outreach_messages (prospect_id);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_opportunity ON outreach_messages (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_status ON outreach_messages (status);
CREATE INDEX IF NOT EXISTS idx_outreach_messages_created ON outreach_messages (created_at);

CREATE TABLE IF NOT EXISTS outreach_approvals (
  id                    TEXT PRIMARY KEY,
  outreach_message_id   TEXT NOT NULL,
  decision              TEXT,
  content_hash          TEXT NOT NULL,
  decided_at            TEXT,
  decided_by            TEXT,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (outreach_message_id) REFERENCES outreach_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_outreach_approvals_message ON outreach_approvals (outreach_message_id);

CREATE TABLE IF NOT EXISTS outreach_attempts (
  id                    TEXT PRIMARY KEY,
  outreach_message_id   TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'PENDING',
  provider_message_id   TEXT,
  started_at            TEXT,
  finished_at           TEXT,
  error_message         TEXT,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (outreach_message_id) REFERENCES outreach_messages(id)
);

CREATE INDEX IF NOT EXISTS idx_outreach_attempts_message ON outreach_attempts (outreach_message_id);
CREATE INDEX IF NOT EXISTS idx_outreach_attempts_status ON outreach_attempts (status);

CREATE TABLE IF NOT EXISTS operator_audit_log (
  id                TEXT PRIMARY KEY,
  operator_id       TEXT NOT NULL,
  action            TEXT NOT NULL,
  tool_name         TEXT,
  request_id        TEXT,
  idempotency_key   TEXT,
  target            TEXT,
  status            TEXT NOT NULL,
  details           TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_audit_created ON operator_audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_operator_audit_tool ON operator_audit_log (tool_name);

CREATE TABLE IF NOT EXISTS control_idempotency (
  id                TEXT PRIMARY KEY,
  idempotency_key   TEXT NOT NULL UNIQUE,
  operator_id       TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  status            TEXT NOT NULL,
  result            TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_control_idempotency_tool ON control_idempotency (tool_name);

CREATE TABLE IF NOT EXISTS repair_sessions (
  id                TEXT PRIMARY KEY,
  task_id           TEXT,
  initial_run_id    TEXT,
  current_run_id    TEXT,
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  state             TEXT NOT NULL DEFAULT 'STARTED',
  failure_reason    TEXT,
  diagnosis         TEXT,
  branch_name       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repair_sessions_task ON repair_sessions (task_id);
CREATE INDEX IF NOT EXISTS idx_repair_sessions_state ON repair_sessions (state);
