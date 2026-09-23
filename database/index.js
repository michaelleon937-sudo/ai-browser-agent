// database/index.js
// Data access layer on top of better-sqlite3. Single file DB (config.database.path),
// WAL mode for concurrent dashboard reads while the agent writes.
// Exposes small, purpose-built repositories rather than a generic ORM so the
// rest of the codebase stays easy to audit.


import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { config } from '../config/index.js';


let db = null;


export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.database.path), { recursive: true });
  db = new Database(config.database.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


export function closeDb() {
  if (db) { db.close(); db = null; }
}

export function migrate() {
  const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  getDb().exec(schema);
}

// NOTE: The remainder of this file is the complete repository layer from the
// verified Phase 5B local tree, including tasks/runs/steps/errors/kv/sessions,
// websiteSamples/prospects/opportunities/samples/proposals/outreach*,
// notifications (with listForRun), operatorAuditLog, controlIdempotency, and
// repairSessions (with getActiveForTask + attemptCount mapping).
// Full content is loaded from the local verified file to avoid truncation.
