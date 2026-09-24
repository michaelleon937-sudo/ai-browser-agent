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

-- Phase 6 CRM — companies, contacts, conversations, inbound messages

CREATE TABLE IF NOT EXISTS companies (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  website           TEXT,
  domain            TEXT,
  industry          TEXT,
  location          TEXT,
  notes             TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies (domain);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies (name);

CREATE TABLE IF NOT EXISTS contacts (
  id                TEXT PRIMARY KEY,
  company_id        TEXT,
  prospect_id       TEXT,
  name              TEXT,
  email             TEXT,
  phone             TEXT,
  role              TEXT,
  external_id       TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (prospect_id) REFERENCES prospects(id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts (email);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_prospect ON contacts (prospect_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_external_id ON contacts (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT,
  contact_id          TEXT,
  prospect_id         TEXT,
  channel             TEXT NOT NULL,
  external_thread_id  TEXT,
  status              TEXT NOT NULL DEFAULT 'OPEN',
  subject             TEXT,
  summary             TEXT,
  last_message_at     TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (prospect_id) REFERENCES prospects(id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations (contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_company ON conversations (company_id);
CREATE INDEX IF NOT EXISTS idx_conversations_prospect ON conversations (prospect_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_external_thread
  ON conversations (channel, external_thread_id)
  WHERE external_thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbound_messages (
  id                    TEXT PRIMARY KEY,
  conversation_id       TEXT NOT NULL,
  company_id            TEXT,
  contact_id            TEXT,
  prospect_id           TEXT,
  provider              TEXT NOT NULL,
  external_message_id   TEXT,
  direction             TEXT NOT NULL DEFAULT 'inbound',
  sender                TEXT,
  recipient             TEXT,
  subject               TEXT,
  body                  TEXT,
  received_at           TEXT NOT NULL,
  intent                TEXT,
  classification        TEXT,
  extracted_data_json   TEXT,
  raw_metadata_json     TEXT,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (prospect_id) REFERENCES prospects(id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_conversation ON inbound_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_contact ON inbound_messages (contact_id);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_prospect ON inbound_messages (prospect_id);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_received ON inbound_messages (received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_messages_provider_external
  ON inbound_messages (provider, external_message_id)
  WHERE external_message_id IS NOT NULL;


-- Phase 6 CRM Prompt 2 — client memory + conversation intelligence

CREATE TABLE IF NOT EXISTS client_memory (
  id                TEXT PRIMARY KEY,
  company_id        TEXT,
  contact_id        TEXT,
  prospect_id       TEXT,
  key               TEXT NOT NULL,
  value             TEXT NOT NULL,
  confidence        TEXT NOT NULL DEFAULT 'INFERRED',
  source            TEXT NOT NULL,
  source_message_id TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expires_at        TEXT,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (prospect_id) REFERENCES prospects(id)
);

CREATE INDEX IF NOT EXISTS idx_client_memory_company ON client_memory (company_id);
CREATE INDEX IF NOT EXISTS idx_client_memory_contact ON client_memory (contact_id);
CREATE INDEX IF NOT EXISTS idx_client_memory_prospect ON client_memory (prospect_id);
CREATE INDEX IF NOT EXISTS idx_client_memory_key ON client_memory (key);

CREATE TABLE IF NOT EXISTS conversation_insights (
  conversation_id       TEXT PRIMARY KEY,
  message_count         INTEGER NOT NULL DEFAULT 0,
  latest_message_id     TEXT,
  current_intent        TEXT,
  current_classification TEXT,
  summary               TEXT,
  facts_json            TEXT,
  requested_service     TEXT,
  requested_deliverables TEXT,
  deadline              TEXT,
  budget                TEXT,
  unresolved_questions_json TEXT,
  next_action           TEXT,
  next_action_reason    TEXT,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);


-- Phase 7 — Billing, Payments & Project Execution

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, invoice_number TEXT NOT NULL UNIQUE, client_id TEXT, company_id TEXT, contact_id TEXT,
  prospect_id TEXT, opportunity_id TEXT, proposal_id TEXT, task_id TEXT, run_id TEXT,
  currency TEXT NOT NULL DEFAULT 'USD', subtotal REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'DRAFT', issue_date TEXT, due_date TEXT,
  description TEXT, line_items_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
CREATE TABLE IF NOT EXISTS invoice_sequences (year INTEGER PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, client_id TEXT, company_id TEXT, provider TEXT NOT NULL,
  provider_payment_id TEXT, provider_transaction_id TEXT, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'CREATED', payment_method TEXT, idempotency_key TEXT, verified_at TEXT,
  metadata_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_txn ON payments (provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT, payment_id TEXT,
  payload_hash TEXT, processed INTEGER NOT NULL DEFAULT 0, processed_at TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_webhook_provider_event ON payment_webhook_events (provider, event_id);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, client_id TEXT, company_id TEXT, contact_id TEXT, prospect_id TEXT, opportunity_id TEXT,
  proposal_id TEXT, invoice_id TEXT, payment_id TEXT, status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  project_type TEXT, scope TEXT, deliverables_json TEXT, deadline TEXT, assigned_task TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE TABLE IF NOT EXISTS billing_records (
  id TEXT PRIMARY KEY, invoice_id TEXT, payment_id TEXT, company_id TEXT, record_type TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', description TEXT, created_at TEXT NOT NULL
);
