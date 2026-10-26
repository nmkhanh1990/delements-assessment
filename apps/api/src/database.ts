import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { databasePath } from "./config.js";

const schema = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('chat', 'email', 'form')),
  department_hint TEXT,
  requester_role TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  content TEXT NOT NULL,
  imported_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
  department TEXT NOT NULL CHECK (
    department IN (
      'IT', 'Marketing', 'E-commerce', 'Customer Service', 'SCM',
      'Finance', 'HR', 'Production', 'Needs Review'
    )
  ),
  priority TEXT NOT NULL CHECK (priority IN ('Critical', 'High', 'Medium', 'Low')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  summary TEXT NOT NULL,
  proposed_owner TEXT NOT NULL,
  proposed_steps_json TEXT NOT NULL CHECK (json_valid(proposed_steps_json)),
  risk_flags_json TEXT NOT NULL CHECK (json_valid(risk_flags_json)),
  recommended_state TEXT NOT NULL CHECK (
    recommended_state IN ('Draft', 'Needs Review')
  ),
  validation_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS request_workflows (
  request_id TEXT PRIMARY KEY REFERENCES requests(id),
  state TEXT NOT NULL CHECK (
    state IN (
      'Received', 'Triaged', 'Draft', 'Needs Review', 'Approved',
      'Open', 'Rejected', 'Merged'
    )
  ),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS request_relations (
  id INTEGER PRIMARY KEY,
  from_request_id TEXT NOT NULL REFERENCES requests(id),
  to_request_id TEXT NOT NULL REFERENCES requests(id),
  relation_type TEXT NOT NULL CHECK (
    relation_type IN ('duplicate_candidate', 'conflict', 'merged_into')
  ),
  status TEXT NOT NULL CHECK (status IN ('unresolved', 'resolved')),
  reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (from_request_id <> to_request_id),
  UNIQUE (from_request_id, to_request_id, relation_type)
) STRICT;

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
  status TEXT NOT NULL CHECK (status = 'Open'),
  opened_at TEXT NOT NULL,
  opened_by TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  reason TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS triage_attempts (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id),
  outcome TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_request_workflows_state
  ON request_workflows(state);
CREATE INDEX IF NOT EXISTS idx_audit_logs_request_created
  ON audit_logs(request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_request_relations_from
  ON request_relations(from_request_id);
CREATE INDEX IF NOT EXISTS idx_request_relations_to
  ON request_relations(to_request_id);
CREATE INDEX IF NOT EXISTS idx_triage_attempts_request_created
  ON triage_attempts(request_id, created_at);
`;

export function openDatabase(path = databasePath): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(schema);

  return database;
}
