ALTER TABLE internal_demo_recipient_bindings ADD COLUMN mode TEXT NOT NULL DEFAULT 'STRICT' CHECK (mode IN ('STRICT','SINK_TEST'));
ALTER TABLE internal_demo_recipient_bindings ADD COLUMN task_label TEXT;
