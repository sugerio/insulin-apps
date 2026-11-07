CREATE TABLE signature_layouts (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES signature_outputs(job_id),
  page_count INTEGER NOT NULL CHECK (page_count > 1),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 7)
);
