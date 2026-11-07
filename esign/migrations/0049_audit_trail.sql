-- The audit trail of a signing: who did what, when and from where (src/audit.ts). Append-only.
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  task_id TEXT REFERENCES tasks(id),
  type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  detail_json TEXT
);
CREATE INDEX audit_events_by_envelope ON audit_events(envelope_id, id);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
-- The signed copy sent to each signer once the envelope is completed (src/signed-copies.ts).
CREATE TABLE copy_deliveries (
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  reserved_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (envelope_id, task_id)
);
