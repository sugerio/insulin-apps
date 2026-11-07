-- Experimental finite evidence reservation; entries are never recycled automatically.
CREATE TABLE candidate_v3_attempt_slots (
  tenant_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 5),
  PRIMARY KEY (tenant_id, envelope_id, task_id, request_hash),
  UNIQUE (tenant_id, envelope_id, task_id, slot)
);
